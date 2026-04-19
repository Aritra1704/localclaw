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
