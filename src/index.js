import fs from 'node:fs/promises';
import process from 'node:process';

import pino from 'pino';

import { config, requireConfig } from './config.js';
import {
  closePool,
  getPool,
  checkDatabaseConnection,
} from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { createOllamaClient } from './llm/ollama.js';
import { createModelSelector } from './llm/modelSelector.js';
import { createPlanner } from './agent/planner.js';
import { createVerifier } from './agent/verifier.js';
import { createSpecializedReviewService } from './agent/specializedReview.js';
import { createLearningExtractor } from './learnings/extractor.js';
import { createMcpRegistry } from './mcp/registry.js';
import { createFilesystemMcpServer } from './mcp/filesystemServer.js';
import { createPostgresMcpServer } from './mcp/postgresServer.js';
import { createRagIngestor } from './rag/ingestor.js';
import { createRagRetriever } from './rag/retriever.js';
import { createKnowledgeGraphService } from './memory/knowledgeGraph.js';
import { createSkillManager } from './skills/manager.js';
import { createToolRegistry } from './tools/registry.js';
import { createGitClient } from './git/cli.js';
import { createGitHubClient } from './github/client.js';
import { createGitHubMcpServer } from './mcp/githubServer.js';
import { createGitHubPublisher } from './github/publisher.js';
import { createRailwayClient } from './railway/client.js';
import { createRailwayDeployer } from './railway/deployer.js';
import { RepairEngine } from './selfhealing/repairEngine.js';
import { ChatHistoryManager } from './control/chatHistory.js';
import { createTaskExecutor } from './agent/executor.js';
import { createDynamicRouter } from './agent/router.js';
import { ReflectionEngine } from './selfimprovement/reflectionEngine.js';
import { Orchestrator } from './orchestrator.js';
import { createProjectService } from './control/projects.js';
import { createChatService } from './control/chat.js';
import { startTelegramBot } from './telegram/bot.js';
import { createControlApiServer } from './control/api.js';

const logger = pino({
  name: 'localclaw-bootstrap',
  level: config.nodeEnv === 'development' ? 'debug' : 'info',
});

let orchestrator;
let telegramBot;
let controlApi;
let projectService;
let chatService;
const BOOT_STAGE_TIMEOUT_MS = 60_000;

async function warmOllamaModels(client) {
  if (!config.ollamaWarmupEnabled) {
    return [];
  }

  const candidates = [
    { model: config.modelPlanner, mode: 'generate', role: 'planner' },
    { model: config.modelCoder, mode: 'generate', role: 'coder' },
    { model: config.modelFast, mode: 'generate', role: 'fast' },
    { model: config.modelReview, mode: 'generate', role: 'review' },
    { model: config.modelEmbed, mode: 'embed', role: 'embed' },
  ];
  const seen = new Set();
  const warmed = [];

  for (const candidate of candidates) {
    const key = `${candidate.mode}:${candidate.model}`;
    if (!candidate.model || seen.has(key)) {
      continue;
    }

    seen.add(key);

    try {
      const result = await client.warmModel({
        model: candidate.model,
        mode: candidate.mode,
        timeoutMs: config.ollamaWarmupTimeoutMs,
      });
      warmed.push({ ...candidate, cached: result.cached ?? false });
    } catch (error) {
      logger.warn(
        { err: error, model: candidate.model, role: candidate.role, mode: candidate.mode },
        'Ollama warmup failed; continuing without preloaded model'
      );
    }
  }

  return warmed;
}

