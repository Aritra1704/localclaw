import { closePool, checkDatabaseConnection, getPool } from '../src/db/client.js';
import { config } from '../src/config.js';
import { createModelSelector } from '../src/llm/modelSelector.js';
import { createGeminiClient } from '../src/llm/providers/gemini.js';
import { createOllamaClient } from '../src/llm/ollama.js';

async function fetchAppliedMigrations() {
  const result = await getPool().query(
    `SELECT version, applied_at
     FROM schema_migrations
     ORDER BY applied_at DESC, version DESC
     LIMIT 20`
  );

  return result.rows;
}

async function main() {
  const modelSelector = createModelSelector();
  const requiredModelsByProvider = modelSelector.requiredModelsByProvider();
  const ollamaClient = createOllamaClient();
  const geminiClient = createGeminiClient();

  const db = await checkDatabaseConnection();
  const migrations = await fetchAppliedMigrations();
  const ollama = await ollamaClient.healthCheck({
    requiredModels: requiredModelsByProvider.ollama,
  });
  const gemini = config.geminiEnabled
    ? await geminiClient.healthCheck({
        requiredModels: requiredModelsByProvider.gemini,
      })
    : {
        ok: false,
        disabled: true,
        models: [],
        missingModels: requiredModelsByProvider.gemini,
      };

  console.log(
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        orchestratorMode: config.orchestratorMode,
        graphBackend: config.graphBackend,
        memoryRetention: {
          enabled: config.memoryRetentionEnabled,
          activeDays: config.memoryRetentionActiveDays,
          archivedDays: config.memoryRetentionArchivedDays,
          orphanDays: config.memoryRetentionOrphanDays,
          intervalMs: config.memoryRetentionIntervalMs,
          maxPrune: config.memoryRetentionMaxPrune,
        },
        db,
        recentMigrations: migrations,
        selectedModels: modelSelector.list(),
        requiredModelsByProvider,
        providers: {
          ollama: {
            ok: ollama.ok,
            missingModels: ollama.missingModels,
            availableModels: ollama.models.map((model) => model.name),
          },
          gemini: {
            configured: config.geminiEnabled,
            ok: gemini.ok,
            disabled: gemini.disabled === true,
            missingModels: gemini.missingModels ?? [],
            availableModels: (gemini.models ?? []).map(
              (model) => model.baseModelId ?? model.name?.replace(/^models\//, '')
            ),
          },
        },
      },
      null,
      2
    )
  );
}

main()
  .then(async () => {
    await closePool();
  })
  .catch(async (error) => {
    console.error('Hybrid rollout check failed:', error);
    await closePool().catch(() => {});
    process.exit(1);
  });
