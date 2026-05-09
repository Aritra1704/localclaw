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

test('planner rejects absolute filesystem paths and repairs them through fallback output', async () => {
  let callCount = 0;

  const planner = createPlanner({
    client: {
      async generate() {
        callCount += 1;

        if (callCount === 1) {
          return {
            responseText: JSON.stringify({
              summary: 'Read the guide.',
              reasoning: 'Need to inspect one file first.',
              executionMode: 'workspace_controlled',
              steps: [
                {
                  stepNumber: 1,
                  objective: 'Read the guide file',
                  tool: 'read_file',
                  args: {
                    path: '/tmp/localclaw-test-workspace/docs/guide.md',
                    maxChars: 4000,
                  },
                },
              ],
              successCriteria: ['Guide file is read'],
            }),
          };
        }

        return {
          responseText: JSON.stringify({
            summary: 'Read the guide.',
            reasoning: 'A relative path keeps the plan portable.',
            executionMode: 'workspace_controlled',
            steps: [
              {
                stepNumber: 1,
                objective: 'Read the guide file',
                tool: 'read_file',
                args: {
                  path: 'docs/guide.md',
                  maxChars: 4000,
                },
              },
            ],
            successCriteria: ['Guide file is read'],
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
      id: 'task-planner-4',
      title: 'Read the guide',
      description: 'Analyze docs/guide.md and prepare a plan.',
    },
    {
      workspaceRoot: '/tmp/localclaw-test-workspace',
      workspaceSnapshot: [],
      toolCatalog: 'read_file(path, maxChars)',
    }
  );

  assert.equal(result.repaired, true);
  assert.equal(result.plan.steps[0].args.path, 'docs/guide.md');
});

test('planner keeps planning-only tasks scoped to the requested artifact shape', async () => {
  let callCount = 0;

  const planner = createPlanner({
    client: {
      async generate() {
        callCount += 1;

        if (callCount === 1) {
          return {
            responseText: JSON.stringify({
              summary: 'Plan Stage 1 work.',
              reasoning: 'Read the guide, then add deploy and audit follow-ups.',
              executionMode: 'workspace_controlled',
              steps: [
                {
                  stepNumber: 1,
                  objective: 'Read the guide file',
                  tool: 'read_file',
                  args: {
                    path: 'docs/guide.md',
                    maxChars: 4000,
                  },
                },
                {
                  stepNumber: 2,
                  objective: 'Append a deploy readiness checklist to README',
                  tool: 'write_file',
                  args: {
                    path: 'README.md',
                    content: '# Deploy\n',
                  },
                },
              ],
              successCriteria: ['Stage 1 plan exists'],
            }),
          };
        }

        return {
          responseText: JSON.stringify({
            summary: 'Plan Stage 1 work.',
            reasoning: 'Keep the plan scoped to the requested stage.',
            executionMode: 'workspace_controlled',
            steps: [
              {
                stepNumber: 1,
                objective: 'Read the guide file',
                tool: 'read_file',
                args: {
                  path: 'docs/guide.md',
                  maxChars: 4000,
                },
              },
              {
                stepNumber: 2,
                objective: 'Write the Stage 1 task plan notes',
                tool: 'write_file',
                args: {
                  path: 'docs/stage1-task-plan.md',
                  content: '# Stage 1\n',
                },
              },
            ],
            successCriteria: ['Stage 1 plan exists'],
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
      id: 'task-planner-5',
      title: 'Create a task plan for Stage 1',
      description:
        'Read docs/guide.md and create a task plan for Stage 1 only. Do not execute commands. Output an ordered task list with dependencies, checks, and approval points.',
    },
    {
      workspaceRoot: '/tmp/localclaw-test-workspace',
      workspaceSnapshot: [],
      toolCatalog: 'read_file(path, maxChars), write_file(path, content, overwrite)',
    }
  );

  assert.equal(result.modelUsed, 'deterministic_planning_only');
  assert.equal(result.plan.steps.length, 2);
  assert.equal(result.plan.steps[1].args.path, 'docs/stage-1-task-plan.md');
  assert.equal(callCount, 0);
});

test('planner uses deterministic planning-only mode for task-plan requests', async () => {
  let called = false;

  const planner = createPlanner({
    client: {
      async generate() {
        called = true;
        throw new Error('should not be called for planning-only tasks');
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
      id: 'task-planner-6',
      title: 'Create a task plan for Stage 1',
      description:
        'Read /tmp/project/docs/localclaw_execution_guide.md and create a task plan for Stage 1 only. Do not execute commands. Output an ordered task list with dependencies, checks, and approval points.',
    },
    {
      workspaceRoot: '/tmp/project',
      workspaceSnapshot: [],
      toolCatalog: 'read_file(path, maxChars), write_file(path, content, overwrite)',
    }
  );

  assert.equal(called, false);
  assert.equal(result.modelUsed, 'deterministic_planning_only');
  assert.equal(result.plan.steps[0].tool, 'read_file');
  assert.equal(result.plan.steps[0].args.path, 'docs/localclaw_execution_guide.md');
  assert.equal(result.plan.steps[1].args.path, 'docs/stage-1-task-plan.md');
});
