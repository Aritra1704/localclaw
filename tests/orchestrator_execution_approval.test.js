import assert from 'node:assert/strict';
import test from 'node:test';

import pino from 'pino';

import { getPool } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { Orchestrator } from '../src/orchestrator.js';

const logger = pino({ level: 'fatal' });
const pool = getPool();

const contract = {
  version: 'task_contract_v1',
  projectName: 'phase7-exec-gate',
  objective: 'Validate plan then require explicit execution approval before running tools.',
  inScope: ['Create strict task contract', 'Store plan preview'],
  outOfScope: ['Deploy the generated app'],
  constraints: ['Do not execute tools before approval'],
  successCriteria: ['Task is waiting approval after planning'],
  priority: 'medium',
  skillHints: [],
  repoIntent: {
    publish: false,
    deploy: false,
  },
};

test.before(async () => {
  await runMigrations();
});

test.after(async () => {
  await pool.query(
    `DELETE FROM tasks
     WHERE source = 'control_api_test'
       AND project_name = 'phase7-exec-gate'`
  );
});

test('createPlannedTask and execution approval transitions are enforced', async () => {
  const previewCalls = [];
  const orchestrator = new Orchestrator({
    logger,
    pool,
    taskExecutor: {
      async previewTaskPlan(task, context) {
        previewCalls.push({ task, context });
        return {
          plan: {
            summary: 'Create baseline files and verify structure',
            reasoning: 'Minimal deterministic plan for approval-gated execution',
            executionMode: 'workspace_controlled',
            steps: [
              {
                stepNumber: 1,
                objective: 'Write README',
                tool: 'write_file',
                args: {
                  path: 'README.md',
                  content: '# phase7',
                },
              },
            ],
            successCriteria: ['README exists'],
            notesForVerifier: [],
          },
          modelUsed: 'test_planner',
          repaired: false,
          durationMs: 4,
        };
      },
    },
  });

  const planned = await orchestrator.createPlannedTask(contract, {
    source: 'control_api_test',
  });

  assert.equal(planned.task.status, 'waiting_approval');
  assert.equal(previewCalls.length, 1);

  const waitingTask = await pool.query(
    `SELECT status, blocked_reason, result
     FROM tasks
     WHERE id = $1`,
    [planned.task.id]
  );

  assert.equal(waitingTask.rows[0].status, 'waiting_approval');
  assert.equal(waitingTask.rows[0].result.preExecutionPlan.status, 'pending');

  const workspaceArtifacts = await pool.query(
    `SELECT COUNT(*)::int AS count
     FROM task_artifacts
     WHERE task_id = $1
       AND artifact_type = 'workspace'`,
    [planned.task.id]
  );

  assert.equal(workspaceArtifacts.rows[0].count, 0);

  const approved = await orchestrator.approveTaskExecution(planned.task.id, {
    respondedVia: 'test_suite',
  });

  assert.equal(approved.status, 'approved');

  const pendingTask = await pool.query(
    `SELECT status, result
     FROM tasks
     WHERE id = $1`,
    [planned.task.id]
  );

  assert.equal(pendingTask.rows[0].status, 'pending');
  assert.equal(pendingTask.rows[0].result.preExecutionPlan.status, 'approved');

  const cannotRejectApproved = await orchestrator.rejectTaskExecution(planned.task.id, {
    respondedVia: 'test_suite',
    reason: 'should not apply',
  });

  assert.equal(cannotRejectApproved, null);

  const plannedForRejection = await orchestrator.createPlannedTask(contract, {
    source: 'control_api_test',
  });

  const rejected = await orchestrator.rejectTaskExecution(plannedForRejection.task.id, {
    respondedVia: 'test_suite',
    reason: 'Rejected by test',
  });

  assert.equal(rejected.status, 'rejected');

  const blockedTask = await pool.query(
    `SELECT status, blocked_reason, result
     FROM tasks
     WHERE id = $1`,
    [plannedForRejection.task.id]
  );

  assert.equal(blockedTask.rows[0].status, 'blocked');
  assert.equal(blockedTask.rows[0].blocked_reason, 'Rejected by test');
  assert.equal(blockedTask.rows[0].result.preExecutionPlan.status, 'rejected');
});
