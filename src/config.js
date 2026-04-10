import { config as loadEnv } from 'dotenv';
import { z } from 'zod';

loadEnv();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DATABASE_SCHEMA: z
    .string()
    .regex(/^[a-z_][a-z0-9_]*$/, 'DATABASE_SCHEMA must be a valid PostgreSQL schema name')
    .default('localclaw'),
  SSD_BASE_PATH: z.string().min(1).default('/Volumes/Ari_SSD_01/PROJECTS/localclaw'),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),
  GITHUB_PAT: z.string().optional(),
  GITHUB_USERNAME: z.string().optional(),
  GITHUB_REPO_OWNER: z.string().optional(),
  GITHUB_API_BASE_URL: z.string().url().default('https://api.github.com'),
  GITHUB_REPO_VISIBILITY: z.enum(['private', 'public']).default('private'),
  GITHUB_AUTO_PUBLISH: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  GIT_DEFAULT_BRANCH: z.string().min(1).default('main'),
  RAILWAY_API_TOKEN: z.string().optional(),
  RAILWAY_GRAPHQL_ENDPOINT: z
    .string()
    .url()
    .default('https://backboard.railway.com/graphql/v2'),
  RAILWAY_PROJECT_ID: z.string().optional(),
  RAILWAY_ENVIRONMENT_ID: z.string().optional(),
  RAILWAY_SERVICE_ID: z.string().optional(),
  RAILWAY_DEPLOY_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  RAILWAY_DEPLOY_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(10000),
  RAILWAY_DEPLOY_TIMEOUT_MS: z.coerce.number().int().positive().default(900000),
  OLLAMA_BASE_URL: z.string().url().default('http://127.0.0.1:11434'),
  OLLAMA_KEEP_ALIVE: z.string().default('30s'),
  MODEL_PLANNER: z.string().default('gemma4:e4b'),
  MODEL_CODER: z.string().default('qwen2.5-coder:7b'),
  MODEL_FAST: z.string().default('qwen2.5:7b-instruct'),
  MODEL_REVIEW: z.string().default('gemma4:e4b'),
  MODEL_EMBED: z.string().default('nomic-embed-text:latest'),
  TASK_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(30000),
  TASK_TIMEOUT_HOURS: z.coerce.number().positive().default(2),
  MAX_CONSECUTIVE_FAILURES: z.coerce.number().int().positive().default(3),
  DOCKER_SANDBOX_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  SKILLS_BUILTIN_DIR: z.string().default('skills/builtin'),
  SKILLS_ALLOW_GENERATED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  CONTROL_API_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  CONTROL_API_HOST: z
    .string()
    .default('127.0.0.1')
    .refine(
      (value) => value === '127.0.0.1' || value === 'localhost',
      'CONTROL_API_HOST must be localhost or 127.0.0.1'
    ),
  CONTROL_API_PORT: z.coerce.number().int().positive().default(4173),
  CONTROL_API_TOKEN: z.string().optional(),
});

const parsedEnv = envSchema.safeParse(process.env);

if (!parsedEnv.success) {
  const formattedErrors = parsedEnv.error.issues
    .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
    .join('\n');

  throw new Error(`Invalid LocalClaw configuration:\n${formattedErrors}`);
}

const env = parsedEnv.data;

export const config = {
  nodeEnv: env.NODE_ENV,
  databaseUrl: env.DATABASE_URL,
  databaseSchema: env.DATABASE_SCHEMA,
  ssdBasePath: env.SSD_BASE_PATH,
  telegramBotToken: env.TELEGRAM_BOT_TOKEN ?? '',
  telegramChatId: env.TELEGRAM_CHAT_ID ?? '',
  githubPat: env.GITHUB_PAT ?? '',
  githubUsername: env.GITHUB_USERNAME ?? '',
  githubRepoOwner: env.GITHUB_REPO_OWNER ?? env.GITHUB_USERNAME ?? '',
  githubApiBaseUrl: env.GITHUB_API_BASE_URL,
  githubRepoVisibility: env.GITHUB_REPO_VISIBILITY,
  githubAutoPublish: env.GITHUB_AUTO_PUBLISH,
  gitDefaultBranch: env.GIT_DEFAULT_BRANCH,
  railwayApiToken: env.RAILWAY_API_TOKEN ?? '',
  railwayGraphqlEndpoint: env.RAILWAY_GRAPHQL_ENDPOINT,
  railwayProjectId: env.RAILWAY_PROJECT_ID ?? '',
  railwayEnvironmentId: env.RAILWAY_ENVIRONMENT_ID ?? '',
  railwayServiceId: env.RAILWAY_SERVICE_ID ?? '',
  railwayDeployEnabled: env.RAILWAY_DEPLOY_ENABLED,
  railwayDeployPollIntervalMs: env.RAILWAY_DEPLOY_POLL_INTERVAL_MS,
  railwayDeployTimeoutMs: env.RAILWAY_DEPLOY_TIMEOUT_MS,
  ollamaBaseUrl: env.OLLAMA_BASE_URL,
  ollamaKeepAlive: env.OLLAMA_KEEP_ALIVE,
  modelPlanner: env.MODEL_PLANNER,
  modelCoder: env.MODEL_CODER,
  modelFast: env.MODEL_FAST,
  modelReview: env.MODEL_REVIEW,
  modelEmbed: env.MODEL_EMBED,
  taskPollIntervalMs: env.TASK_POLL_INTERVAL_MS,
  taskTimeoutHours: env.TASK_TIMEOUT_HOURS,
  maxConsecutiveFailures: env.MAX_CONSECUTIVE_FAILURES,
  dockerSandboxEnabled: env.DOCKER_SANDBOX_ENABLED,
  skillsBuiltinDir: env.SKILLS_BUILTIN_DIR,
  skillsAllowGenerated: env.SKILLS_ALLOW_GENERATED,
  controlApiEnabled: env.CONTROL_API_ENABLED,
  controlApiHost: env.CONTROL_API_HOST,
  controlApiPort: env.CONTROL_API_PORT,
  controlApiToken: env.CONTROL_API_TOKEN ?? '',
};

export function requireConfig(...keys) {
  const missing = keys.filter((key) => !config[key]);

  if (missing.length > 0) {
    throw new Error(`Missing required LocalClaw config values: ${missing.join(', ')}`);
  }
}
