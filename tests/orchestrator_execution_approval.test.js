import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import pino from 'pino';

import { Orchestrator } from '../src/orchestrator.js';

const logger = pino({ level: 'fatal' });

function createExecutionApprovalPool() {
  const tasks = new Map();
  const taskArtifacts = [];
  const memoryArtifacts = [];
  const agentLogs = [];

  return {
    tasks,
    taskArtifacts,
    memoryArtifacts,
    agentLogs,
    async query(sql, params = []) {
      if (sql.includes('INSERT INTO tasks')) {
        const id = randomUUID();
        const row = {
          id,
          title: params[0],
          description: params[1],
          priority: params[2],
          source: params[3],
          project_name: params[4],
          project_path: params[5],
          project_target_id: params[6] ?? null,
          chat_session_id: params[7] ?? null,
          status: params[8] ?? 'pending',
          blocked_reason: null,
          result: null,
          created_at: new Date().toISOString(),
          started_at: null,
          completed_at: null,
          updated_at: new Date().toISOString(),
        };
        tasks.set(id, row);
        return {
          rows: [
            {
              id: row.id,
              title: row.title,
              description: row.description,
              status: row.status,
              priority: row.priority,
              source: row.source,
              project_target_id: row.project_target_id,
              created_at: row.created_at,
            },
          ],
        };
      }

      if (sql.includes('SELECT id, status, result') && sql.includes('FROM tasks')) {
        const task = tasks.get(params[0]);
        return {
          rows: task
            ? [
                {
                  id: task.id,
                  title: task.title,
                  project_name: task.project_name,
                  project_path: task.project_path,
                  chat_session_id: task.chat_session_id,
                  status: task.status,
                  result: task.result,
                },
              ]
            : [],
        };
      }

      if (sql.includes('SELECT id, title, project_name, project_path, chat_session_id, status, result') && sql.includes('FROM tasks')) {
        const task = tasks.get(params[0]);
        return {
          rows: task
            ? [
                {
                  id: task.id,
                  title: task.title,
                  project_name: task.project_name,
                  project_path: task.project_path,
                  chat_session_id: task.chat_session_id,
                  status: task.status,
                  result: task.result,
                },
              ]
            : [],
        };
      }

      if (sql.includes('SELECT status, blocked_reason, result') && sql.includes('FROM tasks')) {
        const task = tasks.get(params[0]);
        return {
          rows: task
            ? [
                {
                  status: task.status,
                  blocked_reason: task.blocked_reason,
                  result: task.result,
                },
              ]
            : [],
        };
      }

      if (sql.includes('UPDATE tasks') && sql.includes('result = $6::jsonb')) {
        const task = tasks.get(params[0]);
        task.status = params[1];
        task.project_name = params[2];
        task.project_path = params[3];
        task.project_target_id = params[4];
        task.blocked_reason =
          params[1] === 'waiting_approval' ? 'Execution waiting for approval' : null;
        task.result = JSON.parse(params[5]);
        task.updated_at = new Date().toISOString();
        return { rows: [] };
      }

      if (sql.includes('UPDATE tasks') && sql.includes("status = 'pending'")) {
        const task = tasks.get(params[0]);
        task.status = 'pending';
        task.blocked_reason = null;
        task.result = JSON.parse(params[1]);
        task.updated_at = new Date().toISOString();
        return { rows: [] };
      }

      if (sql.includes('UPDATE tasks') && sql.includes("status = 'blocked'")) {
        const task = tasks.get(params[0]);
        task.status = 'blocked';
        task.blocked_reason = params[1];
        task.result = JSON.parse(params[2]);
        task.updated_at = new Date().toISOString();
        return { rows: [] };
      }

      if (sql.includes('INSERT INTO task_artifacts')) {
        taskArtifacts.push({
          task_id: params[0],
          artifact_type: params[1],
          artifact_path: params[2],
          metadata: params[3],
        });
        return { rows: [{ id: randomUUID() }] };
      }

      if (sql.includes('INSERT INTO memory_artifacts')) {
        memoryArtifacts.push({
          task_id: params[0],
          chat_session_id: params[1],
          artifact_type: params[2],
          content: params[8],
        });
        return { rows: [{ id: randomUUID(), created_at: new Date().toISOString() }] };
      }

      if (sql.includes('INSERT INTO agent_logs')) {
        agentLogs.push({
          task_id: params[0],
          step_number: params[1],
          step_type: params[2],
          status: params[5],
        });
        return { rows: [{ id: randomUUID() }] };
      }

      if (sql.includes('SELECT COUNT(*)::int AS count') && sql.includes('FROM task_artifacts')) {
        const count = taskArtifacts.filter(
          (artifact) => artifact.task_id === params[0] && artifact.artifact_type === 'workspace'
        ).length;
        return { rows: [{ count }] };
      }

      if (sql.includes('DELETE FROM tasks')) {
        for (const [id, task] of tasks.entries()) {
          if (task.source === 'control_api_test' && task.project_name === 'phase7-exec-gate') {
            tasks.delete(id);
          }
        }
        return { rowCount: 0, rows: [] };
      }

      if (sql.includes('FROM learnings')) {
        return { rows: [] };
      }

      if (sql.includes('FROM document_chunks')) {
        return { rows: [] };
      }

      if (sql.includes('UPDATE learnings')) {
        return { rowCount: 0, rows: [] };
      }

      if (sql.includes('SELECT') && sql.includes('FROM memory_artifacts')) {
        return { rows: [] };
      }

      if (sql.includes('SELECT value FROM agent_state')) {
        return { rows: [] };
      }

      throw new Error(`Unexpected query: ${sql.slice(0, 120)}`);
    },
  };
}

