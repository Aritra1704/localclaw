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

test('orchestrator routes queue recovery, leasing, and task history through postgres MCP', async () => {
  const calls = [];
  const postgresServer = {
    name: 'postgres',
    async callTool(toolName, args) {
      calls.push({ toolName, args });

      switch (toolName) {
        case 'recover_interrupted_tasks':
          return {
            rowCount: 1,
            rows: [{ id: 'task-1', title: 'Recovered task' }],
          };
        case 'insert_agent_log':
          return { rows: [{ id: 'log-1' }] };
        case 'count_pending_tasks':
          return { rows: [{ count: 3 }] };
        case 'lease_next_task':
          return {
            rows: [
              {
                id: 'task-2',
                title: 'Queued task',
                status: 'in_progress',
                priority: 'medium',
              },
            ],
          };
        case 'get_task_by_id':
          return {
            rows: [
              {
                id: args.taskId,
                title: 'Task detail',
                description: 'Inspect the task',
                priority: 'medium',
                status: 'done',
                source: 'test',
                project_name: 'demo',
                project_path: '/tmp/demo',
                repo_url: null,
                blocked_reason: null,
                result: {},
                created_at: '2026-04-16T00:00:00.000Z',
                started_at: '2026-04-16T00:01:00.000Z',
                completed_at: '2026-04-16T00:02:00.000Z',
                updated_at: '2026-04-16T00:02:00.000Z',
              },
            ],
          };
        case 'list_task_logs':
          return {
            rows: [
              {
                step_number: 1,
                step_type: 'act',
                model_used: 'test-model',
                tool_called: 'write_file',
                status: 'success',
                input_summary: 'input',
                output_summary: 'output',
                duration_ms: 12,
                error_message: null,
                created_at: '2026-04-16T00:01:30.000Z',
              },
            ],
          };
        case 'list_task_artifacts':
          return {
            rows: [
              {
                artifact_type: 'narrated_summary_v1',
                artifact_path: `task://${args.taskId}/narrated_summary_v1`,
                metadata: {
                  version: 'narrated_summary_v1',
                  summary: 'I finished the run and verification passed.',
                },
                created_at: '2026-04-16T00:02:10.000Z',
              },
            ],
          };
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
      async connect() {
        throw new Error('pool.connect should not be used in this test');
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

  await orchestrator.recoverInterruptedTasks();
  const pendingCount = await orchestrator.getPendingTaskCount();
  const leased = await orchestrator.leaseNextTask();
  const detail = await orchestrator.getTaskDetails('task-2');

  assert.equal(pendingCount, 3);
  assert.equal(leased.id, 'task-2');
  assert.equal(detail.task.id, 'task-2');
  assert.equal(detail.logs.length, 1);
  assert.equal(detail.persona.narratedSummary.summary, 'I finished the run and verification passed.');
  assert.deepEqual(
    calls.map((entry) => entry.toolName),
    [
      'recover_interrupted_tasks',
      'insert_agent_log',
      'count_pending_tasks',
      'lease_next_task',
      'get_task_by_id',
      'list_task_logs',
      'list_task_artifacts',
    ]
  );
});
