import assert from 'node:assert/strict';
import test from 'node:test';

import pino from 'pino';

import { Orchestrator } from '../src/orchestrator.js';

const logger = pino({ level: 'fatal' });

test('orchestrator routes task/state writes through postgres MCP when available', async () => {
  const calls = [];
  const postgresServer = {
    name: 'postgres',
    async callTool(toolName, args) {
      calls.push({ toolName, args });

      switch (toolName) {
        case 'upsert_agent_state':
          return { rows: [{ state_key: args.key, value: args.value }] };
        case 'get_agent_state':
          return {
            rows: args.key === 'status' ? [{ value: 'running' }] : [],
          };
        case 'create_task':
          return {
            rows: [
              {
                id: '11111111-1111-4111-8111-111111111111',
                title: args.title,
                status: args.status ?? 'pending',
                priority: args.priority,
                created_at: '2026-04-16T00:00:00.000Z',
              },
            ],
          };
        case 'insert_agent_log':
        case 'insert_task_artifact':
        case 'insert_learning':
        case 'touch_task_lease':
          return { rows: [{ id: 'ok' }] };
        default:
          throw new Error(`Unexpected MCP tool: ${toolName}`);
      }
    },
  };

  const orchestrator = new Orchestrator({
    logger,
    pool: {
      async query() {
        throw new Error('Direct pool.query should not be used in this test');
      },
    },
    mcpRegistry: {
      getServer(name) {
        return name === 'postgres' ? postgresServer : null;
      },
      listAllTools() {
        return [];
      },
    },
  });

  await orchestrator.setAgentStateValue('status', 'running');
  const status = await orchestrator.getAgentStateValue('status', 'paused');
  const task = await orchestrator.createTask('Create MCP write coverage', {
    source: 'test',
    priority: 'high',
  });
  await orchestrator.logTaskStep(task.id, {
    stepNumber: 1,
    stepType: 'system',
    status: 'success',
    outputSummary: 'ok',
  });
  await orchestrator.persistArtifacts(task.id, [
    {
      artifactType: 'file',
      artifactPath: '/tmp/readme',
      metadata: { relativePath: 'README.md' },
    },
  ]);
  await orchestrator.touchTaskLease(task.id);
  await orchestrator.persistLearnings(
    { id: task.id },
    {}
  );

  assert.equal(status, 'running');
  assert.equal(task.id, '11111111-1111-4111-8111-111111111111');
  assert.deepEqual(
    calls.map((entry) => entry.toolName),
    [
      'upsert_agent_state',
      'get_agent_state',
      'create_task',
      'insert_agent_log',
      'insert_task_artifact',
      'touch_task_lease',
    ]
  );
});
