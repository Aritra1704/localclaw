import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { chunkDocumentText } from '../src/rag/chunker.js';
import { createRagIngestor } from '../src/rag/ingestor.js';
import { createRagRetriever } from '../src/rag/retriever.js';

test('chunkDocumentText emits bounded chunks with token estimates', () => {
  const text = [
    '# Title',
    '',
    'First paragraph with enough content to exceed the minimum chunk size and validate chunk boundaries.',
    '',
    'Second paragraph adds more detail so the chunker has to split paragraphs under the configured max length.',
    '',
    'Third paragraph keeps the output deterministic for the test.',
  ].join('\n');

  const chunks = chunkDocumentText(text, {
    maxChars: 170,
    minChars: 60,
  });

  assert.equal(chunks.length >= 2, true);

  for (const [index, chunk] of chunks.entries()) {
    assert.equal(chunk.chunkIndex, index);
    assert.equal(chunk.content.length <= 170, true);
    assert.equal(Number.isInteger(chunk.tokenEstimate), true);
    assert.equal(chunk.tokenEstimate > 0, true);
  }
});

test('RAG retriever ranks semantic candidates by cosine similarity', async () => {
  const pool = {
    async query(sql) {
      if (sql.includes('FROM embeddings_index')) {
        return {
          rows: [
            {
              content: 'Best chunk for deployment caching.',
              title: 'Deployment Notes',
              source_path: 'docs/cache.md',
              embedding: [0.99, 0.01],
            },
            {
              content: 'Less relevant chunk.',
              title: 'Testing Notes',
              source_path: 'docs/testing.md',
              embedding: [0.3, 0.7],
            },
            {
              content: 'Moderately relevant chunk.',
              title: 'General Notes',
              source_path: 'docs/general.md',
              embedding: [0.8, 0.2],
            },
          ],
        };
      }

      throw new Error('Unexpected query');
    },
  };

  const retriever = createRagRetriever({
    pool,
    embedModel: 'test-embed-model',
    embeddingClient: {
      async embed() {
        return { embedding: [1, 0] };
      },
    },
  });

  const results = await retriever.retrieveRelevantDocumentChunks('deployment cache', {
    topK: 2,
    candidateLimit: 20,
    minimumScore: 0.01,
  });

  assert.equal(results.length, 2);
  assert.equal(results[0].source_path, 'docs/cache.md');
  assert.equal(results[1].source_path, 'docs/general.md');
});

test('RAG retriever falls back to keyword retrieval when embedding fails', async () => {
  const pool = {
    async query(sql) {
      if (sql.includes('ILIKE ANY')) {
        return {
          rows: [
            {
              content: 'Keyword matched chunk.',
              title: 'Keyword Notes',
              source_path: 'docs/keyword.md',
            },
          ],
        };
      }

      throw new Error('Unexpected query');
    },
  };

  const retriever = createRagRetriever({
    pool,
    embeddingClient: {
      async embed() {
        throw new Error('embedding unavailable');
      },
    },
  });

  const results = await retriever.retrieveRelevantDocumentChunks('keyword retrieval', {
    topK: 1,
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].source_path, 'docs/keyword.md');
});

