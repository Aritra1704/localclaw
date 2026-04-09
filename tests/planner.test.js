import assert from 'node:assert/strict';
import test from 'node:test';

import { createPlanner } from '../src/agent/planner.js';

test('planner derives success criteria when model omits them', async () => {
  const planner = createPlanner({
    client: {
      async generate() {
        return {
          responseText: JSON.stringify({
            summary: 'Create the requested app files.',
            reasoning: 'A small Node service needs package metadata and an entrypoint.',
            executionMode: 'workspace_controlled',
            steps: [
              {
                stepNumber: 1,
                objective: 'Write package.json',
                tool: 'write_file',
                args: {
                  path: 'package.json',
                  content: '{\n  "name": "phase4-sample-app"\n}\n',
                },
              },
            ],
            successCriteria: [],
          }),
        };
      },
    },
    modelSelector: {
      select(kind) {
        return kind === 'planner' ? 'planner-model' : 'fast-model';
      },
    },
  });

  const result = await planner.planTask(
    {
      id: 'task-planner-1',
      title: 'phase4-sample-app',
      description: 'Create a Railway-ready sample app.',
    },
    {
      workspaceRoot: '/tmp/localclaw-test-workspace',
      workspaceSnapshot: [],
      toolCatalog: 'write_file(path, content)',
    }
  );

  assert.equal(result.repaired, false);
  assert.equal(result.plan.successCriteria.length, 1);
  assert.match(result.plan.successCriteria[0], /Write package\.json/);
});

test('planner defaults execution mode and verifier notes when omitted', async () => {
  const planner = createPlanner({
    client: {
      async generate() {
        return {
          responseText: JSON.stringify({
            summary: 'Create a minimal README.',
            reasoning: 'A single file is enough for this request.',
            steps: [
              {
                stepNumber: 1,
                objective: 'Write README.md',
                tool: 'write_file',
                args: {
                  path: 'README.md',
                  content: '# phase4-sample-app\n',
                },
              },
            ],
          }),
        };
      },
    },
    modelSelector: {
      select(kind) {
        return kind === 'planner' ? 'planner-model' : 'fast-model';
      },
    },
  });

  const result = await planner.planTask(
    {
      id: 'task-planner-2',
      title: 'phase4-sample-app',
      description: 'Create a README.',
    },
    {
      workspaceRoot: '/tmp/localclaw-test-workspace',
      workspaceSnapshot: [],
      toolCatalog: 'write_file(path, content)',
    }
  );

  assert.equal(result.plan.executionMode, 'workspace_controlled');
  assert.deepEqual(result.plan.notesForVerifier, []);
  assert.equal(result.plan.steps[0].tool, 'write_file');
});

test('planner falls back to deterministic run_skill plan when model output is malformed twice', async () => {
  let callCount = 0;

  const planner = createPlanner({
    client: {
      async generate() {
        callCount += 1;

        if (callCount === 1) {
          return {
            responseText: JSON.stringify({
              summary: 'attempt',
              reasoning: 'attempt',
              executionMode: 'workspace_controlled',
              steps: ['not-an-object-step'],
              successCriteria: [],
            }),
          };
        }

        return {
          responseText: JSON.stringify({
            summary: 'repair-attempt',
            reasoning: 'repair-attempt',
            executionMode: 'workspace_controlled',
            steps: ['still-invalid-step'],
            successCriteria: [],
          }),
        };
      },
    },
    modelSelector: {
      select(kind) {
        return kind === 'planner' ? 'planner-model' : 'fast-model';
      },
    },
  });

  const result = await planner.planTask(
    {
      id: 'task-planner-3',
      title:
        'Use run_skill scaffold_node_http_service to scaffold a Node service named phase6-smoke on port 4100',
      description: 'Skill-based scaffold request.',
    },
    {
      workspaceRoot: '/tmp/localclaw-test-workspace',
      workspaceSnapshot: [],
      toolCatalog: 'run_skill(name, input)',
    }
  );

  assert.equal(result.modelUsed, 'deterministic_fallback');
  assert.equal(result.fallback, true);
  assert.equal(result.plan.steps[0].tool, 'run_skill');
  assert.equal(result.plan.steps[0].args.name, 'scaffold_node_http_service');
  assert.equal(result.plan.steps[0].args.input.projectName, 'phase6-smoke');
  assert.equal(result.plan.steps[0].args.input.servicePort, '4100');
});
