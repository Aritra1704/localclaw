import { z } from 'zod';

import {
  actorModelRole,
  actorSchema,
  actorSystemPrompt,
  listActors,
} from './actors.js';
import { normalizeTaskContract } from './taskContract.js';
import { collectWorkspaceSnapshot } from '../tools/registry.js';

const sessionTitleSchema = z.string().trim().min(1).max(160);
const messageSchema = z.string().trim().min(1).max(12000);

const createSessionSchema = z
  .object({
    title: sessionTitleSchema.default('LocalClaw chat'),
    actor: actorSchema.default('architect'),
    projectPath: z.string().trim().min(1).optional(),
  })
  .partial()
  .strict();

const appendMessageSchema = z
  .object({
    content: messageSchema,
    actor: actorSchema.optional(),
  })
  .strict();

const draftTaskSchema = z
  .object({
    objective: z.string().trim().min(1).max(2000).optional(),
    actor: actorSchema.optional(),
  })
  .partial()
  .strict();

function compact(value, limit = 4000) {
  const text = `${value ?? ''}`.trim();
  return text.length > limit ? `${text.slice(0, limit - 3)}...` : text;
}

function buildFallbackChatResponse({ actor, userMessage, projectPath }) {
  const projectLine = projectPath ? `\nProject: ${projectPath}` : '';
  return compact(
    `I can help as ${actor}. I will discuss and plan safely without executing anything until you explicitly approve a task.${projectLine}\n\nNext useful step: tell me the objective, constraints, and success criteria, or ask me to draft a task plan.\n\nYour message: ${userMessage}`,
    2000
  );
}

function buildDraftContract({ session, messages, objective }) {
  const latestUserMessage =
    objective ||
    [...messages]
      .reverse()
      .find((message) => message.role === 'user')
      ?.content ||
    session.title;

  return normalizeTaskContract({
    version: 'task_contract_v1',
    projectName:
      session.project_name ||
      session.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48) ||
      'localclaw-task',
    objective: latestUserMessage,
    inScope: [
      'Analyze the requested work',
      'Prepare a safe implementation plan',
      'Make only changes required by the approved task',
    ],
    outOfScope: ['Unrelated refactors', 'Unapproved deployment', 'Bypassing approval gates'],
    constraints: [
      'Use the selected project path only',
      'Keep changes reviewable',
      'Ask for approval before execution',
    ],
    successCriteria: [
      'Plan is explicit and executable',
      'Tests or verification steps are identified',
      'Operator approval is required before execution',
    ],
    priority: 'medium',
    skillHints: [],
    repoIntent: {
      publish: false,
      deploy: false,
    },
    notes: `Drafted from chat session ${session.id}`,
  });
}

async function buildProjectSnapshot(projectPath) {
  if (!projectPath) {
    return 'No project selected.';
  }

  try {
    const snapshot = await collectWorkspaceSnapshot(projectPath, {
      recursive: true,
      limit: 45,
    });
    if (snapshot.length === 0) {
      return 'Project snapshot is empty.';
    }

    return snapshot
      .map((entry) => `${entry.type === 'directory' ? 'dir ' : 'file'} ${entry.path}`)
      .join('\n');
  } catch (error) {
    return `Project snapshot unavailable: ${error.message}`;
  }
}

async function buildChatPrompt({ session, messages, userMessage }) {
  const projectSnapshot = await buildProjectSnapshot(session.project_path);
  const lines = [
    `Session title: ${session.title}`,
    `Actor: ${session.actor}`,
    session.project_path ? `Project path: ${session.project_path}` : 'Project path: none selected',
    session.summary ? `Session summary: ${session.summary}` : 'Session summary: none yet',
    '',
    'Project snapshot:',
    projectSnapshot,
    '',
    'Recent conversation:',
  ];

  for (const message of messages.slice(-12)) {
    lines.push(`${message.role}: ${message.content}`);
  }

  lines.push('', `Current user message: ${userMessage}`);
  return lines.join('\n');
}

