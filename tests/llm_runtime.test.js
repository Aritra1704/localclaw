import assert from 'node:assert/strict';
import test from 'node:test';

import { createGeminiClient } from '../src/llm/providers/gemini.js';
import { createLlmRuntime } from '../src/llm/runtime.js';

test('gemini client shapes generateContent requests and extracts response text', async () => {
  const requests = [];
  const client = createGeminiClient({
    apiKey: 'test-key',
    baseUrl: 'https://example.test/v1beta',
    fetchImpl: async (url, options) => {
      requests.push({
        url,
        body: JSON.parse(options.body),
      });

      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [{ text: '{"ok":true}' }],
              },
            },
          ],
          usageMetadata: {
            promptTokenCount: 42,
            candidatesTokenCount: 9,
          },
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        }
      );
    },
  });

  const result = await client.generate({
    model: 'gemini-2.5-pro',
    system: 'Return JSON.',
    prompt: 'Plan this task.',
    format: 'json',
    temperature: 0.1,
  });

  assert.equal(result.responseText, '{"ok":true}');
  assert.equal(result.promptEvalCount, 42);
  assert.equal(result.evalCount, 9);
  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].url,
    'https://example.test/v1beta/models/gemini-2.5-pro:generateContent'
  );
  assert.equal(
    requests[0].body.generationConfig.responseMimeType,
    'application/json'
  );
  assert.equal(
    requests[0].body.systemInstruction.parts[0].text,
    'Return JSON.'
  );
});

test('llm runtime routes prefixed model refs to the matching provider', async () => {
  const calls = [];
  const runtime = createLlmRuntime({
    providers: {
      ollama: {
        async generate(input) {
          calls.push({ provider: 'ollama', input });
          return { responseText: 'local-ok' };
        },
      },
      gemini: {
        async generate(input) {
          calls.push({ provider: 'gemini', input });
          return { responseText: 'cloud-ok' };
        },
      },
    },
  });

  const local = await runtime.generate({
    model: 'ollama::qwen2.5-coder:7b',
    prompt: 'local',
  });
  const cloud = await runtime.generate({
    model: 'gemini::gemini-2.5-pro',
    prompt: 'cloud',
  });

  assert.equal(local.responseText, 'local-ok');
  assert.equal(cloud.responseText, 'cloud-ok');
  assert.deepEqual(calls, [
    {
      provider: 'ollama',
      input: {
        model: 'qwen2.5-coder:7b',
        prompt: 'local',
      },
    },
    {
      provider: 'gemini',
      input: {
        model: 'gemini-2.5-pro',
        prompt: 'cloud',
      },
    },
  ]);
});

