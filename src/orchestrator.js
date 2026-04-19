import { statfs } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import pino from 'pino';

import { config } from './config.js';
import {
  buildTaskDescriptionFromContract,
  buildTaskTitleFromContract,
} from './control/taskContract.js';
import { getPool } from './db/client.js';
import { ReflectionEngine } from './selfimprovement/reflectionEngine.js';
import { RepairEngine } from './selfhealing/repairEngine.js';
import { ChatHistoryManager } from './control/chatHistory.js';

const logger = pino({
  name: 'localclaw-orchestrator',
  level: config.nodeEnv === 'development' ? 'debug' : 'info',
});
const RAG_SYNC_INTERVAL_MS = 10 * 60 * 1000;

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

function formatRetrievedContext(
  learnings,
  documentChunks,
  suggestedSkills = [],
  graphContext = null,
  impactAnalysis = null
) {
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

  if (suggestedSkills.length > 0) {
    lines.push('Suggested skills:');
    for (const skill of suggestedSkills) {
      lines.push(`- ${skill.name} (v${skill.version}) ${skill.description}`);
    }
  }

  if (graphContext?.lines?.length > 0) {
    lines.push(...graphContext.lines);
  }

  if (impactAnalysis?.lines?.length > 0) {
    lines.push(...impactAnalysis.lines);
  }

  return lines.join('\n').trim();
}

