import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createPlanner } from '../src/agent/planner.js';
import { buildPlannerLongContext } from '../src/agent/plannerContext.js';

test('planner long context includes top-level docs and referenced files', async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'localclaw-planner-context-'));
  await fs.writeFile(path.join(projectRoot, 'README.md'), '# Demo Project\n\nTop-level context.\n');
  await fs.mkdir(path.join(projectRoot, 'docs'), { recursive: true });
  await fs.writeFile(
    path.join(projectRoot, 'docs', 'localclaw_master_hld.md'),
    '# HLD\n\nHybrid provider foundation details.\n'
  );
  await fs.mkdir(path.join(projectRoot, 'src'), { recursive: true });
  await fs.writeFile(
    path.join(projectRoot, 'src', 'index.js'),
    'export function bootstrap() {\n  return "ok";\n}\n'
  );

  const result = await buildPlannerLongContext(
    {
      title: 'Review docs/localclaw_master_hld.md',
      description: 'Use docs/localclaw_master_hld.md and update src/index.js accordingly.',
    },
    {
      projectRoot,
      workspaceSnapshot: [
        { path: 'docs/localclaw_master_hld.md', type: 'file' },
        { path: 'src/index.js', type: 'file' },
      ],
    }
  );

  assert.match(result.text, /Full top-level doc: README\.md/);
  assert.match(result.text, /Full top-level doc: docs\/localclaw_master_hld\.md/);
  assert.match(result.text, /Selected critical file: src\/index\.js/);
  assert.deepEqual(result.diagnostics.docs, ['README.md', 'docs/localclaw_master_hld.md']);
  assert.deepEqual(result.diagnostics.criticalFiles, ['src/index.js']);
});

test('planner prompt includes expanded planner context when provided', async () => {
  let capturedPrompt = null;
  const planner = createPlanner({
    client: {
      async generate(input) {
        capturedPrompt = input.prompt;
        return {
          responseText: JSON.stringify({
            summary: 'Update the runtime.',
            reasoning: 'Use the provided docs and critical files.',
            executionMode: 'workspace_controlled',
            steps: [
              {
                stepNumber: 1,
                objective: 'Write the runtime update',
                tool: 'write_file',
                args: {
                  path: 'src/index.js',
                  content: 'export const ok = true;\n',
                },
              },
            ],
            successCriteria: ['Runtime file is updated'],
            notesForVerifier: [],
          }),
        };
      },
    },
    modelSelector: {
      select(role) {
        return role === 'planner' ? 'planner-model' : 'fast-model';
      },
    },
  });

  await planner.planTask(
    {
      id: 'task-planner-context-1',
      title: 'Update the runtime',
      description: 'Refactor the bootstrap path.',
    },
    {
      workspaceRoot: '/tmp/localclaw-test-workspace',
      workspaceSnapshot: [],
      toolCatalog: 'write_file(path, content)',
      plannerContext: 'Expanded planner context:\nFull top-level doc: README.md\n---\n# Demo',
    }
  );

  assert.match(capturedPrompt, /Expanded planner context:/);
  assert.match(capturedPrompt, /Full top-level doc: README\.md/);
});