async function ensureSsdBasePath() {
  await fs.mkdir(config.ssdBasePath, { recursive: true });
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
  requireConfig('databaseUrl');

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
    logger.warn({ missing: ollamaHealth.missingModels }, 'Missing required Ollama models. Booting anyway, but execution may fail until weights finish downloading.');
  }

  logger.info(
    {
      ollamaBaseUrl: config.ollamaBaseUrl,
      availableModels: ollamaHealth.models.map((model) => model.name),
    },
    'Ollama connection healthy'
  );
  const warmedModels = await warmOllamaModels(ollamaClient);
  logger.info(
    {
      warmedModels: warmedModels.map((entry) => ({
        role: entry.role,
        model: entry.model,
        mode: entry.mode,
        cached: entry.cached,
      })),
    },
    'Ollama warmup pass complete'
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
  const specializedReviewer = createSpecializedReviewService({
    logger,
  });
  const learningExtractor = createLearningExtractor({
    client: ollamaClient,
    modelSelector,
  });
  const mcpRegistry = createMcpRegistry({
    servers: [
      createFilesystemMcpServer(),
      createPostgresMcpServer({ pool: getPool() }),
    ],
  });
  const ragIngestor = createRagIngestor({
    embeddingClient: ollamaClient,
    logger,
    mcpRegistry,
  });
  const ragRetriever = createRagRetriever({
    embeddingClient: ollamaClient,
    logger,
    mcpRegistry,
  });
  const knowledgeGraph = createKnowledgeGraphService({
    logger,
    mcpRegistry,
  });
  const skillManager = createSkillManager({
    logger,
    mcpRegistry,
  });
  const skillSummary = await skillManager.syncRegistry();
  logger.info({ skillSummary }, 'Skill registry synchronized');
  const toolRegistry = createToolRegistry({
    skillManager,
    mcpRegistry,
  });
  let publisher = null;
  let deployer = null;

  if (config.githubAutoPublish) {
    requireConfig('githubPat');
    const gitClient = createGitClient();
    const githubClient = createGitHubClient();
    const githubServer = createGitHubMcpServer({
      client: githubClient,
    });
    mcpRegistry.registerServer(githubServer);
    publisher = createGitHubPublisher({
      gitClient,
      githubClient,
      githubServer,
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
  await setBootPhase('boot_skills_ready');

  const repairEngine = new RepairEngine({
    client: ollamaClient,
    logger,
    modelSelector,
  });

  const chatHistoryManager = new ChatHistoryManager({
    pool: getPool(),
  });

  const taskExecutor = createTaskExecutor({
    planner,
    specializedReviewer,
    verifier,
    toolRegistry,
    repairEngine,
    router: createDynamicRouter({ client: ollamaClient, modelSelector }),
  });

  const reflectionEngine = new ReflectionEngine({
    pool: getPool(),
    ollamaClient,
    logger,
    mcpRegistry,
  });

  orchestrator = new Orchestrator({
    logger,
    taskExecutor,
    publisher,
    deployer,
    learningExtractor,
    ragIngestor,
    ragRetriever,
    knowledgeGraph,
    skillManager,
    reflectionEngine,
    repairEngine,
    chatHistoryManager,
    mcpRegistry,
  });

  toolRegistry.setOrchestrator(orchestrator);

  projectService = createProjectService({
    pool: getPool(),
    mcpRegistry,
    workspaceRoots: config.workspaceRoots,
  });
  chatService = createChatService({
    pool: getPool(),
    projectService,
    orchestrator,
    llmClient: ollamaClient,
    modelSelector,
    logger,
    mcpRegistry,
  });

  telegramBot = await withTimeout(
    startTelegramBot({
      logger,
      orchestrator,
      skillManager,
    }),
    BOOT_STAGE_TIMEOUT_MS,
    'Timed out while starting the Telegram bot.'
  );

  await setBootPhase('boot_telegram_ready');

  if (config.controlApiEnabled) {
    controlApi = createControlApiServer({
      orchestrator,
      logger,
      host: config.controlApiHost,
      port: config.controlApiPort,
      token: config.controlApiToken,
      projectService,
      chatService,
      uiConfig: {
        enabled: config.uiEnabled,
        distDir: config.uiDistDir,
      },
    });

    const bound = await withTimeout(
      controlApi.start(),
      BOOT_STAGE_TIMEOUT_MS,
      'Timed out while starting control API.'
    );

    logger.info(
      {
        controlApiHost: bound.host,
        controlApiPort: bound.port,
      },
      'Control API started'
    );
  }
  await setBootPhase('boot_control_api_ready');
  await setBootPhase('boot_complete');

  logger.info('LocalClaw bootstrap complete');
}

async function shutdown(signal) {
  logger.info({ signal }, 'Shutting down LocalClaw');

  if (telegramBot) {
    await telegramBot.stop();
    telegramBot = null;
  }

  if (controlApi) {
    await controlApi.stop();
    controlApi = null;
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
