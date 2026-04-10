import { config } from '../config.js';

function trimTrailingSlash(value) {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

function buildGenerateBody(input) {
  const body = {
    model: input.model,
    prompt: input.prompt,
    stream: false,
    keep_alive: input.keepAlive,
  };

  if (input.system) {
    body.system = input.system;
  }

  if (input.format) {
    body.format = input.format;
  }

  const options = {
    temperature: input.temperature ?? 0.2,
    ...(input.options ?? {}),
  };

  if (Object.keys(options).length > 0) {
    body.options = options;
  }

  return body;
}

export function extractJsonObjectText(value) {
  const trimmed = value.trim();

  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    return trimmed;
  }

  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');

  if (start === -1 || end === -1 || end <= start) {
    throw new Error('No JSON object found in Ollama response');
  }

  return trimmed.slice(start, end + 1);
}

export function createOllamaClient(options = {}) {
  const baseUrl = trimTrailingSlash(options.baseUrl ?? config.ollamaBaseUrl);
  const keepAlive = options.keepAlive ?? config.ollamaKeepAlive;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  if (typeof fetchImpl !== 'function') {
    throw new Error('Global fetch is not available for the Ollama client');
  }

  async function request(pathname, requestOptions = {}) {
    const response = await fetchImpl(`${baseUrl}${pathname}`, {
      method: requestOptions.method ?? 'GET',
      signal: requestOptions.signal,
      headers: {
        'content-type': 'application/json',
        ...(requestOptions.headers ?? {}),
      },
      body:
        typeof requestOptions.body === 'undefined'
          ? undefined
          : JSON.stringify(requestOptions.body),
    });

    const text = await response.text();
    let payload = null;

    if (text.length > 0) {
      try {
        payload = JSON.parse(text);
      } catch (error) {
        if (!response.ok) {
          throw new Error(
            `Ollama request failed with status ${response.status}: ${text.slice(0, 200)}`
          );
        }

        throw new Error(`Ollama returned non-JSON content: ${text.slice(0, 200)}`);
      }
    }

    if (!response.ok) {
      throw new Error(
        `Ollama request failed with status ${response.status}: ${text.slice(0, 200)}`
      );
    }

    return payload;
  }

  return {
    baseUrl,
    keepAlive,

    async listModels() {
      const payload = await request('/api/tags');
      return payload?.models ?? [];
    },

    async healthCheck(options = {}) {
      const models = await this.listModels();
      const availableTags = new Set(models.map((model) => model.name));
      const requiredModels = options.requiredModels ?? [];
      const missingModels = requiredModels.filter((model) => !availableTags.has(model));

      return {
        ok: missingModels.length === 0,
        modelCount: models.length,
        models,
        missingModels,
      };
    },

    async generate(input) {
      const payload = await request('/api/generate', {
        method: 'POST',
        signal: input.signal,
        body: buildGenerateBody({
          ...input,
          keepAlive,
        }),
      });

      return {
        responseText: payload?.response ?? '',
        totalDuration: payload?.total_duration ?? null,
        loadDuration: payload?.load_duration ?? null,
        promptEvalCount: payload?.prompt_eval_count ?? null,
        evalCount: payload?.eval_count ?? null,
        raw: payload,
      };
    },

    async embed(input) {
      const model = input.model;
      const content = `${input.input ?? ''}`.trim();

      if (!model) {
        throw new Error('embed requires a model');
      }

      if (!content) {
        throw new Error('embed requires non-empty input');
      }

      let firstError = null;

      try {
        const payload = await request('/api/embed', {
          method: 'POST',
          body: {
            model,
            input: [content],
            keep_alive: keepAlive,
          },
        });

        const vector =
          Array.isArray(payload?.embeddings) && Array.isArray(payload.embeddings[0])
            ? payload.embeddings[0]
            : Array.isArray(payload?.embedding)
              ? payload.embedding
              : null;

        if (!vector) {
          throw new Error('Ollama /api/embed returned no embedding vector');
        }

        return {
          embedding: vector,
          endpoint: '/api/embed',
          raw: payload,
        };
      } catch (error) {
        firstError = error;
      }

      try {
        const payload = await request('/api/embeddings', {
          method: 'POST',
          body: {
            model,
            prompt: content,
            keep_alive: keepAlive,
          },
        });

        const vector = Array.isArray(payload?.embedding) ? payload.embedding : null;
        if (!vector) {
          throw new Error('Ollama /api/embeddings returned no embedding vector');
        }

        return {
          embedding: vector,
          endpoint: '/api/embeddings',
          raw: payload,
        };
      } catch (fallbackError) {
        const details = [firstError?.message, fallbackError?.message]
          .filter(Boolean)
          .join(' | ');
        throw new Error(`Failed to generate embedding: ${details}`);
      }
    },
  };
}
