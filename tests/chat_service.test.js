import assert from 'node:assert/strict';
import test from 'node:test';

import { createChatService } from '../src/control/chat.js';

test('chat service uses postgres MCP server for session and message persistence', async () => {
  const calls = [];
  const sessionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const postgresServer = {
    async callTool(toolName, args) {
      calls.push({ toolName, args });

      switch (toolName) {
        case 'insert_chat_session':
          return {
            rows: [
              {
                id: sessionId,
                title: args.title,
                actor: args.actor,
                project_target_id: null,
                project_path: args.projectPath ?? null,
                summary: '',
                summary_state: {},
                status: 'active',
                created_at: '2026-04-16T00:00:00.000Z',
                updated_at: '2026-04-16T00:00:00.000Z',
              },
            ],
          };
        case 'list_chat_sessions':
          return {
            rows: [
              {
                id: sessionId,
                title: 'Demo chat',
                actor: 'architect',
                project_path: null,
                summary: '',
                summary_state: {},
                status: 'active',
                created_at: '2026-04-16T00:00:00.000Z',
                updated_at: '2026-04-16T00:00:00.000Z',
                project_name: null,
              },
            ],
          };
        case 'get_chat_session':
          return {
            rows: [
              {
                id: sessionId,
                title: 'Demo chat',
                actor: 'architect',
                project_target_id: null,
                project_path: null,
                summary: '',
                summary_state: {},
                status: 'active',
                created_at: '2026-04-16T00:00:00.000Z',
                updated_at: '2026-04-16T00:00:00.000Z',
                project_name: null,
              },
            ],
          };
        case 'list_chat_messages':
          return {
            rows: [
              {
                id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
                session_id: sessionId,
                role: 'user',
                actor: 'architect',
                content: 'hello',
                metadata: {},
                created_at: '2026-04-16T00:00:01.000Z',
              },
            ],
          };
        case 'list_tasks_by_chat_session':
          return { rows: [] };
        case 'insert_chat_message':
          return {
            rows: [
              {
                id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
                session_id: sessionId,
                role: args.role,
                actor: args.actor,
                content: args.content,
                metadata: args.metadata ?? {},
                created_at: '2026-04-16T00:00:02.000Z',
              },
            ],
          };
        case 'touch_chat_session':
        case 'update_chat_summary':
        case 'insert_chat_summary':
          return { rows: [{ id: 'ok' }] };
        default:
          throw new Error(`Unexpected MCP tool: ${toolName}`);
      }
    },
  };

  const chatService = createChatService({
    pool: {
      async query() {
        throw new Error('Direct pool.query should not be used in this test');
      },
    },
    projectService: {
      async ensureProjectTarget() {
        return null;
      },
    },
    orchestrator: {},
    mcpRegistry: {
      getServer(name) {
        return name === 'postgres' ? postgresServer : null;
      },
    },
  });

  const session = await chatService.createSession({
    title: 'Demo chat',
    actor: 'architect',
  });
  const sessions = await chatService.listSessions();
  const detail = await chatService.getSession(session.id);
  const appended = await chatService.appendMessage(session.id, {
    content: 'hello',
  });

  assert.equal(session.id, sessionId);
  assert.equal(sessions.length, 1);
  assert.equal(detail.session.id, sessionId);
  assert.equal(appended.user.role, 'user');
  assert.equal(appended.assistant.role, 'assistant');
  assert.deepEqual(
    calls.map((entry) => entry.toolName),
    [
      'insert_chat_session',
      'list_chat_sessions',
      'get_chat_session',
      'list_chat_messages',
      'list_tasks_by_chat_session',
      'get_chat_session',
      'insert_chat_message',
      'touch_chat_session',
      'list_chat_messages',
      'list_tasks_by_chat_session',
      'insert_chat_message',
      'touch_chat_session',
      'update_chat_summary',
      'insert_chat_summary',
    ]
  );
  const updateSummaryCall = calls.find((entry) => entry.toolName === 'update_chat_summary');
  assert.equal(updateSummaryCall.args.summaryState.version, 'chat_summary_v1');
  assert.equal(updateSummaryCall.args.summaryState.summary, 'Latest request: hello');
  assert.equal(updateSummaryCall.args.summaryState.messageCount, 2);
});

