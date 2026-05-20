import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import pino from 'pino';

import { createSkillManager } from '../src/skills/manager.js';
import { createToolRegistry } from '../src/tools/registry.js';

const logger = pino({ level: 'fatal' });

function createSkillsPool() {
  const skills = new Map();
  const skillRuns = [];

  return {
    skills,
    skillRuns,
    async query(sql, params = []) {
      if (sql.includes('DELETE FROM skills WHERE name = $1')) {
        skills.delete(params[0]);
        return { rowCount: 1, rows: [] };
      }

      if (sql.includes('SELECT id, version') && sql.includes('FROM skills')) {
        const skill = skills.get(params[0]);
        return { rows: skill ? [{ id: skill.id, version: skill.version }] : [] };
      }

      if (sql.includes('INSERT INTO skills')) {
        const generated = sql.includes("'generated'");
        const name = generated ? params[1] : params[0];
        const skill = {
          id: (generated ? params[0] : skills.get(name)?.id) ?? skills.get(name)?.id ?? randomUUID(),
          name,
          version: generated ? params[2] : params[1],
          source_type: generated ? 'generated' : params[2],
          description: generated ? params[3] : params[3],
          definition: JSON.parse(generated ? params[4] : params[4]),
          is_enabled: generated ? params[5] : params[5] ?? true,
          updated_at: new Date().toISOString(),
        };
        skills.set(name, skill);
        return { rows: [{ ...skill }] };
      }

      if (sql.includes('SELECT') && sql.includes('FROM skills') && sql.includes('definition') && sql.includes('is_enabled') && sql.includes('WHERE name = $1')) {
        const skill = skills.get(params[0]);
        return { rows: skill ? [{ ...skill }] : [] };
      }

      if (sql.includes('FROM skills') && sql.includes('LEFT JOIN') && sql.includes('skill_runs')) {
        const includeDisabled = params[0];
        const sourceType = params[1];
        const limit = params[2];
        const rows = [...skills.values()]
          .filter((skill) => includeDisabled || skill.is_enabled === true)
          .filter((skill) => !sourceType || skill.source_type === sourceType)
          .sort((a, b) => a.name.localeCompare(b.name))
          .slice(0, limit)
          .map((skill) => {
            const related = skillRuns.filter((run) => run.skill_id === skill.id);
            return {
              id: skill.id,
              name: skill.name,
              version: skill.version,
              source_type: skill.source_type,
              description: skill.description,
              is_enabled: skill.is_enabled,
              updated_at: skill.updated_at,
              total_runs: related.length,
              success_runs: related.filter((run) => run.status === 'success').length,
              failed_runs: related.filter((run) => run.status === 'error').length,
              last_run_at: related.at(-1)?.created_at ?? null,
            };
          });
        return { rows };
      }

      if (sql.includes('UPDATE skills') && sql.includes('RETURNING id, name, source_type, version, is_enabled')) {
        const skill = skills.get(params[0]);
        if (!skill) {
          return { rows: [] };
        }
        skill.is_enabled = params[1];
        skill.updated_at = new Date().toISOString();
        return {
          rows: [
            {
              id: skill.id,
              name: skill.name,
              source_type: skill.source_type,
              version: skill.version,
              is_enabled: skill.is_enabled,
            },
          ],
        };
      }

      if (sql.includes('FROM skills') && sql.includes('WHERE is_enabled = TRUE')) {
        const patterns = params[0];
        const limit = params[1];
        const rows = [...skills.values()]
          .filter((skill) => skill.is_enabled === true)
          .filter((skill) =>
            patterns.some((pattern) => {
              const needle = pattern.replaceAll('%', '').toLowerCase();
              return JSON.stringify(skill.definition).toLowerCase().includes(needle);
            })
          )
          .slice(0, limit)
          .map((skill) => ({
            name: skill.name,
            version: skill.version,
            description: skill.description,
            source_type: skill.source_type,
          }));
        return { rows };
      }

      if (sql.includes('INSERT INTO skill_runs')) {
        skillRuns.push({
          skill_id: params[0],
          task_id: params[1],
          skill_version: params[2],
          status: params[3],
          duration_ms: params[4],
          error_message: params[5],
          input_payload: JSON.parse(params[6]),
          output_summary: params[7],
          created_at: new Date().toISOString(),
        });
        return { rows: [{ id: randomUUID() }] };
      }

      if (sql.includes('SELECT\n       skill_runs.status,') && sql.includes('JOIN skills ON skills.id = skill_runs.skill_id')) {
        const skill = skills.get(params[0]);
        const run = [...skillRuns].reverse().find((entry) => entry.skill_id === skill?.id);
        return {
          rowCount: run ? 1 : 0,
          rows: run
            ? [
                {
                  status: run.status,
                  skill_version: run.skill_version,
                  output_summary: run.output_summary,
                },
              ]
            : [],
        };
      }

      if (sql.includes('FROM skills') && sql.includes('ORDER BY name ASC') && !sql.includes('LEFT JOIN')) {
        return {
          rows: [...skills.values()]
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((skill) => ({ ...skill })),
        };
      }

      throw new Error(`Unexpected query: ${sql.slice(0, 140)}`);
    },
  };
}

test('skills manager syncs built-ins, enforces enable policy, and logs runs', async () => {
  const pool = createSkillsPool();

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

  await pool.query('DELETE FROM skills WHERE name = $1', [skillName]);
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

  await pool.query('DELETE FROM skills WHERE name = $1', [skillName]);
});

test('generated skill creation is blocked when explicit guardrail is not enabled', async () => {
  const pool = createSkillsPool();

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
  const pool = createSkillsPool();

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

  await pool.query('DELETE FROM skills WHERE name = $1', [skillName]);
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

  await pool.query('DELETE FROM skills WHERE name = $1', [skillName]);
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
