import assert from 'node:assert/strict';
import test from 'node:test';

import pino from 'pino';

import { Orchestrator } from '../src/orchestrator.js';

const logger = pino({ level: 'fatal' });

test('buildRetrievalContext increments learning usage when learnings are injected', async () => {
  const learningId = '11111111-1111-4111-8111-111111111111';
  const usageUpdates = [];

  const pool = {
    async query(sql, params) {
      if (sql.includes('FROM learnings')) {
        return {
          rows: [
            {
              id: learningId,
              category: 'execution',
              observation: 'Reuse deployment-safe defaults to avoid cold-start failures.',
              confidence_score: 8,
            },
          ],
        };
      }

      if (sql.includes('FROM document_chunks')) {
        return { rows: [] };
      }

      if (sql.includes('UPDATE learnings')) {
        usageUpdates.push(params[0]);
        return { rowCount: 1, rows: [] };
      }

      throw new Error(`Unexpected query: ${sql.slice(0, 80)}`);
    },
  };

  const orchestrator = new Orchestrator({
    logger,
    pool,
  });

  const context = await orchestrator.buildRetrievalContext({
    id: 'task-phase5-1',
    title: 'Improve deployment reliability',
    description: 'Tune deployment retries and approval behavior',
  });

  assert.match(context, /Learnings:/);
  assert.match(context, /deployment-safe defaults/);
  assert.equal(usageUpdates.length, 1);
  assert.deepEqual(usageUpdates[0], [learningId]);
});