test('chat service selects the actor model role instead of forcing fast chat mode', async () => {
  const requestedRoles = [];
  const requestedModels = [];
  const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

  const chatService = createChatService({
    pool: {
      async query(sql, params) {
        if (sql.includes('INSERT INTO chat_sessions')) {
          return {
            rows: [
              {
                id: sessionId,
                title: 'Demo chat',
                actor: 'architect',
                project_target_id: null,
                project_path: null,
                summary: '',
                summary_state: {},
                status: 'active',
                created_at: '2026-04-16T00:00:00.000Z',
                updated_at: '2026-04-16T00:00:00.000Z',
              },
            ],
          };
        }

        if (sql.includes('FROM chat_sessions')) {
          return {
            rows: [
              {
                id: sessionId,
                title: 'Demo chat',
                actor: 'architect',
                project_target_id: null,
                project_path: null,
                summary: '',
                summary_state: {
                  preferences: {
                    verbosity: {
                      value: 'concise',
                      source: 'explicit',
                      confidence: 0.98,
                    },
                  },
                },
                status: 'active',
                created_at: '2026-04-16T00:00:00.000Z',
                updated_at: '2026-04-16T00:00:00.000Z',
                project_name: null,
              },
            ],
          };
        }

        if (sql.includes('FROM chat_messages')) {
          return { rows: [] };
        }

        if (sql.includes('WHERE chat_session_id =')) {
          return { rows: [] };
        }

        if (sql.includes('INSERT INTO chat_messages')) {
          return {
            rows: [
              {
                id: 'msg-1',
                session_id: sessionId,
                role: params[1],
                actor: params[2],
                content: params[3],
                metadata: JSON.parse(params[4]),
                created_at: '2026-04-16T00:00:01.000Z',
              },
            ],
          };
        }

        if (sql.includes('UPDATE chat_sessions SET updated_at')) {
          return { rowCount: 1, rows: [] };
        }

        if (sql.includes('SET summary =')) {
          return { rowCount: 1, rows: [] };
        }

        if (sql.includes('INSERT INTO chat_summaries')) {
          return { rowCount: 1, rows: [] };
        }

        throw new Error(`Unexpected query: ${sql.slice(0, 80)}`);
      },
    },
    projectService: {
      async ensureProjectTarget() {
        return null;
      },
    },
    orchestrator: {},
    llmClient: {
      async generate({ model }) {
        requestedModels.push(model);
        return {
          responseText: '1. Define scope\n2. Choose architecture\n3. Build execution plan',
        };
      },
    },
    modelSelector: {
      selectWithFallback(role) {
        requestedRoles.push(role);
        return role === 'planner' ? ['planner-model', 'fast-model'] : ['fast-model'];
      },
    },
  });

  await chatService.createSession({
    title: 'Demo chat',
    actor: 'architect',
  });

  const response = await chatService.appendMessage(sessionId, {
    content: 'give me the steps',
  });

  assert.deepEqual(requestedRoles, ['planner']);
  assert.deepEqual(requestedModels, ['planner-model']);
  assert.match(response.assistant.content, /1\. Define scope/);
});

