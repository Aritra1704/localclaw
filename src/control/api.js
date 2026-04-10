import http from 'node:http';

import { z } from 'zod';

import { normalizeTaskContract } from './taskContract.js';

const jsonHeaders = {
  'content-type': 'application/json; charset=utf-8',
};

const runRequestSchema = z
  .object({
    contract: z.unknown(),
    approveExecution: z.boolean().default(false),
  })
  .strict();

const rejectExecutionSchema = z
  .object({
    reason: z.string().trim().min(1).max(500).default('Execution rejected via control API'),
  })
  .partial()
  .strict();

const rejectApprovalSchema = z
  .object({
    reason: z.string().trim().min(1).max(500).default('Rejected via control API'),
  })
  .partial()
  .strict();

const pauseSchema = z
  .object({
    reason: z.string().trim().min(1).max(300).default('Paused via control API'),
  })
  .partial()
  .strict();

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, jsonHeaders);
  res.end(JSON.stringify(payload));
}

function sendValidationError(res, error) {
  sendJson(res, 400, {
    error: 'validation_error',
    message: 'Request validation failed',
    details: error?.issues ?? [],
  });
}

function parseLimit(rawValue, fallback) {
  if (!rawValue) {
    return fallback;
  }

  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 200) {
    return fallback;
  }

  return parsed;
}

async function readJsonBody(req) {
  const chunks = [];
  let totalSize = 0;

  for await (const chunk of req) {
    totalSize += chunk.length;
    if (totalSize > 1_000_000) {
      throw new Error('Request body too large');
    }
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) {
    return {};
  }

  return JSON.parse(text);
}

function extractToken(req) {
  const bearer = req.headers.authorization;
  if (typeof bearer === 'string') {
    const match = bearer.match(/^Bearer\s+(.+)$/i);
    if (match) {
      return match[1].trim();
    }
  }

  const headerToken = req.headers['x-control-token'];
  if (typeof headerToken === 'string') {
    return headerToken.trim();
  }

  if (Array.isArray(headerToken) && headerToken.length > 0) {
    return `${headerToken[0]}`.trim();
  }

  return null;
}

function normalizeContractPayload(body) {
  const candidate = body?.contract ?? body;
  return normalizeTaskContract(candidate);
}

function isMutatingRequest(req) {
  return req.method !== 'GET' && req.method !== 'HEAD';
}