test('RAG retriever uses postgres MCP server for semantic and keyword retrieval', async () => {
  const calls = [];
  const retriever = createRagRetriever({
    pool: {
      async query() {
        throw new Error('Direct pool.query should not be used when MCP server is available');
      },
    },
    embedModel: 'test-embed-model',
    embeddingClient: {
      async embed() {
        return { embedding: [1, 0] };
      },
    },
    mcpRegistry: {
      getServer(name) {
        if (name !== 'postgres') {
          return null;
        }

        return {
          async callTool(toolName, args) {
            calls.push({ toolName, args });

            if (toolName === 'list_embedding_candidates') {
              return {
                rows: [
                  {
                    content: 'Best chunk for deployment caching.',
                    title: 'Deployment Notes',
                    source_path: 'docs/cache.md',
                    embedding: [0.99, 0.01],
                  },
                  {
                    content: 'Less relevant chunk.',
                    title: 'Testing Notes',
                    source_path: 'docs/testing.md',
                    embedding: [0.2, 0.8],
                  },
                ],
              };
            }

            if (toolName === 'search_document_chunks') {
              return {
                rows: [
                  {
                    content: 'Keyword matched chunk.',
                    title: 'Keyword Notes',
                    source_path: 'docs/keyword.md',
                  },
                ],
              };
            }

            throw new Error(`Unexpected MCP tool: ${toolName}`);
          },
        };
      },
    },
  });

  const semanticResults = await retriever.retrieveRelevantDocumentChunks('deployment cache', {
    topK: 1,
  });

  const keywordRetriever = createRagRetriever({
    pool: {
      async query() {
        throw new Error('Direct pool.query should not be used when MCP server is available');
      },
    },
    embeddingClient: {
      async embed() {
        throw new Error('embedding unavailable');
      },
    },
    mcpRegistry: {
      getServer(name) {
        return name === 'postgres'
          ? {
              async callTool(toolName, args) {
                calls.push({ toolName, args });
                if (toolName === 'search_document_chunks') {
                  return {
                    rows: [
                      {
                        content: 'Keyword matched chunk.',
                        title: 'Keyword Notes',
                        source_path: 'docs/keyword.md',
                      },
                    ],
                  };
                }
                throw new Error(`Unexpected MCP tool: ${toolName}`);
              },
            }
          : null;
      },
    },
  });
  const keywordResults = await keywordRetriever.retrieveRelevantDocumentChunks('keyword retrieval', {
    topK: 1,
  });

  assert.equal(semanticResults[0].source_path, 'docs/cache.md');
  assert.equal(keywordResults[0].source_path, 'docs/keyword.md');
  assert.deepEqual(
    calls.map((entry) => entry.toolName),
    ['list_embedding_candidates', 'search_document_chunks']
  );
});

test('RAG ingestor uses postgres MCP server for document indexing', async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'localclaw-rag-mcp-'));
  await fs.writeFile(
    path.join(projectRoot, 'README.md'),
    '# Demo\n\nThis is a sufficiently long README document for MCP ingestion coverage.\n'
  );

  const calls = [];
  const ingestor = createRagIngestor({
    pool: {
      async query() {
        throw new Error('Direct pool.query should not be used when MCP server is available');
      },
    },
    embedModel: 'test-embed-model',
    embeddingClient: {
      async embed() {
        return { embedding: [0.1, 0.2, 0.3] };
      },
    },
    mcpRegistry: {
      getServer(name) {
        if (name !== 'postgres') {
          return null;
        }

        let nextChunkId = 1;
        return {
          async callTool(toolName, args) {
            calls.push(toolName);

            switch (toolName) {
              case 'get_document_by_source_path':
                return { rows: [] };
              case 'upsert_document_record':
                return { rows: [{ id: 'doc-1' }] };
              case 'delete_document_embeddings_by_document':
              case 'delete_document_chunks_by_document':
                return { rows: [], rowCount: 0 };
              case 'insert_document_chunk':
                return { rows: [{ id: `chunk-${nextChunkId++}` }] };
              case 'upsert_chunk_embedding':
                return { rows: [{ document_chunk_id: args.documentChunkId }] };
              default:
                throw new Error(`Unexpected MCP tool: ${toolName}`);
            }
          },
        };
      },
    },
  });

  const summary = await ingestor.ingestProjectDocuments({ projectRoot });

  assert.equal(summary.indexed, 1);
  assert.equal(summary.chunksUpserted > 0, true);
  assert.equal(summary.embeddingsUpserted > 0, true);
  assert.equal(calls.includes('upsert_document_record'), true);
  assert.equal(calls.includes('insert_document_chunk'), true);
  assert.equal(calls.includes('upsert_chunk_embedding'), true);
});
