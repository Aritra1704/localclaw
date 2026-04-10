import fs from 'node:fs/promises';
import path from 'node:path';

import { normalizeTaskContract } from '../control/taskContract.js';

function parseArgs(argv) {
  const positionals = [];
  const options = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }

    const raw = token.slice(2);
    const separator = raw.indexOf('=');
    if (separator >= 0) {
      const key = raw.slice(0, separator);
      const value = raw.slice(separator + 1);
      options[key] = value;
      continue;
    }

    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      options[raw] = next;
      index += 1;
      continue;
    }

    options[raw] = true;
  }

  return { positionals, options };
}

function usage() {
  return [
    'LocalClaw CLI',
    '',
    'Commands:',
    '  localclaw status',
    '  localclaw tasks [--limit 20]',
    '  localclaw approvals [--limit 20]',
    '  localclaw skills [--limit 20] [--include-disabled]',
    '  localclaw pause [reason]',
    '  localclaw resume',
    '  localclaw approve <approval-id>',
    '  localclaw reject <approval-id> [reason]',
    '  localclaw task init [--file localclaw.task.json]',
    '  localclaw task plan --file <contract.json>',
    '  localclaw task run --file <contract.json> [--approve]',
    '  localclaw task approve <task-id>',
    '  localclaw task reject <task-id> [reason]',
    '',
    'Global options:',
    '  --host 127.0.0.1',
    '  --port 4173',
    '  --token <CONTROL_API_TOKEN>',
  ].join('\n');
}

function templateContract() {
  return {
    version: 'task_contract_v1',
    projectName: 'safe-commit',
    objective:
      'Implement the requested feature with tests and keep deployment behavior approval-gated.',
    inScope: ['Update source code', 'Add or update tests', 'Update docs if behavior changes'],
    outOfScope: ['Infrastructure migration', 'Unrelated refactors'],
    constraints: ['Use existing architecture', 'Do not bypass approval gates'],
    successCriteria: ['Tests pass', 'Changes are reviewable and production-safe'],
    priority: 'medium',
    skillHints: [],
    repoIntent: {
      publish: false,
      deploy: false,
    },
    notes: 'Optional operator notes',
  };
}

function resolveBaseUrl(options) {
  const host = options.host ?? process.env.CONTROL_API_HOST ?? '127.0.0.1';
  const port = options.port ?? process.env.CONTROL_API_PORT ?? '4173';
  return `http://${host}:${port}`;
}

function resolveToken(options) {
  return options.token ?? process.env.CONTROL_API_TOKEN ?? '';
}

function resolveWaitMs(options) {
  const rawValue = options['wait-ms'] ?? process.env.CONTROL_API_WAIT_MS ?? '30000';
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 30000;
  }

  return Math.min(parsed, 300000);
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function makePrinter(io) {
  const stdout = io?.stdout ?? process.stdout;
  const stderr = io?.stderr ?? process.stderr;

  return {
    out(message) {
      stdout.write(`${message}\n`);
    },
    err(message) {
      stderr.write(`${message}\n`);
    },
  };
}

function shouldRetryFetch(error) {
  const code = error?.cause?.code;
  return (
    error?.name === 'TypeError' ||
    error?.message === 'fetch failed' ||
    code === 'ECONNREFUSED' ||
    code === 'ECONNRESET' ||
    code === 'EHOSTUNREACH'
  );
}

async function fetchWithStartupRetry({
  fetchImpl,
  url,
  options,
  waitMs,
  sleepImpl,
  baseUrl,
}) {
  const startedAt = Date.now();
  let lastError = null;

  while (Date.now() - startedAt <= waitMs) {
    try {
      return await fetchImpl(url, options);
    } catch (error) {
      if (!shouldRetryFetch(error)) {
        throw error;
      }

      lastError = error;
      await sleepImpl(1000);
    }
  }

  throw new Error(
    `Control API is not reachable at ${baseUrl}. Confirm LocalClaw is running and /health returns ok. Last error: ${lastError?.message ?? 'unknown'}`
  );
}

async function waitForControlApi({ fetchImpl, baseUrl, waitMs, sleepImpl }) {
  const response = await fetchWithStartupRetry({
    fetchImpl,
    url: `${baseUrl}/health`,
    options: { method: 'GET' },
    waitMs,
    sleepImpl,
    baseUrl,
  });

  if (!response.ok) {
    throw new Error(`Control API health check failed: ${response.status} ${response.statusText}`);
  }
}

