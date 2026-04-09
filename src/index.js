import fs from 'node:fs/promises';
import process from 'node:process';

import pino from 'pino';

import { config, requireConfig } from './config.js';
import { createTaskExecutor } from './agent/executor.js';
import { createPlanner } from './agent/planner.js';
import { createVerifier } from './agent/verifier.js';
import { checkDatabaseConnection, closePool, getPool } from './db/client.js';
import { createGitClient } from './git/cli.js';
import { createGitHubClient } from './github/client.js';
import { createGitHubPublisher } from './github/publisher.js';
import { createLearningExtractor } from './learnings/extractor.js';
import { createModelSelector } from './llm/modelSelector.js';
import { createOllamaClient } from './llm/ollama.js';
import { createRagIngestor } from './rag/ingestor.js';
import { createRagRetriever } from './rag/retriever.js';
import { createRailwayClient } from './railway/client.js';
import { createRailwayDeployer } from './railway/deployer.js';
import { runMigrations } from './db/migrate.js';
import { Orchestrator } from './orchestrator.js';
import { startTelegramBot } from './telegram/bot.js';
import { createToolRegistry } from './tools/registry.js';

const logger = pino({
  name: 'localclaw',
  level: config.nodeEnv === 'development' ? 'debug' : 'info',
});

let orchestrator;
let telegramBot;
const BOOT_STAGE_TIMEOUT_MS = 10_000;

async function ensureSsdBasePath() {
  await fs.access(config.ssdBasePath);
}

