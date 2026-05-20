import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import pino from 'pino';

import { createTelegramHandlers } from '../src/telegram/commands.js';

const logger = pino({ level: 'fatal' });

const testState = {
  handlers: null,
  replies: [],
  killReasons: [],
  orchestrator: null,
};

function createCtx(text) {
  return {
    message: { text },
    reply: async (message) => {
      testState.replies.push(message);
      return { text: message };
    },
  };
}

async function runCommand(name, text) {
  testState.replies.length = 0;
  const ctx = createCtx(text);
  await testState.handlers[name](ctx);
  return testState.replies.at(-1) ?? null;
}

function createOrchestratorStub() {
  const agentState = new Map([
    ['status', 'running'],
    ['pause_reason', null],
    ['current_task_id', null],
    ['stats', { tasks_completed: 0, tasks_failed: 0, uptime_start: '2026-04-20T00:00:00.000Z' }],
    ['boot_phase', 'boot_ready'],
    ['boot_error', null],
    ['polling_active', false],
  ]);
  const tasks = [];

  return {
    tasks,
    async getStatusSnapshot() {
      return {
        status: agentState.get('status'),
        bootPhase: agentState.get('boot_phase'),
        bootError: agentState.get('boot_error'),
        pollingActive: agentState.get('polling_active'),
        currentTaskId: agentState.get('current_task_id'),
        pauseReason: agentState.get('pause_reason'),
        stats: agentState.get('stats'),
        queue: {
          pending_count: tasks.filter((task) => task.status === 'pending').length,
          in_progress_count: tasks.filter((task) => task.status === 'in_progress').length,
          blocked_count: tasks.filter((task) => task.status === 'blocked').length,
          waiting_approval_count: tasks.filter((task) => task.status === 'waiting_approval').length,
        },
        approvals: { pending_count: 0 },
        deployments: { deploying_count: 0 },
        currentTask: null,
        instanceId: 'test-instance',
        pollIntervalMs: 60000,
      };
    },
    async createTask(description, options = {}) {
      const task = {
        id: randomUUID(),
        title: options.title ?? description,
        source: options.source ?? 'telegram',
        status: 'pending',
        priority: options.priority ?? 'medium',
        created_at: new Date().toISOString(),
      };
      tasks.push(task);
      return task;
    },
    async listTasks() {
      return [...tasks];
    },
    async pause(reason) {
      agentState.set('status', 'paused');
      agentState.set('pause_reason', reason);
    },
    async resume() {
      agentState.set('status', 'running');
      agentState.set('pause_reason', null);
    },
    async markStopped(reason) {
      agentState.set('status', 'stopped');
      agentState.set('pause_reason', reason);
    },
    async getAgentStateValue(key, fallback = null) {
      return agentState.has(key) ? agentState.get(key) : fallback;
    },
    async setAgentStateValue(key, value) {
      agentState.set(key, value);
    },
    async listPendingApprovals() {
      return [];
    },
    async listSkills() {
      return [];
    },
    async setSkillEnabled() {
      return null;
    },
    async approveApproval() {
      return null;
    },
    async rejectApproval() {
      return null;
    },
  };
}

test.before(() => {
  testState.orchestrator = createOrchestratorStub();
  testState.handlers = createTelegramHandlers({
    logger,
    orchestrator: testState.orchestrator,
    onKill: async (reason) => {
      testState.killReasons.push(reason);
    },
  });
});

test('telegram command handlers update agent_state and tasks', async () => {
  const startReply = await runCommand('start', '/start');
  assert.match(startReply, /LocalClaw bot is connected/);

  const statusReply = await runCommand('status', '/status');
  assert.match(statusReply, /Status:/);

  const addReply = await runCommand('add', '/add LC_TEST_create hello world api');
  assert.match(addReply, /Task created\./);

  const createdTask = testState.orchestrator.tasks.find(
    (task) => task.title === 'LC_TEST_create hello world api'
  );
  assert.ok(createdTask);
  assert.equal(createdTask.source, 'telegram');
  assert.equal(createdTask.status, 'pending');

  createdTask.priority = 'critical';

  const tasksReply = await runCommand('tasks', '/tasks');
  assert.match(tasksReply, /LC_TEST_create hello world api/);

  const pauseReply = await runCommand('pause', '/pause maintenance window');
  assert.match(pauseReply, /LocalClaw paused\./);

  const pausedStatus = await testState.orchestrator.getAgentStateValue('status');
  const pauseReason = await testState.orchestrator.getAgentStateValue('pause_reason');
  assert.equal(pausedStatus, 'paused');
  assert.equal(pauseReason, 'maintenance window');

  const resumeReply = await runCommand('resume', '/resume');
  assert.match(resumeReply, /LocalClaw resumed\./);

  const resumedStatus = await testState.orchestrator.getAgentStateValue('status');
  assert.equal(resumedStatus, 'running');

  const killReply = await runCommand('kill', '/kill controlled stop');
  assert.match(killReply, /LocalClaw stopping now\./);

  await new Promise((resolve) => setTimeout(resolve, 100));

  const stoppedStatus = await testState.orchestrator.getAgentStateValue('status');
  const stoppedReason = await testState.orchestrator.getAgentStateValue('pause_reason');
  assert.equal(stoppedStatus, 'stopped');
  assert.equal(stoppedReason, 'controlled stop');
  assert.deepEqual(testState.killReasons, ['controlled stop']);
});