const contract = {
  version: 'task_contract_v1',
  projectName: 'phase7-exec-gate',
  objective: 'Validate plan and queue execution immediately after planning.',
  inScope: ['Create strict task contract', 'Store plan preview'],
  outOfScope: ['Deploy the generated app'],
  constraints: ['Queue execution immediately after planning'],
  successCriteria: ['Task is pending after planning'],
  priority: 'medium',
  skillHints: [],
  executionPolicy: 'external_only',
  repoIntent: {
    publish: false,
    deploy: false,
  },
};

test('createPlannedTask leaves external_only work waiting for explicit approval', async () => {
  const pool = createExecutionApprovalPool();
  const previewCalls = [];
  const orchestrator = new Orchestrator({
    logger,
    pool,
    knowledgeGraph: {
      async analyzeImpact() {
        return {
          summary: 'Impact analysis touches README.md and its dependents.',
          riskLevel: 'medium',
          primaryTargets: ['README.md'],
          upstreamDependencies: [],
          downstreamDependents: ['docs/ARCHITECTURE.md'],
          volatileAreas: [],
          historicalLearnings: [],
          lines: [
            'Semantic impact analysis:',
            '- likely edit targets: README.md',
            '- downstream dependents: docs/ARCHITECTURE.md',
            '- impact risk: medium',
          ],
        };
      },
    },
    taskExecutor: {
      async previewTaskPlan(task, context) {
        previewCalls.push({ task, context });
        return {
          plan: {
            summary: 'Create baseline files and verify structure',
            reasoning: 'Minimal deterministic plan for immediate execution',
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
  assert.equal(planned.executionApproval.status, 'pending');
  assert.equal(previewCalls.length, 1);

  const waitingTask = await pool.query(
    `SELECT status, blocked_reason, result
     FROM tasks
     WHERE id = $1`,
    [planned.task.id]
  );

  assert.equal(waitingTask.rows[0].status, 'waiting_approval');
  assert.equal(waitingTask.rows[0].result.preExecutionPlan.status, 'pending');
  assert.equal(waitingTask.rows[0].result.preExecutionPlan.impact_analysis.riskLevel, 'medium');

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
});
