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

test('postgres MCP server standardizes queue, reflection, and document indexing operations', async () => {
  const calls = [];
  const txCalls = [];
  const client = {
    async query(sql, params) {
      txCalls.push({ sql, params });

      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return { rows: [] };
      }

      if (sql.includes('FOR UPDATE SKIP LOCKED')) {
        return {
          rows: [
            {
              id: 'task-1',
              title: 'Queued task',
              description: 'Run queued work',
              priority: 'medium',
              project_name: 'demo',
              project_path: '/tmp/demo',
            },
          ],
        };
      }

      if (sql.includes('RETURNING *')) {
        return {
          rows: [{ id: 'task-1', status: 'in_progress' }],
        };
      }

      throw new Error(`Unexpected tx query: ${sql.slice(0, 80)}`);
    },
    release() {
      txCalls.push({ sql: 'RELEASE', params: [] });
    },
  };

  const pool = {
    async connect() {
      return client;
    },
    async query(sql, params) {
      calls.push({ sql, params });

      if (sql.includes("WHERE status IN ('in_progress', 'verifying')")) {
        return { rowCount: 1, rows: [{ id: 'task-1', title: 'Recovered task' }] };
      }

      if (sql.includes("WHERE status = 'pending'")) {
        return { rows: [{ count: 2 }] };
      }

      if (sql.includes('FROM agent_logs')) {
        return { rows: [{ step_number: 1, step_type: 'act', status: 'success' }] };
      }

      if (sql.includes('LEFT JOIN learnings l')) {
        return { rows: [{ id: 'task-2', title: 'Failed task' }] };
      }

      if (sql.includes('FROM documents')) {
        return { rows: [{ id: 'doc-1', checksum: 'abc123' }] };
      }

      if (sql.includes('UPDATE documents')) {
        return { rows: [{ id: 'doc-1', source_path: 'README.md', title: 'Readme', checksum: 'abc123' }] };
      }

      if (sql.includes('DELETE FROM embeddings_index')) {
        return { rowCount: 1, rows: [] };
      }

      if (sql.includes('DELETE FROM document_chunks')) {
        return { rowCount: 2, rows: [] };
      }

      if (sql.includes('INSERT INTO document_chunks')) {
        return { rows: [{ id: 'chunk-1' }] };
      }

      if (sql.includes('INSERT INTO embeddings_index')) {
        return { rows: [{ document_chunk_id: 'chunk-1', model_tag: 'embed-model' }] };
      }

      if (sql.includes('FROM embeddings_index')) {
        return {
          rows: [
            {
              content: 'Document candidate',
              title: 'Readme',
              source_path: 'README.md',
              embedding: [0.1, 0.2],
            },
          ],
        };
      }

      throw new Error(`Unexpected query: ${sql.slice(0, 80)}`);
    },
  };

  const server = createPostgresMcpServer({ pool });

  const recovered = await server.callTool('recover_interrupted_tasks');
  const pendingCount = await server.callTool('count_pending_tasks');
  const leased = await server.callTool('lease_next_task', { instanceId: 'instance-1' });
  const logs = await server.callTool('list_task_logs', { taskId: 'task-1', limit: 10, order: 'asc' });
  const failedTasks = await server.callTool('list_recent_failed_tasks_without_reflection', {
    limit: 5,
    hours: 24,
  });
  const document = await server.callTool('get_document_by_source_path', { sourcePath: 'README.md' });
  const upserted = await server.callTool('upsert_document_record', {
    id: 'doc-1',
    sourcePath: 'README.md',
    title: 'Readme',
    checksum: 'abc123',
  });
  await server.callTool('delete_document_embeddings_by_document', { documentId: 'doc-1' });
  await server.callTool('delete_document_chunks_by_document', { documentId: 'doc-1' });
  const chunk = await server.callTool('insert_document_chunk', {
    documentId: 'doc-1',
    chunkIndex: 0,
    content: 'hello',
    tokenEstimate: 4,
  });
  const embedding = await server.callTool('upsert_chunk_embedding', {
    documentChunkId: 'chunk-1',
    modelTag: 'embed-model',
    embedding: [0.1, 0.2],
  });
  const candidates = await server.callTool('list_embedding_candidates', {
    modelTag: 'embed-model',
    limit: 10,
  });

  assert.equal(recovered.rows[0].id, 'task-1');
  assert.equal(pendingCount.rows[0].count, 2);
  assert.equal(leased.rows[0].id, 'task-1');
  assert.equal(logs.rows.length, 1);
  assert.equal(failedTasks.rows[0].id, 'task-2');
  assert.equal(document.rows[0].id, 'doc-1');
  assert.equal(upserted.rows[0].id, 'doc-1');
  assert.equal(chunk.rows[0].id, 'chunk-1');
  assert.equal(embedding.rows[0].model_tag, 'embed-model');
  assert.equal(candidates.rows[0].source_path, 'README.md');
  assert.equal(txCalls.some((entry) => entry.sql === 'BEGIN'), true);
  assert.equal(txCalls.some((entry) => entry.sql === 'COMMIT'), true);
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
