import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createProjectService } from '../src/control/projects.js';

test('project service only accepts paths inside configured workspace roots', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'localclaw-workspace-'));
  const projectPath = path.join(workspace, 'demo');
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'localclaw-outside-'));
  const rows = [];

  await fs.mkdir(projectPath);

  const pool = {
    async query(sql, params = []) {
      if (sql.includes('INSERT INTO project_targets')) {
        const row = {
          id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          name: params[0],
          root_path: params[1],
        };
        rows.push(row);
        return { rows: [row] };
      }

      if (sql.includes('SELECT id, name, root_path')) {
        return { rows };
      }

      if (sql.includes('DELETE FROM project_targets')) {
        const index = rows.findIndex((row) => row.id === params[0]);
        if (index === -1) {
          return { rows: [] };
        }

        const [deleted] = rows.splice(index, 1);
        return { rows: [deleted] };
      }

      throw new Error(`Unexpected query: ${sql}`);
    },
  };

  const service = createProjectService({
    pool,
    workspaceRoots: [workspace],
  });

  const project = await service.addProject({
    name: 'demo',
    rootPath: projectPath,
  });
  assert.equal(project.name, 'demo');
  assert.equal(project.root_path, projectPath);

  await assert.rejects(
    () => service.addProject({ rootPath: outside }),
    /outside allowed workspace roots/
  );

  const deleted = await service.deleteProject(project.id);
  assert.equal(deleted?.id, project.id);

  const missing = await service.deleteProject(project.id);
  assert.equal(missing, null);
});

test('project service uses postgres MCP server when available', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'localclaw-workspace-mcp-'));
  const projectPath = path.join(workspace, 'demo');
  await fs.mkdir(projectPath);

  const calls = [];
  const postgresServer = {
    async callTool(toolName, args) {
      calls.push({ toolName, args });

      switch (toolName) {
        case 'upsert_project_target':
          return {
            rows: [
              {
                id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                name: args.name,
                root_path: args.rootPath,
              },
            ],
          };
        case 'list_project_targets':
          return {
            rows: [
              {
                id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                name: 'demo',
                root_path: projectPath,
              },
            ],
          };
        case 'delete_project_target':
          return {
            rows: [
              {
                id: args.id,
                name: 'demo',
                root_path: projectPath,
              },
            ],
          };
        default:
          throw new Error(`Unexpected MCP tool: ${toolName}`);
      }
    },
  };

  const service = createProjectService({
    pool: {
      async query() {
        throw new Error('Direct pool.query should not be used in this test');
      },
    },
    mcpRegistry: {
      getServer(name) {
        return name === 'postgres' ? postgresServer : null;
      },
    },
    workspaceRoots: [workspace],
  });

  const project = await service.addProject({
    name: 'demo',
    rootPath: projectPath,
  });
  const listed = await service.listProjects();
  const deleted = await service.deleteProject(project.id);

  assert.equal(project.root_path, projectPath);
  assert.equal(listed.projects.length, 1);
  assert.equal(deleted.id, project.id);
  assert.deepEqual(
    calls.map((entry) => entry.toolName),
    ['upsert_project_target', 'list_project_targets', 'delete_project_target']
  );
});
