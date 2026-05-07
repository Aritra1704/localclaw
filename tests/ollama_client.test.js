import assert from 'node:assert/strict';
import test from 'node:test';

import { createOllamaClient } from '../src/llm/ollama.js';

test('ollama client warms model and retries generate after timeout', async () => {
  let generateAttempts = 0;
  let warmupCalls = 0;

  const client = createOllamaClient({
    timeoutMs: 10,
    warmupTimeoutMs: 50,
    maxRetries: 1,
    fetchImpl: async (url, options) => {
      if (url.endsWith('/api/generate')) {
        const body = JSON.parse(options.body);

        if (body.prompt === '') {
          warmupCalls += 1;
          return new Response(JSON.stringify({ response: '', done: true }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }

        generateAttempts += 1;
        if (generateAttempts === 1) {
          return new Promise((_, reject) => {
            options.signal.addEventListener(
              'abort',
              () => {
                const error = new Error('aborted');
                error.name = 'AbortError';
                reject(error);
              },
              { once: true }
            );
          });
        }

        return new Response(
          JSON.stringify({
            response: 'ok',
            total_duration: 5,
            load_duration: 2,
            prompt_eval_count: 1,
            eval_count: 1,
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }
        );
      }

      throw new Error(`Unexpected URL: ${url}`);
    },
  });

  const result = await client.generate({
    model: 'qwen2.5-coder:7b',
    prompt: 'hello',
  });

  assert.equal(result.responseText, 'ok');
  assert.equal(generateAttempts, 2);
  assert.equal(warmupCalls, 1);
});

test('ollama client caches successful warmups per model and mode', async () => {
  let generateWarmups = 0;
  let embedWarmups = 0;

  const client = createOllamaClient({
    fetchImpl: async (url, options) => {
      if (url.endsWith('/api/generate')) {
        generateWarmups += 1;
        return new Response(JSON.stringify({ response: '', done: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      if (url.endsWith('/api/embed')) {
        embedWarmups += 1;
        return new Response(JSON.stringify({ embeddings: [[0.1]] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      throw new Error(`Unexpected URL: ${url}`);
    },
  });

  await client.warmModel({ model: 'planner-model', mode: 'generate' });
  await client.warmModel({ model: 'planner-model', mode: 'generate' });
  await client.warmModel({ model: 'embed-model', mode: 'embed' });
  await client.warmModel({ model: 'embed-model', mode: 'embed' });

  assert.equal(generateWarmups, 1);
  assert.equal(embedWarmups, 1);
});
