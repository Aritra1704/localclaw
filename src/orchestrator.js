import os from 'node:os';
import process from 'node:process';

import pino from 'pino';

import { config } from './config.js';
import { getPool } from './db/client.js';

const logger = pino({
  name: 'localclaw-orchestrator',
  level: config.nodeEnv === 'development' ? 'debug' : 'info',
});

export class Orchestrator {
  constructor(options = {}) {
    this.instanceId =
      options.instanceId ?? `${os.hostname()}:${process.pid}`;
    this.pollIntervalMs = options.pollIntervalMs ?? config.taskPollIntervalMs;
    this.logger = options.logger ?? logger;
    this.pool = options.pool ?? getPool();
    this.taskExecutor = options.taskExecutor;
    this.timer = null;
    this.isRunning = false;
    this.tickInFlight = false;
  }

  async start() {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;

    const existingStatus = await this.getAgentStateValue('status');
    if (!existingStatus) {
      await this.setAgentStateValue('status', 'running');
    }

    const currentTaskId = await this.getAgentStateValue('current_task_id');
    if (typeof currentTaskId === 'undefined') {
      await this.setAgentStateValue('current_task_id', null);
    }

    const stats = (await this.getAgentStateValue('stats')) ?? {};
    if (!stats.uptime_start) {
      stats.uptime_start = new Date().toISOString();
      await this.setAgentStateValue('stats', stats);
    }

    this.logger.info(
      { instanceId: this.instanceId, pollIntervalMs: this.pollIntervalMs },
      'Orchestrator started'
    );

    await this.tick();

    this.timer = setInterval(() => {
      this.tick().catch((error) => {
        this.logger.error({ err: error }, 'Polling tick failed');
      });
    }, this.pollIntervalMs);
  }

  async stop(options = {}) {
    const { status = null, reason = null } = options;

    this.isRunning = false;

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    await this.setAgentStateValue('current_task_id', null);

    if (status) {
      await this.setAgentStateValue('status', status);
    }

    if (reason !== null) {
      await this.setAgentStateValue('pause_reason', reason);
    }

    this.logger.info('Orchestrator stopped');
  }

  async tick() {
    if (!this.isRunning || this.tickInFlight) {
      return;
    }

    this.tickInFlight = true;

    try {
      const status = await this.getAgentStateValue('status', 'running');
      if (status !== 'running') {
        this.logger.info({ status }, 'Skipping poll because agent is not running');
        return;
      }

      const pendingCount = await this.getPendingTaskCount();
      this.logger.debug({ pendingCount }, 'Polling task queue');

      if (pendingCount === 0) {
        return;
      }

      const task = await this.leaseNextTask();
      if (!task) {
        return;
      }

      await this.setAgentStateValue('current_task_id', task.id);
      await this.logTaskStep(task.id, {
        stepNumber: 1,
        stepType: 'system',
        status: 'started',
        outputSummary: `Picked task "${task.title}" for controlled execution`,
      });

      await this.executeTask(task);
    } finally {
      this.tickInFlight = false;
    }
  }

  async getPendingTaskCount() {
    const result = await this.pool.query(
      `SELECT COUNT(*)::int AS count
       FROM tasks
       WHERE status = 'pending'`
    );

    return result.rows[0]?.count ?? 0;
  }