test('chat service can approve the only pending planned task from natural language', async () => {
  const approvedTasks = [];
  const sessionId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

  const chatService = createChatService({
    pool: {
      async query(sql, params) {
        if (sql.includes('INSERT INTO chat_sessions')) {
          return {
            rows: [
              {
                id: sessionId,
                title: 'Demo chat',
                actor: 'architect',
                project_target_id: null,
                project_path: null,
                summary: '',
                summary_state: {},
                status: 'active',
                created_at: '2026-04-16T00:00:00.000Z',
                updated_at: '2026-04-16T00:00:00.000Z',
              },
            ],
          };
        }

        if (sql.includes('FROM chat_sessions')) {
          return {
            rows: [
              {
                id: sessionId,
                title: 'Demo chat',
                actor: 'architect',
                project_target_id: null,
                project_path: null,
                summary: '',
                summary_state: {},
                status: 'active',
                created_at: '2026-04-16T00:00:00.000Z',
                updated_at: '2026-04-16T00:00:00.000Z',
                project_name: null,
              },
            ],
          };
        }

        if (sql.includes('FROM chat_messages')) {
          return { rows: [] };
        }

        if (sql.includes('WHERE chat_session_id =')) {
          return {
            rows: [
              {
                id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
                title: 'Planned task',
                status: 'waiting_approval',
                priority: 'medium',
                created_at: '2026-04-16T00:00:00.000Z',
                updated_at: '2026-04-16T00:00:00.000Z',
              },
            ],
          };
        }

        if (sql.includes('INSERT INTO chat_messages')) {
          return {
            rows: [
              {
                id: 'msg-2',
                session_id: sessionId,
                role: params[1],
                actor: params[2],
                content: params[3],
                metadata: JSON.parse(params[4]),
                created_at: '2026-04-16T00:00:01.000Z',
              },
            ],
          };
        }

        if (sql.includes('UPDATE chat_sessions SET updated_at')) {
          return { rowCount: 1, rows: [] };
        }

        if (sql.includes('SET summary =')) {
          return { rowCount: 1, rows: [] };
        }

        if (sql.includes('INSERT INTO chat_summaries')) {
          return { rowCount: 1, rows: [] };
        }

        throw new Error(`Unexpected query: ${sql.slice(0, 80)}`);
      },
    },
    projectService: {
      async ensureProjectTarget() {
        return null;
      },
    },
    orchestrator: {
      async approveTaskExecution(taskId, options) {
        approvedTasks.push({ taskId, options });
        return {
          task_id: taskId,
          status: 'approved',
        };
      },
    },
  });

  await chatService.createSession({
    title: 'Demo chat',
    actor: 'architect',
  });

  const response = await chatService.appendMessage(sessionId, {
    content: 'yes, start it',
  });

  assert.equal(approvedTasks.length, 1);
  assert.equal(approvedTasks[0].taskId, 'ffffffff-ffff-4fff-8fff-ffffffffffff');
  assert.equal(response.assistant.metadata.executionApproval.task_id, 'ffffffff-ffff-4fff-8fff-ffffffffffff');
  assert.match(response.assistant.content, /Work is now in progress/);
});

