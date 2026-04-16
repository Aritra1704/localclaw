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

test('skills manager uses postgres MCP server for registry, lookup, and run logging', async () => {
  const skillName = `test_skill_mcp_${Date.now()}`;
  const skillDir = await fs.mkdtemp(path.join(os.tmpdir(), 'localclaw-skills-mcp-'));
  const skillPath = path.join(skillDir, `${skillName}.json`);
  const toolCalls = [];
  const skills = new Map();
  const runs = [];

  await fs.writeFile(
    skillPath,
    JSON.stringify(
      {
        name: skillName,
        version: 1,
        description: 'Phase 11 MCP skill test',
        sourceType: 'builtin',
        isEnabled: true,
        inputDefaults: {
          text: 'fallback',
        },
        steps: [
          {
            tool: 'append_file',
            args: {
              path: 'README.md',
              content: '{{text}}',
            },
          },
        ],
      },
      null,
      2
    ),
    'utf8'
  );

  const postgresServer = {
    async callTool(toolName, args = {}) {
      toolCalls.push(toolName);

      switch (toolName) {
        case 'get_skill_by_name': {
          const row = skills.get(args.name);
          return { rows: row ? [{ ...row }] : [] };
        }

        case 'upsert_skill_definition': {
          const row = {
            id: args.id ?? `skill-${skills.size + 1}`,
            name: args.name,
            version: args.version,
            source_type: args.sourceType,
            description: args.description,
            definition: args.definition,
            is_enabled: args.isEnabled,
            updated_at: new Date().toISOString(),
          };
          skills.set(args.name, row);
          return { rows: [{ ...row }] };
        }

        case 'list_skills_catalog': {
          const rows = [...skills.values()]
            .filter((row) => (args.includeDisabled ?? true) || row.is_enabled)
            .filter((row) => !args.sourceType || row.source_type === args.sourceType)
            .sort((left, right) => left.name.localeCompare(right.name))
            .slice(0, args.limit ?? 20)
            .map((row) => {
              const base = {
                id: row.id,
                name: row.name,
                version: row.version,
                source_type: row.source_type,
                description: row.description,
                is_enabled: row.is_enabled,
                updated_at: row.updated_at,
              };

              if (args.includeDefinition) {
                base.definition = row.definition;
              }

              if (args.includeMetrics) {
                const relatedRuns = runs.filter((run) => run.skill_id === row.id);
                base.total_runs = relatedRuns.length;
                base.success_runs = relatedRuns.filter((run) => run.status === 'success').length;
                base.failed_runs = relatedRuns.filter((run) => run.status === 'error').length;
                base.last_run_at = relatedRuns.at(-1)?.created_at ?? null;
              }

              return base;
            });
          return { rows };
        }

        case 'set_skill_enabled': {
          const row = skills.get(args.name);
          if (!row) {
            return { rows: [] };
          }

          row.is_enabled = args.enabled;
          row.updated_at = new Date().toISOString();
          return {
            rows: [
              {
                id: row.id,
                name: row.name,
                source_type: row.source_type,
                version: row.version,
                is_enabled: row.is_enabled,
              },
            ],
          };
        }

        case 'search_enabled_skills': {
          const rows = [...skills.values()]
            .filter((row) => row.is_enabled)
            .filter((row) =>
              (args.patterns ?? []).some((pattern) => {
                const needle = pattern.replaceAll('%', '').toLowerCase();
                return JSON.stringify(row.definition).toLowerCase().includes(needle);
              })
            )
            .map((row) => ({
              name: row.name,
              version: row.version,
              description: row.description,
              source_type: row.source_type,
            }))
            .slice(0, args.limit ?? 4);
          return { rows };
        }

        case 'insert_skill_run': {
          runs.push({
            skill_id: args.skillId,
            status: args.status,
            skill_version: args.skillVersion,
            output_summary: args.outputSummary,
            created_at: new Date().toISOString(),
          });
          return { rows: [{ id: `run-${runs.length}` }] };
        }

        default:
          throw new Error(`Unexpected tool: ${toolName}`);
      }
    },
  };

  const skillManager = createSkillManager({
    logger,
    pool: {
      query() {
        throw new Error('pool.query should not be used when MCP server is available');
      },
    },
    builtInDirectory: skillDir,
    mcpRegistry: {
      getServer(name) {
        return name === 'postgres' ? postgresServer : null;
      },
    },
  });

  const syncSummary = await skillManager.syncRegistry();
  assert.equal(syncSummary.builtInsDiscovered, 1);

  const listed = await skillManager.listSkills({
    includeDisabled: true,
    sourceType: 'builtin',
    limit: 10,
  });
  assert.equal(listed.some((skill) => skill.name === skillName), true);

  const suggested = await skillManager.suggestSkillsForTask({
    title: 'Need README append helper',
    description: 'append file content into the project readme',
  });
  assert.equal(suggested.some((skill) => skill.name === skillName), true);

  const execution = await skillManager.executeSkill({
    name: skillName,
    input: { text: 'from-mcp' },
    workspaceRoot: '/tmp/workspace-not-used',
    toolRunner: async (tool, args) => ({
      summary: `${tool}:${args.path}`,
      artifacts: [],
    }),
  });

  assert.equal(execution.output.skill, skillName);
  assert.equal(runs.length, 1);
  assert.deepEqual(
    toolCalls.filter((toolName) =>
      [
        'get_skill_by_name',
        'upsert_skill_definition',
        'list_skills_catalog',
        'search_enabled_skills',
        'insert_skill_run',
      ].includes(toolName)
    ),
    [
      'get_skill_by_name',
      'upsert_skill_definition',
      'list_skills_catalog',
      'list_skills_catalog',
      'search_enabled_skills',
      'get_skill_by_name',
      'insert_skill_run',
    ]
  );
});
