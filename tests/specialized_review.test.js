import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createSpecializedReviewService } from '../src/agent/specializedReview.js';

test('specialized review refreshes README and architecture docs for code workspaces', async () => {
  const workspaceRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), 'localclaw-specialized-docs-')
  );

  await fs.mkdir(path.join(workspaceRoot, 'src'), { recursive: true });
  await fs.writeFile(path.join(workspaceRoot, 'src', 'index.js'), 'export const ok = true;\n');
  await fs.writeFile(
    path.join(workspaceRoot, 'package.json'),
    JSON.stringify(
      {
        name: 'phase10-app',
        main: 'src/index.js',
        scripts: {
          start: 'node src/index.js',
        },
        dependencies: {
          express: '4.20.0',
        },
      },
      null,
      2
    )
  );
  await fs.writeFile(path.join(workspaceRoot, 'package-lock.json'), '{}\n');

  const reviewer = createSpecializedReviewService();
  const result = await reviewer.reviewTask(
    {
      id: 'task-phase10-docs',
      title: 'Build phase10 sample',
      description: 'Create a small service and keep the docs synchronized.',
      project_name: 'phase10-app',
    },
    {
      workspaceRoot,
      workspaceName: 'phase10-app',
    }
  );

  assert.equal(result.status, 'passed');
  assert.equal(result.agents[0].name, 'documentation');
  const readme = await fs.readFile(path.join(workspaceRoot, 'README.md'), 'utf8');
  const architecture = await fs.readFile(
    path.join(workspaceRoot, 'docs', 'ARCHITECTURE.md'),
    'utf8'
  );

  assert.match(readme, /localclaw:autodoc:readme:start/);
  assert.match(readme, /src\/index\.js/);
  assert.match(architecture, /localclaw:autodoc:architecture:start/);
  assert.match(architecture, /src\/index\.js/);
});

test('specialized review blocks on high-confidence secret patterns', async () => {
  const workspaceRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), 'localclaw-specialized-security-')
  );

  await fs.mkdir(path.join(workspaceRoot, 'src'), { recursive: true });
  await fs.writeFile(
    path.join(workspaceRoot, 'src', 'config.js'),
    'export const token = "sk-abcdefghijklmnopqrstuvwxyz123456";\n'
  );

  const reviewer = createSpecializedReviewService();
  const result = await reviewer.reviewTask(
    {
      id: 'task-phase10-security',
      title: 'Test security review',
      description: 'Create a config file.',
      project_name: 'security-app',
    },
    {
      workspaceRoot,
      workspaceName: 'security-app',
    }
  );

  const securityAgent = result.agents.find((agent) => agent.name === 'security');

  assert.equal(result.status, 'failed');
  assert.equal(securityAgent?.status, 'failed');
  assert.equal(
    securityAgent?.findings.some((finding) => finding.type === 'OpenAI API key'),
    true
  );
});

test('dependency agent creates follow-up tasks for vulnerable package baselines', async () => {
  const workspaceRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), 'localclaw-specialized-deps-')
  );

  await fs.writeFile(
    path.join(workspaceRoot, 'package.json'),
    JSON.stringify(
      {
        name: 'dependency-app',
        dependencies: {
          lodash: '4.17.20',
        },
      },
      null,
      2
    )
  );
  await fs.writeFile(path.join(workspaceRoot, 'package-lock.json'), '{}\n');

  const reviewer = createSpecializedReviewService();
  const result = await reviewer.reviewTask(
    {
      id: 'task-phase10-deps',
      title: 'Audit dependencies',
      description: 'Check package safety.',
      project_name: 'dependency-app',
    },
    {
      workspaceRoot,
      workspaceName: 'dependency-app',
    }
  );

  const dependencyAgent = result.agents.find((agent) => agent.name === 'dependency');

  assert.equal(result.status, 'needs_human_review');
  assert.equal(dependencyAgent?.status, 'needs_human_review');
  assert.equal(result.followUpTasks.length, 1);
  assert.match(result.followUpTasks[0].title, /Patch dependency lodash/);
});