test('chat service turns a clear execution request into an approval-gated planned task', async () => {
  const sessionId = '99999999-9999-4999-8999-999999999999';
  const plannedContracts = [];

  const chatService = createChatService({
    pool: {
      async query(sql, params) {
        if (sql.includes('INSERT INTO chat_sessions')) {
          return {
            rows: [
              {
                id: sessionId,
                title: 'Demo chat',
                actor: 'architect',
                project_target_id: null,
                project_path: '/tmp/demo-project',
                summary: '',
                summary_state: {},
                status: 'active',
                created_at: '2026-04-16T00:00:00.000Z',
                updated_at: '2026-04-16T00:00:00.000Z',
              },
            ],
          };
        }

        if (sql.includes('FROM chat_sessions')) {
          return {
            rows: [
              {
                id: sessionId,
                title: 'Demo chat',
                actor: 'architect',
                project_target_id: null,
                project_path: '/tmp/demo-project',
                summary: '',
                summary_state: {},
                status: 'active',
                created_at: '2026-04-16T00:00:00.000Z',
                updated_at: '2026-04-16T00:00:00.000Z',
                project_name: null,
              },
            ],
          };
        }

        if (sql.includes('FROM chat_messages')) {
          return {
            rows: [
              {
                id: 'user-msg-1',
                session_id: sessionId,
                role: 'user',
                actor: 'architect',
                content: 'create the new directory and write the project plan into a markdown file',
                metadata: {},
                created_at: '2026-04-16T00:00:01.000Z',
              },
            ],
          };
        }

        if (sql.includes('WHERE chat_session_id =')) {
          return { rows: [] };
        }

        if (sql.includes('INSERT INTO chat_messages')) {
          return {
            rows: [
              {
                id: 'msg-auto-plan',
                session_id: sessionId,
                role: params[1],
                actor: params[2],
                content: params[3],
                metadata: JSON.parse(params[4]),
                created_at: '2026-04-16T00:00:02.000Z',
              },
            ],
          };
        }

        if (sql.includes('UPDATE chat_sessions SET updated_at')) {
          return { rowCount: 1, rows: [] };
        }

        if (sql.includes('SET summary =')) {
          return { rowCount: 1, rows: [] };
        }

        if (sql.includes('INSERT INTO chat_summaries')) {
          return { rowCount: 1, rows: [] };
        }

        throw new Error(`Unexpected query: ${sql.slice(0, 80)}`);
      },
    },
    projectService: {
      async ensureProjectTarget() {
        return null;
      },
    },
    orchestrator: {
      async createPlannedTask(contract, options) {
        plannedContracts.push({ contract, options });
        return {
          task: {
            id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
            status: 'waiting_approval',
          },
          plan: {
            summary: 'Create the new project directory and seed the planning document.',
            steps: [
              {
                stepNumber: 1,
                objective: 'Create the target directory',
                tool: 'shell',
              },
              {
                stepNumber: 2,
                objective: 'Write the planning markdown file',
                tool: 'filesystem',
              },
            ],
          },
        };
      },
    },
  });

  await chatService.createSession({
    title: 'Demo chat',
    actor: 'architect',
    projectPath: '/tmp/demo-project',
  });

  const response = await chatService.appendMessage(sessionId, {
    content: 'create the new directory and write the project plan into a markdown file',
  });

  assert.equal(plannedContracts.length, 1);
  assert.equal(plannedContracts[0].options.source, 'chat_auto_plan');
  assert.equal(plannedContracts[0].options.chatSessionId, sessionId);
  assert.equal(response.assistant.metadata.taskId, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
  assert.equal(response.assistant.metadata.executionPending, true);
  assert.equal(response.assistant.metadata.autoPlannedFromChat, true);
  assert.match(response.assistant.content, /approval-gated task/i);
  assert.match(response.assistant.content, /Execution has not started yet/i);
});

test('chat service planTask reconciles local-only auto-start tasks before rendering approval guidance', async () => {
  const sessionId = '56565656-5656-4565-8565-565656565656';
  const sessionRow = {
    id: sessionId,
    title: 'Plan reconcile chat',
    actor: 'architect',
    project_target_id: null,
    project_path: '/tmp/demo-project',
    summary: '',
    summary_state: {},
    status: 'active',
    created_at: '2026-04-16T00:00:00.000Z',
    updated_at: '2026-04-16T00:00:00.000Z',
    project_name: null,
  };
  const messages = [];

  const chatService = createChatService({
    pool: {
      async query(sql, params) {
        if (sql.includes('INSERT INTO chat_sessions')) {
          return { rows: [sessionRow] };
        }

        if (sql.includes('FROM chat_sessions')) {
          return { rows: [sessionRow] };
        }

        if (sql.includes('FROM chat_messages')) {
          return { rows: [...messages].reverse() };
        }

        if (sql.includes('WHERE chat_session_id =')) {
          return { rows: [] };
        }

        if (sql.includes('INSERT INTO chat_messages')) {
          const row = {
            id: `plan-reconcile-msg-${messages.length + 1}`,
            session_id: sessionId,
            role: params[1],
            actor: params[2],
            content: params[3],
            metadata: JSON.parse(params[4]),
            created_at: `2026-04-16T00:00:0${messages.length + 1}.000Z`,
          };
          messages.push(row);
          return { rows: [row] };
        }

        if (sql.includes('UPDATE chat_sessions SET updated_at')) {
          return { rowCount: 1, rows: [] };
        }

        if (sql.includes('SET summary =')) {
          sessionRow.summary = params[1];
          sessionRow.summary_state = JSON.parse(params[2]);
          return { rowCount: 1, rows: [] };
        }

        if (sql.includes('INSERT INTO chat_summaries')) {
          return { rowCount: 1, rows: [] };
        }

        throw new Error(`Unexpected query: ${sql.slice(0, 120)}`);
      },
    },
    projectService: {
      async ensureProjectTarget() {
        return null;
      },
    },
    orchestrator: {
      async createPlannedTask() {
        return {
          task: {
            id: '67676767-6767-4676-8676-676767676767',
            status: 'waiting_approval',
          },
          plan: {
            summary: 'Create the requested local markdown file.',
            steps: [
              {
                stepNumber: 1,
                objective: 'Write TEST_LOCALCLAW.md in the project root',
                tool: 'write_file',
              },
            ],
          },
          execution: {
            executionClass: 'local_only',
            executionPolicy: 'auto_local',
            approvalRequired: false,
          },
          executionApproval: {
            status: 'pending',
            approvalRequired: false,
            autoStarted: false,
          },
        };
      },
      async getTaskDetails(taskId) {
        return {
          task: {
            id: taskId,
            status: 'in_progress',
            result: {
              preExecutionPlan: {
                status: 'approved',
              },
            },
          },
        };
      },
    },
  });

  await chatService.createSession({
    title: 'Plan reconcile chat',
    actor: 'architect',
    projectPath: '/tmp/demo-project',
  });

  const planned = await chatService.planTask(sessionId, {
    contract: {
      version: 'task_contract_v1',
      projectName: 'demo-project',
      objective: 'Create TEST_LOCALCLAW.md at the repo root. No publish. No deploy.',
      inScope: ['Create TEST_LOCALCLAW.md in the repo root'],
      outOfScope: ['Publish changes', 'Deploy anything'],
      constraints: ['Do not publish', 'Do not deploy'],
      successCriteria: ['TEST_LOCALCLAW.md exists with the requested content'],
      priority: 'medium',
      repoIntent: {
        publish: false,
        deploy: false,
      },
      notes: 'chat service local-only plan reconciliation test',
    },
  });

  assert.equal(planned.task.status, 'in_progress');
  assert.equal(planned.executionApproval.status, 'approved');
  assert.equal(messages.length, 1);
  assert.match(messages[0].content, /Plan created and execution started\./);
  assert.match(messages[0].content, /Execution is in progress\./);
  assert.doesNotMatch(messages[0].content, /Execution has not started yet/i);
});

test('chat service asks for clarification before auto-planning a vague execution request', async () => {
  const sessionId = '77777777-7777-4777-8777-777777777777';
  const plannedContracts = [];
  const sessionRow = {
    id: sessionId,
    title: 'Clarify chat',
    actor: 'architect',
    project_target_id: null,
    project_path: null,
    summary: '',
    summary_state: {},
    status: 'active',
    created_at: '2026-04-16T00:00:00.000Z',
    updated_at: '2026-04-16T00:00:00.000Z',
    project_name: null,
  };
  const messages = [];

  const chatService = createChatService({
    pool: {
      async query(sql, params) {
        if (sql.includes('INSERT INTO chat_sessions')) {
          return { rows: [sessionRow] };
        }

        if (sql.includes('FROM chat_sessions')) {
          return { rows: [sessionRow] };
        }

        if (sql.includes('FROM chat_messages')) {
          return { rows: [...messages].reverse() };
        }

        if (sql.includes('WHERE chat_session_id =')) {
          return { rows: [] };
        }

        if (sql.includes('INSERT INTO chat_messages')) {
          const row = {
            id: `clarify-msg-${messages.length + 1}`,
            session_id: sessionId,
            role: params[1],
            actor: params[2],
            content: params[3],
            metadata: JSON.parse(params[4]),
            created_at: `2026-04-16T00:00:0${messages.length + 1}.000Z`,
          };
          messages.push(row);
          return { rows: [row] };
        }

        if (sql.includes('UPDATE chat_sessions SET updated_at')) {
          return { rowCount: 1, rows: [] };
        }

        if (sql.includes('SET summary =')) {
          sessionRow.summary = params[1];
          sessionRow.summary_state = JSON.parse(params[2]);
          return { rowCount: 1, rows: [] };
        }

        if (sql.includes('INSERT INTO chat_summaries')) {
          return { rowCount: 1, rows: [] };
        }

        throw new Error(`Unexpected query: ${sql.slice(0, 120)}`);
      },
    },
    projectService: {
      async ensureProjectTarget() {
        return null;
      },
    },
    orchestrator: {
      async createPlannedTask(contract, options) {
        plannedContracts.push({ contract, options });
        return {
          task: {
            id: 'never-planned',
            status: 'waiting_approval',
          },
          plan: {
            summary: 'should not be used',
            steps: [],
          },
        };
      },
    },
  });

  await chatService.createSession({
    title: 'Clarify chat',
    actor: 'architect',
  });

  const response = await chatService.appendMessage(sessionId, {
    content: 'fix it',
  });

  assert.equal(plannedContracts.length, 0);
  assert.equal(response.assistant.metadata.clarificationRequested, true);
  assert.deepEqual(response.assistant.metadata.missingContext, [
    'requested_change',
    'target_area',
  ]);
  assert.match(response.assistant.content, /need a bit more detail/i);
  assert.equal(sessionRow.summary_state.contractDraft.pendingClarification, true);
});

test('chat service auto-plans after clarification makes the draft contract concrete', async () => {
  const sessionId = '88888888-8888-4888-8888-888888888888';
  const plannedContracts = [];
  const sessionRow = {
    id: sessionId,
    title: 'Refine chat',
    actor: 'architect',
    project_target_id: null,
    project_path: '/tmp/demo-project',
    summary: '',
    summary_state: {},
    status: 'active',
    created_at: '2026-04-16T00:00:00.000Z',
    updated_at: '2026-04-16T00:00:00.000Z',
    project_name: null,
  };
  const messages = [];

  const chatService = createChatService({
    pool: {
      async query(sql, params) {
        if (sql.includes('INSERT INTO chat_sessions')) {
          return { rows: [sessionRow] };
        }

        if (sql.includes('FROM chat_sessions')) {
          return { rows: [sessionRow] };
        }

        if (sql.includes('FROM chat_messages')) {
          return { rows: [...messages].reverse() };
        }

        if (sql.includes('WHERE chat_session_id =')) {
          return { rows: [] };
        }

        if (sql.includes('INSERT INTO chat_messages')) {
          const row = {
            id: `refine-msg-${messages.length + 1}`,
            session_id: sessionId,
            role: params[1],
            actor: params[2],
            content: params[3],
            metadata: JSON.parse(params[4]),
            created_at: `2026-04-16T00:00:0${messages.length + 1}.000Z`,
          };
          messages.push(row);
          return { rows: [row] };
        }

        if (sql.includes('UPDATE chat_sessions SET updated_at')) {
          return { rowCount: 1, rows: [] };
        }

        if (sql.includes('SET summary =')) {
          sessionRow.summary = params[1];
          sessionRow.summary_state = JSON.parse(params[2]);
          return { rowCount: 1, rows: [] };
        }

        if (sql.includes('INSERT INTO chat_summaries')) {
          return { rowCount: 1, rows: [] };
        }

        throw new Error(`Unexpected query: ${sql.slice(0, 120)}`);
      },
    },
    projectService: {
      async ensureProjectTarget() {
        return null;
      },
    },
    orchestrator: {
      async createPlannedTask(contract, options) {
        plannedContracts.push({ contract, options });
        return {
          task: {
            id: 'planned-after-refine',
            status: 'waiting_approval',
          },
          plan: {
            summary: 'Fix the invoice rounding logic in the billing API.',
            steps: [
              {
                stepNumber: 1,
                objective: 'Inspect the billing logic',
                tool: 'shell',
              },
            ],
          },
        };
      },
    },
  });

  await chatService.createSession({
    title: 'Refine chat',
    actor: 'architect',
    projectPath: '/tmp/demo-project',
  });

  await chatService.appendMessage(sessionId, {
    content: 'fix it',
  });

  const response = await chatService.appendMessage(sessionId, {
    content: 'in the billing API, update invoice rounding and add a regression test',
  });

  assert.equal(plannedContracts.length, 1);
  assert.equal(plannedContracts[0].options.source, 'chat_auto_plan');
  assert.match(plannedContracts[0].contract.objective, /fix it/i);
  assert.match(plannedContracts[0].contract.objective, /billing API/i);
  assert.equal(response.assistant.metadata.executionPending, true);
  assert.equal(response.assistant.metadata.taskId, 'planned-after-refine');
  assert.match(response.assistant.content, /approval-gated task/i);
});

test('chat service refines structured contract fields across follow-up turns', async () => {
  const sessionId = '91919191-9191-4919-8919-919191919191';
  const plannedContracts = [];
  const sessionRow = {
    id: sessionId,
    title: 'Structured refine chat',
    actor: 'architect',
    project_target_id: null,
    project_path: '/tmp/demo-project',
    summary: '',
    summary_state: {},
    status: 'active',
    created_at: '2026-04-16T00:00:00.000Z',
    updated_at: '2026-04-16T00:00:00.000Z',
    project_name: null,
  };
  const messages = [];

  const chatService = createChatService({
    pool: {
      async query(sql, params) {
        if (sql.includes('INSERT INTO chat_sessions')) {
          return { rows: [sessionRow] };
        }

        if (sql.includes('FROM chat_sessions')) {
          return { rows: [sessionRow] };
        }

        if (sql.includes('FROM chat_messages')) {
          return { rows: [...messages].reverse() };
        }

        if (sql.includes('WHERE chat_session_id =')) {
          return { rows: [] };
        }

        if (sql.includes('INSERT INTO chat_messages')) {
          const row = {
            id: `structured-msg-${messages.length + 1}`,
            session_id: sessionId,
            role: params[1],
            actor: params[2],
            content: params[3],
            metadata: JSON.parse(params[4]),
            created_at: `2026-04-16T00:00:0${messages.length + 1}.000Z`,
          };
          messages.push(row);
          return { rows: [row] };
        }

        if (sql.includes('UPDATE chat_sessions SET updated_at')) {
          return { rowCount: 1, rows: [] };
        }

        if (sql.includes('SET summary =')) {
          sessionRow.summary = params[1];
          sessionRow.summary_state = JSON.parse(params[2]);
          return { rowCount: 1, rows: [] };
        }

        if (sql.includes('INSERT INTO chat_summaries')) {
          return { rowCount: 1, rows: [] };
        }

        throw new Error(`Unexpected query: ${sql.slice(0, 120)}`);
      },
    },
    projectService: {
      async ensureProjectTarget() {
        return null;
      },
    },
    orchestrator: {
      async createPlannedTask(contract, options) {
        plannedContracts.push({ contract, options });
        return {
          task: {
            id: 'structured-plan',
            status: 'waiting_approval',
          },
          plan: {
            summary: 'Refine contract fields before execution.',
            steps: [],
          },
        };
      },
    },
  });

  await chatService.createSession({
    title: 'Structured refine chat',
    actor: 'architect',
    projectPath: '/tmp/demo-project',
  });

  await chatService.appendMessage(sessionId, {
    content: 'fix it',
  });

  const response = await chatService.appendMessage(sessionId, {
    content:
      'for the billing API invoice rounding path, in scope: update the rounding helper | add regression coverage; out of scope: frontend changes; constraints: use the existing billing API | keep the patch small; success criteria: all invoice rounding tests pass | add a regression test; high priority; do not deploy',
  });

  assert.equal(plannedContracts.length, 1);
  const contract = plannedContracts[0].contract;
  assert.equal(contract.priority, 'high');
  assert.equal(contract.repoIntent.deploy, false);
  assert.match(contract.objective, /billing API/i);
  assert(contract.inScope.includes('update the rounding helper'));
  assert(contract.inScope.includes('add regression coverage'));
  assert(contract.outOfScope.includes('frontend changes'));
  assert(contract.constraints.includes('use the existing billing API'));
  assert(contract.constraints.includes('keep the patch small'));
  assert(contract.successCriteria.includes('all invoice rounding tests pass'));
  assert(contract.successCriteria.includes('add a regression test'));
  assert.equal(response.assistant.metadata.taskId, 'structured-plan');
});

test('chat service extracts structured preferences into summary state', async () => {
  const sessionId = '12121212-1212-4212-8212-121212121212';
  const sessionRow = {
    id: sessionId,
    title: 'Preference chat',
    actor: 'architect',
    project_target_id: null,
    project_path: null,
    summary: '',
    summary_state: {},
    status: 'active',
    created_at: '2026-04-16T00:00:00.000Z',
    updated_at: '2026-04-16T00:00:00.000Z',
    project_name: null,
  };
  const messages = [];
  const recordedPreferenceStates = [];

  const chatService = createChatService({
    pool: {
      async query(sql, params) {
        if (sql.includes('INSERT INTO chat_sessions')) {
          return { rows: [sessionRow] };
        }

        if (sql.includes('FROM chat_sessions')) {
          return { rows: [sessionRow] };
        }

        if (sql.includes('FROM chat_messages')) {
          return { rows: [...messages].reverse() };
        }

        if (sql.includes('WHERE chat_session_id =')) {
          return { rows: [] };
        }

        if (sql.includes('INSERT INTO chat_messages')) {
          const row = {
            id: `msg-${messages.length + 1}`,
            session_id: sessionId,
            role: params[1],
            actor: params[2],
            content: params[3],
            metadata: JSON.parse(params[4]),
            created_at: `2026-04-16T00:00:0${messages.length + 1}.000Z`,
          };
          messages.push(row);
          return { rows: [row] };
        }

        if (sql.includes('UPDATE chat_sessions SET updated_at')) {
          return { rowCount: 1, rows: [] };
        }

        if (sql.includes('SET summary =')) {
          sessionRow.summary = params[1];
          sessionRow.summary_state = JSON.parse(params[2]);
          return { rowCount: 1, rows: [] };
        }

        if (sql.includes('INSERT INTO chat_summaries')) {
          return { rowCount: 1, rows: [] };
        }

        throw new Error(`Unexpected query: ${sql.slice(0, 120)}`);
      },
    },
    projectService: {
      async ensureProjectTarget() {
        return null;
      },
    },
    orchestrator: {
      async recordPersonaPreferenceSignals(summaryState) {
        recordedPreferenceStates.push(summaryState);
      },
    },
  });

  await chatService.createSession({
    title: 'Preference chat',
    actor: 'architect',
  });

  await chatService.appendMessage(sessionId, {
    content: 'keep it concise, explain why briefly, and give me the steps',
  });

  assert.equal(sessionRow.summary_state.version, 'chat_summary_v1');
  assert.equal(sessionRow.summary_state.preferences.verbosity.value, 'concise');
  assert.equal(sessionRow.summary_state.preferences.explanationDepth.value, 'high');
  assert.equal(sessionRow.summary_state.preferences.planningStyle.value, 'stepwise');
  assert.equal(sessionRow.summary_state.preferences.verbosity.source, 'explicit');
  assert.match(sessionRow.summary, /Latest request:/);
  assert.equal(recordedPreferenceStates.length, 1);
  assert.equal(recordedPreferenceStates[0].preferences.verbosity.value, 'concise');
});
