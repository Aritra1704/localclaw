import assert from 'node:assert/strict';
import test from 'node:test';

import pino from 'pino';

import { Orchestrator } from '../src/orchestrator.js';
import { createPostgresMcpServer } from '../src/mcp/postgresServer.js';
import { pruneMemoryArtifactsWithPool } from '../src/memory/retention.js';
import { assembleLayeredRetrievalContext, createLayerEntry } from '../src/memory/retrieval.js';

const logger = pino({ level: 'fatal' });

test('layered retrieval assembly preserves L0-L3 order and enforces per-layer budgets', () => {
  const result = assembleLayeredRetrievalContext(
    {
      L0: [createLayerEntry({ label: 'Current task state', source: 'task_state', text: 'state-a' })],
      L1: [createLayerEntry({ label: 'Exact memory', source: 'memory_artifact', text: 'x'.repeat(120) })],
      L2: [createLayerEntry({ label: 'Learnings', source: 'learning', text: 'learning-a' })],
      L3: [createLayerEntry({ label: 'Archive', source: 'archive', text: 'archive-a' })],
    },
    {
      budgets: {
        L0: 80,
        L1: 40,
        L2: 80,
        L3: 80,
      },
    }
  );

  assert.match(result.text, /^L0:/);
  assert.ok(result.text.indexOf('L1:') > result.text.indexOf('L0:'));
  assert.ok(result.text.indexOf('L2:') > result.text.indexOf('L1:'));
  assert.ok(result.text.indexOf('L3:') > result.text.indexOf('L2:'));
  assert.equal(result.diagnostics.layers.L1.truncated, true);
});

test('buildRetrievalContext prefers task-linked exact memory before broad learnings', async () => {
  const postgresServer = {
    async callTool(toolName, args) {
      if (toolName === 'list_memory_artifacts') {
        if (args.taskId && args.historicalMode === false) {
          return {
            rows: [
              {
                id: 'memory-1',
                task_id: args.taskId,
                artifact_type: 'user_instruction',
                project_scope: 'sample-app',
                subsystem: 'chat',
                retrieval_priority: 100,
                content: 'Do not rename the deployment service while fixing retries.',
                created_at: '2026-05-20T00:00:00.000Z',
              },
            ],
          };
        }

        return { rows: [] };
      }

      if (toolName === 'search_learnings') {
        return {
          rows: [
            {
              id: 'learning-1',
              category: 'execution',
              observation: 'Prefer bounded retry loops.',
              confidence_score: 7,
            },
          ],
        };
      }

      if (toolName === 'search_document_chunks') {
        return { rows: [] };
      }

      if (toolName === 'bump_learning_usage') {
        return { rows: [] };
      }

      throw new Error(`Unexpected tool: ${toolName}`);
    },
  };

  const orchestrator = new Orchestrator({
    logger,
    pool: {
      async query() {
        throw new Error('Unexpected direct pool query');
      },
    },
    mcpRegistry: {
      getServer(name) {
        return name === 'postgres' ? postgresServer : null;
      },
    },
  });

  const context = await orchestrator.buildRetrievalContext({
    id: 'task-memory-1',
    title: 'Fix deploy retries',
    description: 'Tune retry policy without changing service naming',
    priority: 'high',
    status: 'pending',
    project_name: 'sample-app',
  });

  assert.ok(context.retrievalContext.indexOf('L1:') > -1);
  assert.ok(context.retrievalContext.indexOf('L2:') > context.retrievalContext.indexOf('L1:'));
  assert.match(context.retrievalContext, /Do not rename the deployment service/);
  assert.match(context.retrievalContext, /Prefer bounded retry loops/);
  assert.equal(context.diagnostics.layers.L1.selectedCount, 1);
});

test('buildRetrievalContext loads archival exact memory only in fallback mode', async () => {
  const postgresServer = {
    async callTool(toolName, args) {
      if (toolName === 'list_memory_artifacts') {
        if (args.historicalMode === true) {
          return {
            rows: [
              {
                id: 'memory-archive-1',
                task_id: args.taskId,
                artifact_type: 'system_decision',
                project_scope: 'sample-app',
                subsystem: 'orchestrator',
                retrieval_priority: 50,
                content: 'Previous deployment retries were capped after repeated failures.',
                created_at: '2026-05-18T00:00:00.000Z',
              },
            ],
          };
        }

        return { rows: [] };
      }

      if (toolName === 'search_learnings' || toolName === 'search_document_chunks') {
        return { rows: [] };
      }

      if (toolName === 'bump_learning_usage') {
        return { rows: [] };
      }

      throw new Error(`Unexpected tool: ${toolName}`);
    },
  };

  const orchestrator = new Orchestrator({
    logger,
    pool: {
      async query() {
        throw new Error('Unexpected direct pool query');
      },
    },
    mcpRegistry: {
      getServer(name) {
        return name === 'postgres' ? postgresServer : null;
      },
    },
  });

  const context = await orchestrator.buildRetrievalContext(
    {
      id: 'task-memory-2',
      title: 'Investigate deploy instability',
      description: 'Need context on prior failures',
      priority: 'medium',
      status: 'pending',
    },
    {
      historicalMode: true,
    }
  );

  assert.match(context.retrievalContext, /L3:/);
  assert.match(context.retrievalContext, /Previous deployment retries were capped/);
});

