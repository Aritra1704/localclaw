function extractJsonArrayText(value) {
  const trimmed = value.trim();

  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed;
  }

  const start = trimmed.indexOf('[');
  const end = trimmed.lastIndexOf(']');

  if (start === -1 || end === -1 || end <= start) {
    throw new Error('No JSON array found in learning extractor response');
  }

  return trimmed.slice(start, end + 1);
}

function normalizeKeywords(values) {
  if (!Array.isArray(values)) {
    return [];
  }

  return [...new Set(
    values
      .map((item) => (typeof item === 'string' ? item.trim().toLowerCase() : ''))
      .filter((item) => item.length >= 3)
  )].slice(0, 8);
}

function buildPrompt(task, result) {
  return `You are extracting reusable engineering learnings from a LocalClaw task.
Return only a JSON array and nothing else.

Task title:
${task.title}

Task description:
${task.description}

Plan summary:
${result.plan?.summary ?? 'n/a'}

Verification:
status=${result.verification?.review?.status ?? 'unknown'}
summary=${result.verification?.review?.summary ?? 'n/a'}

Publication:
attempted=${result.publication?.attempted === true ? 'yes' : 'no'}
published=${result.publication?.published === true ? 'yes' : 'no'}
error=${result.publication?.error?.message ?? 'none'}

Return 1-4 items.
JSON schema for each item:
{
  "category": "planning | execution | verification | publishing | deployment",
  "observation": "specific, reusable lesson",
  "keywords": ["keyword1", "keyword2"],
  "confidenceScore": 1-10
}`;
}

function parseModelOutput(text) {
  const candidate = JSON.parse(extractJsonArrayText(text));

  if (!Array.isArray(candidate)) {
    throw new Error('Learning extractor must return an array');
  }

  return candidate
    .map((item) => ({
      category:
        typeof item?.category === 'string' && item.category.trim().length > 0
          ? item.category.trim().slice(0, 50)
          : 'execution',
      observation:
        typeof item?.observation === 'string' ? item.observation.trim() : '',
      keywords: normalizeKeywords(item?.keywords),
      confidenceScore: Number.isFinite(item?.confidenceScore)
        ? Math.max(1, Math.min(10, Math.round(item.confidenceScore)))
        : 6,
    }))
    .filter((item) => item.observation.length >= 10)
    .slice(0, 4);
}

function buildFallback(task, result) {
  const verificationStatus = result.verification?.review?.status ?? 'unknown';
  const publishError = result.publication?.error?.message ?? null;
  const items = [];

  items.push({
    category: 'verification',
    observation: `Verification ended with status "${verificationStatus}" for task "${task.title}".`,
    keywords: ['verification', verificationStatus, 'phase5'],
    confidenceScore: 6,
  });

  if (publishError) {
    items.push({
      category: 'publishing',
      observation: `Publishing surfaced an error: ${publishError.slice(0, 220)}.`,
      keywords: ['publishing', 'github', 'error'],
      confidenceScore: 7,
    });
  }

  return items.slice(0, 4);
}

export function createLearningExtractor({ client, modelSelector }) {
  return {
    async extract(task, result) {
      const model = modelSelector.select('fast');

      try {
        const response = await client.generate({
          model,
          prompt: buildPrompt(task, result),
          format: 'json',
          options: {
            temperature: 0,
          },
        });

        const parsed = parseModelOutput(response.responseText);
        if (parsed.length > 0) {
          return parsed;
        }
      } catch {
        // Non-blocking: fallback below.
      }

      return buildFallback(task, result);
    },
  };
}
