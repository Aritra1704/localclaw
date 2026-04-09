import os from 'node:os';
import process from 'node:process';

import pino from 'pino';

import { config } from './config.js';
import { getPool } from './db/client.js';

const logger = pino({
  name: 'localclaw-orchestrator',
  level: config.nodeEnv === 'development' ? 'debug' : 'info',
});

const RETRIEVAL_STOP_WORDS = new Set([
  'about',
  'after',
  'against',
  'app',
  'application',
  'before',
  'build',
  'create',
  'deploy',
  'deployment',
  'from',
  'into',
  'localclaw',
  'phase',
  'project',
  'railway',
  'sample',
  'task',
  'that',
  'then',
  'this',
  'update',
  'with',
]);

function extractKeywords(text, limit = 12) {
  const tokens = `${text ?? ''}`
    .toLowerCase()
    .replace(/[^a-z0-9_\s-]+/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(
      (token) =>
        token.length >= 3 &&
        token.length <= 32 &&
        !RETRIEVAL_STOP_WORDS.has(token)
    );

  return [...new Set(tokens)].slice(0, limit);
}

function formatRetrievedContext(learnings, documentChunks) {
  const lines = [];

  if (learnings.length > 0) {
    lines.push('Learnings:');
    for (const learning of learnings) {
      lines.push(
        `- [${learning.category}] ${learning.observation} (confidence=${learning.confidence_score})`
      );
    }
  }

  if (documentChunks.length > 0) {
    lines.push('Document context:');
    for (const chunk of documentChunks) {
      const source = chunk.title || chunk.source_path || 'document';
      lines.push(`- [${source}] ${chunk.content}`);
    }
  }

  return lines.join('\n').trim();
}

export class Orchestrator {
  constructor(options = {}) {
    this.instanceId =
      options.instanceId ?? `${os.hostname()}:${process.pid}`;
    this.pollIntervalMs = options.pollIntervalMs ?? config.taskPollIntervalMs;
    this.logger = options.logger ?? logger;
    this.pool = options.pool ?? getPool();
    this.taskExecutor = options.taskExecutor;
    this.publisher = options.publisher ?? null;
    this.deployer = options.deployer ?? null;
    this.learningExtractor = options.learningExtractor ?? null;
    this.notifier = options.notifier ?? null;
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

    await this.recoverInterruptedTasks();
    await this.setAgentStateValue('polling_active', true);

    this.logger.info(
      { instanceId: this.instanceId, pollIntervalMs: this.pollIntervalMs },
      'Orchestrator started'
    );

    this.timer = setInterval(() => {
      this.tick().catch((error) => {
        this.logger.error({ err: error }, 'Polling tick failed');
      });
    }, this.pollIntervalMs);

    queueMicrotask(() => {
      this.tick().catch((error) => {
        this.logger.error({ err: error }, 'Initial polling tick failed');
      });
    });
  }

  async stop(options = {}) {
    const { status = null, reason = null } = options;

    this.isRunning = false;

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    await this.setAgentStateValue('polling_active', false);
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
      await this.pollActiveDeployments();

      const status = await this.getAgentStateValue('status', 'running');
      if (status !== 'running') {
        this.logger.info({ status }, 'Skipping poll because agent is not running');
        return;
      }

      await this.processReadyDeployments();

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

  async recoverInterruptedTasks() {
    const result = await this.pool.query(
      `UPDATE tasks
       SET
         status = 'pending',
         blocked_reason = CASE
           WHEN blocked_reason IS NULL
             THEN 'Recovered after LocalClaw restart before task completion.'
           ELSE blocked_reason
         END,
         locked_by = NULL,
         lease_expires_at = NULL,
         last_heartbeat_at = NOW(),
         updated_at = NOW()
       WHERE status IN ('in_progress', 'verifying')
       RETURNING id, title`
    );

    if (result.rowCount === 0) {
      return;
    }

    for (const row of result.rows) {
      await this.logTaskStep(row.id, {
        stepNumber: 0,
        stepType: 'system',
        status: 'success',
        outputSummary: 'Re-queued after LocalClaw restart recovery',
      });
    }

    this.logger.warn(
      {
        recoveredTaskIds: result.rows.map((row) => row.id),
      },
      'Recovered interrupted tasks during startup'
    );
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
      const retrievalContext = await this.buildRetrievalContext(task);
      const result = await this.taskExecutor.executeTask(task, {
        startStepNumber: 2,
        publisher: this.publisher,
        deployer: this.deployer,
        retrievalContext,
        logStep: async (step) => {
          await this.logTaskStep(task.id, step);
          await this.touchTaskLease(task.id);
        },
      });

      await this.persistArtifacts(task.id, result.artifacts ?? []);
      await this.persistLearnings(task, result);

      if (result.publication?.published && this.deployer?.isEnabled?.()) {
        const deploymentTargetCheck = this.deployer.validateRepositoryName?.(
          result.publication.repo?.name ?? null
        );

        if (deploymentTargetCheck?.ok === false) {
          await this.logTaskStep(task.id, {
            stepNumber: 899,
            stepType: 'deploy',
            status: 'error',
            inputSummary: result.publication.repo?.name ?? null,
            outputSummary: null,
            errorMessage: deploymentTargetCheck.error,
          });

          await this.pool.query(
            `UPDATE tasks
             SET
               status = 'blocked',
               project_name = COALESCE(project_name, $2),
               project_path = COALESCE(project_path, $3),
               repo_url = COALESCE(repo_url, $4),
               blocked_reason = $5,
               result = $6::jsonb,
               updated_at = NOW(),
               locked_by = NULL,
               lease_expires_at = NULL,
               last_heartbeat_at = NOW()
             WHERE id = $1`,
            [
              task.id,
              result.publication.repo?.name ?? result.workspaceName ?? null,
              result.workspaceRoot,
              result.publication.repo?.htmlUrl ?? null,
              deploymentTargetCheck.error,
              JSON.stringify(result),
            ]
          );

          this.logger.warn(
            {
              taskId: task.id,
              repositoryName: result.publication.repo?.name ?? null,
              deployTarget: this.deployer.getTarget(),
            },
            'Published repository does not match the configured Railway service'
          );

          return;
        }

        await this.queueDeploymentApproval(task, result);
        return;
      }

      const publishBlocked =
        result.publication?.attempted === true &&
        result.publication?.published === false;

      const taskStatus = publishBlocked
        ? 'blocked'
        : result.verification.review.status === 'passed'
          ? 'done'
          : result.verification.review.status === 'needs_human_review'
            ? 'blocked'
            : 'failed';

      await this.pool.query(
        `UPDATE tasks
         SET
           status = $2,
           project_name = COALESCE(project_name, $3),
           project_path = COALESCE(project_path, $4),
           repo_url = COALESCE(repo_url, $5),
           blocked_reason = $6,
           result = $7::jsonb,
           completed_at = CASE WHEN $2 = 'done' THEN NOW() ELSE completed_at END,
           updated_at = NOW(),
           locked_by = NULL,
           lease_expires_at = NULL,
           last_heartbeat_at = NOW()
         WHERE id = $1`,
        [
          task.id,
          taskStatus,
          result.publication?.repo?.name ?? result.workspaceName ?? null,
          result.workspaceRoot,
          result.publication?.repo?.htmlUrl ?? null,
          taskStatus === 'blocked'
            ? result.publication?.error?.message ?? result.verification.review.summary
            : null,
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

  setNotifier(notifier) {
    this.notifier = notifier;
  }

  async buildRetrievalContext(task) {
    const keywords = extractKeywords(`${task.title} ${task.description}`);
    if (keywords.length === 0) {
      return null;
    }

    try {
      const learningResult = await this.pool.query(
        `SELECT category, observation, confidence_score
         FROM learnings
         WHERE keywords && $1::text[]
         ORDER BY times_applied DESC, confidence_score DESC, created_at DESC
         LIMIT 5`,
        [keywords]
      );

      const likePatterns = keywords.slice(0, 6).map((keyword) => `%${keyword}%`);
      const chunkResult = await this.pool.query(
        `SELECT
           LEFT(document_chunks.content, 280) AS content,
           documents.title,
           documents.source_path
         FROM document_chunks
         JOIN documents ON documents.id = document_chunks.document_id
         WHERE document_chunks.content ILIKE ANY($1::text[])
         ORDER BY document_chunks.created_at DESC
         LIMIT 4`,
        [likePatterns]
      );

      const context = formatRetrievedContext(learningResult.rows, chunkResult.rows);
      return context.length > 0 ? context : null;
    } catch (error) {
      this.logger.warn({ err: error, taskId: task.id }, 'Failed to retrieve Phase 5 context');
      return null;
    }
  }

  async persistLearnings(task, result) {
    if (!this.learningExtractor?.extract) {
      return;
    }

    try {
      const learnings = await this.learningExtractor.extract(task, result);
      if (!Array.isArray(learnings) || learnings.length === 0) {
        return;
      }

      for (const learning of learnings.slice(0, 4)) {
        await this.pool.query(
          `INSERT INTO learnings (
             task_id,
             category,
             observation,
             keywords,
             confidence_score
           )
           VALUES ($1, $2, $3, $4::text[], $5)`,
          [
            task.id,
            learning.category ?? 'execution',
            learning.observation,
            Array.isArray(learning.keywords) ? learning.keywords : [],
            Number.isFinite(learning.confidenceScore)
              ? Math.max(1, Math.min(10, Math.round(learning.confidenceScore)))
              : 6,
          ]
        );
      }

      await this.logTaskStep(task.id, {
        stepNumber: 950,
        stepType: 'learn',
        status: 'success',
        outputSummary: `Persisted ${Math.min(learnings.length, 4)} learning item(s)`,
      });
    } catch (error) {
      this.logger.warn({ err: error, taskId: task.id }, 'Failed to persist learnings');
    }
  }

  async notify(text, options = {}) {
    if (!this.notifier?.sendMessage) {
      return null;
    }

    try {
      return await this.notifier.sendMessage(text, options);
    } catch (error) {
      this.logger.error({ err: error }, 'Failed to send Telegram notification');
      return null;
    }
  }

  async queueDeploymentApproval(task, result) {
    const target = this.deployer.getTarget();
    const approvalResult = await this.pool.query(
      `INSERT INTO approvals (
         task_id,
         approval_type,
         status,
         requested_via,
         response_payload
       )
       VALUES ($1, $2, 'pending', 'telegram', $3::jsonb)
       RETURNING id, task_id, requested_at`,
      [
        task.id,
        'railway_deploy',
        JSON.stringify({
          repoUrl: result.publication.repo.htmlUrl,
          target,
        }),
      ]
    );

    const approval = approvalResult.rows[0];
    const deploymentResult = await this.pool.query(
      `INSERT INTO deployments (
         task_id,
         provider,
         target_env,
         repo_url,
         status,
         approval_id,
         project_id,
         environment_id,
         service_id,
         updated_at
       )
       VALUES ($1, 'railway', $2, $3, 'approval_pending', $4, $5, $6, $7, NOW())
       RETURNING id`,
      [
        task.id,
        target.environmentName,
        result.publication.repo.htmlUrl,
        approval.id,
        target.projectId,
        target.environmentId,
        target.serviceId,
      ]
    );

    await this.pool.query(
      `UPDATE tasks
       SET
         status = 'waiting_approval',
         project_name = COALESCE(project_name, $2),
         project_path = COALESCE(project_path, $3),
         repo_url = COALESCE(repo_url, $4),
         blocked_reason = NULL,
         result = $5::jsonb,
         updated_at = NOW(),
         locked_by = NULL,
         lease_expires_at = NULL,
         last_heartbeat_at = NOW()
       WHERE id = $1`,
      [
        task.id,
        result.publication.repo.name,
        result.workspaceRoot,
        result.publication.repo.htmlUrl,
        JSON.stringify(result),
      ]
    );

    await this.logTaskStep(task.id, {
      stepNumber: 900,
      stepType: 'approval',
      status: 'success',
      inputSummary: result.publication.repo.htmlUrl,
      outputSummary: `Deploy approval requested: ${approval.id}`,
    });

    const message = [
      `Deploy approval requested.`,
      `Task: ${task.title}`,
      `Approval: ${approval.id}`,
      `Deployment: ${deploymentResult.rows[0].id}`,
      `Repo: ${result.publication.repo.htmlUrl}`,
      `Target: ${target.projectId} / ${target.environmentName} / ${target.serviceName ?? target.serviceId}`,
      `Approve: /approve ${approval.id}`,
      `Reject: /reject ${approval.id} not ready`,
    ].join('\n');

    const sentMessage = await this.notify(message, {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: 'Approve deploy',
              callback_data: `approval:approve:${approval.id}`,
            },
            {
              text: 'Reject deploy',
              callback_data: `approval:reject:${approval.id}`,
            },
          ],
        ],
      },
    });

    if (sentMessage?.message_id) {
      await this.pool.query(
        `UPDATE approvals
         SET request_message_id = $2
         WHERE id = $1`,
        [approval.id, sentMessage.message_id.toString()]
      );
    }

    this.logger.info(
      {
        taskId: task.id,
        approvalId: approval.id,
        deploymentId: deploymentResult.rows[0].id,
      },
      'Deployment approval requested'
    );
  }

  async listPendingApprovals(limit = 10) {
    const result = await this.pool.query(
      `SELECT
         approvals.id,
         approvals.task_id,
         approvals.requested_at,
         tasks.title AS task_title,
         deployments.repo_url,
         deployments.target_env,
         deployments.service_id
       FROM approvals
       JOIN tasks ON tasks.id = approvals.task_id
       LEFT JOIN deployments ON deployments.approval_id = approvals.id
       WHERE approvals.status = 'pending'
         AND approvals.approval_type = 'railway_deploy'
       ORDER BY approvals.requested_at ASC
       LIMIT $1`,
      [limit]
    );

    return result.rows;
  }

  async approveApproval(approvalId, options = {}) {
    const payload = {
      respondedVia: options.respondedVia ?? 'telegram',
      note: options.note ?? null,
    };

    const approvalResult = await this.pool.query(
      `UPDATE approvals
       SET
         status = 'approved',
         responded_at = NOW(),
         response_payload = COALESCE(response_payload, '{}'::jsonb) || $2::jsonb
       WHERE id = $1
         AND status = 'pending'
       RETURNING id, task_id`,
      [approvalId, JSON.stringify(payload)]
    );

    const approval = approvalResult.rows[0];
    if (!approval) {
      return null;
    }

    await this.pool.query(
      `UPDATE deployments
       SET
         status = 'approved',
         updated_at = NOW(),
         last_error = NULL
       WHERE approval_id = $1
         AND status = 'approval_pending'`,
      [approvalId]
    );

    return approval;
  }

  async rejectApproval(approvalId, options = {}) {
    const reason = options.reason ?? 'Rejected via Telegram';
    const payload = {
      respondedVia: options.respondedVia ?? 'telegram',
      reason,
    };

    const approvalResult = await this.pool.query(
      `UPDATE approvals
       SET
         status = 'rejected',
         responded_at = NOW(),
         response_payload = COALESCE(response_payload, '{}'::jsonb) || $2::jsonb
       WHERE id = $1
         AND status = 'pending'
       RETURNING id, task_id`,
      [approvalId, JSON.stringify(payload)]
    );

    const approval = approvalResult.rows[0];
    if (!approval) {
      return null;
    }

    await this.pool.query(
      `UPDATE deployments
       SET
         status = 'rejected',
         last_error = $2,
         updated_at = NOW(),
         completed_at = NOW()
       WHERE approval_id = $1`,
      [approvalId, reason]
    );

    await this.pool.query(
      `UPDATE tasks
       SET
         status = 'blocked',
         blocked_reason = $2,
         updated_at = NOW(),
         locked_by = NULL,
         lease_expires_at = NULL,
         last_heartbeat_at = NOW()
       WHERE id = $1`,
      [approval.task_id, reason]
    );

    await this.logTaskStep(approval.task_id, {
      stepNumber: 901,
      stepType: 'approval',
      status: 'error',
      outputSummary: null,
      errorMessage: reason,
    });

    return approval;
  }

  async processReadyDeployments() {
    if (!this.deployer?.isEnabled?.()) {
      return;
    }

    const result = await this.pool.query(
      `SELECT
         deployments.id AS deployment_id,
         deployments.task_id,
         deployments.project_id,
         deployments.environment_id,
         deployments.service_id,
         deployments.repo_url,
         tasks.title,
         tasks.result
       FROM deployments
       JOIN approvals ON approvals.id = deployments.approval_id
       JOIN tasks ON tasks.id = deployments.task_id
       WHERE approvals.status = 'approved'
         AND deployments.status IN ('approval_pending', 'approved')
       ORDER BY deployments.created_at ASC`
    );

    for (const row of result.rows) {
      await this.startApprovedDeployment(row);
    }
  }

  async startApprovedDeployment(row) {
    try {
      const remoteDeploymentId = await this.deployer.triggerDeployment({
        serviceId: row.service_id,
        environmentId: row.environment_id,
        // Railway commit-target deploys can fail fast with no logs due to provider-side sync timing.
        // Trigger against the service/environment head for a more reliable Phase 4 path.
        commitSha: null,
      });

      await this.pool.query(
        `UPDATE deployments
         SET
           status = 'deploying',
           remote_deployment_id = $2,
           updated_at = NOW(),
           last_error = NULL
         WHERE id = $1`,
        [row.deployment_id, remoteDeploymentId]
      );

      await this.pool.query(
        `UPDATE tasks
         SET
           status = 'in_progress',
           blocked_reason = NULL,
           locked_by = $2,
           lease_expires_at = NOW() + INTERVAL '15 minutes',
           last_heartbeat_at = NOW(),
           updated_at = NOW()
         WHERE id = $1`,
        [row.task_id, this.instanceId]
      );

      await this.logTaskStep(row.task_id, {
        stepNumber: 902,
        stepType: 'deploy',
        status: 'success',
        inputSummary: row.repo_url ?? row.service_id,
        outputSummary: `Railway deployment started: ${remoteDeploymentId}`,
      });

      await this.notify(
        [
          `Railway deploy started.`,
          `Task: ${row.title}`,
          `Deployment: ${row.deployment_id}`,
          `Remote deployment: ${remoteDeploymentId}`,
        ].join('\n')
      );
    } catch (error) {
      await this.failDeployment({
        deploymentId: row.deployment_id,
        taskId: row.task_id,
        title: row.title,
        errorMessage: error.message,
      });
    }
  }

  async pollActiveDeployments() {
    if (!this.deployer?.isEnabled?.()) {
      return;
    }

    const result = await this.pool.query(
      `SELECT
         deployments.id AS deployment_id,
         deployments.task_id,
         deployments.remote_deployment_id,
         deployments.service_id,
         deployments.environment_id,
         deployments.last_error,
         tasks.title
       FROM deployments
       JOIN tasks ON tasks.id = deployments.task_id
       WHERE deployments.status = 'deploying'
         AND deployments.remote_deployment_id IS NOT NULL
       ORDER BY deployments.updated_at ASC`
    );

    for (const row of result.rows) {
      await this.refreshDeployment(row);
    }
  }

  async refreshDeployment(row) {
    try {
      const snapshot = await this.deployer.getDeployment(row.remote_deployment_id);

      await this.touchTaskLease(row.task_id);

      if (snapshot.state === 'pending') {
        await this.pool.query(
          `UPDATE deployments
           SET
             deploy_url = COALESCE($2, deploy_url),
             updated_at = NOW()
           WHERE id = $1`,
          [row.deployment_id, snapshot.url]
        );
        return;
      }

      const logSnapshot = await this.captureDeploymentLogs(row.remote_deployment_id);

      if (snapshot.state === 'success') {
        await this.pool.query(
          `UPDATE deployments
           SET
             status = 'success',
             deploy_url = COALESCE($2, deploy_url),
             log_snapshot = $3,
             last_error = NULL,
             updated_at = NOW(),
             completed_at = NOW()
           WHERE id = $1`,
          [row.deployment_id, snapshot.url, logSnapshot]
        );

        await this.pool.query(
          `UPDATE tasks
           SET
             status = 'done',
             blocked_reason = NULL,
             completed_at = NOW(),
             updated_at = NOW(),
             locked_by = NULL,
             lease_expires_at = NULL,
             last_heartbeat_at = NOW()
           WHERE id = $1`,
          [row.task_id]
        );

        await this.incrementStats('tasks_completed');
        await this.logTaskStep(row.task_id, {
          stepNumber: 903,
          stepType: 'deploy',
          status: 'success',
          inputSummary: row.remote_deployment_id,
          outputSummary: snapshot.url ?? snapshot.status,
        });

        await this.notify(
          [
            `Railway deploy succeeded.`,
            `Task: ${row.title}`,
            `URL: ${snapshot.url ?? 'n/a'}`,
          ].join('\n')
        );

        return;
      }

      const shouldRetryWithoutCommitTarget =
        snapshot.status === 'FAILED' &&
        !logSnapshot &&
        row.last_error !== 'retrying_after_failed_no_logs';

      if (shouldRetryWithoutCommitTarget) {
        await this.retryDeploymentWithoutCommitTarget(row);
        return;
      }

      await this.failDeployment({
        deploymentId: row.deployment_id,
        taskId: row.task_id,
        title: row.title,
        errorMessage: `Railway deployment ${snapshot.status}`,
        logSnapshot,
      });
    } catch (error) {
      await this.failDeployment({
        deploymentId: row.deployment_id,
        taskId: row.task_id,
        title: row.title,
        errorMessage: error.message,
      });
    }
  }

  async retryDeploymentWithoutCommitTarget(row) {
    const remoteDeploymentId = await this.deployer.triggerDeployment({
      serviceId: row.service_id,
      environmentId: row.environment_id,
      commitSha: null,
    });

    await this.pool.query(
      `UPDATE deployments
       SET
         status = 'deploying',
         remote_deployment_id = $2,
         last_error = 'retrying_after_failed_no_logs',
         updated_at = NOW()
       WHERE id = $1`,
      [row.deployment_id, remoteDeploymentId]
    );

    await this.logTaskStep(row.task_id, {
      stepNumber: 905,
      stepType: 'deploy',
      status: 'success',
      inputSummary: row.remote_deployment_id,
      outputSummary: `Retrying Railway deployment: ${remoteDeploymentId}`,
    });

    await this.notify(
      [
        `Railway deploy retry started.`,
        `Task: ${row.title}`,
        `Deployment: ${row.deployment_id}`,
        `Remote deployment: ${remoteDeploymentId}`,
      ].join('\n')
    );
  }

  async captureDeploymentLogs(remoteDeploymentId) {
    const logs = await this.deployer.getDeploymentLogs(remoteDeploymentId, 50);
    if (logs.length === 0) {
      return null;
    }

    return logs
      .map((entry) => `[${entry.timestamp}] ${entry.severity ?? 'INFO'} ${entry.message}`)
      .join('\n');
  }

  async failDeployment({ deploymentId, taskId, title, errorMessage, logSnapshot = null }) {
    await this.pool.query(
      `UPDATE deployments
       SET
         status = 'failed',
         last_error = $2,
         log_snapshot = COALESCE($3, log_snapshot),
         updated_at = NOW(),
         completed_at = NOW()
       WHERE id = $1`,
      [deploymentId, errorMessage, logSnapshot]
    );

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
      [taskId, errorMessage]
    );

    await this.incrementStats('tasks_failed');
    await this.logTaskStep(taskId, {
      stepNumber: 904,
      stepType: 'deploy',
      status: 'error',
      outputSummary: null,
      errorMessage,
    });

    await this.notify(
      [
        `Railway deploy failed.`,
        `Task: ${title}`,
        `Reason: ${errorMessage}`,
      ].join('\n')
    );
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
    const [
      status,
      currentTaskId,
      pauseReason,
      stats,
      bootPhase,
      bootError,
      pollingActive,
      queueResult,
      deploymentResult,
      approvalResult,
    ] =
      await Promise.all([
        this.getAgentStateValue('status', 'running'),
        this.getAgentStateValue('current_task_id', null),
        this.getAgentStateValue('pause_reason', null),
        this.getAgentStateValue('stats', {
          tasks_completed: 0,
          tasks_failed: 0,
          uptime_start: null,
        }),
        this.getAgentStateValue('boot_phase', 'unknown'),
        this.getAgentStateValue('boot_error', null),
        this.getAgentStateValue('polling_active', false),
        this.pool.query(
          `SELECT
             COUNT(*) FILTER (WHERE status = 'pending')::int AS pending_count,
             COUNT(*) FILTER (WHERE status = 'in_progress')::int AS in_progress_count,
             COUNT(*) FILTER (WHERE status = 'blocked')::int AS blocked_count,
             COUNT(*) FILTER (WHERE status = 'waiting_approval')::int AS waiting_approval_count
           FROM tasks`
        ),
        this.pool.query(
          `SELECT COUNT(*)::int AS deploying_count
           FROM deployments
           WHERE status = 'deploying'`
        ),
        this.pool.query(
          `SELECT COUNT(*)::int AS pending_count
           FROM approvals
           WHERE status = 'pending'
             AND approval_type = 'railway_deploy'`
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
      bootPhase,
      bootError,
      pollingActive,
      currentTaskId,
      pauseReason,
      stats,
      queue: queueResult.rows[0] ?? {
        pending_count: 0,
        in_progress_count: 0,
        blocked_count: 0,
        waiting_approval_count: 0,
      },
      deployments: {
        deploying_count: deploymentResult.rows[0]?.deploying_count ?? 0,
      },
      approvals: {
        pending_count: approvalResult.rows[0]?.pending_count ?? 0,
      },
      currentTask: taskResult.rows[0] ?? null,
      instanceId: this.instanceId,
      pollIntervalMs: this.pollIntervalMs,
    };
  }
}
