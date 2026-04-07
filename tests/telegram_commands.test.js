import assert from 'node:assert/strict';
import test from 'node:test';

import pino from 'pino';

import { closePool, getPool } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { Orchestrator } from '../src/orchestrator.js';
import { createTelegramHandlers } from '../src/telegram/commands.js';

const logger = pino({ level: 'fatal' });
const pool = getPool();

const testState = {
  orchestrator: null,
  handlers: null,
  replies: [],
  killReasons: [],
  originalStatus: null,
  originalPauseReason: null,
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

test.before(async () => {
  await runMigrations();

  testState.orchestrator = new Orchestrator({
    logger,
    pollIntervalMs: 60_000,
  });

  testState.originalStatus = await testState.orchestrator.getAgentStateValue(
    'status',
    'running'
  );
  testState.originalPauseReason = await testState.orchestrator.getAgentStateValue(
    'pause_reason',
    null
  );

  testState.handlers = createTelegramHandlers({
    logger,
    orchestrator: testState.orchestrator,
    onKill: async (reason) => {
      testState.killReasons.push(reason);
    },
  });
});

test.after(async () => {
  await pool.query(
    `DELETE FROM tasks
     WHERE source = 'telegram'
       AND title LIKE 'LC_TEST_%'`
  );

  await testState.orchestrator.setAgentStateValue(
    'status',
    testState.originalStatus ?? 'running'
  );
  await testState.orchestrator.setAgentStateValue(
    'pause_reason',
    testState.originalPauseReason ?? null
  );
  await testState.orchestrator.setAgentStateValue('current_task_id', null);

  await closePool();
});

test('telegram command handlers update agent_state and tasks', async () => {
  const startReply = await runCommand('start', '/start');
  assert.match(startReply, /LocalClaw bot is connected/);

  const statusReply = await runCommand('status', '/status');
  assert.match(statusReply, /Status:/);

  const addReply = await runCommand('add', '/add LC_TEST_create hello world api');
  assert.match(addReply, /Task created\./);

  const taskResult = await pool.query(
    `SELECT title, source, status
     FROM tasks
     WHERE title = 'LC_TEST_create hello world api'
     ORDER BY created_at DESC
     LIMIT 1`
  );

  assert.equal(taskResult.rowCount, 1);
  assert.equal(taskResult.rows[0].source, 'telegram');
  assert.equal(taskResult.rows[0].status, 'pending');

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