export function createChatService({
  pool,
  projectService,
  orchestrator,
  llmClient = null,
  modelSelector = null,
  logger = null,
}) {
  if (!pool) {
    throw new Error('Chat service requires a database pool');
  }

  async function listMessages(sessionId, limit = 40) {
    const result = await pool.query(
      `SELECT id, session_id, role, actor, content, metadata, created_at
       FROM chat_messages
       WHERE session_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [sessionId, limit]
    );

    return result.rows.reverse();
  }

  async function getSessionRow(sessionId) {
    const result = await pool.query(
      `SELECT
         chat_sessions.id,
         chat_sessions.title,
         chat_sessions.actor,
         chat_sessions.project_target_id,
         chat_sessions.project_path,
         chat_sessions.summary,
         chat_sessions.status,
         chat_sessions.created_at,
         chat_sessions.updated_at,
         project_targets.name AS project_name
       FROM chat_sessions
       LEFT JOIN project_targets ON project_targets.id = chat_sessions.project_target_id
       WHERE chat_sessions.id = $1`,
      [sessionId]
    );

    return result.rows[0] ?? null;
  }

  async function insertMessage({ sessionId, role, actor = null, content, metadata = {} }) {
    const result = await pool.query(
      `INSERT INTO chat_messages (session_id, role, actor, content, metadata)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       RETURNING id, session_id, role, actor, content, metadata, created_at`,
      [sessionId, role, actor, content, JSON.stringify(metadata)]
    );

    await pool.query(
      `UPDATE chat_sessions SET updated_at = NOW() WHERE id = $1`,
      [sessionId]
    );

    return result.rows[0];
  }

  async function updateSummary(session, messages) {
    const userMessages = messages.filter((message) => message.role === 'user');
    const summary = compact(
      userMessages
        .slice(-4)
        .map((message) => message.content)
        .join('\n'),
      1200
    );

    await pool.query(
      `UPDATE chat_sessions
       SET summary = $2, updated_at = NOW()
       WHERE id = $1`,
      [session.id, summary]
    );

    await pool.query(
      `INSERT INTO chat_summaries (session_id, summary, message_count)
       VALUES ($1, $2, $3)`,
      [session.id, summary, messages.length]
    );

    return summary;
  }

  async function generateAssistantResponse({ session, actor, messages, userMessage }) {
    if (!llmClient?.generate || !modelSelector?.selectWithFallback) {
      return buildFallbackChatResponse({
        actor,
        userMessage,
        projectPath: session.project_path,
      });
    }

    const role = actorModelRole(actor);
    const models = modelSelector.selectWithFallback(role);
    let lastError = null;

    for (const model of models) {
      try {
        const response = await llmClient.generate({
          model,
          system: actorSystemPrompt(actor),
          prompt: await buildChatPrompt({ session, messages, userMessage }),
          temperature: 0.2,
        });

        return compact(response.responseText, 8000);
      } catch (error) {
        lastError = error;
        logger?.warn?.({ err: error, model, actor }, 'Chat model failed; trying fallback');
      }
    }

    logger?.warn?.({ err: lastError, actor }, 'All chat models failed; using fallback response');
    return buildFallbackChatResponse({
      actor,
      userMessage,
      projectPath: session.project_path,
    });
  }

  return {
    actors: listActors(),

    async createSession(input = {}) {
      const parsed = createSessionSchema.parse(input);
      const actor = actorSchema.parse(parsed.actor ?? 'architect');
      const project = parsed.projectPath
        ? await projectService.ensureProjectTarget(parsed.projectPath)
        : null;
      const title = sessionTitleSchema.parse(parsed.title ?? 'LocalClaw chat');

      const result = await pool.query(
        `INSERT INTO chat_sessions (title, actor, project_target_id, project_path)
         VALUES ($1, $2, $3, $4)
         RETURNING id, title, actor, project_target_id, project_path, summary, status, created_at, updated_at`,
        [title, actor, project?.id ?? null, project?.root_path ?? null]
      );

      return result.rows[0];
    },

    async listSessions(limit = 30) {
      const result = await pool.query(
        `SELECT
           chat_sessions.id,
           chat_sessions.title,
           chat_sessions.actor,
           chat_sessions.project_path,
           chat_sessions.summary,
           chat_sessions.status,
           chat_sessions.created_at,
           chat_sessions.updated_at,
           project_targets.name AS project_name
         FROM chat_sessions
         LEFT JOIN project_targets ON project_targets.id = chat_sessions.project_target_id
         ORDER BY chat_sessions.updated_at DESC
         LIMIT $1`,
        [Math.min(Math.max(Number(limit) || 30, 1), 100)]
      );

      return result.rows;
    },

    async getSession(sessionId) {
      const session = await getSessionRow(sessionId);
      if (!session) {
        return null;
      }

      const [messages, tasks] = await Promise.all([
        listMessages(sessionId),
        pool.query(
          `SELECT id, title, status, priority, created_at, updated_at
           FROM tasks
           WHERE chat_session_id = $1
           ORDER BY created_at DESC
           LIMIT 20`,
          [sessionId]
        ),
      ]);

      return {
        session,
        messages,
        tasks: tasks.rows,
      };
    },

    async appendMessage(sessionId, input) {
      const parsed = appendMessageSchema.parse(input);
      const session = await getSessionRow(sessionId);
      if (!session) {
        return null;
      }

      const actor = actorSchema.parse(parsed.actor ?? session.actor);
      const user = await insertMessage({
        sessionId,
        role: 'user',
        actor,
        content: parsed.content,
      });
      const messages = await listMessages(sessionId);
      const content = await generateAssistantResponse({
        session: {
          ...session,
          actor,
        },
        actor,
        messages,
        userMessage: parsed.content,
      });
      const assistant = await insertMessage({
        sessionId,
        role: 'assistant',
        actor,
        content,
        metadata: {
          conservativeExecution: true,
        },
      });

      await updateSummary(session, [...messages, assistant]);

      return {
        user,
        assistant,
      };
    },

    async draftTask(sessionId, input = {}) {
      const parsed = draftTaskSchema.parse(input);
      const session = await getSessionRow(sessionId);
      if (!session) {
        return null;
      }

      const messages = await listMessages(sessionId);
      const contract = buildDraftContract({
        session,
        messages,
        objective: parsed.objective,
      });

      await insertMessage({
        sessionId,
        role: 'assistant',
        actor: parsed.actor ?? session.actor,
        content: `Drafted a task contract. It is not queued until you request a plan or approve execution.\n\nObjective: ${contract.objective}`,
        metadata: {
          draftContract: contract,
        },
      });

      return { contract };
    },

    async planTask(sessionId, input = {}) {
      const session = await getSessionRow(sessionId);
      if (!session) {
        return null;
      }

      const contract = input.contract
        ? normalizeTaskContract(input.contract)
        : (await this.draftTask(sessionId, { objective: input.objective })).contract;
      const planned = await orchestrator.createPlannedTask(contract, {
        source: 'chat',
        chatSessionId: sessionId,
        projectPath: session.project_path,
      });

      await insertMessage({
        sessionId,
        role: 'assistant',
        actor: session.actor,
        content: `Plan created and waiting for execution approval.\n\nTask: ${planned.task.id}\nPlan: ${planned.plan.summary}`,
        metadata: {
          taskId: planned.task.id,
          plan: planned.plan,
        },
      });

      return planned;
    },

    async approveTask(sessionId, input = {}) {
      const taskId = z.string().uuid().parse(input.taskId);
      const approved = await orchestrator.approveTaskExecution(taskId, {
        respondedVia: 'chat',
        note: `Approved from chat session ${sessionId}`,
      });

      if (!approved) {
        return null;
      }

      await insertMessage({
        sessionId,
        role: 'assistant',
        actor: input.actor ?? null,
        content: `Execution approved for task ${taskId}.`,
        metadata: {
          taskId,
          executionApproval: approved,
        },
      });

      return approved;
    },
  };
}
