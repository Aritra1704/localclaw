import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import pino from 'pino';

import { config } from '../src/config.js';
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

test('repair approvals resume immediately through postgres MCP and repair tooling', async () => {
  const calls = [];
  let resumedTask = null;
  const postgresServer = {
    name: 'postgres',
    async callTool(toolName, args) {
      calls.push({ toolName, args });

      switch (toolName) {
        case 'respond_to_approval':
          return {
            rows: [
              {
                id: args.approvalId,
                task_id: 'task-repair-1',
                approval_type: 'repair',
              },
            ],
          };
        case 'update_deployments_by_approval':
          return { rows: [] };
        case 'list_ready_repairs':
          return {
            rows: [
              {
                approval_id: args.approvalId,
                task_id: args.taskId,
                repair_proposal: {
                  steps: [
                    {
                      stepNumber: 1,
                      objective: 'Rewrite the broken file with a corrected path',
                      tool: 'write_file',
                      args: {
                        path: 'README.md',
                        content: '# repaired\n',
                        overwrite: true,
                      },
                    },
                  ],
                },
                title: 'Repair task',
                task_result: {
                  workspaceRoot: '/tmp/localclaw-repair',
                  plan: { summary: 'Repair and resume' },
                },
              },
            ],
          };
        case 'mark_approval_applied':
          return {
            rows: [
              {
                id: args.approvalId,
                task_id: 'task-repair-1',
                approval_type: 'repair',
              },
            ],
          };
        case 'update_task_record':
          return { rows: [{ id: 'task-repair-1', status: args.patch.status }] };
        case 'insert_agent_log':
          return { rows: [{ id: 'log-1' }] };
        case 'get_task_by_id':
          return {
            rows: [
              {
                id: args.taskId,
                title: 'Repair task',
                description: 'Resume from approved repair',
                priority: 'medium',
                status: 'in_progress',
                source: 'test',
                project_name: 'demo',
                project_path: '/tmp/demo',
                repo_url: null,
                blocked_reason: null,
                result: {},
                created_at: '2026-04-16T00:00:00.000Z',
                started_at: '2026-04-16T00:01:00.000Z',
                completed_at: null,
                updated_at: '2026-04-16T00:02:00.000Z',
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
    },
    taskExecutor: {
      toolRegistry: {
        async runTool() {
          return { summary: 'repair applied' };
        },
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

  orchestrator.executeTask = async (task) => {
    resumedTask = task;
  };

  const approval = await orchestrator.approveApproval('repair-1', {
    respondedVia: 'test',
  });
  await Promise.all(Array.from(orchestrator.activeTasks).map((entry) => entry.promise));

  assert.equal(approval.id, 'repair-1');
  assert.equal(approval.approval_type, 'repair');
  assert.equal(resumedTask?.id, 'task-repair-1');
  assert.deepEqual(
    calls.map((entry) => entry.toolName),
    [
      'respond_to_approval',
      'update_deployments_by_approval',
      'list_ready_repairs',
      'mark_approval_applied',
      'update_task_record',
      'insert_agent_log',
      'insert_agent_log',
      'get_task_by_id',
    ]
  );
});

test('queueRepairApproval records repair budget metadata and increments retry count', async () => {
  const calls = [];
  const postgresServer = {
    name: 'postgres',
    async callTool(toolName, args) {
      calls.push({ toolName, args });

      switch (toolName) {
        case 'insert_task_artifact':
        case 'insert_agent_log':
          return { rows: [{ id: 'ok' }] };
        case 'insert_approval':
          return {
            rows: [
              {
                id: 'approval-1',
                task_id: args.taskId,
                requested_at: '2026-04-19T00:00:00.000Z',
              },
            ],
          };
        case 'update_task_record':
          return { rows: [{ id: args.taskId, status: args.patch.status }] };
        case 'update_approval_request_message':
          return { rows: [{ id: args.approvalId }] };
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
  orchestrator.notify = async () => ({ message_id: 42 });

  await orchestrator.queueRepairApproval(
    {
      id: 'task-1',
      title: 'Repair me',
      retry_count: 1,
      max_retries: 3,
      result: {},
    },
    {
      repairProposal: {
        summary: 'Retry with corrected path',
        reasoning: 'The file path was incorrect.',
        steps: [
          {
            stepNumber: 1,
            objective: 'Rewrite the file at the correct path',
            tool: 'write_file',
            args: {
              path: 'README.md',
              content: '# fixed\n',
              overwrite: true,
            },
          },
        ],
      },
      toolRuns: [
        {
          stepNumber: 2,
          objective: 'Write the file',
          tool: 'write_file',
          status: 'failed',
          summary: 'ENOENT: no such file or directory',
        },
      ],
      artifacts: [],
    }
  );

  const approvalInsert = calls.find((entry) => entry.toolName === 'insert_approval');
  const taskUpdate = calls.find((entry) => entry.toolName === 'update_task_record');

  assert.equal(approvalInsert.args.responsePayload.repairState.attemptCount, 2);
  assert.equal(approvalInsert.args.responsePayload.repairState.maxAttempts, 3);
  assert.equal(approvalInsert.args.responsePayload.repairState.lastOutcome, 'repair_proposal_generated');
  assert.equal(taskUpdate.args.patch.retry_count, 2);
  assert.equal(taskUpdate.args.patch.result.repairState.attemptCount, 2);
  assert.equal(typeof taskUpdate.args.patch.result.repairState.nextEligibleAt, 'string');
});

test('approved repairs stay pending until their cooldown window opens', async () => {
  const calls = [];
  const nextEligibleAt = new Date(Date.now() + 60_000).toISOString();
  const postgresServer = {
    name: 'postgres',
    async callTool(toolName, args) {
      calls.push({ toolName, args });

      switch (toolName) {
        case 'respond_to_approval':
          return {
            rows: [
              {
                id: args.approvalId,
                task_id: 'task-repair-2',
                approval_type: 'repair',
              },
            ],
          };
        case 'update_deployments_by_approval':
          return { rows: [] };
        case 'list_ready_repairs':
          return {
            rows: [
              {
                approval_id: args.approvalId,
                task_id: args.taskId,
                repair_proposal: {
                  steps: [],
                },
                title: 'Repair task',
                task_result: {
                  repairState: {
                    attemptCount: 2,
                    maxAttempts: 3,
                    nextEligibleAt,
                  },
                },
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

  const approval = await orchestrator.approveApproval('repair-2', {
    respondedVia: 'test',
  });

  assert.equal(approval.id, 'repair-2');
  assert.equal(orchestrator.activeTasks.size, 0);
  assert.deepEqual(
    calls.map((entry) => entry.toolName),
    ['respond_to_approval', 'update_deployments_by_approval', 'list_ready_repairs']
  );
});

test('persistLearnings emits deterministic self-healing learnings for repaired runs', async () => {
  const calls = [];
  const postgresServer = {
    name: 'postgres',
    async callTool(toolName, args) {
      calls.push({ toolName, args });

      switch (toolName) {
        case 'insert_learning':
        case 'insert_agent_log':
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
    learningExtractor: {
      async extract() {
        return [
          {
            category: 'verification',
            observation: 'Verification passed after the repaired workspace reran cleanly.',
            keywords: ['verification', 'repair'],
            confidenceScore: 7,
          },
        ];
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

  await orchestrator.persistLearnings(
    {
      id: 'task-repaired-1',
      title: 'Recover test workspace',
    },
    {
      repairState: {
        status: 'resolved',
        attemptCount: 2,
        maxAttempts: 3,
        lastOutcome: 'repair_recovered',
      },
    }
  );

  const learningCalls = calls.filter((entry) => entry.toolName === 'insert_learning');
  assert.equal(learningCalls.length, 2);
  assert.equal(learningCalls[0].args.category, 'self-healing');
  assert.match(learningCalls[0].args.observation, /bounded repair workflow recovered task/i);
  assert.equal(learningCalls[1].args.category, 'verification');
  assert.deepEqual(
    calls.map((entry) => entry.toolName),
    ['insert_learning', 'insert_learning', 'insert_agent_log']
  );
});

test('workspace_junk_cleanup proactive remediation removes ignored workspace junk and records state', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'localclaw-remediation-'));
  const originalSsdBasePath = config.ssdBasePath;
  config.ssdBasePath = tempRoot;
  const workspaceRoot = path.join(tempRoot, 'workspace', 'demo');
  const junkFile = path.join(workspaceRoot, '.DS_Store');
  await fs.mkdir(workspaceRoot, { recursive: true });
  await fs.writeFile(junkFile, 'junk', 'utf8');

  const state = new Map();
  const orchestrator = new Orchestrator({
    logger,
    proactiveRemediations: ['workspace_junk_cleanup'],
    pool: {
      async query() {
        throw new Error('Direct pool.query should not be used in this test');
      },
    },
    mcpRegistry: {
      getServer(name) {
        if (name !== 'postgres') {
          return null;
        }

        return {
          async callTool(toolName, args) {
            switch (toolName) {
              case 'get_agent_state':
                return {
                  rows: state.has(args.key) ? [{ value: state.get(args.key) }] : [],
                };
              case 'upsert_agent_state':
                state.set(args.key, args.value);
                return {
                  rows: [{ state_key: args.key, value: args.value }],
                };
              default:
                throw new Error(`Unexpected MCP tool: ${toolName}`);
            }
          },
        };
      },
      listAllTools() {
        return [];
      },
    },
  });

  try {
    const removedCount = await orchestrator.runWorkspaceJunkCleanupIfDue(true);
    const remediationState = await orchestrator.getAgentStateValue(
      'proactive_remediation:workspace_junk_cleanup',
      null
    );

    assert.equal(removedCount >= 1, true);
    await assert.rejects(fs.access(junkFile));
    assert.equal(remediationState.status, 'success');
    assert.match(remediationState.detail, /Removed \d+ ignored workspace path/);
  } finally {
    config.ssdBasePath = originalSsdBasePath;
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
