import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import pino from 'pino';

import { getPool } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { createSkillManager } from '../src/skills/manager.js';
import { createToolRegistry } from '../src/tools/registry.js';

const logger = pino({ level: 'fatal' });
const pool = getPool();

async function cleanupSkill(name) {
  await pool.query('DELETE FROM skills WHERE name = $1', [name]);
}

test('skills manager syncs built-ins, enforces enable policy, and logs runs', async () => {
  await runMigrations();

  const skillName = `test_skill_phase6_${Date.now()}`;
  const skillDir = await fs.mkdtemp(path.join(os.tmpdir(), 'localclaw-skills-'));
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'localclaw-workspace-'));
  const skillPath = path.join(skillDir, `${skillName}.json`);

  await fs.writeFile(
    skillPath,
    JSON.stringify(
      {
        name: skillName,
        version: 1,
        description: 'Phase 6 test skill',
        sourceType: 'builtin',
        isEnabled: true,
        inputDefaults: {
          text: 'fallback-text',
        },
        steps: [
          {
            tool: 'append_file',
            args: {
              path: 'README.md',
              content: '\n{{text}}\n',
            },
          },
        ],
      },
      null,
      2
    ),
    'utf8'
  );

  const skillManager = createSkillManager({
    logger,
    pool,
    builtInDirectory: skillDir,
  });

  await cleanupSkill(skillName);
  const syncSummary = await skillManager.syncRegistry();
  assert.equal(syncSummary.builtInsDiscovered, 1);

  const listed = await skillManager.listSkills({
    includeDisabled: true,
    sourceType: 'builtin',
    limit: 50,
  });
  assert.equal(listed.some((skill) => skill.name === skillName), true);

  const disabled = await skillManager.setSkillEnabled(skillName, false);
  assert.equal(disabled?.is_enabled, false);

  await assert.rejects(
    () =>
      skillManager.executeSkill({
        name: skillName,
        input: { text: 'disabled-run' },
        workspaceRoot,
        toolRunner: async () => ({ summary: 'noop', artifacts: [] }),
      }),
    /disabled/
  );

  await skillManager.setSkillEnabled(skillName, true);

  const toolRegistry = createToolRegistry({ skillManager });
  await toolRegistry.runTool(
    'run_skill',
    {
      name: skillName,
      input: { text: 'phase6-run' },
    },
    {
      workspaceRoot,
      taskId: null,
    }
  );

  const readme = await fs.readFile(path.join(workspaceRoot, 'README.md'), 'utf8');
  assert.match(readme, /phase6-run/);

  const runResult = await pool.query(
    `SELECT
       skill_runs.status,
       skill_runs.skill_version,
       skill_runs.output_summary
     FROM skill_runs
     JOIN skills ON skills.id = skill_runs.skill_id
     WHERE skills.name = $1
     ORDER BY skill_runs.created_at DESC
     LIMIT 1`,
    [skillName]
  );

  assert.equal(runResult.rowCount, 1);
  assert.equal(runResult.rows[0].status, 'success');
  assert.equal(runResult.rows[0].skill_version, 1);
  assert.match(runResult.rows[0].output_summary, /append_file/);

  await cleanupSkill(skillName);
});

test('generated skill creation is blocked when explicit guardrail is not enabled', async () => {
  await runMigrations();

  const skillManager = createSkillManager({
    logger,
    pool,
    builtInDirectory: path.join(process.cwd(), 'skills', 'builtin'),
  });

  await assert.rejects(
    () =>
      skillManager.createGeneratedSkill({
        name: 'generated_phase6_test_skill',
        description: 'guardrail test',
        definition: {
          steps: [
            {
              tool: 'write_file',
              args: {
                path: 'README.md',
                content: 'test',
              },
            },
          ],
        },
        enableRequested: true,
        confirmation: 'ALLOW_GENERATED_SKILL',
      }),
    /Generated skill creation is disabled/
  );
});

test('skills manager maps port->servicePort and projectName->serviceRoot for templates', async () => {
  await runMigrations();

  const skillName = `test_skill_aliases_${Date.now()}`;
  const skillDir = await fs.mkdtemp(path.join(os.tmpdir(), 'localclaw-skills-alias-'));
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'localclaw-workspace-alias-'));
  const skillPath = path.join(skillDir, `${skillName}.json`);

  await fs.writeFile(
    skillPath,
    JSON.stringify(
      {
        name: skillName,
        version: 1,
        description: 'Alias mapping test skill',
        sourceType: 'builtin',
        isEnabled: true,
        inputDefaults: {},
        steps: [
          {
            tool: 'make_dir',
            args: {
              path: '{{serviceRoot}}',
            },
          },
          {
            tool: 'write_file',
            args: {
              path: '{{serviceRoot}}/PORT.txt',
              content: '{{servicePort}}',
              overwrite: true,
            },
          },
        ],
      },
      null,
      2
    ),
    'utf8'
  );

  const skillManager = createSkillManager({
    logger,
    pool,
    builtInDirectory: skillDir,
  });

  await cleanupSkill(skillName);
  await skillManager.syncRegistry();

  const toolRegistry = createToolRegistry({ skillManager });
  await toolRegistry.runTool(
    'run_skill',
    {
      name: skillName,
      input: {
        projectName: 'phase6-smoke',
        port: 4100,
      },
    },
    {
      workspaceRoot,
      taskId: null,
    }
  );

  const portText = await fs.readFile(
    path.join(workspaceRoot, 'phase6-smoke', 'PORT.txt'),
    'utf8'
  );
  assert.equal(portText, '4100');

  await cleanupSkill(skillName);
});
