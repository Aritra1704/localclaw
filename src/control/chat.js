import { z } from 'zod';

import {
  actorSchema,
  actorModelRole,
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

const CHAT_MODEL_TIMEOUT_MS = 20000;
const CHAT_SUMMARY_STATE_VERSION = 'chat_summary_v1';
const EXECUTION_APPROVAL_PHRASES = new Set([
  'yes',
  'yes start it',
  'yes start this',
  'yes run it',
  'yes run this',
  'yep',
  'yeah',
  'go ahead',
  'go ahead start it',
  'go ahead start this',
  'start',
  'start it',
  'start this',
  'start now',
  'run it',
  'run this',
  'run now',
  'execute it',
  'execute this',
  'approve it',
  'approve this',
  'proceed',
  'continue',
  'do it',
  'ship it',
]);
const EXECUTION_REQUEST_PATTERNS = [
  /^(?:please\s+)?(?:can you\s+|could you\s+|would you\s+)?(?:create|build|implement|set up|setup|scaffold|generate|write|draft|fix|update|add|remove|refactor|rename|move|delete|start)\b/i,
  /^(?:please\s+)?(?:i need you to|need you to|help me)\s+(?:create|build|implement|set up|setup|scaffold|generate|write|draft|fix|update|add|remove|refactor|rename|move|delete|start)\b/i,
];
const TARGET_HINT_PATTERN =
  /(?:\.[a-z0-9]{1,8}\b|\/[a-z0-9_.-]+|\b(?:readme|package\.json|dockerfile|ui|api|page|component|route|endpoint|schema|table|migration|query|test|frontend|backend|database|react|node|typescript|python|markdown)\b)/i;
const VAGUE_OBJECTIVE_PATTERN =
  /\b(?:fix it|update it|make it better|do it|handle it|something|stuff|thing|this|that)\b/i;
const LIST_SPLIT_PATTERN = /\s*(?:\||\n)\s*/;

function compact(value, limit = 4000) {
  const text = `${value ?? ''}`.trim();
  return text.length > limit ? `${text.slice(0, limit - 3)}...` : text;
}

function buildMessageExcerpt(content, limit = 220) {
  return compact(`${content ?? ''}`.replace(/\s+/g, ' '), limit);
}

function normalizeListItem(item) {
  return `${item ?? ''}`
    .replace(/^[\-\*\d\.\)\s]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function dedupeList(items) {
  const seen = new Set();
  const result = [];

  for (const item of items) {
    const normalized = normalizeListItem(item);
    if (!normalized) {
      continue;
    }
    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(normalized);
  }

  return result;
}

function matchPreferencePattern(content, patternGroups) {
  for (const group of patternGroups) {
    if (group.pattern.test(content)) {
      return {
        value: group.value,
        source: group.source ?? 'explicit',
        confidence: group.confidence ?? 0.95,
      };
    }
  }

  return null;
}

function extractChatPreferences(messages) {
  const userMessages = messages
    .filter((message) => message.role === 'user')
    .slice(-20)
    .reverse();
  const preferences = {};

  const explicitPreferenceMatchers = {
    verbosity: [
      {
        pattern: /\b(concise|brief|short|quick summary|quick answer|tldr|just the answer)\b/i,
        value: 'concise',
        confidence: 0.98,
      },
      {
        pattern: /\b(detailed|detail|thorough|comprehensive|deep dive|in depth|more detail)\b/i,
        value: 'detailed',
        confidence: 0.98,
      },
    ],
    explanationDepth: [
      {
        pattern: /\b(no explanation|don't explain|do not explain|just the code|code only)\b/i,
        value: 'low',
        confidence: 0.98,
      },
      {
        pattern: /\b(explain why|teach me|walk me through|show me why|show your reasoning|explain the reasoning)\b/i,
        value: 'high',
        confidence: 0.98,
      },
    ],
    planningStyle: [
      {
        pattern: /\b(step by step|steps|numbered steps|checklist|plan steps|give me the steps)\b/i,
        value: 'stepwise',
        confidence: 0.96,
      },
      {
        pattern: /\b(brainstorm|talk it through|discuss first|think with me|explore options)\b/i,
        value: 'conversational',
        confidence: 0.96,
      },
    ],
  };

  for (const message of userMessages) {
    const content = `${message.content ?? ''}`;

    for (const [dimension, patterns] of Object.entries(explicitPreferenceMatchers)) {
      if (preferences[dimension]) {
        continue;
      }

      const match = matchPreferencePattern(content, patterns);
      if (match) {
        preferences[dimension] = {
          ...match,
          evidence: buildMessageExcerpt(content, 160),
        };
      }
    }
  }

  if (!preferences.interactionMode) {
    const latestExecutionRequest = userMessages.find((message) =>
      isExecutionTaskRequest(message.content)
    );
    if (latestExecutionRequest) {
      preferences.interactionMode = {
        value: 'execution_oriented',
        source: 'inferred',
        confidence: 0.72,
        evidence: buildMessageExcerpt(latestExecutionRequest.content, 160),
      };
    }
  }

  if (!preferences.interactionMode) {
    const latestDiscussionRequest = userMessages.find((message) =>
      /\b(brainstorm|discuss|talk through|explore options|what do you think)\b/i.test(
        `${message.content ?? ''}`
      )
    );
    if (latestDiscussionRequest) {
      preferences.interactionMode = {
        value: 'discussion_oriented',
        source: 'inferred',
        confidence: 0.68,
        evidence: buildMessageExcerpt(latestDiscussionRequest.content, 160),
      };
    }
  }

  return preferences;
}

function findLatestExecutionRequestIndex(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (isExecutionTaskRequest(messages[index]?.content)) {
      return index;
    }
  }

  return -1;
}

function countWords(text) {
  return `${text ?? ''}`
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

function buildDraftObjective(messages, previousDraft = null, explicitObjective = null) {
  if (explicitObjective?.trim()) {
    return explicitObjective.trim();
  }

  const userMessages = messages.filter((message) => message.role === 'user');
  if (userMessages.length === 0) {
    return previousDraft?.contract?.objective ?? previousDraft?.objective ?? null;
  }

  const latestExecutionIndex = findLatestExecutionRequestIndex(userMessages);
  if (latestExecutionIndex >= 0) {
    const baseObjective = `${userMessages[latestExecutionIndex]?.content ?? ''}`.trim();
    const followUps = userMessages
      .slice(latestExecutionIndex + 1)
      .map((message) => `${message.content ?? ''}`.trim())
      .filter((content) => content && !isExecutionApprovalIntent(content));

    if (followUps.length > 0) {
      return compact(`${baseObjective}\n\nAdditional context: ${followUps.join(' | ')}`, 1800);
    }

    return baseObjective;
  }

  if (previousDraft?.pendingClarification && (previousDraft?.contract?.objective || previousDraft?.objective)) {
    const latestUserMessage = `${userMessages.at(-1)?.content ?? ''}`.trim();
    if (latestUserMessage) {
      return compact(
        `${previousDraft.contract?.objective ?? previousDraft.objective}\n\nAdditional context: ${latestUserMessage}`,
        1800
      );
    }
  }

  return null;
}

function getRelevantDraftMessages(messages) {
  const userMessages = messages
    .filter((message) => message.role === 'user')
    .map((message) => `${message.content ?? ''}`.trim())
    .filter(Boolean);
  const latestExecutionIndex = findLatestExecutionRequestIndex(
    userMessages.map((content) => ({ content }))
  );
  if (latestExecutionIndex >= 0) {
    return userMessages.slice(latestExecutionIndex);
  }
  return userMessages;
}

function splitDirectiveSegments(content) {
  return `${content ?? ''}`
    .split(/\s*(?:;|\n)\s*/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseListDirective(content, cuePattern) {
  const match = `${content ?? ''}`.trim().match(cuePattern);
  if (!match?.[1]) {
    return [];
  }

  return dedupeList(match[1].split(LIST_SPLIT_PATTERN));
}

function inferPriority(messages, previousPriority = 'medium') {
  for (const content of [...messages].reverse()) {
    if (/\b(?:critical|sev1|p0)\b/i.test(content)) {
      return 'critical';
    }
    if (/\b(?:urgent|high priority|p1)\b/i.test(content)) {
      return 'high';
    }
    if (/\b(?:low priority|whenever|not urgent|p3)\b/i.test(content)) {
      return 'low';
    }
    if (/\b(?:medium priority|normal priority|p2)\b/i.test(content)) {
      return 'medium';
    }
  }

  return previousPriority;
}

function inferRepoIntent(messages, previousIntent = { publish: false, deploy: false }) {
  const intent = { ...previousIntent };

  for (const content of messages) {
    if (/\b(?:deploy it|ship it|push to prod|release it)\b/i.test(content)) {
      intent.deploy = true;
    }
    if (/\b(?:do not deploy|don't deploy|without deploy|no deploy)\b/i.test(content)) {
      intent.deploy = false;
    }
    if (/\b(?:publish it|open a pr|create a pr|push it|commit it)\b/i.test(content)) {
      intent.publish = true;
    }
    if (/\b(?:do not publish|don't publish|without publish|no pr|no publish)\b/i.test(content)) {
      intent.publish = false;
    }
  }

  return intent;
}

function buildContractRefinements(messages, previousDraft = null) {
  const relevantMessages = getRelevantDraftMessages(messages);
  const directiveSegments = relevantMessages.flatMap((content) => splitDirectiveSegments(content));
  const previousContract = previousDraft?.contract ?? null;

  const inScope = [
    ...(previousContract?.inScope ?? []),
    ...directiveSegments.flatMap((content) =>
      parseListDirective(
        content,
        /\b(?:include|also include|in scope|scope includes|add scope)\s*:?\s*(.+)$/i
      )
    ),
  ];
  const outOfScope = [
    ...(previousContract?.outOfScope ?? []),
    ...directiveSegments.flatMap((content) =>
      parseListDirective(
        content,
        /\b(?:out of scope|do not touch|don't touch|exclude|skip)\s*:?\s*(.+)$/i
      )
    ),
  ];
  const constraints = [
    ...(previousContract?.constraints ?? []),
    ...directiveSegments.flatMap((content) =>
      parseListDirective(
        content,
        /\b(?:constraints?|must|need to|use|keep|without)\s*:?\s*(.+)$/i
      )
    ),
  ];
  const successCriteria = [
    ...(previousContract?.successCriteria ?? []),
    ...directiveSegments.flatMap((content) =>
      parseListDirective(
        content,
        /\b(?:success means|done when|acceptance criteria|success criteria|make sure|ensure)\s*:?\s*(.+)$/i
      )
    ),
  ];
  const skillHints = [
    ...(previousContract?.skillHints ?? []),
    ...directiveSegments.flatMap((content) =>
      parseListDirective(content, /\b(?:skill hint|skill hints|use skill)\s*:?\s*(.+)$/i)
    ),
  ];

  return {
    inScope: dedupeList(inScope),
    outOfScope: dedupeList(outOfScope),
    constraints: dedupeList(constraints),
    successCriteria: dedupeList(successCriteria),
    skillHints: dedupeList(skillHints),
    priority: inferPriority(relevantMessages, previousContract?.priority ?? 'medium'),
    repoIntent: inferRepoIntent(relevantMessages, previousContract?.repoIntent ?? undefined),
  };
}

function assessDraftReadiness(session, objective) {
  const missingContext = [];
  const wordCount = countWords(objective);
  const normalized = `${objective ?? ''}`.trim();

  if (
    wordCount < 8 ||
    (wordCount < 14 && VAGUE_OBJECTIVE_PATTERN.test(normalized))
  ) {
    missingContext.push('requested_change');
  }

  if (!session.project_path && !TARGET_HINT_PATTERN.test(normalized)) {
    missingContext.push('target_area');
  }

  return {
    readyForPlanning: missingContext.length === 0,
    missingContext,
  };
}

function buildClarificationQuestion(session, draftState) {
  const prompts = [];
  for (const key of draftState?.missingContext ?? []) {
    if (key === 'requested_change') {
      prompts.push('What exactly should I change or create?');
    }

    if (key === 'target_area') {
      prompts.push(
        session.project_path
          ? 'Which file, component, or subsystem should this apply to?'
          : 'Which project, file, or component should this apply to?'
      );
    }
  }

  if (prompts.length === 0) {
    prompts.push('What should success look like when this task is done?');
  }

  return [
    'I can turn this into an approval-gated task, but I need a bit more detail before planning safely.',
    '',
    ...prompts.map((prompt, index) => `${index + 1}. ${prompt}`),
    draftState?.contract?.objective || draftState?.objective
      ? `\nCurrent draft objective: ${draftState.contract?.objective ?? draftState.objective}`
      : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function buildContractDraftState({ session, messages, previousSummaryState = null, explicitObjective = null }) {
  const previousDraft = previousSummaryState?.contractDraft ?? null;
  const objective = buildDraftObjective(messages, previousDraft, explicitObjective);
  if (!objective) {
    return null;
  }
  const readiness = assessDraftReadiness(session, objective);
  const refinements = buildContractRefinements(messages, previousDraft);
  const contract =
    objective.trim().length >= 10
      ? buildDraftContract({
          session,
          messages,
          objective,
          refinements,
        })
      : null;

  return {
    objective,
    contract,
    readyForPlanning: readiness.readyForPlanning,
    pendingClarification: !readiness.readyForPlanning,
    missingContext: readiness.missingContext,
    clarificationQuestion: readiness.readyForPlanning
      ? null
      : buildClarificationQuestion(session, {
          contract,
          missingContext: readiness.missingContext,
        }),
    objectiveSource: explicitObjective ? 'explicit' : 'conversation',
    lastRefinedAt: new Date().toISOString(),
  };
}

function buildChatSummaryState({ session, messages, previousSummaryState = null, explicitObjective = null }) {
  const userMessages = messages.filter((message) => message.role === 'user');
  const latestUserMessages = userMessages.slice(-4);
  const latestRequest = latestUserMessages.at(-1)?.content ?? '';
  const previousContext = latestUserMessages
    .slice(0, -1)
    .map((message) => buildMessageExcerpt(message.content, 180));
  const summary = compact(
    latestRequest
      ? [
          `Latest request: ${buildMessageExcerpt(latestRequest, 320)}`,
          previousContext.length > 0 ? `Recent context: ${previousContext.join(' | ')}` : '',
        ]
          .filter(Boolean)
          .join('\n')
      : '',
    1200
  );

  return {
    version: CHAT_SUMMARY_STATE_VERSION,
    summary,
    highlights: latestUserMessages.map((message) => buildMessageExcerpt(message.content, 180)),
    preferences: extractChatPreferences(messages),
    contractDraft: buildContractDraftState({
      session,
      messages,
      previousSummaryState,
      explicitObjective,
    }),
    messageCount: messages.length,
    updatedAt: new Date().toISOString(),
  };
}

function formatChatPreferencePrompt(summaryState) {
  const preferences = summaryState?.preferences;
  if (!preferences || Object.keys(preferences).length === 0) {
    return 'Operator preferences: none captured yet';
  }

  const entries = Object.entries(preferences).map(([name, value]) => {
    const confidence =
      typeof value?.confidence === 'number' ? `${Math.round(value.confidence * 100)}%` : 'n/a';
    return `${name}=${value?.value ?? 'unknown'} (${value?.source ?? 'unknown'}, ${confidence})`;
  });

  return `Operator preferences: ${entries.join('; ')}`;
}

function buildFallbackChatResponse({ actor, userMessage, projectPath }) {
  const projectLine = projectPath ? `\nProject: ${projectPath}` : '';
  return compact(
    `I can help as ${actor}. I will discuss and plan safely without executing anything until you explicitly approve a task.${projectLine}\n\nNext useful step: tell me the objective, constraints, and success criteria, or ask me to draft a task plan.\n\nYour message: ${userMessage}`,
    2000
  );
}

function buildGreetingResponse({ actor, projectPath }) {
  const projectLine = projectPath ? `\nProject: ${projectPath}` : '';
  return `Hi. I am LocalClaw in ${actor} mode.${projectLine}

I can discuss, review, plan, draft a task contract, or create an approval-gated execution plan. I will not execute anything until you explicitly approve it.`;
}

function isExecutionApprovalIntent(message) {
  const normalized = `${message ?? ''}`
    .toLowerCase()
    .replace(/[^a-z0-9\s-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return EXECUTION_APPROVAL_PHRASES.has(normalized);
}

function isExecutionTaskRequest(message) {
  const normalized = `${message ?? ''}`.trim();
  if (!normalized || normalized.startsWith('/')) {
    return false;
  }

  if (isExecutionApprovalIntent(normalized)) {
    return false;
  }

  return EXECUTION_REQUEST_PATTERNS.some((pattern) => pattern.test(normalized));
}

function formatPlanForChat(plan) {
  const lines = [];
  const summary = `${plan?.summary ?? ''}`.trim();
  if (summary) {
    lines.push(`Plan: ${summary}`);
  }

  const steps = Array.isArray(plan?.steps) ? plan.steps : [];
  if (steps.length > 0) {
    lines.push('Steps:');
    for (const step of steps) {
      lines.push(
        `${step?.stepNumber ?? '?'}. ${`${step?.objective ?? 'No objective'}`.trim()} [${`${step?.tool ?? 'unspecified'}`.trim()}]`
      );
    }
  }

  return lines.join('\n');
}

function buildPlannedTaskChatResponse({ task, plan, autoPlannedFromChat = false }) {
  const header = autoPlannedFromChat
    ? 'I turned that request into an approval-gated task.'
    : 'Plan created and waiting for execution approval.';
  const lines = [header, '', `Task: ${task.id}`];
  const formattedPlan = formatPlanForChat(plan);
  if (formattedPlan) {
    lines.push(formattedPlan);
  }
  lines.push(
    'Execution has not started yet. Use /approve, the chat approval control, or reply "yes, start it" to begin.'
  );
  return lines.join('\n');
}

function buildDraftContract({ session, messages, objective, refinements = {} }) {
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
    inScope: dedupeList([
      'Analyze the requested work',
      'Prepare a safe implementation plan',
      'Make only changes required by the approved task',
      ...(refinements.inScope ?? []),
    ]).slice(0, 20),
    outOfScope: dedupeList([
      'Unrelated refactors',
      'Unapproved deployment',
      'Bypassing approval gates',
      ...(refinements.outOfScope ?? []),
    ]).slice(0, 20),
    constraints: dedupeList([
      'Use the selected project path only',
      'Keep changes reviewable',
      'Ask for approval before execution',
      ...(refinements.constraints ?? []),
    ]).slice(0, 20),
    successCriteria: dedupeList([
      'Plan is explicit and executable',
      'Tests or verification steps are identified',
      'Operator approval is required before execution',
      ...(refinements.successCriteria ?? []),
    ]).slice(0, 20),
    priority: refinements.priority ?? 'medium',
    skillHints: dedupeList(refinements.skillHints ?? []).slice(0, 12),
    repoIntent: refinements.repoIntent ?? {
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
    formatChatPreferencePrompt(session.summary_state),
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
  mcpRegistry = null,
}) {
  if (!pool) {
    throw new Error('Chat service requires a database pool');
  }

  const postgresServer = mcpRegistry?.getServer?.('postgres') ?? null;

  async function callPostgresTool(toolName, args, fallback) {
    if (postgresServer) {
      return postgresServer.callTool(toolName, args);
    }
    return fallback();
  }

  async function listMessages(sessionId, limit = 40) {
    const result = await callPostgresTool(
      'list_chat_messages',
      { sessionId, limit },
      () =>
        pool.query(
          `SELECT id, session_id, role, actor, content, metadata, created_at
           FROM chat_messages
           WHERE session_id = $1
           ORDER BY created_at DESC
           LIMIT $2`,
          [sessionId, limit]
        )
    );

    return result.rows.reverse();
  }

  async function listTasksForSession(sessionId, limit = 20) {
    const result = await callPostgresTool(
      'list_tasks_by_chat_session',
      {
        sessionId,
        limit,
      },
      () =>
        pool.query(
          `SELECT id, title, status, priority, created_at, updated_at
           FROM tasks
           WHERE chat_session_id = $1
           ORDER BY created_at DESC
           LIMIT $2`,
          [sessionId, limit]
        )
    );

    return result.rows;
  }

  async function getSessionRow(sessionId) {
    const result = await callPostgresTool(
      'get_chat_session',
      { sessionId },
      () =>
        pool.query(
          `SELECT
             chat_sessions.id,
             chat_sessions.title,
             chat_sessions.actor,
             chat_sessions.project_target_id,
             chat_sessions.project_path,
             chat_sessions.summary,
             chat_sessions.summary_state,
             chat_sessions.status,
             chat_sessions.created_at,
             chat_sessions.updated_at,
             project_targets.name AS project_name
           FROM chat_sessions
           LEFT JOIN project_targets ON project_targets.id = chat_sessions.project_target_id
           WHERE chat_sessions.id = $1`,
          [sessionId]
        )
    );

    return result.rows[0] ?? null;
  }

  async function insertMessage({ sessionId, role, actor = null, content, metadata = {} }) {
    const result = await callPostgresTool(
      'insert_chat_message',
      { sessionId, role, actor, content, metadata },
      () =>
        pool.query(
          `INSERT INTO chat_messages (session_id, role, actor, content, metadata)
           VALUES ($1, $2, $3, $4, $5::jsonb)
           RETURNING id, session_id, role, actor, content, metadata, created_at`,
          [sessionId, role, actor, content, JSON.stringify(metadata)]
        )
    );

    await callPostgresTool(
      'touch_chat_session',
      { sessionId },
      () => pool.query(`UPDATE chat_sessions SET updated_at = NOW() WHERE id = $1`, [sessionId])
    );

    return result.rows[0];
  }

  async function updateSummary(session, messages) {
    const summaryState = buildChatSummaryState({
      session,
      messages,
      previousSummaryState: session.summary_state,
    });
    const summary = summaryState.summary;

    await callPostgresTool(
      'update_chat_summary',
      {
        sessionId: session.id,
        summary,
        summaryState,
      },
      () =>
        pool.query(
          `UPDATE chat_sessions
           SET summary = $2, summary_state = $3::jsonb, updated_at = NOW()
           WHERE id = $1`,
          [session.id, summary, JSON.stringify(summaryState)]
        )
    );

    await callPostgresTool(
      'insert_chat_summary',
      {
        sessionId: session.id,
        summary,
        summaryState,
        messageCount: messages.length,
      },
      () =>
        pool.query(
          `INSERT INTO chat_summaries (session_id, summary, summary_state, message_count)
           VALUES ($1, $2, $3::jsonb, $4)`,
          [session.id, summary, JSON.stringify(summaryState), messages.length]
        )
    );

    return summary;
  }

  async function createPlannedTaskMessage({
    session,
    sessionId,
    actor,
    objective,
    contract: providedContract = null,
    autoPlannedFromChat = false,
  }) {
    const messages = await listMessages(sessionId);
    const contract =
      providedContract ??
      buildDraftContract({
        session,
        messages,
        objective,
      });
    const planned = await orchestrator.createPlannedTask(contract, {
      source: autoPlannedFromChat ? 'chat_auto_plan' : 'chat',
      chatSessionId: sessionId,
      projectPath: session.project_path,
    });
    const assistant = await insertMessage({
      sessionId,
      role: 'assistant',
      actor,
      content: buildPlannedTaskChatResponse({
        task: planned.task,
        plan: planned.plan,
        autoPlannedFromChat,
      }),
      metadata: {
        taskId: planned.task.id,
        taskStatus: planned.task.status,
        plan: planned.plan,
        draftContract: contract,
        executionPending: true,
        autoPlannedFromChat,
      },
    });

    await updateSummary(session, [...messages, assistant]);

    return {
      planned,
      assistant,
    };
  }

  async function generateAssistantResponse({ session, actor, messages, userMessage }) {
    if (/^(hi|hello|hey|yo|hola)$/i.test(userMessage.trim())) {
      return buildGreetingResponse({
        actor,
        projectPath: session.project_path,
      });
    }

    if (!llmClient?.generate || !modelSelector?.selectWithFallback) {
      return buildFallbackChatResponse({
        actor,
        userMessage,
        projectPath: session.project_path,
      });
    }

    const modelRole = actorModelRole(actor);
    const models = modelSelector.selectWithFallback(modelRole);
    let lastError = null;

    for (const model of models) {
      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort();
      }, CHAT_MODEL_TIMEOUT_MS);

      try {
        const response = await llmClient.generate({
          model,
          system: actorSystemPrompt(actor),
          prompt: await buildChatPrompt({ session, messages, userMessage }),
          temperature: 0.2,
          signal: controller.signal,
        });

        return compact(response.responseText, 8000);
      } catch (error) {
        lastError = error;
        logger?.warn?.({ err: error, model, actor }, 'Chat model failed; trying fallback');
      } finally {
        clearTimeout(timer);
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

      const result = await callPostgresTool(
        'insert_chat_session',
        {
          title,
          actor,
          projectTargetId: project?.id ?? null,
          projectPath: project?.root_path ?? null,
        },
        () =>
          pool.query(
            `INSERT INTO chat_sessions (title, actor, project_target_id, project_path)
             VALUES ($1, $2, $3, $4)
             RETURNING id, title, actor, project_target_id, project_path, summary, summary_state, status, created_at, updated_at`,
            [title, actor, project?.id ?? null, project?.root_path ?? null]
          )
      );

      return result.rows[0];
    },

    async listSessions(limit = 30) {
      const result = await callPostgresTool(
        'list_chat_sessions',
        {
          limit: Math.min(Math.max(Number(limit) || 30, 1), 100),
        },
        () =>
          pool.query(
            `SELECT
               chat_sessions.id,
               chat_sessions.title,
               chat_sessions.actor,
               chat_sessions.project_path,
               chat_sessions.summary,
               chat_sessions.summary_state,
               chat_sessions.status,
               chat_sessions.created_at,
               chat_sessions.updated_at,
               project_targets.name AS project_name
             FROM chat_sessions
             LEFT JOIN project_targets ON project_targets.id = chat_sessions.project_target_id
             ORDER BY chat_sessions.updated_at DESC
             LIMIT $1`,
            [Math.min(Math.max(Number(limit) || 30, 1), 100)]
          )
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
        listTasksForSession(sessionId, 20),
      ]);

      return {
        session,
        messages,
        tasks,
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
      const sessionTasks = await listTasksForSession(sessionId, 20);
      const pendingExecutionTasks = sessionTasks.filter(
        (task) => task.status === 'waiting_approval'
      );
      const conversationSummaryState = buildChatSummaryState({
        session: {
          ...session,
          actor,
        },
        messages,
        previousSummaryState: session.summary_state,
      });
      const activeDraft = conversationSummaryState.contractDraft ?? null;

      if (isExecutionApprovalIntent(parsed.content)) {
        if (pendingExecutionTasks.length === 1) {
          const pendingTask = pendingExecutionTasks[0];
          const approved = await orchestrator.approveTaskExecution(pendingTask.id, {
            respondedVia: 'chat',
            note: `Approved from natural-language chat reply in session ${sessionId}`,
          });

          if (approved) {
            const assistant = await insertMessage({
              sessionId,
              role: 'assistant',
              actor,
              content: `Execution approved for task ${pendingTask.id}. Work is now in progress. Use /status ${pendingTask.id} if you want another snapshot.`,
              metadata: {
                taskId: pendingTask.id,
                executionApproval: approved,
                autoApprovedFromChat: true,
              },
            });

            await updateSummary(session, [...messages, assistant]);

            return {
              user,
              assistant,
            };
          }
        } else {
          const content =
            pendingExecutionTasks.length > 1
              ? `I found ${pendingExecutionTasks.length} tasks waiting for execution approval in this chat. Please approve one explicitly with /approve <task-id> or /status <task-id> first.`
              : 'There is no task waiting for execution approval in this chat yet. Create one with /plan first.';
          const assistant = await insertMessage({
            sessionId,
            role: 'assistant',
            actor,
            content,
            metadata: {
              conservativeExecution: true,
              approvalIntentDetected: true,
            },
          });

          await updateSummary(session, [...messages, assistant]);

          return {
            user,
            assistant,
          };
        }
      }

      if (
        pendingExecutionTasks.length === 0 &&
        (isExecutionTaskRequest(parsed.content) || session.summary_state?.contractDraft?.pendingClarification)
      ) {
        if (activeDraft?.readyForPlanning && activeDraft.contract) {
          const { assistant } = await createPlannedTaskMessage({
            session: {
              ...session,
              actor,
              summary_state: conversationSummaryState,
            },
            sessionId,
            actor,
            objective: activeDraft.contract.objective,
            contract: activeDraft.contract,
            autoPlannedFromChat: true,
          });

          return {
            user,
            assistant,
          };
        }

        const assistant = await insertMessage({
          sessionId,
          role: 'assistant',
          actor,
          content:
            activeDraft?.clarificationQuestion ??
            'I need a bit more detail before I can turn this into an approval-gated task.',
          metadata: {
            conservativeExecution: true,
            clarificationRequested: true,
            draftContract: activeDraft?.contract ?? null,
            missingContext: activeDraft?.missingContext ?? ['requested_change'],
          },
        });

        await updateSummary(
          {
            ...session,
            actor,
            summary_state: conversationSummaryState,
          },
          [...messages, assistant]
        );

        return {
          user,
          assistant,
        };
      }

      const content = await generateAssistantResponse({
        session: {
          ...session,
          actor,
          summary_state: conversationSummaryState,
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

      await updateSummary(
        {
          ...session,
          actor,
          summary_state: conversationSummaryState,
        },
        [...messages, assistant]
      );

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
      const draftState = buildContractDraftState({
        session,
        messages,
        previousSummaryState: session.summary_state,
        explicitObjective: parsed.objective,
      });
      const contract =
        draftState?.contract ??
        buildDraftContract({
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
          draftReadyForPlanning: draftState?.readyForPlanning ?? true,
          missingContext: draftState?.missingContext ?? [],
        },
      });

      return { contract };
    },

    async planTask(sessionId, input = {}) {
      const session = await getSessionRow(sessionId);
      if (!session) {
        return null;
      }

      if (input.contract) {
        const messages = await listMessages(sessionId);
        const planned = await orchestrator.createPlannedTask(normalizeTaskContract(input.contract), {
          source: 'chat',
          chatSessionId: sessionId,
          projectPath: session.project_path,
        });

        const assistant = await insertMessage({
          sessionId,
          role: 'assistant',
          actor: session.actor,
          content: buildPlannedTaskChatResponse({
            task: planned.task,
            plan: planned.plan,
          }),
          metadata: {
            taskId: planned.task.id,
            taskStatus: planned.task.status,
            plan: planned.plan,
            executionPending: true,
          },
        });

        await updateSummary(session, [...messages, assistant]);
        return planned;
      }

      const messages = await listMessages(sessionId);
      const draftState = buildContractDraftState({
        session,
        messages,
        previousSummaryState: session.summary_state,
        explicitObjective: input.objective,
      });

      const { planned } = await createPlannedTaskMessage({
        session,
        sessionId,
        actor: session.actor,
        objective: draftState?.contract?.objective ?? input.objective,
        contract: draftState?.contract ?? null,
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
