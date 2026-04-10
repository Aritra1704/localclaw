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
});