  async leaseNextTask() {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      const result = await client.query(
        `SELECT id, title, description, priority, project_name, project_path
         FROM tasks
         WHERE status = 'pending'
         ORDER BY
           CASE priority
             WHEN 'critical' THEN 1
             WHEN 'high' THEN 2
             WHEN 'medium' THEN 3
             WHEN 'low' THEN 4
             ELSE 5
           END,
           created_at ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED`
      );

      const task = result.rows[0];
      if (!task) {
        await client.query('COMMIT');
        return null;
      }

      const updated = await client.query(
        `UPDATE tasks
         SET
           status = 'in_progress',
           locked_by = $2,
           lease_expires_at = NOW() + INTERVAL '5 minutes',
           last_heartbeat_at = NOW(),
           started_at = COALESCE(started_at, NOW()),
           updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [task.id, this.instanceId]
      );

      await client.query('COMMIT');
      return updated.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async executeTask(task) {
    if (!this.taskExecutor) {
      throw new Error('Task executor is not configured');
    }

    this.logger.info({ taskId: task.id, title: task.title }, 'Executing task');

    try {
      const result = await this.taskExecutor.executeTask(task, {
        startStepNumber: 2,
        logStep: async (step) => {
          await this.logTaskStep(task.id, step);
          await this.touchTaskLease(task.id);
        },
      });

      await this.persistArtifacts(task.id, result.artifacts ?? []);

      const taskStatus =
        result.verification.review.status === 'passed'
          ? 'done'
          : result.verification.review.status === 'needs_human_review'
            ? 'blocked'
            : 'failed';

      await this.pool.query(
        `UPDATE tasks
         SET
           status = $2,
           project_path = COALESCE(project_path, $3),
           blocked_reason = $4,
           result = $5::jsonb,
           completed_at = CASE WHEN $2 = 'done' THEN NOW() ELSE completed_at END,
           updated_at = NOW(),
           locked_by = NULL,
           lease_expires_at = NULL,
           last_heartbeat_at = NOW()
         WHERE id = $1`,
        [
          task.id,
          taskStatus,
          result.workspaceRoot,
          taskStatus === 'blocked' ? result.verification.review.summary : null,
          JSON.stringify(result),
        ]
      );

      this.logger.info(
        {
          taskId: task.id,
          title: task.title,
          taskStatus,
          workspaceRoot: result.workspaceRoot,
        },
        'Task execution finished'
      );

      if (taskStatus === 'done') {
        await this.incrementStats('tasks_completed');
      } else {
        await this.incrementStats('tasks_failed');
      }
    } catch (error) {
      await this.logTaskStep(task.id, {
        stepNumber: 999,
        stepType: 'system',
        status: 'error',
        outputSummary: null,
        errorMessage: error.message,
      });

      await this.pool.query(
        `UPDATE tasks
         SET
           status = 'failed',
           blocked_reason = $2,
           updated_at = NOW(),
           locked_by = NULL,
           lease_expires_at = NULL,
           last_heartbeat_at = NOW()
         WHERE id = $1`,
        [task.id, error.message]
      );

      this.logger.error(
        {
          err: error,
          taskId: task.id,
          title: task.title,
        },
        'Task execution failed'
      );

      await this.incrementStats('tasks_failed');
      throw error;
    } finally {
      await this.setAgentStateValue('current_task_id', null);
    }
  }

  async persistArtifacts(taskId, artifacts) {
    for (const artifact of artifacts) {
      await this.pool.query(
        `INSERT INTO task_artifacts (
           task_id,
           artifact_type,
           artifact_path,
           metadata
         )
         VALUES ($1, $2, $3, $4::jsonb)`,
        [
          taskId,
          artifact.artifactType,
          artifact.artifactPath,
          JSON.stringify(artifact.metadata ?? {}),
        ]
      );
    }
  }

  async touchTaskLease(taskId) {
    await this.pool.query(
      `UPDATE tasks
       SET
         lease_expires_at = NOW() + INTERVAL '5 minutes',
         last_heartbeat_at = NOW(),
         updated_at = NOW()
       WHERE id = $1`,
      [taskId]
    );
  }

  async incrementStats(field) {
    const stats = (await this.getAgentStateValue('stats')) ?? {
      tasks_completed: 0,
      tasks_failed: 0,
      uptime_start: new Date().toISOString(),
    };

    stats[field] = (stats[field] ?? 0) + 1;
    await this.setAgentStateValue('stats', stats);
  }

  async logTaskStep(taskId, step) {
    await this.pool.query(
      `INSERT INTO agent_logs (
         task_id,
         step_number,
         step_type,
         model_used,
         tool_called,
         status,
         input_summary,
         output_summary,
         duration_ms,
         error_message
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        taskId,
        step.stepNumber,
        step.stepType,
        step.modelUsed ?? null,
        step.toolCalled ?? null,
        step.status,
        step.inputSummary ?? null,
        step.outputSummary ?? null,
        step.durationMs ?? null,
        step.errorMessage ?? null,
      ]
    );
  }

