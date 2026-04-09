import fs from 'node:fs/promises';
import process from 'node:process';

import pino from 'pino';

import { config, requireConfig } from './config.js';
import { createTaskExecutor } from './agent/executor.js';
import { createPlanner } from './agent/planner.js';
import { createVerifier } from './agent/verifier.js';
import { checkDatabaseConnection, closePool } from './db/client.js';
import { createGitClient } from './git/cli.js';
import { createGitHubClient } from './github/client.js';
import { createGitHubPublisher } from './github/publisher.js';
import { createModelSelector } from './llm/modelSelector.js';
import { createOllamaClient } from './llm/ollama.js';
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

async function ensureSsdBasePath() {
  await fs.access(config.ssdBasePath);
}

async function bootstrap() {
  requireConfig('databaseUrl', 'ssdBasePath');

  await ensureSsdBasePath();
  await runMigrations();

  const dbHealth = await checkDatabaseConnection();
  logger.info({ serverTime: dbHealth.server_time }, 'Database connection healthy');

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

  const planner = createPlanner({
    client: ollamaClient,
    modelSelector,
  });
  const verifier = createVerifier({
    client: ollamaClient,
    modelSelector,
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
    deployer = createRailwayDeployer({
      client: railwayClient,
      timeoutMs: config.railwayDeployTimeoutMs,
    });

    logger.info(
      {
        railwayProjectId: config.railwayProjectId,
        railwayEnvironmentId: config.railwayEnvironmentId,
        railwayServiceId: config.railwayServiceId,
      },
      'Railway deploy gate enabled'
    );
  }

  const taskExecutor = createTaskExecutor({
    planner,
    verifier,
    toolRegistry,
  });

  orchestrator = new Orchestrator({ logger, taskExecutor, publisher, deployer });
  telegramBot = await startTelegramBot({
    logger,
    orchestrator,
    onKill: async (reason) => {
      await shutdown(`telegram_kill:${reason}`);
      process.exit(0);
    },
  });
  orchestrator.setNotifier(telegramBot);
  await orchestrator.start();

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
  logger.error({ err: error }, 'Failed to bootstrap LocalClaw');
  await closePool().catch(() => {});
  process.exit(1);
});
