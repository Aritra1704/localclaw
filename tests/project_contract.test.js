import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  BASELINE_GITIGNORE_LINES,
  buildBaselineGitIgnore,
  collectWorkspaceJunk,
  removeWorkspaceJunk,
  seedRepoContract,
  shouldIgnoreWorkspaceEntry,
} from '../src/project/contract.js';

test('workspace ignore rules classify macOS junk correctly', () => {
  assert.equal(shouldIgnoreWorkspaceEntry('._README.md'), true);
  assert.equal(shouldIgnoreWorkspaceEntry('src/._app.js'), true);
  assert.equal(shouldIgnoreWorkspaceEntry('.DS_Store'), true);
  assert.equal(shouldIgnoreWorkspaceEntry('.Spotlight-V100/index'), true);
  assert.equal(shouldIgnoreWorkspaceEntry('.opskit/settings.json'), false);
  assert.equal(shouldIgnoreWorkspaceEntry('PROJECT_CONTEXT.md'), false);
});

test('repo contract seeding creates required baseline files', async () => {
  const workspaceRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), 'localclaw-contract-')
  );

  await seedRepoContract({
    workspaceRoot,
    task: {
      id: 'task-123',
      title: 'phase4-sample-app',
      description: 'Create a deploy-ready sample app.',
      priority: 'medium',
      source: 'test',
    },
  });

  const requiredPaths = [
    '.gitignore',
    'PROJECT_CONTEXT.md',
    'PROJECT_CONTEXT.local.md',
    'PROJECT_RULES.md',
    '.opskit/README.md',
    '.opskit/settings.json',
    '.opskit/settings.local.json',
    '.opskit/commands/review.md',
    '.opskit/commands/fix-issue.md',
    '.opskit/commands/deploy.md',
    '.opskit/rules/code-style.md',
    '.opskit/rules/testing.md',
    '.opskit/rules/api.md',
    '.opskit/skills/workspace-hygiene/SKILL.md',
    '.opskit/skills/deploy-readiness/SKILL.md',
    '.opskit/agents/reviewer.md',
    '.opskit/agents/security.md',
    '.opskit/agents/release.md',
  ];

  for (const relativePath of requiredPaths) {
    const absolutePath = path.join(workspaceRoot, relativePath);
    const stats = await fs.stat(absolutePath);
    assert.equal(stats.isFile(), true, `${relativePath} should exist`);
  }

  const gitIgnore = await fs.readFile(path.join(workspaceRoot, '.gitignore'), 'utf8');
  for (const line of BASELINE_GITIGNORE_LINES) {
    assert.match(gitIgnore, new RegExp(line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  const junkAfterSeed = await collectWorkspaceJunk(workspaceRoot);
  assert.deepEqual(junkAfterSeed, []);
});

test('workspace junk cleanup removes AppleDouble files', async () => {
  const workspaceRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), 'localclaw-junk-')
  );

  await fs.mkdir(path.join(workspaceRoot, 'src'), { recursive: true });
  await fs.writeFile(path.join(workspaceRoot, 'README.md'), 'ok\n', 'utf8');
  await fs.writeFile(path.join(workspaceRoot, '._README.md'), 'junk', 'utf8');
  await fs.writeFile(path.join(workspaceRoot, 'src', '._app.js'), 'junk', 'utf8');
  await fs.writeFile(path.join(workspaceRoot, '.DS_Store'), 'junk', 'utf8');

  const beforeCleanup = await collectWorkspaceJunk(workspaceRoot);
  assert.equal(beforeCleanup.length >= 3, true);

  await removeWorkspaceJunk(workspaceRoot);
  const afterCleanup = await collectWorkspaceJunk(workspaceRoot);
  assert.deepEqual(afterCleanup, []);
  assert.equal(buildBaselineGitIgnore().includes('._*'), true);
});