  async getAgentStateValue(key, fallback = null) {
    const result = await this.pool.query(
      'SELECT value FROM agent_state WHERE state_key = $1',
      [key]
    );

    if (result.rows.length === 0) {
      return fallback;
    }

    return result.rows[0].value;
  }

  async setAgentStateValue(key, value) {
    await this.pool.query(
      `INSERT INTO agent_state (state_key, value, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (state_key)
       DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [key, JSON.stringify(value)]
    );
  }

  async pause(reason = 'Paused via Telegram') {
    await this.setAgentStateValue('status', 'paused');
    await this.setAgentStateValue('pause_reason', reason);
  }

  async resume() {
    await this.setAgentStateValue('status', 'running');
    await this.setAgentStateValue('pause_reason', null);
  }

  async markStopped(reason = 'Stopped via Telegram') {
    await this.setAgentStateValue('status', 'stopped');
    await this.setAgentStateValue('pause_reason', reason);
  }

  async createTask(description, options = {}) {
    const trimmedDescription = description.trim();
    const title =
      options.title ??
      trimmedDescription
        .split('\n')
        .find((line) => line.trim().length > 0)
        ?.trim()
        .slice(0, 80);

    if (!title) {
      throw new Error('Task description cannot be empty.');
    }

    const result = await this.pool.query(
      `INSERT INTO tasks (
         title,
         description,
         priority,
         source,
         project_name,
         project_path
       )
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, title, status, priority, created_at`,
      [
        title,
        trimmedDescription,
        options.priority ?? 'medium',
        options.source ?? 'telegram',
        options.projectName ?? null,
        options.projectPath ?? null,
      ]
    );

    return result.rows[0];
  }

  async listTasks(limit = 10) {
    const result = await this.pool.query(
      `SELECT id, title, status, priority, created_at, started_at, updated_at
       FROM tasks
       WHERE status IN ('pending', 'in_progress', 'verifying', 'blocked', 'waiting_approval')
       ORDER BY
         CASE priority
           WHEN 'critical' THEN 1
           WHEN 'high' THEN 2
           WHEN 'medium' THEN 3
           WHEN 'low' THEN 4
           ELSE 5
         END,
         created_at ASC
       LIMIT $1`,
      [limit]
    );

    return result.rows;
  }

  async getStatusSnapshot() {
    const [status, currentTaskId, pauseReason, stats, queueResult] =
      await Promise.all([
        this.getAgentStateValue('status', 'running'),
        this.getAgentStateValue('current_task_id', null),
        this.getAgentStateValue('pause_reason', null),
        this.getAgentStateValue('stats', {
          tasks_completed: 0,
          tasks_failed: 0,
          uptime_start: null,
        }),
        this.pool.query(
          `SELECT
             COUNT(*) FILTER (WHERE status = 'pending')::int AS pending_count,
             COUNT(*) FILTER (WHERE status = 'in_progress')::int AS in_progress_count,
             COUNT(*) FILTER (WHERE status = 'blocked')::int AS blocked_count
           FROM tasks`
        ),
      ]);

    const taskResult = currentTaskId
      ? await this.pool.query(
          `SELECT id, title, status, priority, started_at
           FROM tasks
           WHERE id = $1`,
          [currentTaskId]
        )
      : { rows: [] };

    return {
      status,
      currentTaskId,
      pauseReason,
      stats,
      queue: queueResult.rows[0] ?? {
        pending_count: 0,
        in_progress_count: 0,
        blocked_count: 0,
      },
      currentTask: taskResult.rows[0] ?? null,
      instanceId: this.instanceId,
      pollIntervalMs: this.pollIntervalMs,
    };
  }
}