function slugifyTaskTitle(value) {
  return `${value ?? ''}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

function buildChecklistFromPlan(planSteps = [], options = {}) {
  const completedCount = Math.max(options.completedCount ?? 0, 0);
  const currentStepNumber = options.currentStepNumber ?? null;
  const failedStepNumber = options.failedStepNumber ?? null;

  return planSteps.map((step, index) => {
    let status = 'pending';
    if (failedStepNumber === step.stepNumber) {
      status = 'failed';
    } else if (step.stepNumber === currentStepNumber) {
      status = 'current';
    } else if (index < completedCount) {
      status = 'completed';
    }

    return {
      stepNumber: step.stepNumber,
      objective: step.objective,
      tool: step.tool,
      status,
    };
  });
}

function derivePersistedRuntime(task, logs = []) {
  const plan = task?.result?.preExecutionPlan?.plan ?? task?.result?.plan ?? null;
  const planSteps = Array.isArray(plan?.steps) ? plan.steps : [];
  const completedCount = logs.filter(
    (entry) => entry.step_type === 'act' && entry.status === 'success'
  ).length;
  const hasFailedActStep = logs.some(
    (entry) => entry.step_type === 'act' && entry.status === 'error'
  );
  const hasPlanPreview = Boolean(task?.result?.preExecutionPlan);

  let phase = 'idle';
  let phaseLabel = 'Idle';
  let detail = 'No transient runtime is available for this task.';
  let currentStepNumber = null;
  let failedStepNumber = null;

  if (task?.status === 'waiting_approval') {
    phase = 'waiting_approval';
    phaseLabel = 'Waiting for approval';
    detail = 'Plan preview is ready. Execution has not started yet.';
  } else if (task?.status === 'pending') {
    phase = 'queued';
    phaseLabel = 'Queued';
    detail = 'Task is queued and waiting for an executor slot.';
  } else if (task?.status === 'in_progress') {
    if (completedCount === 0) {
      phase = 'preparing';
      phaseLabel = 'Preparing workspace';
      detail = 'Workspace setup is in progress.';
    } else if (completedCount < planSteps.length) {
      phase = 'acting';
      phaseLabel = 'Executing plan';
      detail = `Running step ${completedCount + 1} of ${planSteps.length}.`;
      currentStepNumber = planSteps[completedCount]?.stepNumber ?? null;
    } else {
      phase = 'verifying';
      phaseLabel = 'Verifying result';
      detail = 'Workspace execution is complete. Verification is in progress.';
    }
  } else if (task?.status === 'verifying') {
    phase = 'verifying';
    phaseLabel = 'Verifying result';
    detail = 'Verifier checks are running.';
  } else if (task?.status === 'blocked') {
    phase = 'blocked';
    phaseLabel = 'Blocked';
    detail = task?.blocked_reason || 'Task requires operator attention.';
    failedStepNumber = hasFailedActStep
      ? planSteps[Math.min(completedCount, planSteps.length - 1)]?.stepNumber ?? null
      : null;
  } else if (task?.status === 'done') {
    phase = 'complete';
    phaseLabel = 'Done';
    detail = 'Task finished successfully.';
  } else if (task?.status === 'failed') {
    phase = 'failed';
    phaseLabel = 'Failed';
    detail = task?.blocked_reason || 'Task execution failed.';
    failedStepNumber = hasFailedActStep
      ? planSteps[Math.min(completedCount, planSteps.length - 1)]?.stepNumber ?? null
      : null;
  }

  const checklist = buildChecklistFromPlan(planSteps, {
    completedCount:
      task?.status === 'done' ? planSteps.length : Math.min(completedCount, planSteps.length),
    currentStepNumber,
    failedStepNumber,
  });

  return {
    live: false,
    phase,
    phaseLabel,
    detail,
    summary: plan?.summary ?? null,
    currentModel:
      task?.result?.verification?.modelUsed ??
      task?.result?.preExecutionPlan?.model_used ??
      null,
    modelRole: hasPlanPreview ? 'planner' : null,
    usage: null,
    checklist,
    counts: {
      completed: checklist.filter((item) => item.status === 'completed').length,
      total: checklist.length,
    },
    currentStep:
      checklist.find((item) => item.status === 'current') ??
      checklist.find((item) => item.status === 'failed') ??
      null,
    startedAt: task?.started_at ?? task?.created_at ?? null,
    updatedAt: task?.updated_at ?? null,
  };
}

function mergeRuntimeSnapshots(persisted, live) {
  if (!live) {
    return persisted;
  }

  return {
    ...persisted,
    ...live,
    live: true,
    checklist: Array.isArray(live.checklist) ? live.checklist : persisted.checklist,
    counts: live.counts ?? persisted.counts,
    currentStep:
      typeof live.currentStep === 'undefined' ? persisted.currentStep : live.currentStep,
    usage: typeof live.usage === 'undefined' ? persisted.usage : live.usage,
    currentModel:
      typeof live.currentModel === 'undefined'
        ? persisted.currentModel
        : live.currentModel,
    modelRole:
      typeof live.modelRole === 'undefined' ? persisted.modelRole : live.modelRole,
    summary: typeof live.summary === 'undefined' ? persisted.summary : live.summary,
    detail: typeof live.detail === 'undefined' ? persisted.detail : live.detail,
    startedAt: live.startedAt ?? persisted.startedAt,
    updatedAt: live.updatedAt ?? persisted.updatedAt,
  };
}

function deriveFinalReviewStatus(result) {
  const verificationStatus = result?.verification?.review?.status ?? 'failed';
  const specializedStatus = result?.specializedReview?.status ?? 'passed';

  if (verificationStatus === 'failed') {
    return 'failed';
  }

  if (verificationStatus === 'needs_human_review') {
    return 'blocked';
  }

  if (specializedStatus === 'failed' || specializedStatus === 'needs_human_review') {
    return 'blocked';
  }

  return 'done';
}

function deriveBlockedReason(result) {
  return (
    result?.publication?.error?.message ??
    result?.specializedReview?.summary ??
    result?.verification?.review?.summary ??
    null
  );
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
    this.ragIngestor = options.ragIngestor ?? null;
    this.ragRetriever = options.ragRetriever ?? null;
    this.knowledgeGraph = options.knowledgeGraph ?? null;
    this.skillManager = options.skillManager ?? null;
    this.notifier = options.notifier ?? null;
    this.mcpRegistry = options.mcpRegistry ?? null;
    this.reflectionEngine = options.reflectionEngine ?? null;
    this.repairEngine = options.repairEngine ?? null;
    this.chatHistoryManager = options.chatHistoryManager ?? null;
    this.reflectionInFlight = false;
    this.lastReflectionAt = 0;
    this.timer = null;
    this.isRunning = false;
    this.tickInFlight = false;
    this.ragSyncInFlight = false;
    this.lastRagSyncAt = 0;
    this.ragSyncIntervalMs = options.ragSyncIntervalMs ?? RAG_SYNC_INTERVAL_MS;
    this.lastAutoPruneAt = 0;
    this.lastSpaceWarningAt = 0;
    
    this.activeTasks = new Set();
    this.maxConcurrency = options.maxConcurrency ?? parseInt(process.env.MAX_CONCURRENT_TASKS || '3', 10);
    this.liveTaskRuntime = new Map();
  }

  getPostgresMcpServer() {
    return this.mcpRegistry?.getServer?.('postgres') ?? null;
  }

  async callPostgresTool(toolName, args, fallback) {
    const postgresServer = this.getPostgresMcpServer();
    if (postgresServer) {
      return postgresServer.callTool(toolName, args);
    }

    return fallback();
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

    await Promise.all(Array.from(this.activeTasks).map(t => t.promise).filter(Boolean));
    this.logger.info('Orchestrator stopped');
  }

  async tick() {
    if (!this.isRunning || this.tickInFlight) {
      return;
    }

    this.tickInFlight = true;

    try {
      await this.checkSystemHealth();
      await this.syncRagCorpusIfDue();
      await this.runSelfReflectionIfDue();
      await this.pollActiveDeployments();

      const status = await this.getAgentStateValue('status', 'running');
      if (status !== 'running') {
        this.logger.info({ status }, 'Skipping poll because agent is not running');
        return;
      }

      await this.processReadyDeployments();
      await this.processReadyRepairs();

      if (this.activeTasks.size >= this.maxConcurrency) {
        return;
      }

      const pendingCount = await this.getPendingTaskCount();
      this.logger.debug({ pendingCount, activeCount: this.activeTasks.size }, 'Polling task queue');

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

      const taskObj = { id: task.id, promise: null };
      taskObj.promise = this.executeTask(task).finally(() => {
        this.activeTasks.delete(taskObj);
      });
      this.activeTasks.add(taskObj);
    } finally {
      this.tickInFlight = false;
    }
  }

  async syncRagCorpusIfDue(force = false) {
    if (!this.ragIngestor?.ingestProjectDocuments && !this.knowledgeGraph?.ingestProjectGraph) {
      return;
    }

    if (this.ragSyncInFlight) {
      return;
    }

    const now = Date.now();
    if (!force && now - this.lastRagSyncAt < this.ragSyncIntervalMs) {
      return;
    }

    this.ragSyncInFlight = true;

    try {
      const [ragSummary, graphSummary] = await Promise.all([
        this.ragIngestor?.ingestProjectDocuments
          ? this.ragIngestor.ingestProjectDocuments({
              projectRoot: process.cwd(),
            })
          : null,
        this.knowledgeGraph?.ingestProjectGraph
          ? this.knowledgeGraph.ingestProjectGraph({
              projectRoot: process.cwd(),
            })
          : null,
      ]);

      this.logger.info(
        { ragSummary, graphSummary },
        'Knowledge corpus sync completed'
      );
    } catch (error) {
      this.logger.warn({ err: error }, 'Knowledge corpus sync failed');
    } finally {
      this.lastRagSyncAt = Date.now();
      this.ragSyncInFlight = false;
    }
  }

  async checkSystemHealth() {
    const checkPath = async (fsPath, label) => {
      const stats = await statfs(fsPath);
      const freeGiB = (stats.bavail * stats.bsize) / 1024 ** 3;

      if (freeGiB < 10) {
        const msg = `🚨 *SYSTEM LOCKDOWN*\nAvailable ${label} space dropped to \`${freeGiB.toFixed(2)} GB\`.\nLocalClaw has paused to prevent system failure.`;
        this.logger.error({ freeGiB, fsPath }, `SYSTEM_LOCKDOWN: ${label} space critical`);
        if (this.notifier) await this.notifier.sendNotification(msg);
        await this.stop({
          status: 'paused',
          reason: `Disk space critical (<10GB on ${label}: ${fsPath})`,
        });
        throw new Error('SYSTEM_LOCKDOWN');
      }

      if (freeGiB < 25 && this.skillManager && Date.now() - this.lastAutoPruneAt > 6 * 60 * 60 * 1000) {
        this.logger.info({ freeGiB, label }, 'Triggering auto_prune due to low disk space');
        this.lastAutoPruneAt = Date.now();
        // Fire and forget the prune to not block the heartbeat
        this.skillManager.executeSkill({
          name: 'auto_prune',
          input: {},
          workspaceRoot: process.cwd(),
          toolRunner: async (name, args) => {
            // Orchestrator needs to be able to run tools directly for system maintenance
            // For now, we use a minimal runner for builtin maintenance skills
            if (name === 'system_prune') {
              const { createToolRegistry } = await import('./tools/registry.js');
              const registry = createToolRegistry({ skillManager: this.skillManager });
              return registry.runTool(name, args, { workspaceRoot: process.cwd() });
            }
            throw new Error(`Orchestrator skill runner does not support tool: ${name}`);
          }
        }).catch(err => {
          this.logger.warn({ err }, 'Auto-prune skill execution failed');
        });
      }

      if (freeGiB < 20) {
        this.logger.warn({ freeGiB, fsPath }, `SPACE_WARNING: ${label} space low`);
        if (this.notifier && !this.lastSpaceWarningAt || Date.now() - this.lastSpaceWarningAt > 3600000) {
          await this.notifier.sendNotification(`⚠️ *SPACE WARNING*\nAvailable ${label} space is low: \`${freeGiB.toFixed(2)} GB\`.`);
          this.lastSpaceWarningAt = Date.now();
        }
      }
    };

    try {
      await checkPath(config.ssdBasePath, 'External SSD');
      await checkPath('/', 'Internal Mac Drive');
    } catch (err) {
      if (err.message === 'SYSTEM_LOCKDOWN') throw err;
      this.logger.warn({ err }, 'Failed to check system health statfs');
    }
  }

  async runSelfReflectionIfDue(force = false) {
    if (!this.reflectionEngine) return;
    if (this.reflectionInFlight) return;
    
    const now = Date.now();
    // Run every 4 hours or customizable. 
    if (!force && now - this.lastReflectionAt < 4 * 60 * 60 * 1000) return;

    this.reflectionInFlight = true;
    try {
      await this.reflectionEngine.runReflectionCycle();
    } catch (error) {
      this.logger.error({ err: error }, 'Self-reflection cycle failed');
    } finally {
      this.lastReflectionAt = Date.now();
      this.reflectionInFlight = false;
    }
  }

  async recoverInterruptedTasks() {
    const result = await this.callPostgresTool(
      'recover_interrupted_tasks',
      {},
      () =>
        this.pool.query(
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
        )
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
    const result = await this.callPostgresTool(
      'count_pending_tasks',
      {},
      () =>
        this.pool.query(
          `SELECT COUNT(*)::int AS count
           FROM tasks
           WHERE status = 'pending'`
        )
    );

    return result.rows[0]?.count ?? 0;
  }

  async leaseNextTask() {
    const result = await this.callPostgresTool(
      'lease_next_task',
      { instanceId: this.instanceId },
      async () => {
        const client = await this.pool.connect();

        try {
          await client.query('BEGIN');

          const selected = await client.query(
            `SELECT id, title, description, priority, project_name, project_path, chat_session_id
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

          const task = selected.rows[0];
          if (!task) {
            await client.query('COMMIT');
            return { rows: [] };
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
          return { rows: updated.rows };
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      }
    );

    return result.rows[0] ?? null;
  }

  async executeTask(task) {
    if (!this.taskExecutor) {
      throw new Error('Task executor is not configured');
    }

    this.logger.info({ taskId: task.id, title: task.title }, 'Executing task');
    this.updateTaskRuntime(task.id, {
      phase: 'preparing',
      phaseLabel: 'Preparing workspace',
      detail: 'Loading retrieval context and bootstrapping the local workspace.',
      currentModel: null,
      modelRole: null,
      usage: null,
      checklist: [],
      counts: {
        completed: 0,
        total: 0,
      },
      currentStep: null,
      summary: null,
    });

    try {
      const { retrievalContext, chatHistory } = await this.buildRetrievalContext(task);
      const result = await this.taskExecutor.executeTask(task, {
        startStepNumber: 2,
        publisher: this.publisher,
        deployer: this.deployer,
        retrievalContext,
        chatHistory,
        logStep: async (step) => {
          await this.logTaskStep(task.id, step);
          await this.touchTaskLease(task.id);
        },
        runtimeUpdate: (snapshot) => {
          this.updateTaskRuntime(task.id, snapshot);
        },
      });

      if (result.status === 'needs_repair') {
        await this.queueRepairApproval(task, result);
        return;
      }

      await this.persistArtifacts(task.id, result.artifacts ?? []);
      await this.persistLearnings(task, result);
      await this.enqueueSpecializedFollowUpTasks(task, result.specializedReview?.followUpTasks ?? []);

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
          this.updateTaskRuntime(task.id, {
            phase: 'blocked',
            phaseLabel: 'Deployment target mismatch',
            detail: deploymentTargetCheck.error,
            currentModel: null,
            modelRole: null,
            currentStep: null,
          });

          return;
        }

        this.updateTaskRuntime(task.id, {
          phase: 'waiting_approval',
          phaseLabel: 'Awaiting deploy approval',
          detail: 'Execution passed verification and is waiting for deployment approval.',
          currentModel: null,
          modelRole: null,
          currentStep: null,
        });
        await this.queueDeploymentApproval(task, result);
        return;
      }

      const publishBlocked =
        result.publication?.attempted === true &&
        result.publication?.published === false;

      const taskStatus = publishBlocked
        ? 'blocked'
        : deriveFinalReviewStatus(result);

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
          taskStatus === 'blocked' ? deriveBlockedReason(result) : null,
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
      this.updateTaskRuntime(task.id, {
        phase:
          taskStatus === 'done'
            ? 'complete'
            : taskStatus === 'blocked'
              ? 'blocked'
              : 'failed',
        phaseLabel:
          taskStatus === 'done'
            ? 'Done'
            : taskStatus === 'blocked'
              ? 'Blocked'
              : 'Failed',
        detail:
          taskStatus === 'done'
            ? result.verification.review.summary
            : taskStatus === 'blocked'
              ? deriveBlockedReason(result)
              : result.verification.review.summary,
        currentModel: result.verification.modelUsed ?? null,
        modelRole: result.verification.modelUsed ? 'verifier' : null,
        checklist: buildChecklistFromPlan(result.plan?.steps ?? [], {
          completedCount: (result.plan?.steps ?? []).length,
        }),
        counts: {
          completed: (result.plan?.steps ?? []).length,
          total: (result.plan?.steps ?? []).length,
        },
        currentStep: null,
        summary: result.plan?.summary ?? null,
      });

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
      this.updateTaskRuntime(task.id, {
        phase: 'failed',
        phaseLabel: 'Failed',
        detail: error.message,
        currentModel: null,
        modelRole: null,
        currentStep: null,
      });

      await this.incrementStats('tasks_failed');
      throw error;
    } finally {
      await this.setAgentStateValue('current_task_id', null);
    }
  }

  async enqueueSpecializedFollowUpTasks(task, followUpTasks = []) {
    const postgresServer = this.getPostgresMcpServer();

    for (const followUpTask of followUpTasks) {
      const existing = postgresServer
        ? await postgresServer.callTool('find_active_task_by_title', {
            title: followUpTask.title,
            source: followUpTask.source ?? 'phase10_dependency_agent',
          })
        : await this.pool.query(
            `SELECT id
             FROM tasks
             WHERE title = $1
               AND source = $2
               AND status IN ('pending', 'leased', 'in_progress', 'blocked', 'waiting_approval')
             LIMIT 1`,
            [followUpTask.title, followUpTask.source ?? 'phase10_dependency_agent']
          );

      if (existing.rows.length > 0) {
        continue;
      }

      const createdTask = await this.createTask(followUpTask.description, {
        title: followUpTask.title,
        priority: followUpTask.priority ?? 'medium',
        source: followUpTask.source ?? 'phase10_dependency_agent',
        projectName: followUpTask.projectName ?? task.project_name ?? null,
        projectPath: followUpTask.projectPath ?? task.project_path ?? null,
      });

      await this.logTaskStep(task.id, {
        stepNumber: 950,
        stepType: 'review',
        status: 'success',
        outputSummary: `Dependency follow-up task created: ${createdTask.id}`,
      });
    }
  }

  setNotifier(notifier) {
    this.notifier = notifier;
  }

  async buildRetrievalContext(task) {
    const queryText = `${task.title} ${task.description}`.trim();
    const keywords = extractKeywords(queryText);
    const postgresServer = this.getPostgresMcpServer();

    try {
      const learningResult =
        keywords.length > 0
          ? postgresServer
            ? await postgresServer.callTool('search_learnings', {
                keywords,
                limit: 5,
              })
            : await this.pool.query(
                `SELECT id, category, observation, confidence_score
                 FROM learnings
                 WHERE keywords && $1::text[]
                 ORDER BY times_applied DESC, confidence_score DESC, created_at DESC
                 LIMIT 5`,
                [keywords]
              )
          : { rows: [] };

      const keywordChunkResult =
        keywords.length > 0
          ? postgresServer
            ? await postgresServer.callTool('search_document_chunks', {
                keywords: keywords.slice(0, 6),
                limit: 4,
              })
            : await this.pool.query(
                `SELECT
                   LEFT(document_chunks.content, 280) AS content,
                   documents.title,
                   documents.source_path
                 FROM document_chunks
                 JOIN documents ON documents.id = document_chunks.document_id
                 WHERE document_chunks.content ILIKE ANY($1::text[])
                 ORDER BY document_chunks.created_at DESC
                 LIMIT 4`,
                [keywords.slice(0, 6).map((keyword) => `%${keyword}%`)]
              )
          : { rows: [] };

      const semanticChunks = this.ragRetriever?.retrieveRelevantDocumentChunks
        ? await this.ragRetriever.retrieveRelevantDocumentChunks(queryText, {
            topK: 4,
            candidateLimit: 260,
          })
        : [];

      const documentChunkMap = new Map();
      for (const chunk of [...keywordChunkResult.rows, ...semanticChunks]) {
        const key = `${chunk.source_path ?? ''}:${chunk.content ?? ''}`;
        if (!documentChunkMap.has(key)) {
          documentChunkMap.set(key, chunk);
        }
      }

      const documentChunks = [...documentChunkMap.values()].slice(0, 6);
      const suggestedSkills = this.skillManager?.suggestSkillsForTask
        ? await this.skillManager.suggestSkillsForTask(task, { limit: 4 })
        : [];
      const graphContext = this.knowledgeGraph?.retrieveRelevantContext
        ? await this.knowledgeGraph.retrieveRelevantContext(queryText, {
            limit: 6,
            relationshipLimit: 10,
            changeLimit: 5,
            learningLimit: 4,
          })
        : null;
      const impactAnalysis = this.knowledgeGraph?.analyzeImpact
        ? await this.knowledgeGraph.analyzeImpact(queryText, {
            graphContext,
            limit: 6,
            relationshipLimit: 10,
            changeLimit: 5,
            learningLimit: 4,
          })
        : null;

      const context = formatRetrievedContext(
        learningResult.rows,
        documentChunks,
        suggestedSkills,
        graphContext,
        impactAnalysis
      );

      let chatHistory = null;
      if (this.chatHistoryManager && task.chat_session_id) {
        const history = await this.chatHistoryManager.getHistory(task.chat_session_id);
        chatHistory = this.chatHistoryManager.formatForPrompt(history);
      }

      try {
        await this.bumpLearningUsage(
          learningResult.rows.map((row) => row.id).filter(Boolean)
        );
      } catch (error) {
        this.logger.warn(
          { err: error, taskId: task.id },
          'Failed to update learning usage counters'
        );
      }

      return {
        retrievalContext: context.length > 0 ? context : null,
        chatHistory
      };
    } catch (error) {
      this.logger.warn({ err: error, taskId: task.id }, 'Failed to retrieve Phase 5/14 context');
      return { retrievalContext: null, chatHistory: null };
    }
  }

  async bumpLearningUsage(learningIds) {
    if (!Array.isArray(learningIds) || learningIds.length === 0) {
      return;
    }

    const deduplicated = [...new Set(learningIds)].filter(Boolean);
    if (deduplicated.length === 0) {
      return;
    }

    const postgresServer = this.getPostgresMcpServer();
    if (postgresServer) {
      await postgresServer.callTool('bump_learning_usage', {
        learningIds: deduplicated,
      });
      return;
    }

    await this.pool.query(
      `UPDATE learnings
       SET times_applied = times_applied + 1
       WHERE id = ANY($1::uuid[])`,
      [deduplicated]
    );
  }

  getMcpStatus() {
    if (!this.mcpRegistry) {
      return {
        servers: [],
      };
    }

    return {
      servers: this.mcpRegistry.listAllTools(),
    };
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
        await this.callPostgresTool(
          'insert_learning',
          {
            taskId: task.id,
            category: learning.category ?? 'execution',
            observation: learning.observation,
            keywords: Array.isArray(learning.keywords) ? learning.keywords : [],
            confidenceScore: Number.isFinite(learning.confidenceScore)
              ? Math.max(1, Math.min(10, Math.round(learning.confidenceScore)))
              : 6,
          },
          () =>
            this.pool.query(
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
            )
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

  async listSkills(options = {}) {
    if (!this.skillManager?.listSkills) {
      return [];
    }

    return this.skillManager.listSkills(options);
  }

  async setSkillEnabled(name, enabled) {
    if (!this.skillManager?.setSkillEnabled) {
      throw new Error('Skill manager is not configured');
    }

    return this.skillManager.setSkillEnabled(name, enabled);
  }

  async queueDeploymentApproval(task, result) {
    const target = this.deployer.getTarget();
    const approvalResult = await this.callPostgresTool(
      'insert_approval',
      {
        taskId: task.id,
        approvalType: 'railway_deploy',
        status: 'pending',
        requestedVia: 'telegram',
        responsePayload: {
          repoUrl: result.publication.repo.htmlUrl,
          target,
        },
      },
      () =>
        this.pool.query(
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
        )
    );

    const approval = approvalResult.rows[0];
    const deploymentResult = await this.callPostgresTool(
      'insert_deployment',
      {
        taskId: task.id,
        provider: 'railway',
        targetEnv: target.environmentName,
        repoUrl: result.publication.repo.htmlUrl,
        status: 'approval_pending',
        approvalId: approval.id,
        projectId: target.projectId,
        environmentId: target.environmentId,
        serviceId: target.serviceId,
      },
      () =>
        this.pool.query(
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
        )
    );

    await this.callPostgresTool(
      'update_task_record',
      {
        taskId: task.id,
        patch: {
          status: 'waiting_approval',
          project_name: result.publication.repo.name,
          project_path: result.workspaceRoot,
          repo_url: result.publication.repo.htmlUrl,
          result,
          clear_blocked_reason: true,
          clear_lock: true,
          touch_heartbeat: true,
        },
      },
      () =>
        this.pool.query(
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
        )
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
      await this.callPostgresTool(
        'update_approval_request_message',
        {
          approvalId: approval.id,
          requestMessageId: sentMessage.message_id.toString(),
        },
        () =>
          this.pool.query(
            `UPDATE approvals
             SET request_message_id = $2
             WHERE id = $1`,
            [approval.id, sentMessage.message_id.toString()]
          )
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

  async queueRepairApproval(task, result) {
    const approvalResult = await this.callPostgresTool(
      'insert_approval',
      {
        taskId: task.id,
        approvalType: 'repair',
        status: 'pending',
        requestedVia: 'telegram',
        responsePayload: {
          repairProposal: result.repairProposal,
        },
      },
      () =>
        this.pool.query(
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
            'repair',
            JSON.stringify({
              repairProposal: result.repairProposal,
            }),
          ]
        )
    );

    const approval = approvalResult.rows[0];

    await this.callPostgresTool(
      'update_task_record',
      {
        taskId: task.id,
        patch: {
          status: 'waiting_approval',
          result,
          clear_blocked_reason: true,
          clear_lock: true,
          touch_heartbeat: true,
        },
      },
      () =>
        this.pool.query(
          `UPDATE tasks
           SET
             status = 'waiting_approval',
             blocked_reason = NULL,
             result = $2::jsonb,
             updated_at = NOW(),
             locked_by = NULL,
             lease_expires_at = NULL,
             last_heartbeat_at = NOW()
           WHERE id = $1`,
          [task.id, JSON.stringify(result)]
        )
    );

    await this.logTaskStep(task.id, {
      stepNumber: 910,
      stepType: 'approval',
      status: 'success',
      inputSummary: result.repairProposal.summary,
      outputSummary: `Repair approval requested: ${approval.id}`,
    });

    const stepsText = result.repairProposal.steps.map(s => `- ${s.objective} (${s.tool})`).join('\n');
    const message = [
      `🛠 *REPAIR PROPOSAL*`,
      `Task: ${task.title}`,
      `Error: ${result.repairProposal.reasoning}`,
      `Proposed Fix:`,
      stepsText,
      `Approve: /approve_repair ${approval.id}`,
      `Reject: /reject_repair ${approval.id}`,
    ].join('\n');

    const sentMessage = await this.notify(message, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: 'Approve Repair',
              callback_data: `approval:approve_repair:${approval.id}`,
            },
            {
              text: 'Reject Repair',
              callback_data: `approval:reject_repair:${approval.id}`,
            },
          ],
        ],
      },
    });

    if (sentMessage?.message_id) {
      await this.callPostgresTool(
        'update_approval_request_message',
        {
          approvalId: approval.id,
          requestMessageId: sentMessage.message_id.toString(),
        },
        () =>
          this.pool.query(
            `UPDATE approvals
             SET request_message_id = $2
             WHERE id = $1`,
            [approval.id, sentMessage.message_id.toString()]
          )
      );
    }

    this.logger.info(
      {
        taskId: task.id,
        approvalId: approval.id,
      },
      'Repair approval requested'
    );
  }

  async resumeWithRepair(taskId, approvalId) {
    // This will be implemented in the next step to trigger re-execution
    this.logger.info({ taskId, approvalId }, 'Resuming task with repair');
  }

  async processReadyRepairs() {
    const result = await this.callPostgresTool(
      'list_ready_repairs',
      {},
      () =>
        this.pool.query(
          `SELECT
             approvals.id AS approval_id,
             approvals.task_id,
             approvals.response_payload->'repairProposal' AS repair_proposal,
             tasks.title,
             tasks.result AS task_result
           FROM approvals
           JOIN tasks ON tasks.id = approvals.task_id
           WHERE approvals.status = 'approved'
             AND approvals.approval_type = 'repair'
             AND tasks.status = 'waiting_approval'
           ORDER BY approvals.requested_at ASC`
        )
    );

    for (const row of result.rows) {
      await this.startApprovedRepair(row);
    }
  }

  async startApprovedRepair(row) {
    const task = {
      id: row.task_id,
      title: row.title,
      // ... other task fields needed for executor
    };

    this.logger.info({ taskId: row.task_id }, 'Starting approved repair');

    // Update task status back to in_progress
    await this.callPostgresTool(
      'update_task_record',
      {
        taskId: row.task_id,
        patch: {
          status: 'in_progress',
          locked_by: this.instanceId,
          lease_expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
          touch_heartbeat: true,
        },
      },
      () =>
        this.pool.query(
          `UPDATE tasks
           SET
             status = 'in_progress',
             locked_by = $2,
             lease_expires_at = NOW() + INTERVAL '15 minutes',
             last_heartbeat_at = NOW(),
             updated_at = NOW()
           WHERE id = $1`,
          [row.task_id, this.instanceId]
        )
    );

    // Update approval status to 'applied' or similar
    await this.pool.query(
      `UPDATE approvals SET status = 'applied' WHERE id = $1`,
      [row.approval_id]
    );

    // Trigger execution with repair steps
    const taskObj = { id: row.task_id, promise: null };
    taskObj.promise = this.executeTaskWithRepair(row).finally(() => {
      this.activeTasks.delete(taskObj);
    });
    this.activeTasks.add(taskObj);
  }

  async executeTaskWithRepair(row) {
    const task = {
      id: row.task_id,
      title: row.title,
      description: row.task_result.plan.summary, // Use plan summary or original description
      result: row.task_result,
    };

    this.logger.info({ taskId: task.id }, 'Executing repair steps');

    try {
      // 1. Apply repair steps
      const repairProposal = row.repair_proposal;
      const workspaceRoot = row.task_result.workspaceRoot;

      for (const step of repairProposal.steps) {
        await this.logTaskStep(task.id, {
          stepNumber: 911,
          stepType: 'repair',
          toolCalled: step.tool,
          status: 'started',
          inputSummary: step.objective,
        });

        const toolResult = await this.taskExecutor.toolRegistry.runTool(step.tool, step.args, {
          workspaceRoot,
          taskId: task.id,
        });

        await this.logTaskStep(task.id, {
          stepNumber: 911,
          stepType: 'repair',
          toolCalled: step.tool,
          status: 'success',
          outputSummary: toolResult.summary,
        });
      }

      // 2. Resume original task
      // For now, we just re-run the whole task. 
      // A more sophisticated implementation would resume from the failed step.
      const taskRecord = (await this.pool.query('SELECT * FROM tasks WHERE id = $1', [task.id])).rows[0];
      await this.executeTask(taskRecord);
    } catch (error) {
      this.logger.error({ err: error, taskId: task.id }, 'Repair failed');
      await this.logTaskStep(task.id, {
        stepNumber: 911,
        stepType: 'repair',
        status: 'error',
        errorMessage: error.message,
      });
      await this.pool.query(
        `UPDATE tasks SET status = 'failed', blocked_reason = $2 WHERE id = $1`,
        [task.id, `Repair failed: ${error.message}`]
      );
    }
  }

  async listPendingApprovals(limit = 10) {
    const result = await this.callPostgresTool(
      'list_pending_approvals',
      { limit },
      () =>
        this.pool.query(
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
             AND approvals.approval_type IN ('railway_deploy', 'repair')
           ORDER BY approvals.requested_at ASC
           LIMIT $1`,
          [limit]
        )
    );

    return result.rows;
  }

  async approveApproval(approvalId, options = {}) {
    const payload = {
      respondedVia: options.respondedVia ?? 'telegram',
      note: options.note ?? null,
    };

    const approvalResult = await this.callPostgresTool(
      'respond_to_approval',
      {
        approvalId,
        status: 'approved',
        mergeResponsePayload: payload,
      },
      () =>
        this.pool.query(
          `UPDATE approvals
           SET
             status = 'approved',
             responded_at = NOW(),
             response_payload = COALESCE(response_payload, '{}'::jsonb) || $2::jsonb
           WHERE id = $1
             AND status = 'pending'
           RETURNING id, task_id`,
          [approvalId, JSON.stringify(payload)]
        )
    );

    const approval = approvalResult.rows[0];
    if (!approval) {
      return null;
    }

    await this.callPostgresTool(
      'update_deployments_by_approval',
      {
        approvalId,
        patch: {
          status: 'approved',
          clear_last_error: true,
        },
      },
      () =>
        this.pool.query(
          `UPDATE deployments
           SET
             status = 'approved',
             updated_at = NOW(),
             last_error = NULL
           WHERE approval_id = $1
             AND status = 'approval_pending'`,
          [approvalId]
        )
    );

    return approval;
  }

  async rejectApproval(approvalId, options = {}) {
    const reason = options.reason ?? 'Rejected via Telegram';
    const payload = {
      respondedVia: options.respondedVia ?? 'telegram',
      reason,
    };

    const approvalResult = await this.callPostgresTool(
      'respond_to_approval',
      {
        approvalId,
        status: 'rejected',
        mergeResponsePayload: payload,
      },
      () =>
        this.pool.query(
          `UPDATE approvals
           SET
             status = 'rejected',
             responded_at = NOW(),
             response_payload = COALESCE(response_payload, '{}'::jsonb) || $2::jsonb
           WHERE id = $1
             AND status = 'pending'
           RETURNING id, task_id`,
          [approvalId, JSON.stringify(payload)]
        )
    );

    const approval = approvalResult.rows[0];
    if (!approval) {
      return null;
    }

    await this.callPostgresTool(
      'update_deployments_by_approval',
      {
        approvalId,
        patch: {
          status: 'rejected',
          last_error: reason,
          touch_completed_at: true,
        },
      },
      () =>
        this.pool.query(
          `UPDATE deployments
           SET
             status = 'rejected',
             last_error = $2,
             updated_at = NOW(),
             completed_at = NOW()
           WHERE approval_id = $1`,
          [approvalId, reason]
        )
    );

    await this.callPostgresTool(
      'update_task_record',
      {
        taskId: approval.task_id,
        patch: {
          status: 'blocked',
          blocked_reason: reason,
          clear_lock: true,
          touch_heartbeat: true,
        },
      },
      () =>
        this.pool.query(
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
        )
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

    const result = await this.callPostgresTool(
      'list_ready_deployments',
      {},
      () =>
        this.pool.query(
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
        )
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

      await this.callPostgresTool(
        'update_deployment_record',
        {
          deploymentId: row.deployment_id,
          patch: {
            status: 'deploying',
            remote_deployment_id: remoteDeploymentId,
            clear_last_error: true,
          },
        },
        () =>
          this.pool.query(
            `UPDATE deployments
             SET
               status = 'deploying',
               remote_deployment_id = $2,
               updated_at = NOW(),
               last_error = NULL
             WHERE id = $1`,
            [row.deployment_id, remoteDeploymentId]
          )
      );

      await this.callPostgresTool(
        'update_task_record',
        {
          taskId: row.task_id,
          patch: {
            status: 'in_progress',
            locked_by: this.instanceId,
            clear_blocked_reason: true,
            lease_expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
            touch_heartbeat: true,
          },
        },
        () =>
          this.pool.query(
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
          )
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

    const result = await this.callPostgresTool(
      'list_active_deployments',
      {},
      () =>
        this.pool.query(
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
        )
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
        await this.callPostgresTool(
          'update_deployment_record',
          {
            deploymentId: row.deployment_id,
            patch: {
              deploy_url: snapshot.url ?? null,
            },
          },
          () =>
            this.pool.query(
              `UPDATE deployments
               SET
                 deploy_url = COALESCE($2, deploy_url),
                 updated_at = NOW()
               WHERE id = $1`,
              [row.deployment_id, snapshot.url]
            )
        );
        return;
      }

      const logSnapshot = await this.captureDeploymentLogs(row.remote_deployment_id);

      if (snapshot.state === 'success') {
        await this.callPostgresTool(
          'update_deployment_record',
          {
            deploymentId: row.deployment_id,
            patch: {
              status: 'success',
              deploy_url: snapshot.url ?? null,
              log_snapshot: logSnapshot,
              clear_last_error: true,
              touch_completed_at: true,
            },
          },
          () =>
            this.pool.query(
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
            )
        );

        await this.callPostgresTool(
          'update_task_record',
          {
            taskId: row.task_id,
            patch: {
              status: 'done',
              clear_blocked_reason: true,
              touch_completed_at: true,
              clear_lock: true,
              touch_heartbeat: true,
            },
          },
          () =>
            this.pool.query(
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
            )
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

    await this.callPostgresTool(
      'update_deployment_record',
      {
        deploymentId: row.deployment_id,
        patch: {
          status: 'deploying',
          remote_deployment_id: remoteDeploymentId,
          last_error: 'retrying_after_failed_no_logs',
        },
      },
      () =>
        this.pool.query(
          `UPDATE deployments
           SET
             status = 'deploying',
             remote_deployment_id = $2,
             last_error = 'retrying_after_failed_no_logs',
             updated_at = NOW()
           WHERE id = $1`,
          [row.deployment_id, remoteDeploymentId]
        )
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
    await this.callPostgresTool(
      'update_deployment_record',
      {
        deploymentId,
        patch: {
          status: 'failed',
          last_error: errorMessage,
          log_snapshot: logSnapshot,
          touch_completed_at: true,
        },
      },
      () =>
        this.pool.query(
          `UPDATE deployments
           SET
             status = 'failed',
             last_error = $2,
             log_snapshot = COALESCE($3, log_snapshot),
             updated_at = NOW(),
             completed_at = NOW()
           WHERE id = $1`,
          [deploymentId, errorMessage, logSnapshot]
        )
    );

    await this.callPostgresTool(
      'update_task_record',
      {
        taskId,
        patch: {
          status: 'failed',
          blocked_reason: errorMessage,
          clear_lock: true,
          touch_heartbeat: true,
        },
      },
      () =>
        this.pool.query(
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
        )
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
      await this.callPostgresTool(
        'insert_task_artifact',
        {
          taskId,
          artifactType: artifact.artifactType,
          artifactPath: artifact.artifactPath,
          metadata: artifact.metadata ?? {},
        },
        () =>
          this.pool.query(
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
          )
      );
    }
  }

  async touchTaskLease(taskId) {
    await this.callPostgresTool(
      'touch_task_lease',
      { taskId },
      () =>
        this.pool.query(
          `UPDATE tasks
           SET
             lease_expires_at = NOW() + INTERVAL '5 minutes',
             last_heartbeat_at = NOW(),
             updated_at = NOW()
           WHERE id = $1`,
          [taskId]
        )
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
    await this.callPostgresTool(
      'insert_agent_log',
      {
        taskId,
        stepNumber: step.stepNumber,
        stepType: step.stepType,
        modelUsed: step.modelUsed ?? null,
        toolCalled: step.toolCalled ?? null,
        status: step.status,
        inputSummary: step.inputSummary ?? null,
        outputSummary: step.outputSummary ?? null,
        durationMs: step.durationMs ?? null,
        errorMessage: step.errorMessage ?? null,
      },
      () =>
        this.pool.query(
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
        )
    );
  }

  async getAgentStateValue(key, fallback = null) {
    const result = await this.callPostgresTool(
      'get_agent_state',
      { key },
      () =>
        this.pool.query('SELECT value FROM agent_state WHERE state_key = $1', [key])
    );

    if (result.rows.length === 0) {
      return fallback;
    }

    return result.rows[0].value;
  }

  async setAgentStateValue(key, value) {
    await this.callPostgresTool(
      'upsert_agent_state',
      { key, value },
      () =>
        this.pool.query(
          `INSERT INTO agent_state (state_key, value, updated_at)
           VALUES ($1, $2::jsonb, NOW())
           ON CONFLICT (state_key)
           DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
          [key, JSON.stringify(value)]
        )
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

  async createPlannedTask(contract, options = {}) {
    if (!this.taskExecutor?.previewTaskPlan) {
      throw new Error('Task executor preview mode is not configured');
    }

    const source = options.source ?? 'control_api';
    const title = buildTaskTitleFromContract(contract);
    const description = buildTaskDescriptionFromContract(contract);

    const inserted = await this.callPostgresTool(
      'create_task',
      {
        title,
        description,
        priority: contract.priority,
        source,
        projectName: contract.projectName,
        projectPath: options.projectPath ?? null,
        chatSessionId: options.chatSessionId ?? null,
        status: 'pending',
      },
      () =>
        this.pool.query(
          `INSERT INTO tasks (
             title,
             description,
             priority,
             source,
             project_name,
             project_path,
             chat_session_id,
             status
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
           RETURNING id, title, description, status, priority, source, created_at`,
          [
            title,
            description,
            contract.priority,
            source,
            contract.projectName,
            options.projectPath ?? null,
            options.chatSessionId ?? null,
          ]
        )
    );

    const task = inserted.rows[0];
    const workspaceName = `${slugifyTaskTitle(task.title) || 'task'}-${task.id.slice(0, 8)}`;
    const workspaceRoot = path.join(config.ssdBasePath, 'workspace', workspaceName);

    try {
      const retrievalContext = await this.buildRetrievalContext(task);
      const impactAnalysis = this.knowledgeGraph?.analyzeImpact
        ? await this.knowledgeGraph.analyzeImpact(`${task.title} ${task.description}`.trim(), {
            limit: 6,
            relationshipLimit: 10,
            changeLimit: 5,
            learningLimit: 4,
          })
        : null;
      const planning = await this.taskExecutor.previewTaskPlan(task, {
        workspaceRoot,
        workspaceSnapshot: [],
        retrievalContext,
      });
      const requestedAt = new Date().toISOString();

      const resultPayload = {
        taskContract: contract,
        preExecutionPlan: {
          status: 'pending',
          requested_at: requestedAt,
          responded_at: null,
          responded_via: null,
          workspace_root: workspaceRoot,
          model_used: planning.modelUsed,
          repaired: planning.repaired === true,
          fallback: planning.fallback === true,
          impact_analysis: impactAnalysis,
          plan: planning.plan,
        },
      };

      await this.callPostgresTool(
        'update_task_record',
        {
          taskId: task.id,
          patch: {
            status: 'waiting_approval',
            project_name: contract.projectName,
            project_path: options.projectPath ?? workspaceRoot,
            result: resultPayload,
            clear_blocked_reason: true,
            clear_lock: true,
            touch_heartbeat: true,
          },
        },
        () =>
          this.pool.query(
            `UPDATE tasks
             SET
               status = 'waiting_approval',
               project_name = COALESCE(project_name, $2),
               project_path = COALESCE($3, project_path),
               blocked_reason = NULL,
               result = $4::jsonb,
               updated_at = NOW(),
               locked_by = NULL,
               lease_expires_at = NULL,
               last_heartbeat_at = NOW()
             WHERE id = $1`,
            [
              task.id,
              contract.projectName,
              options.projectPath ?? workspaceRoot,
              JSON.stringify(resultPayload),
            ]
          )
      );

      await this.persistArtifacts(task.id, [
        {
          artifactType: 'task_contract_v1',
          artifactPath: `task://${task.id}/task_contract_v1`,
          metadata: { contract },
        },
        {
          artifactType: 'plan_preview',
          artifactPath: `task://${task.id}/plan_preview`,
          metadata: {
            summary: planning.plan.summary,
            modelUsed: planning.modelUsed,
            repaired: planning.repaired === true,
            fallback: planning.fallback === true,
          },
        },
      ]);

      await this.logTaskStep(task.id, {
        stepNumber: 1,
        stepType: 'plan',
        modelUsed: planning.modelUsed,
        status: 'success',
        inputSummary: task.title,
        outputSummary: planning.plan.summary,
        durationMs: planning.durationMs,
      });

      await this.logTaskStep(task.id, {
        stepNumber: 2,
        stepType: 'approval',
        status: 'success',
        outputSummary: 'Execution approval requested via control API',
      });

      return {
        task: {
          id: task.id,
          title: task.title,
          status: 'waiting_approval',
          priority: task.priority,
          source: task.source,
          project_name: contract.projectName,
          created_at: task.created_at,
        },
        plan: planning.plan,
        planner: {
          modelUsed: planning.modelUsed,
          repaired: planning.repaired === true,
          fallback: planning.fallback === true,
        },
        memory: {
          impactAnalysis,
        },
      };
    } catch (error) {
      await this.callPostgresTool(
        'update_task_record',
        {
          taskId: task.id,
          patch: {
            status: 'failed',
            blocked_reason: error.message,
            clear_lock: true,
            touch_heartbeat: true,
          },
        },
        () =>
          this.pool.query(
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
          )
      );

      await this.logTaskStep(task.id, {
        stepNumber: 999,
        stepType: 'system',
        status: 'error',
        outputSummary: null,
        errorMessage: error.message,
      });

      throw error;
    }
  }

  async approveTaskExecution(taskId, options = {}) {
    const result = await this.callPostgresTool(
      'get_task_by_id',
      { taskId, view: 'detail' },
      () =>
        this.pool.query(
          `SELECT id, status, result
           FROM tasks
           WHERE id = $1`,
          [taskId]
        )
    );

    const task = result.rows[0];
    const planState = task?.result?.preExecutionPlan;
    if (
      !task ||
      task.status !== 'waiting_approval' ||
      !planState ||
      planState.status !== 'pending'
    ) {
      return null;
    }

    const respondedAt = new Date().toISOString();
    const nextResult = {
      ...(task.result ?? {}),
      preExecutionPlan: {
        ...planState,
        status: 'approved',
        responded_at: respondedAt,
        responded_via: options.respondedVia ?? 'control_api',
        note: options.note ?? null,
      },
    };

    await this.callPostgresTool(
      'update_task_record',
      {
        taskId,
        patch: {
          status: 'pending',
          result: nextResult,
          clear_blocked_reason: true,
          clear_lock: true,
          touch_heartbeat: true,
        },
      },
      () =>
        this.pool.query(
          `UPDATE tasks
           SET
             status = 'pending',
             blocked_reason = NULL,
             result = $2::jsonb,
             updated_at = NOW(),
             locked_by = NULL,
             lease_expires_at = NULL,
             last_heartbeat_at = NOW()
           WHERE id = $1`,
          [taskId, JSON.stringify(nextResult)]
        )
    );

    await this.logTaskStep(taskId, {
      stepNumber: 3,
      stepType: 'approval',
      status: 'success',
      outputSummary: 'Execution approved; task returned to pending queue',
    });

    return {
      task_id: taskId,
      status: 'approved',
      responded_at: respondedAt,
    };
  }

  async rejectTaskExecution(taskId, options = {}) {
    const result = await this.callPostgresTool(
      'get_task_by_id',
      { taskId, view: 'detail' },
      () =>
        this.pool.query(
          `SELECT id, status, result
           FROM tasks
           WHERE id = $1`,
          [taskId]
        )
    );

    const task = result.rows[0];
    const planState = task?.result?.preExecutionPlan;
    if (
      !task ||
      task.status !== 'waiting_approval' ||
      !planState ||
      planState.status !== 'pending'
    ) {
      return null;
    }

    const reason = options.reason ?? 'Execution rejected via control API';
    const respondedAt = new Date().toISOString();
    const nextResult = {
      ...(task.result ?? {}),
      preExecutionPlan: {
        ...planState,
        status: 'rejected',
        responded_at: respondedAt,
        responded_via: options.respondedVia ?? 'control_api',
        reason,
      },
    };

    await this.callPostgresTool(
      'update_task_record',
      {
        taskId,
        patch: {
          status: 'blocked',
          blocked_reason: reason,
          result: nextResult,
          clear_lock: true,
          touch_heartbeat: true,
        },
      },
      () =>
        this.pool.query(
          `UPDATE tasks
           SET
             status = 'blocked',
             blocked_reason = $2,
             result = $3::jsonb,
             updated_at = NOW(),
             locked_by = NULL,
             lease_expires_at = NULL,
             last_heartbeat_at = NOW()
           WHERE id = $1`,
          [taskId, reason, JSON.stringify(nextResult)]
        )
    );

    await this.logTaskStep(taskId, {
      stepNumber: 3,
      stepType: 'approval',
      status: 'error',
      outputSummary: null,
      errorMessage: reason,
    });

    return {
      task_id: taskId,
      status: 'rejected',
      reason,
      responded_at: respondedAt,
    };
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

    const result = await this.callPostgresTool(
      'create_task',
      {
        title,
        description: trimmedDescription,
        priority: options.priority ?? 'medium',
        source: options.source ?? 'telegram',
        projectName: options.projectName ?? null,
        projectPath: options.projectPath ?? null,
      },
      () =>
        this.pool.query(
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
        )
    );

    return result.rows[0];
  }

  async listTasks(limit = 10) {
    const result = await this.callPostgresTool(
      'list_active_tasks',
      { limit },
      () =>
        this.pool.query(
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
        )
    );

    return result.rows;
  }

  async getTaskDetails(taskId, options = {}) {
    const taskResult = await this.callPostgresTool(
      'get_task_by_id',
      { taskId, view: 'detail' },
      () =>
        this.pool.query(
          `SELECT
             id,
             title,
             description,
             priority,
             status,
             source,
             project_name,
             project_path,
             repo_url,
             blocked_reason,
             result,
             created_at,
             started_at,
             completed_at,
             updated_at
           FROM tasks
           WHERE id = $1`,
          [taskId]
        )
    );

    const task = taskResult.rows[0];
    if (!task) {
      return null;
    }

    const logLimit =
      Number.isInteger(options.logLimit) && options.logLimit > 0
        ? Math.min(options.logLimit, 300)
        : 120;
    const logsResult = await this.callPostgresTool(
      'list_task_logs',
      {
        taskId,
        limit: logLimit,
        order: 'asc',
      },
      () =>
        this.pool.query(
          `SELECT
             step_number,
             step_type,
             model_used,
             tool_called,
             status,
             input_summary,
             output_summary,
             duration_ms,
             error_message,
             created_at
           FROM agent_logs
           WHERE task_id = $1
           ORDER BY created_at ASC
           LIMIT $2`,
          [taskId, logLimit]
        )
    );

    return {
      task,
      logs: logsResult.rows,
      runtime: mergeRuntimeSnapshots(
        derivePersistedRuntime(task, logsResult.rows),
        this.liveTaskRuntime.get(taskId) ?? null
      ),
    };
  }

  updateTaskRuntime(taskId, patch = {}) {
    const previous = this.liveTaskRuntime.get(taskId) ?? {};
    const timestamp = new Date().toISOString();
    const next = {
      ...previous,
      ...patch,
      startedAt: previous.startedAt ?? patch.startedAt ?? timestamp,
      updatedAt: timestamp,
    };

    if (!next.counts && Array.isArray(next.checklist)) {
      next.counts = {
        completed: next.checklist.filter((item) => item.status === 'completed').length,
        total: next.checklist.length,
      };
    }

    this.liveTaskRuntime.set(taskId, next);
    if (this.liveTaskRuntime.size > 200) {
      const oldestKey = this.liveTaskRuntime.keys().next().value;
      if (oldestKey) {
        this.liveTaskRuntime.delete(oldestKey);
      }
    }

    return next;
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
      statusCounts,
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
        this.callPostgresTool(
          'get_status_counts',
          {},
          async () => {
            const [queueResult, deploymentResult, approvalResult] = await Promise.all([
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

            return {
              queue: queueResult.rows[0] ?? null,
              deployments: deploymentResult.rows[0] ?? null,
              approvals: approvalResult.rows[0] ?? null,
            };
          }
        ),
      ]);

    const taskResult = currentTaskId
      ? await this.callPostgresTool(
          'get_task_by_id',
          { taskId: currentTaskId, view: 'summary' },
          () =>
            this.pool.query(
              `SELECT id, title, status, priority, started_at
               FROM tasks
               WHERE id = $1`,
              [currentTaskId]
            )
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
      queue: statusCounts.queue ?? {
        pending_count: 0,
        in_progress_count: 0,
        blocked_count: 0,
        waiting_approval_count: 0,
      },
      deployments: {
        deploying_count: statusCounts.deployments?.deploying_count ?? 0,
      },
      approvals: {
        pending_count: statusCounts.approvals?.pending_count ?? 0,
      },
      currentTask: taskResult.rows[0] ?? null,
      instanceId: this.instanceId,
      pollIntervalMs: this.pollIntervalMs,
    };
  }
}
