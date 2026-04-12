import assert from 'node:assert/strict';
import test from 'node:test';

import { chunkDocumentText } from '../src/rag/chunker.js';
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
