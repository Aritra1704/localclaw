import assert from 'node:assert/strict';
import test from 'node:test';

import pino from 'pino';

import { createControlApiServer } from '../src/control/api.js';

const logger = pino({ level: 'fatal' });

const validContract = {
  version: 'task_contract_v1',
  projectName: 'phase7-prep',
  objective: 'Implement CLI-first control API with strict plan+approve execution.',
  inScope: ['Add local control API', 'Add CLI interface'],
  outOfScope: ['Build web UI'],
  constraints: ['Keep deploy approval gates unchanged'],
  successCriteria: ['API can create plan previews', 'CLI can approve execution'],
  priority: 'medium',
  skillHints: ['scaffold_node_http_service'],
  repoIntent: {
    publish: false,
    deploy: false,
  },
};

test('control API enforces token on mutating routes and returns deterministic responses', async () => {
  const callLog = [];
  const orchestrator = {
    async getStatusSnapshot() {
      return {
        status: 'running',
        queue: {
          pending_count: 1,
          in_progress_count: 0,
          blocked_count: 0,
          waiting_approval_count: 1,
        },
      };
    },
    async listTasks() {
      return [];
    },
    async listPendingApprovals() {
      return [];
    },
    async listSkills() {
      return [];
    },
    async getTaskDetails(taskId) {
      return {
        task: { id: taskId, status: 'waiting_approval' },
        logs: [],
      };
    },
    async createPlannedTask(contract) {
      callLog.push({ fn: 'createPlannedTask', contract });
      return {
        task: {
          id: '11111111-1111-4111-8111-111111111111',
          title: 'phase7-prep: plan',
          status: 'waiting_approval',
        },
        plan: {
          summary: 'Create strict plan and wait for execution approval',
          steps: [
            {
              stepNumber: 1,
              objective: 'Write file',
              tool: 'write_file',
              args: { path: 'README.md', content: 'x' },
            },
          ],
        },
        planner: {
          modelUsed: 'test',
          repaired: false,
          fallback: false,
        },
      };
    },
    async approveTaskExecution(taskId) {
      callLog.push({ fn: 'approveTaskExecution', taskId });
      return {
        task_id: taskId,
        status: 'approved',
      };
    },
    async rejectTaskExecution(taskId, options) {
      callLog.push({ fn: 'rejectTaskExecution', taskId, options });
      return {
        task_id: taskId,
        status: 'rejected',
        reason: options.reason,
      };
    },
    async approveApproval(approvalId) {
      callLog.push({ fn: 'approveApproval', approvalId });
      return {
        id: approvalId,
        task_id: '11111111-1111-4111-8111-111111111111',
      };
    },
    async rejectApproval(approvalId, options) {
      callLog.push({ fn: 'rejectApproval', approvalId, options });
      return {
        id: approvalId,
        task_id: '11111111-1111-4111-8111-111111111111',
      };
    },
    async pause() {},
    async resume() {},
  };

  const api = createControlApiServer({
    orchestrator,
    logger,
    host: '127.0.0.1',
    port: 0,
    token: 'test-token',
  });

  const bound = await api.start();
  const baseUrl = `http://${bound.host}:${bound.port}`;

  try {
    const statusResponse = await fetch(`${baseUrl}/v1/status`);
    assert.equal(statusResponse.status, 200);

    const unauthorizedResponse = await fetch(`${baseUrl}/v1/tasks/plan`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ contract: validContract }),
    });
    assert.equal(unauthorizedResponse.status, 401);

    const invalidContractResponse = await fetch(`${baseUrl}/v1/tasks/plan`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ contract: { ...validContract, objective: '' } }),
    });
    assert.equal(invalidContractResponse.status, 400);
    const invalidPayload = await invalidContractResponse.json();
    assert.equal(invalidPayload.error, 'validation_error');

    const planResponse = await fetch(`${baseUrl}/v1/tasks/plan`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ contract: validContract }),
    });
    assert.equal(planResponse.status, 201);
    const plannedPayload = await planResponse.json();
    assert.equal(plannedPayload.data.task.status, 'waiting_approval');
    assert.equal(plannedPayload.data.task.id, '11111111-1111-4111-8111-111111111111');

    const runResponse = await fetch(`${baseUrl}/v1/tasks/run`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        contract: validContract,
        approveExecution: true,
      }),
    });
    assert.equal(runResponse.status, 201);
    const runPayload = await runResponse.json();
    assert.equal(runPayload.data.executionApproval.status, 'approved');

    const callSummary = callLog.map((entry) => entry.fn);
    assert.deepEqual(callSummary, [
      'createPlannedTask',
      'createPlannedTask',
      'approveTaskExecution',
    ]);
  } finally {
    await api.stop();
  }
});
