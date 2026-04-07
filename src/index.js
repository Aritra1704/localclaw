import fs from 'node:fs/promises';
import process from 'node:process';

import pino from 'pino';

import { config, requireConfig } from './config.js';
import { checkDatabaseConnection, closePool } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { Orchestrator } from './orchestrator.js';
import { startTelegramBot } from './telegram/bot.js';

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

  orchestrator = new Orchestrator({ logger });
  await orchestrator.start();
  telegramBot = await startTelegramBot({
    logger,
    orchestrator,
    onKill: async (reason) => {
      await shutdown(`telegram_kill:${reason}`);
      process.exit(0);
    },
  });

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