async function setAgentStateValue(key, value) {
  try {
    await getPool().query(
      `INSERT INTO agent_state (state_key, value, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (state_key)
       DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [key, JSON.stringify(value)]
    );
  } catch (error) {
    logger.warn({ err: error, key }, 'Failed to update bootstrap agent_state value');
  }
}

async function setBootPhase(phase, errorMessage = null) {
  await Promise.all([
    setAgentStateValue('boot_phase', phase),
    setAgentStateValue('boot_error', errorMessage),
  ]);

  logger.info(
    {
      bootPhase: phase,
      ...(errorMessage ? { bootError: errorMessage } : {}),
    },
    'Boot phase reached'
  );
}

async function withTimeout(promise, timeoutMs, message) {
  let timer;

  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function bootstrap() {
  requireConfig('databaseUrl', 'ssdBasePath');

  await setBootPhase('boot_starting');
  await setAgentStateValue('polling_active', false);
  await ensureSsdBasePath();
  await runMigrations();
  await setBootPhase('boot_migrations_done');

  const dbHealth = await checkDatabaseConnection();
  logger.info({ serverTime: dbHealth.server_time }, 'Database connection healthy');
  await setBootPhase('boot_db_ready');

  const ollamaClient = createOllamaClient({ logger });
  const modelSelector = createModelSelector();
  const ollamaHealth = await ollamaClient.healthCheck({
    requiredModels: [
      config.modelPlanner,
      config.modelCoder,
      config.modelFast,
      config.modelReview,
      config.modelEmbed,
    ],
  });

  if (!ollamaHealth.ok) {
    throw new Error(
      `Missing required Ollama models: ${ollamaHealth.missingModels.join(', ')}`
    );
  }

  logger.info(
    {
      ollamaBaseUrl: config.ollamaBaseUrl,
      availableModels: ollamaHealth.models.map((model) => model.name),
    },
    'Ollama connection healthy'
  );
  await setBootPhase('boot_ollama_ready');

  const planner = createPlanner({
    client: ollamaClient,
    modelSelector,
  });
  const verifier = createVerifier({
    client: ollamaClient,
    modelSelector,
  });
  const learningExtractor = createLearningExtractor({
    client: ollamaClient,
    modelSelector,
  });
  const ragIngestor = createRagIngestor({
    embeddingClient: ollamaClient,
    logger,
  });
  const ragRetriever = createRagRetriever({
    embeddingClient: ollamaClient,
    logger,
  });
  const toolRegistry = createToolRegistry();
  let publisher = null;
  let deployer = null;

  if (config.githubAutoPublish) {
    requireConfig('githubPat');
    const gitClient = createGitClient();
    const githubClient = createGitHubClient();
    publisher = createGitHubPublisher({
      gitClient,
      githubClient,
      logger,
    });

    logger.info(
      {
        githubRepoOwner: config.githubRepoOwner || config.githubUsername,
        visibility: config.githubRepoVisibility,
      },
      'GitHub auto-publish enabled'
    );
  }

  await setBootPhase('boot_github_ready');

  if (config.railwayDeployEnabled) {
    if (!config.githubAutoPublish) {
      throw new Error(
        'RAILWAY_DEPLOY_ENABLED requires GITHUB_AUTO_PUBLISH=true so LocalClaw can deploy a published repository.'
      );
    }

    requireConfig(
      'railwayApiToken',
      'railwayProjectId',
      'railwayEnvironmentId',
      'railwayServiceId'
    );

    const railwayClient = createRailwayClient({ logger });
    const railwayService = await railwayClient.getService(config.railwayServiceId);
    deployer = createRailwayDeployer({
      client: railwayClient,
      timeoutMs: config.railwayDeployTimeoutMs,
      serviceName: railwayService?.name ?? null,
    });

    logger.info(
      {
        railwayProjectId: config.railwayProjectId,
        railwayEnvironmentId: config.railwayEnvironmentId,
        railwayServiceId: config.railwayServiceId,
        railwayServiceName: railwayService?.name ?? null,
      },
      'Railway deploy gate enabled'
    );
  }

  await setBootPhase('boot_railway_ready');

  const taskExecutor = createTaskExecutor({
    planner,
    verifier,
    toolRegistry,
  });

  orchestrator = new Orchestrator({
    logger,
    taskExecutor,
    publisher,
    deployer,
    learningExtractor,
    ragIngestor,
    ragRetriever,
  });
  telegramBot = await withTimeout(
    startTelegramBot({
      logger,
      orchestrator,
      onKill: async (reason) => {
        await shutdown(`telegram_kill:${reason}`);
        process.exit(0);
      },
    }),
    BOOT_STAGE_TIMEOUT_MS,
    'Timed out while starting Telegram bot.'
  );
  await setBootPhase('boot_telegram_ready');
  orchestrator.setNotifier(telegramBot);
  await withTimeout(
    orchestrator.start(),
    BOOT_STAGE_TIMEOUT_MS,
    'Timed out while starting orchestrator.'
  );
  await setBootPhase('boot_orchestrator_ready');
  await setBootPhase('boot_complete');

  logger.info('LocalClaw bootstrap complete');
}

async function shutdown(signal) {
  logger.info({ signal }, 'Shutting down LocalClaw');

  if (telegramBot) {
    await telegramBot.stop();
    telegramBot = null;
  }

  if (orchestrator) {
    await orchestrator.stop();
    orchestrator = null;
  }

  await closePool();
}

process.on('SIGINT', () => {
  shutdown('SIGINT')
    .then(() => process.exit(0))
    .catch((error) => {
      logger.error({ err: error }, 'Failed during SIGINT shutdown');
      process.exit(1);
    });
});

process.on('SIGTERM', () => {
  shutdown('SIGTERM')
    .then(() => process.exit(0))
    .catch((error) => {
      logger.error({ err: error }, 'Failed during SIGTERM shutdown');
      process.exit(1);
    });
});

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled promise rejection');
});

process.on('uncaughtException', (error) => {
  logger.error({ err: error }, 'Uncaught exception');
  shutdown('uncaughtException')
    .then(() => process.exit(1))
    .catch(() => process.exit(1));
});

bootstrap().catch(async (error) => {
  await setBootPhase('boot_failed', error.message).catch(() => {});
  await setAgentStateValue('polling_active', false).catch(() => {});
  logger.error({ err: error }, 'Failed to bootstrap LocalClaw');
  await closePool().catch(() => {});
  process.exit(1);
});
