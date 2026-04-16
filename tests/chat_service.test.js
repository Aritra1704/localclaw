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
      'insert_chat_message',
      'touch_chat_session',
      'update_chat_summary',
      'insert_chat_summary',
    ]
  );
});
