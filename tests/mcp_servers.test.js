import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createFilesystemMcpServer } from '../src/mcp/filesystemServer.js';
import { createGitHubMcpServer } from '../src/mcp/githubServer.js';
import { createPostgresMcpServer } from '../src/mcp/postgresServer.js';
import { createMcpRegistry } from '../src/mcp/registry.js';
import { createToolRegistry } from '../src/tools/registry.js';

test('filesystem MCP server and tool registry standardize workspace file operations', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'localclaw-mcp-fs-'));
  const filesystemServer = createFilesystemMcpServer();
  const mcpRegistry = createMcpRegistry({
    servers: [filesystemServer],
  });
  const toolRegistry = createToolRegistry({
    mcpRegistry,
  });

  await toolRegistry.runTool(
    'write_file',
    {
      path: 'README.md',
      content: '# Hello\n',
      overwrite: true,
    },
    { workspaceRoot }
  );

  const readResult = await toolRegistry.runTool(
    'read_file',
    {
      path: 'README.md',
      maxChars: 100,
    },
    { workspaceRoot }
  );
  const listResult = await toolRegistry.runTool(
    'list_files',
    {
      path: '.',
      recursive: true,
      limit: 20,
    },
    { workspaceRoot }
  );

  assert.match(readResult.output, /Hello/);
  assert.equal(listResult.output.some((entry) => entry.path === 'README.md'), true);
  assert.equal(mcpRegistry.listTools('filesystem').some((tool) => tool.name === 'write_file'), true);
});

test('postgres MCP server standardizes retrieval queries and active-task lookups', async () => {
  const calls = [];
  const pool = {
    async query(sql, params) {
      calls.push({ sql, params });

      if (sql.includes('FROM learnings')) {
        return {
          rows: [
            {
              id: '11111111-1111-4111-8111-111111111111',
              category: 'execution',
              observation: 'Keep plans bounded.',
              confidence_score: 8,
            },
          ],
        };
      }

      if (sql.includes('FROM document_chunks')) {
        return {
          rows: [
            {
              content: 'Phase 11 note',
              title: 'Context',
              source_path: 'docs/context.md',
            },
          ],
        };
      }

      if (sql.includes('UPDATE learnings')) {
        return { rowCount: 1, rows: [] };
      }

      if (sql.includes('FROM tasks')) {
        return {
          rows: [{ id: 'active-task-1' }],
        };
      }

      if (sql.includes('FROM agent_logs')) {
        return { rows: [] };
      }

      throw new Error(`Unexpected query: ${sql.slice(0, 80)}`);
    },
  };

  const server = createPostgresMcpServer({ pool });

  const learningResult = await server.callTool('search_learnings', {
    keywords: ['phase', 'mcp'],
    limit: 5,
  });
  const chunkResult = await server.callTool('search_document_chunks', {
    keywords: ['phase'],
    limit: 4,
  });
  const activeTaskResult = await server.callTool('find_active_task_by_title', {
    title: 'Patch dependency lodash for sample-app',
    source: 'phase10_dependency_agent',
  });
  await server.callTool('bump_learning_usage', {
    learningIds: ['11111111-1111-4111-8111-111111111111'],
  });

  assert.equal(learningResult.rows.length, 1);
  assert.equal(chunkResult.rows[0].source_path, 'docs/context.md');
  assert.equal(activeTaskResult.rows[0].id, 'active-task-1');
  assert.equal(calls.length >= 4, true);
});

test('github MCP server standardizes repository operations', async () => {
  const calls = [];
  const client = {
    async getAuthenticatedUser() {
      calls.push('getAuthenticatedUser');
      return { login: 'localclaw' };
    },
    async getRepository(owner, repo) {
      calls.push(['getRepository', owner, repo]);
      return { owner, name: repo };
    },
    async ensureRepository(input) {
      calls.push(['ensureRepository', input.name]);
      return {
        name: input.name,
        clone_url: 'https://example.com/repo.git',
      };
    },
  };

  const server = createGitHubMcpServer({ client });
  const user = await server.callTool('get_authenticated_user');
  const repository = await server.callTool('get_repository', {
    owner: 'openai',
    repo: 'localclaw',
  });
  const ensured = await server.callTool('ensure_repository', {
    owner: 'openai',
    name: 'localclaw',
    private: true,
  });

  assert.equal(user.login, 'localclaw');
  assert.equal(repository.name, 'localclaw');
  assert.equal(ensured.name, 'localclaw');
  assert.deepEqual(calls[0], 'getAuthenticatedUser');
});