async function requestJson({
  fetchImpl,
  baseUrl,
  pathName,
  method = 'GET',
  token = '',
  body,
  waitMs = 30000,
  sleepImpl = sleep,
}) {
  const headers = {
    'content-type': 'application/json',
  };

  if (method !== 'GET' && method !== 'HEAD') {
    await waitForControlApi({ fetchImpl, baseUrl, waitMs, sleepImpl });
  }

  if (method !== 'GET' && method !== 'HEAD') {
    headers.authorization = `Bearer ${token}`;
  }

  const response = await fetchWithStartupRetry({
    fetchImpl,
    url: `${baseUrl}${pathName}`,
    options: {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    },
    waitMs,
    sleepImpl,
    baseUrl,
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload.message ?? `${response.status} ${response.statusText}`);
  }

  return payload.data;
}

async function readContractFromFile(filePath) {
  const content = await fs.readFile(filePath, 'utf8');
  return normalizeTaskContract(JSON.parse(content));
}

function ensureArg(value, message) {
  if (!value) {
    throw new Error(message);
  }

  return value;
}

export async function runCli(argv, io = {}, deps = {}) {
  const { positionals, options } = parseArgs(argv);
  const logger = makePrinter(io);

  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  if (!fetchImpl) {
    logger.err('Global fetch is not available in this runtime.');
    return 1;
  }

  const baseUrl = resolveBaseUrl(options);
  const token = resolveToken(options);
  const waitMs = resolveWaitMs(options);
  const sleepImpl = deps.sleepImpl ?? sleep;

  const command = positionals[0];

  try {
    if (!command || command === 'help' || command === '--help') {
      logger.out(usage());
      return 0;
    }

    if (command === 'status') {
      const status = await requestJson({
        fetchImpl,
        baseUrl,
        pathName: '/v1/status',
        waitMs,
        sleepImpl,
      });
      logger.out(
        [
          `Status: ${status.status}`,
          `Boot phase: ${status.bootPhase}`,
          `Polling active: ${status.pollingActive ? 'yes' : 'no'}`,
          `Pending: ${status.queue.pending_count}`,
          `In progress: ${status.queue.in_progress_count}`,
          `Blocked: ${status.queue.blocked_count}`,
          `Waiting approval: ${status.queue.waiting_approval_count}`,
          `Current task: ${status.currentTask?.title ?? 'none'}`,
        ].join('\n')
      );
      return 0;
    }

    if (command === 'tasks') {
      const limit = Number(options.limit ?? 20);
      const tasks = await requestJson({
        fetchImpl,
        baseUrl,
        pathName: `/v1/tasks?limit=${Number.isInteger(limit) ? limit : 20}`,
        waitMs,
        sleepImpl,
      });

      if (tasks.length === 0) {
        logger.out('No active tasks.');
        return 0;
      }

      logger.out(
        tasks
          .map((task) => `${task.id} | ${task.status} | ${task.priority} | ${task.title}`)
          .join('\n')
      );
      return 0;
    }

    if (command === 'approvals') {
      const limit = Number(options.limit ?? 20);
      const approvals = await requestJson({
        fetchImpl,
        baseUrl,
        pathName: `/v1/approvals?limit=${Number.isInteger(limit) ? limit : 20}`,
        waitMs,
        sleepImpl,
      });

      if (approvals.length === 0) {
        logger.out('No pending deploy approvals.');
        return 0;
      }

      logger.out(
        approvals
          .map((approval) => `${approval.id} | ${approval.task_title} | ${approval.target_env}`)
          .join('\n')
      );
      return 0;
    }

    if (command === 'skills') {
      const includeDisabled =
        options['include-disabled'] === true || options.includeDisabled === 'true';
      const limit = Number(options.limit ?? 20);
      const skills = await requestJson({
        fetchImpl,
        baseUrl,
        pathName: `/v1/skills?limit=${Number.isInteger(limit) ? limit : 20}&includeDisabled=${includeDisabled}`,
        waitMs,
        sleepImpl,
      });

      if (skills.length === 0) {
        logger.out('No registered skills.');
        return 0;
      }

      logger.out(
        skills
          .map(
            (skill) =>
              `${skill.name} (v${skill.version}) | enabled=${skill.is_enabled ? 'yes' : 'no'} | runs=${skill.total_runs}`
          )
          .join('\n')
      );
      return 0;
    }

    if (command === 'pause') {
      const reason = positionals.slice(1).join(' ').trim() || 'Paused via CLI';
      const response = await requestJson({
        fetchImpl,
        baseUrl,
        pathName: '/v1/pause',
        method: 'POST',
        token,
        body: { reason },
        waitMs,
        sleepImpl,
      });
      logger.out(`Paused: ${response.reason}`);
      return 0;
    }

    if (command === 'resume') {
      await requestJson({
        fetchImpl,
        baseUrl,
        pathName: '/v1/resume',
        method: 'POST',
        token,
        waitMs,
        sleepImpl,
      });
      logger.out('Resumed.');
      return 0;
    }

    if (command === 'approve') {
      const approvalId = ensureArg(positionals[1], 'Usage: localclaw approve <approval-id>');
      const response = await requestJson({
        fetchImpl,
        baseUrl,
        pathName: `/v1/approvals/${approvalId}/approve`,
        method: 'POST',
        token,
        waitMs,
        sleepImpl,
      });
      logger.out(`Approved deploy: ${response.id}`);
      return 0;
    }

    if (command === 'reject') {
      const approvalId = ensureArg(positionals[1], 'Usage: localclaw reject <approval-id> [reason]');
      const reason = positionals.slice(2).join(' ').trim() || 'Rejected via CLI';
      const response = await requestJson({
        fetchImpl,
        baseUrl,
        pathName: `/v1/approvals/${approvalId}/reject`,
        method: 'POST',
        token,
        body: { reason },
        waitMs,
        sleepImpl,
      });
      logger.out(`Rejected deploy: ${response.id}`);
      return 0;
    }

    if (command === 'task') {
      const subcommand = positionals[1];

      if (subcommand === 'init') {
        const filePath = path.resolve(options.file ?? 'localclaw.task.json');
        await fs.writeFile(filePath, `${JSON.stringify(templateContract(), null, 2)}\n`, 'utf8');
        logger.out(`Task template written: ${filePath}`);
        return 0;
      }

      if (subcommand === 'plan') {
        const filePath = path.resolve(
          ensureArg(options.file, 'Usage: localclaw task plan --file <contract.json>')
        );
        const contract = await readContractFromFile(filePath);
        const response = await requestJson({
          fetchImpl,
          baseUrl,
          pathName: '/v1/tasks/plan',
          method: 'POST',
          token,
          body: { contract },
          waitMs,
          sleepImpl,
        });

        logger.out(
          [
            `Task: ${response.task.id}`,
            `Status: ${response.task.status}`,
            `Plan: ${response.plan.summary}`,
          ].join('\n')
        );
        return 0;
      }

      if (subcommand === 'run') {
        const filePath = path.resolve(
          ensureArg(options.file, 'Usage: localclaw task run --file <contract.json> [--approve]')
        );
        const contract = await readContractFromFile(filePath);
        const approveExecution = options.approve === true;
        const response = await requestJson({
          fetchImpl,
          baseUrl,
          pathName: '/v1/tasks/run',
          method: 'POST',
          token,
          body: {
            contract,
            approveExecution,
          },
          waitMs,
          sleepImpl,
        });

        logger.out(
          [
            `Task: ${response.task.id}`,
            `Status: ${approveExecution ? 'pending' : response.task.status}`,
            `Execution approval: ${response.executionApproval.status}`,
          ].join('\n')
        );
        return 0;
      }

      if (subcommand === 'approve') {
        const taskId = ensureArg(positionals[2], 'Usage: localclaw task approve <task-id>');
        const response = await requestJson({
          fetchImpl,
          baseUrl,
          pathName: `/v1/tasks/${taskId}/approve-execution`,
          method: 'POST',
          token,
          waitMs,
          sleepImpl,
        });
        logger.out(`Execution approved: ${response.task_id}`);
        return 0;
      }

      if (subcommand === 'reject') {
        const taskId = ensureArg(positionals[2], 'Usage: localclaw task reject <task-id> [reason]');
        const reason = positionals.slice(3).join(' ').trim() || 'Rejected via CLI';
        const response = await requestJson({
          fetchImpl,
          baseUrl,
          pathName: `/v1/tasks/${taskId}/reject-execution`,
          method: 'POST',
          token,
          body: { reason },
          waitMs,
          sleepImpl,
        });
        logger.out(`Execution rejected: ${response.task_id}`);
        return 0;
      }

      throw new Error('Unknown task subcommand. Use: init | plan | run | approve | reject');
    }

    throw new Error(`Unknown command: ${command}`);
  } catch (error) {
    logger.err(error.message);
    return 1;
  }
}