export function createControlApiServer({
  orchestrator,
  logger,
  host,
  port,
  token,
}) {
  if (!orchestrator) {
    throw new Error('Control API requires an orchestrator instance');
  }

  if (!token) {
    throw new Error('Control API requires a token for mutating endpoints');
  }

  const server = http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
    const pathname = requestUrl.pathname;

    try {
      if (pathname === '/health' && req.method === 'GET') {
        sendJson(res, 200, { ok: true });
        return;
      }

      if (isMutatingRequest(req)) {
        const providedToken = extractToken(req);
        if (!providedToken || providedToken !== token) {
          sendJson(res, 401, {
            error: 'unauthorized',
            message: 'Missing or invalid control API token',
          });
          return;
        }
      }

      if (pathname === '/v1/status' && req.method === 'GET') {
        const snapshot = await orchestrator.getStatusSnapshot();
        sendJson(res, 200, { data: snapshot });
        return;
      }

      if (pathname === '/v1/tasks' && req.method === 'GET') {
        const limit = parseLimit(requestUrl.searchParams.get('limit'), 20);
        const tasks = await orchestrator.listTasks(limit);
        sendJson(res, 200, { data: tasks });
        return;
      }

      if (pathname === '/v1/approvals' && req.method === 'GET') {
        const limit = parseLimit(requestUrl.searchParams.get('limit'), 20);
        const approvals = await orchestrator.listPendingApprovals(limit);
        sendJson(res, 200, { data: approvals });
        return;
      }

      if (pathname === '/v1/skills' && req.method === 'GET') {
        const includeDisabled =
          requestUrl.searchParams.get('includeDisabled') === 'true';
        const limit = parseLimit(requestUrl.searchParams.get('limit'), 20);
        const skills = await orchestrator.listSkills({ includeDisabled, limit });
        sendJson(res, 200, { data: skills });
        return;
      }

      const taskIdMatch = pathname.match(/^\/v1\/tasks\/([0-9a-f-]{36})$/i);
      if (taskIdMatch && req.method === 'GET') {
        const taskDetails = await orchestrator.getTaskDetails(taskIdMatch[1]);
        if (!taskDetails) {
          sendJson(res, 404, {
            error: 'not_found',
            message: 'Task not found',
          });
          return;
        }

        sendJson(res, 200, { data: taskDetails });
        return;
      }

      if (pathname === '/v1/tasks/plan' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const contract = normalizeContractPayload(body);
        const plannedTask = await orchestrator.createPlannedTask(contract, {
          source: 'control_api',
        });

        sendJson(res, 201, {
          data: plannedTask,
        });
        return;
      }

      if (pathname === '/v1/tasks/run' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const parsed = runRequestSchema.parse({
          contract: body?.contract ?? body,
          approveExecution: body?.approveExecution,
        });

        const contract = normalizeTaskContract(parsed.contract);
        const plannedTask = await orchestrator.createPlannedTask(contract, {
          source: 'control_api',
        });

        let executionApproval = {
          status: 'pending',
          taskId: plannedTask.task.id,
        };

        if (parsed.approveExecution) {
          const approved = await orchestrator.approveTaskExecution(plannedTask.task.id, {
            respondedVia: 'control_api',
            note: 'Approved immediately by /v1/tasks/run',
          });

          if (!approved) {
            sendJson(res, 409, {
              error: 'conflict',
              message: 'Task execution approval could not be applied',
            });
            return;
          }

          executionApproval = {
            status: 'approved',
            taskId: approved.task_id,
          };
        }

        sendJson(res, 201, {
          data: {
            ...plannedTask,
            executionApproval,
          },
        });
        return;
      }

      const approveExecutionMatch = pathname.match(
        /^\/v1\/tasks\/([0-9a-f-]{36})\/approve-execution$/i
      );
      if (approveExecutionMatch && req.method === 'POST') {
        const approved = await orchestrator.approveTaskExecution(approveExecutionMatch[1], {
          respondedVia: 'control_api',
        });

        if (!approved) {
          sendJson(res, 409, {
            error: 'conflict',
            message: 'Task is not waiting execution approval',
          });
          return;
        }

        sendJson(res, 200, { data: approved });
        return;
      }

      const rejectExecutionMatch = pathname.match(
        /^\/v1\/tasks\/([0-9a-f-]{36})\/reject-execution$/i
      );
      if (rejectExecutionMatch && req.method === 'POST') {
        const body = await readJsonBody(req);
        const parsed = rejectExecutionSchema.parse(body);
        const rejected = await orchestrator.rejectTaskExecution(rejectExecutionMatch[1], {
          respondedVia: 'control_api',
          reason: parsed.reason,
        });

        if (!rejected) {
          sendJson(res, 409, {
            error: 'conflict',
            message: 'Task is not waiting execution approval',
          });
          return;
        }

        sendJson(res, 200, { data: rejected });
        return;
      }

      const approveMatch = pathname.match(/^\/v1\/approvals\/([0-9a-f-]{36})\/approve$/i);
      if (approveMatch && req.method === 'POST') {
        const approval = await orchestrator.approveApproval(approveMatch[1], {
          respondedVia: 'control_api',
        });

        if (!approval) {
          sendJson(res, 404, {
            error: 'not_found',
            message: 'Approval not found or already handled',
          });
          return;
        }

        sendJson(res, 200, { data: approval });
        return;
      }

      const rejectMatch = pathname.match(/^\/v1\/approvals\/([0-9a-f-]{36})\/reject$/i);
      if (rejectMatch && req.method === 'POST') {
        const body = await readJsonBody(req);
        const parsed = rejectApprovalSchema.parse(body);
        const approval = await orchestrator.rejectApproval(rejectMatch[1], {
          respondedVia: 'control_api',
          reason: parsed.reason,
        });

        if (!approval) {
          sendJson(res, 404, {
            error: 'not_found',
            message: 'Approval not found or already handled',
          });
          return;
        }

        sendJson(res, 200, { data: approval });
        return;
      }

      if (pathname === '/v1/pause' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const parsed = pauseSchema.parse(body);
        await orchestrator.pause(parsed.reason);
        sendJson(res, 200, { data: { status: 'paused', reason: parsed.reason } });
        return;
      }

      if (pathname === '/v1/resume' && req.method === 'POST') {
        await orchestrator.resume();
        sendJson(res, 200, { data: { status: 'running' } });
        return;
      }

      sendJson(res, 404, {
        error: 'not_found',
        message: 'Endpoint not found',
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        sendValidationError(res, error);
        return;
      }

      if (error instanceof SyntaxError) {
        sendJson(res, 400, {
          error: 'invalid_json',
          message: 'Request body must be valid JSON',
        });
        return;
      }

      logger?.error?.({ err: error, path: pathname, method: req.method }, 'Control API request failed');
      sendJson(res, 500, {
        error: 'internal_error',
        message: error.message,
      });
    }
  });

  return {
    async start() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.removeListener('error', reject);
          resolve();
        });
      });

      const address = server.address();
      return {
        host,
        port: typeof address === 'object' && address ? address.port : port,
      };
    },

    async stop() {
      if (!server.listening) {
        return;
      }

      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    },

    get server() {
      return server;
    },
  };
}
