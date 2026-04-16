import fs from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

const projectNameSchema = z.string().trim().min(1).max(120);

function normalizeRoot(value) {
  return path.resolve(value).replace(/\/+$/, '');
}

function isInsideRoot(candidatePath, rootPath) {
  const relative = path.relative(rootPath, candidatePath);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

export function createProjectService({ pool, workspaceRoots = [] }) {
  if (!pool) {
    throw new Error('Project service requires a database pool');
  }

  const allowedRoots = [...new Set(workspaceRoots.map(normalizeRoot))];
  if (allowedRoots.length === 0) {
    throw new Error('Project service requires at least one workspace root');
  }

  async function validateProjectPath(rawPath) {
    const resolved = normalizeRoot(rawPath);
    const allowedRoot = allowedRoots.find((root) => isInsideRoot(resolved, root));

    if (!allowedRoot) {
      throw new Error(
        `Project path is outside allowed workspace roots: ${allowedRoots.join(', ')}`
      );
    }

    const stat = await fs.stat(resolved).catch(() => null);
    if (!stat?.isDirectory()) {
      throw new Error(`Project path does not exist or is not a directory: ${resolved}`);
    }

    return {
      rootPath: resolved,
      allowedRoot,
    };
  }

  return {
    allowedRoots,

    async listProjects() {
      const result = await pool.query(
        `SELECT id, name, root_path, created_at, updated_at
         FROM project_targets
         ORDER BY updated_at DESC, created_at DESC`
      );

      return {
        allowedRoots,
        projects: result.rows,
      };
    },

    async addProject({ name, rootPath }) {
      const validation = await validateProjectPath(rootPath);
      const resolvedName =
        name && `${name}`.trim()
          ? projectNameSchema.parse(name)
          : path.basename(validation.rootPath) || validation.rootPath;

      const result = await pool.query(
        `INSERT INTO project_targets (name, root_path, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (root_path)
         DO UPDATE SET name = EXCLUDED.name, updated_at = NOW()
         RETURNING id, name, root_path, created_at, updated_at`,
        [resolvedName, validation.rootPath]
      );

      return result.rows[0];
    },

    async ensureProjectTarget(rootPath, options = {}) {
      if (!rootPath) {
        return null;
      }

      return this.addProject({
        name: options.name,
        rootPath,
      });
    },

    async getProject(id) {
      const result = await pool.query(
        `SELECT id, name, root_path, created_at, updated_at
         FROM project_targets
         WHERE id = $1`,
        [id]
      );
      return result.rows[0] ?? null;
    },

    async deleteProject(id) {
      const result = await pool.query(
        `DELETE FROM project_targets
         WHERE id = $1
         RETURNING id, name, root_path, created_at, updated_at`,
        [id]
      );

      return result.rows[0] ?? null;
    },

    validateProjectPath,
  };
}