test('postgres MCP server inserts, lists, and archives memory artifacts', async () => {
  const calls = [];
  const pool = {
    async query(sql, params) {
      calls.push({ sql, params });

      if (sql.includes('INSERT INTO memory_artifacts')) {
        return { rows: [{ id: 'memory-1', created_at: '2026-05-20T00:00:00.000Z' }] };
      }

      if (sql.includes('FROM memory_artifacts')) {
        return {
          rows: [
            {
              id: 'memory-1',
              artifact_type: 'user_instruction',
              content: 'Keep the retry budget explicit.',
            },
          ],
        };
      }

      if (sql.includes('UPDATE memory_artifacts')) {
        return { rowCount: 1, rows: [{ id: 'memory-1' }] };
      }

      throw new Error(`Unexpected query: ${sql.slice(0, 80)}`);
    },
  };

  const server = createPostgresMcpServer({ pool });

  await server.callTool('insert_memory_artifact', {
    taskId: '11111111-1111-4111-8111-111111111111',
    artifactType: 'user_instruction',
    content: 'Keep the retry budget explicit.',
  });
  const listed = await server.callTool('list_memory_artifacts', {
    taskId: '11111111-1111-4111-8111-111111111111',
    limit: 5,
  });
  const archived = await server.callTool('archive_memory_artifacts', {
    taskId: '11111111-1111-4111-8111-111111111111',
  });

  assert.equal(listed.rows[0].artifact_type, 'user_instruction');
  assert.equal(archived.rowCount, 1);
  assert.equal(calls.length >= 3, true);
});

test('memory retention helper archives, expires, and deletes old artifacts', async () => {
  const calls = [];
  const pool = {
    async query(sql, params) {
      calls.push({ sql, params });

      if (sql.includes('SET archived_at = NOW()')) {
        return { rowCount: 2, rows: [{ id: 'archive-1' }, { id: 'archive-2' }] };
      }

      if (sql.includes('SET expires_at = NOW()')) {
        return { rowCount: 3, rows: [{ id: 'expire-1' }, { id: 'expire-2' }, { id: 'expire-3' }] };
      }

      if (sql.includes('DELETE FROM memory_artifacts')) {
        return { rowCount: 1, rows: [{ id: 'delete-1' }] };
      }

      throw new Error(`Unexpected query: ${sql.slice(0, 80)}`);
    },
  };

  const summary = await pruneMemoryArtifactsWithPool(
    pool,
    {
      enabled: true,
      activeDays: 30,
      archivedDays: 7,
      orphanDays: 14,
      maxPrune: 50,
    },
    {
      maxRows: 50,
    }
  );

  assert.equal(summary.archivedCount, 2);
  assert.equal(summary.expiredCount, 3);
  assert.equal(summary.deletedCount, 1);
  assert.equal(calls.length, 3);
});

test('approveTaskExecution captures an exact approval response artifact', async () => {
  const memoryInserts = [];
  const pool = {
    async query(sql, params) {
      if (sql.includes('FROM tasks')) {
        return {
          rows: [
            {
              id: 'task-approval-1',
              title: 'Approve planned task',
              project_name: 'sample-app',
              project_path: '/tmp/sample-app',
              chat_session_id: '22222222-2222-4222-8222-222222222222',
              status: 'waiting_approval',
              result: {
                preExecutionPlan: {
                  status: 'pending',
                  plan: {
                    summary: 'Write a targeted patch',
                  },
                },
              },
            },
          ],
        };
      }

      if (sql.includes('UPDATE tasks')) {
        return { rows: [] };
      }

      if (sql.includes('INSERT INTO agent_logs')) {
        return { rows: [{ id: 'log-1' }] };
      }

      if (sql.includes('INSERT INTO memory_artifacts')) {
        memoryInserts.push(params);
        return { rows: [{ id: 'memory-approval-1', created_at: '2026-05-20T00:00:00.000Z' }] };
      }

      if (sql.includes('SELECT\n             id,')) {
        return { rows: [] };
      }

      throw new Error(`Unexpected query: ${sql.slice(0, 80)}`);
    },
  };

  const orchestrator = new Orchestrator({
    logger,
    pool,
  });

  const approved = await orchestrator.approveTaskExecution('task-approval-1', {
    respondedVia: 'chat',
    note: 'Approved from test',
  });

  assert.equal(approved.status, 'approved');
  assert.equal(memoryInserts.length, 1);
  assert.equal(memoryInserts[0][2], 'approval_response');
  assert.match(memoryInserts[0][8], /"decision": "approved"/);
});
