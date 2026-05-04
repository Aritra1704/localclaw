import assert from 'node:assert/strict';
import test from 'node:test';

import pino from 'pino';

import { Orchestrator } from '../src/orchestrator.js';

const logger = pino({ level: 'fatal' });

test('enqueueSpecializedFollowUpTasks creates dependency tasks only when missing', async () => {
  const queries = [];
  const createdTasks = [];
  const loggedSteps = [];
  let existingCheckCount = 0;

  const pool = {
    async query(sql, params) {
      queries.push({ sql, params });

      if (sql.includes('FROM tasks')) {
        existingCheckCount += 1;
        return {
          rows: existingCheckCount === 1 ? [] : [{ id: 'existing-task-1' }],
        };
      }

      throw new Error(`Unexpected query: ${sql.slice(0, 80)}`);
    },
  };

  const orchestrator = new Orchestrator({
    logger,
    pool,
  });

  orchestrator.createTask = async (description, options = {}) => {
    createdTasks.push({ description, options });
    return { id: 'created-follow-up-task' };
  };
  orchestrator.logTaskStep = async (taskId, step) => {
    loggedSteps.push({ taskId, step });
  };

  await orchestrator.enqueueSpecializedFollowUpTasks(
    {
      id: 'source-task-1',
      project_name: 'sample-app',
      project_path: '/tmp/sample-app',
    },
    [
      {
        title: 'Patch dependency lodash for sample-app',
        description: 'Upgrade lodash to the safe baseline.',
        priority: 'high',
        source: 'phase10_dependency_agent',
        projectName: 'sample-app',
        projectPath: '/tmp/sample-app',
      },
      {
        title: 'Patch dependency lodash for sample-app',
        description: 'Upgrade lodash to the safe baseline.',
        priority: 'high',
        source: 'phase10_dependency_agent',
        projectName: 'sample-app',
        projectPath: '/tmp/sample-app',
      },
    ]
  );

  assert.equal(createdTasks.length, 1);
  assert.equal(createdTasks[0].options.title, 'Patch dependency lodash for sample-app');
  assert.equal(loggedSteps.length, 1);
  assert.equal(loggedSteps[0].taskId, 'source-task-1');
});
