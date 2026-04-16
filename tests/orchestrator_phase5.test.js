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

test('buildRetrievalContext includes graph-based impact context when available', async () => {
  const pool = {
    async query(sql) {
      if (sql.includes('FROM learnings')) {
        return { rows: [] };
      }

      if (sql.includes('FROM document_chunks')) {
        return { rows: [] };
      }

      if (sql.includes('UPDATE learnings')) {
        return { rowCount: 0, rows: [] };
      }

      throw new Error(`Unexpected query: ${sql.slice(0, 80)}`);
    },
  };

  const orchestrator = new Orchestrator({
    logger,
    pool,
    knowledgeGraph: {
      async analyzeImpact() {
        return {
          summary: 'Impact analysis touches src/index.js and downstream helpers.',
          riskLevel: 'medium',
          primaryTargets: ['src/index.js'],
          upstreamDependencies: ['src/helper.js'],
          downstreamDependents: ['README.md'],
          volatileAreas: ['src/index.js'],
          historicalLearnings: ['Touch helper imports carefully during refactors.'],
          lines: [
            'Semantic impact analysis:',
            '- likely edit targets: src/index.js',
            '- upstream dependencies: src/helper.js',
            '- downstream dependents: README.md',
            '- recently changed areas: src/index.js',
            '- historical cautions: Touch helper imports carefully during refactors.',
            '- impact risk: medium',
          ],
        };
      },
      async retrieveRelevantContext() {
        return {
          matches: [
            {
              node_type: 'file',
              display_name: 'index.js',
              source_path: 'src/index.js',
            },
          ],
          relationships: [
            {
              edge_type: 'imports',
              from_name: 'index.js',
              to_name: 'helper.js',
            },
          ],
          recentChanges: [
            {
              title: 'Refactor index module',
              status: 'done',
              relative_path: 'src/index.js',
            },
          ],
          lines: [
            'Architecture graph:',
            '- [file] index.js @ src/index.js',
            'Impact relationships:',
            '- index.js -[imports]-> helper.js',
            'Historical changes:',
            '- Refactor index module (done) @ src/index.js',
          ],
        };
      },
    },
  });

  const context = await orchestrator.buildRetrievalContext({
    id: 'task-phase12-1',
    title: 'Update index module',
    description: 'Analyze helper imports before editing index.js',
  });

  assert.match(context, /Architecture graph:/);
  assert.match(context, /Historical changes:/);
  assert.match(context, /Semantic impact analysis:/);
});

test('getTaskDetails merges transient runtime with persisted task context', async () => {
  const pool = {
    async query(sql) {
      if (sql.includes('FROM tasks')) {
        return {
          rows: [
            {
              id: 'task-runtime-1',
              title: 'Build sample app',
              description: 'Create a small sample app',
              priority: 'medium',
              status: 'in_progress',
              source: 'control_api',
              project_name: 'sample-app',
              project_path: '/tmp/sample-app',
              repo_url: null,
              blocked_reason: null,
              result: {
                preExecutionPlan: {
                  model_used: 'planner-model',
                  plan: {
                    summary: 'Write files and verify output',
                    steps: [
                      {
                        stepNumber: 1,
                        objective: 'Write package.json',
                        tool: 'write_file',
                      },
                      {
                        stepNumber: 2,
                        objective: 'Write README.md',
                        tool: 'write_file',
                      },
                    ],
                  },
                },
              },
              created_at: '2026-04-13T00:00:00.000Z',
              started_at: '2026-04-13T00:01:00.000Z',
              completed_at: null,
              updated_at: '2026-04-13T00:02:00.000Z',
            },
          ],
        };
      }

      if (sql.includes('FROM agent_logs')) {
        return {
          rows: [
            {
              step_number: 3,
              step_type: 'act',
              model_used: null,
              tool_called: 'write_file',
              status: 'success',
              input_summary: 'Write package.json',
              output_summary: 'Wrote package.json',
              duration_ms: 32,
              error_message: null,
              created_at: '2026-04-13T00:01:30.000Z',
            },
          ],
        };
      }

      throw new Error(`Unexpected query: ${sql.slice(0, 80)}`);
    },
  };

  const orchestrator = new Orchestrator({
    logger,
    pool,
  });

  orchestrator.updateTaskRuntime('task-runtime-1', {
    phase: 'acting',
    phaseLabel: 'Executing plan',
    detail: 'Running step 2 of 2.',
    currentModel: null,
    modelRole: null,
    checklist: [
      {
        stepNumber: 1,
        objective: 'Write package.json',
        tool: 'write_file',
        status: 'completed',
      },
      {
        stepNumber: 2,
        objective: 'Write README.md',
        tool: 'write_file',
        status: 'current',
      },
    ],
    counts: {
      completed: 1,
      total: 2,
    },
    currentStep: {
      stepNumber: 2,
      objective: 'Write README.md',
      tool: 'write_file',
    },
  });

  const detail = await orchestrator.getTaskDetails('task-runtime-1');

  assert.equal(detail.runtime.live, true);
  assert.equal(detail.runtime.phase, 'acting');
  assert.equal(detail.runtime.currentModel, null);
  assert.equal(detail.runtime.summary, 'Write files and verify output');
  assert.equal(detail.runtime.checklist[1].status, 'current');
});
