import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { normalizeTaskContract } from '../src/control/taskContract.js';
import { runCli } from '../src/cli/index.js';

function createIO() {
  const out = [];
  const err = [];

  return {
    out,
    err,
    io: {
      stdout: {
        write(chunk) {
          out.push(String(chunk));
        },
      },
      stderr: {
        write(chunk) {
          err.push(String(chunk));
        },
      },
    },
  };
}

test('cli task init writes a valid task_contract_v1 template', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'localclaw-cli-'));
  const templatePath = path.join(tempRoot, 'task.json');
  const capture = createIO();

  const exitCode = await runCli(['task', 'init', '--file', templatePath], capture.io);
  assert.equal(exitCode, 0);

  const content = await fs.readFile(templatePath, 'utf8');
  const parsed = normalizeTaskContract(JSON.parse(content));
  assert.equal(parsed.version, 'task_contract_v1');
  assert.match(capture.out.join(''), /Task template written:/);
});

test('cli task plan posts contract payload and prints task id and steps', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'localclaw-cli-'));
  const contractPath = path.join(tempRoot, 'task.json');

  const contract = {
    version: 'task_contract_v1',
    projectName: 'phase7-cli',
    objective: 'Plan a strict execution contract for CLI testing flow.',
    inScope: ['Create control API', 'Create CLI command'],
    outOfScope: ['UI work'],
    constraints: ['No unsafe deploy bypass'],
    successCriteria: ['Plan summary returned'],
    priority: 'medium',
    skillHints: [],
    repoIntent: { publish: false, deploy: false },
  };

  await fs.writeFile(contractPath, JSON.stringify(contract, null, 2));

  const capture = createIO();
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith('/health')) {
      return {
        ok: true,
        status: 200,
        async json() {
          return { ok: true };
        },
      };
    }

    return {
      ok: true,
      status: 201,
      async json() {
        return {
          data: {
            task: {
              id: '11111111-1111-4111-8111-111111111111',
              status: 'waiting_approval',
            },
            plan: {
              summary: 'Plan generated',
              steps: [
                {
                  stepNumber: 1,
                  objective: 'Define API contract',
                  tool: 'planner',
                },
                {
                  stepNumber: 2,
                  objective: 'Prepare execution checklist',
                  tool: 'planner',
                },
              ],
            },
          },
        };
      },
    };
  };

  const exitCode = await runCli(
    [
      'task',
      'plan',
      '--file',
      contractPath,
      '--host',
      '127.0.0.1',
      '--port',
      '4173',
      '--token',
      'abc123',
    ],
    capture.io,
    { fetchImpl }
  );

  assert.equal(exitCode, 0);
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /\/health$/);
  assert.match(calls[1].url, /\/v1\/tasks\/plan$/);
  assert.equal(calls[1].options.method, 'POST');

  const body = JSON.parse(calls[1].options.body);
  assert.equal(body.contract.projectName, 'phase7-cli');
  assert.match(capture.out.join(''), /Task: 11111111-1111-4111-8111-111111111111/);
  assert.match(capture.out.join(''), /Steps:/);
  assert.match(capture.out.join(''), /1\. Define API contract \[planner\]/);
  assert.match(capture.out.join(''), /2\. Prepare execution checklist \[planner\]/);
});

test('cli task run --approve sends approveExecution=true', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'localclaw-cli-'));
  const contractPath = path.join(tempRoot, 'task.json');

  const contract = {
    version: 'task_contract_v1',
    projectName: 'phase7-run',
    objective: 'Run strict contract through approve-execution fast path.',
    inScope: ['Prepare task contract'],
    outOfScope: ['Deploy'],
    constraints: ['Use control API only'],
    successCriteria: ['Execution approved in response payload'],
    priority: 'high',
    skillHints: [],
    repoIntent: { publish: false, deploy: false },
  };

  await fs.writeFile(contractPath, JSON.stringify(contract, null, 2));

  const capture = createIO();
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith('/health')) {
      return {
        ok: true,
        status: 200,
        async json() {
          return { ok: true };
        },
      };
    }

    return {
      ok: true,
      status: 201,
      async json() {
        return {
          data: {
            task: {
              id: '22222222-2222-4222-8222-222222222222',
              status: 'waiting_approval',
            },
            executionApproval: {
              status: 'approved',
            },
          },
        };
      },
    };
  };

  const exitCode = await runCli(
    ['task', 'run', '--file', contractPath, '--approve', '--token', 'abc123'],
    capture.io,
    { fetchImpl }
  );

  assert.equal(exitCode, 0);
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /\/health$/);
  assert.match(calls[1].url, /\/v1\/tasks\/run$/);

  const body = JSON.parse(calls[1].options.body);
  assert.equal(body.approveExecution, true);
  assert.match(capture.out.join(''), /Execution approval: approved/);
});

test('cli waits for control API health before mutating requests', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'localclaw-cli-'));
  const contractPath = path.join(tempRoot, 'task.json');

  const contract = {
    version: 'task_contract_v1',
    projectName: 'phase7-wait',
    objective: 'Retry the health check before sending a mutating request.',
    inScope: ['Wait for local API readiness'],
    outOfScope: ['Deploy'],
    constraints: ['Keep retry bounded'],
    successCriteria: ['Plan request is sent after health succeeds'],
    priority: 'medium',
    skillHints: [],
    repoIntent: { publish: false, deploy: false },
  };

  await fs.writeFile(contractPath, JSON.stringify(contract, null, 2));

  const capture = createIO();
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith('/health') && calls.length === 1) {
      const error = new TypeError('fetch failed');
      error.cause = { code: 'ECONNREFUSED' };
      throw error;
    }

    if (url.endsWith('/health')) {
      return {
        ok: true,
        status: 200,
        async json() {
          return { ok: true };
        },
      };
    }

    return {
      ok: true,
      status: 201,
      async json() {
        return {
          data: {
            task: {
              id: '33333333-3333-4333-8333-333333333333',
              status: 'waiting_approval',
            },
            plan: {
              summary: 'Plan generated after readiness wait',
            },
          },
        };
      },
    };
  };

  const exitCode = await runCli(
    ['task', 'plan', '--file', contractPath, '--token', 'abc123', '--wait-ms', '2000'],
    capture.io,
    {
      fetchImpl,
      sleepImpl: async () => {},
    }
  );

  assert.equal(exitCode, 0);
  assert.equal(calls.length, 3);
  assert.match(calls[0].url, /\/health$/);
  assert.match(calls[1].url, /\/health$/);
  assert.match(calls[2].url, /\/v1\/tasks\/plan$/);
  assert.match(capture.out.join(''), /33333333-3333-4333-8333-333333333333/);
});

test('cli loads CONTROL_API_TOKEN from nearest .env for mutating requests', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'localclaw-cli-env-'));
  const contractPath = path.join(tempRoot, 'task.json');
  const previousToken = process.env.CONTROL_API_TOKEN;
  const previousHost = process.env.CONTROL_API_HOST;
  const previousPort = process.env.CONTROL_API_PORT;

  delete process.env.CONTROL_API_TOKEN;
  delete process.env.CONTROL_API_HOST;
  delete process.env.CONTROL_API_PORT;

  const contract = {
    version: 'task_contract_v1',
    projectName: 'phase7-env',
    objective: 'Verify CLI discovers the control API token from the nearest env file.',
    inScope: ['Load env file'],
    outOfScope: ['Prompt user for token'],
    constraints: ['Do not print token'],
    successCriteria: ['Authorization header is sent'],
    priority: 'medium',
    skillHints: [],
    repoIntent: { publish: false, deploy: false },
  };

  await fs.writeFile(contractPath, JSON.stringify(contract, null, 2));
  await fs.writeFile(
    path.join(tempRoot, '.env'),
    [
      'CONTROL_API_HOST=127.0.0.1',
      'CONTROL_API_PORT=4173',
      'CONTROL_API_TOKEN=nearest-env-token',
    ].join('\n')
  );

  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith('/health')) {
      return {
        ok: true,
        status: 200,
        async json() {
          return { ok: true };
        },
      };
    }

    return {
      ok: true,
      status: 201,
      async json() {
        return {
          data: {
            task: {
              id: '44444444-4444-4444-8444-444444444444',
              status: 'waiting_approval',
            },
            plan: {
              summary: 'Plan generated',
            },
          },
        };
      },
    };
  };

  try {
    const capture = createIO();
    const exitCode = await runCli(
      ['task', 'plan', '--file', contractPath],
      capture.io,
      { fetchImpl, cwd: tempRoot }
    );

    assert.equal(exitCode, 0);
    assert.equal(calls[1].options.headers.authorization, 'Bearer nearest-env-token');
    assert.doesNotMatch(capture.out.join(''), /nearest-env-token/);
  } finally {
    if (previousToken === undefined) {
      delete process.env.CONTROL_API_TOKEN;
    } else {
      process.env.CONTROL_API_TOKEN = previousToken;
    }
    if (previousHost === undefined) {
      delete process.env.CONTROL_API_HOST;
    } else {
      process.env.CONTROL_API_HOST = previousHost;
    }
    if (previousPort === undefined) {
      delete process.env.CONTROL_API_PORT;
    } else {
      process.env.CONTROL_API_PORT = previousPort;
    }
  }
});

test('cli doctor reports token without printing its value', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'localclaw-cli-doctor-'));
  const previousToken = process.env.CONTROL_API_TOKEN;
  delete process.env.CONTROL_API_TOKEN;
  await fs.writeFile(path.join(tempRoot, '.env'), 'CONTROL_API_TOKEN=doctor-secret\n');

  const fetchImpl = async (url) => {
    if (url.endsWith('/health')) {
      return {
        ok: true,
        status: 200,
        async json() {
          return { ok: true };
        },
      };
    }
    if (url.endsWith('/v1/status')) {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            data: {
              bootPhase: 'boot_complete',
              pollingActive: true,
            },
          };
        },
      };
    }
    if (url.endsWith('/api/tags')) {
      return {
        ok: true,
        status: 200,
        async json() {
          return { models: [] };
        },
      };
    }
    throw new Error(`unexpected url ${url}`);
  };

  try {
    const capture = createIO();
    const exitCode = await runCli(['doctor'], capture.io, {
      fetchImpl,
      cwd: tempRoot,
      execFileImpl: async () => ({ stdout: '[]' }),
    });

    assert.equal(exitCode, 0);
    assert.match(capture.out.join(''), /control token: present/);
    assert.doesNotMatch(capture.out.join(''), /doctor-secret/);
  } finally {
    if (previousToken === undefined) {
      delete process.env.CONTROL_API_TOKEN;
    } else {
      process.env.CONTROL_API_TOKEN = previousToken;
    }
  }
});

test('cli chat shows pending plan details for auto-planned requests without starting execution', async () => {
  const capture = createIO();
  const calls = [];
  const input = new PassThrough();
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });

    if (url.endsWith('/health')) {
      return {
        ok: true,
        status: 200,
        async json() {
          return { ok: true };
        },
      };
    }

    if (url.endsWith('/v1/chat/sessions')) {
      return {
        ok: true,
        status: 201,
        async json() {
          return {
            data: {
              id: 'chat-session-1',
              actor: 'architect',
              project_path: '/tmp/demo-project',
            },
          };
        },
      };
    }

    if (url.endsWith('/v1/chat/sessions/chat-session-1/messages')) {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            data: {
              assistant: {
                content: 'I turned that request into an approval-gated task.',
                metadata: {
                  taskId: '55555555-5555-4555-8555-555555555555',
                  taskStatus: 'waiting_approval',
                  executionPending: true,
                  autoPlannedFromChat: true,
                  plan: {
                    summary: 'Create the project directory and write the plan file.',
                    steps: [
                      {
                        stepNumber: 1,
                        objective: 'Create the project directory',
                        tool: 'shell',
                      },
                      {
                        stepNumber: 2,
                        objective: 'Write the planning markdown file',
                        tool: 'filesystem',
                      },
                    ],
                  },
                },
              },
            },
          };
        },
      };
    }

    throw new Error(`unexpected url ${url}`);
  };

  queueMicrotask(() => {
    input.write('create the project directory and write the plan file\n');
    input.write('/exit\n');
    input.end();
  });

  const exitCode = await runCli(['chat', '--project', '/tmp/demo-project', '--token', 'abc123'], capture.io, {
    fetchImpl,
    input,
  });

  assert.equal(exitCode, 0);
  assert.equal(
    calls.filter((call) => /\/v1\/tasks\/55555555-5555-4555-8555-555555555555$/.test(call.url)).length,
    0
  );

  const output = capture.out.join('');
  assert.match(output, /approval-gated task/);
  assert.match(output, /Task: 55555555-5555-4555-8555-555555555555/);
  assert.match(output, /Status: waiting_approval/);
  assert.match(output, /1\. Create the project directory \[shell\]/);
  assert.match(output, /Execution is still approval-gated/);
  assert.doesNotMatch(output, /Watching task progress/);
});

test('cli chat prints heartbeat updates while an approved task stays active', async () => {
  const capture = createIO();
  const calls = [];
  const input = new PassThrough();
  let taskPollCount = 0;

  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });

    if (url.endsWith('/health')) {
      return {
        ok: true,
        status: 200,
        async json() {
          return { ok: true };
        },
      };
    }

    if (url.endsWith('/v1/chat/sessions')) {
      return {
        ok: true,
        status: 201,
        async json() {
          return {
            data: {
              id: 'chat-session-2',
              actor: 'architect',
              project_path: '/tmp/demo-project',
            },
          };
        },
      };
    }

    if (url.endsWith('/v1/chat/sessions/chat-session-2/messages')) {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            data: {
              assistant: {
                content: 'Execution approved for task 66666666-6666-4666-8666-666666666666. Work is now in progress.',
                metadata: {
                  executionApproval: {
                    task_id: '66666666-6666-4666-8666-666666666666',
                    status: 'approved',
                  },
                },
              },
            },
          };
        },
      };
    }

    if (url.endsWith('/v1/tasks/66666666-6666-4666-8666-666666666666')) {
      taskPollCount += 1;
      if (taskPollCount < 4) {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              data: {
                task: {
                  id: '66666666-6666-4666-8666-666666666666',
                  status: 'in_progress',
                },
                runtime: {
                  phase: 'planning',
                  phaseLabel: 'Planning task',
                  detail: 'Planner model is generating the execution checklist.',
                },
              },
            };
          },
        };
      }

      return {
        ok: true,
        status: 200,
        async json() {
          return {
            data: {
              task: {
                id: '66666666-6666-4666-8666-666666666666',
                status: 'done',
              },
              runtime: {
                phase: 'complete',
                phaseLabel: 'Done',
                detail: 'Task finished successfully.',
              },
            },
          };
        },
      };
    }

    throw new Error(`unexpected url ${url}`);
  };

  queueMicrotask(() => {
    input.write('yes, start it\n');
    input.write('/exit\n');
    input.end();
  });

  const exitCode = await runCli(['chat', '--project', '/tmp/demo-project', '--token', 'abc123'], capture.io, {
    fetchImpl,
    input,
    sleepImpl: async () => {},
  });

  assert.equal(exitCode, 0);

  const output = capture.out.join('');
  assert.match(output, /Watching task progress/);
  assert.match(output, /\[task 66666666-6666-4666-8666-666666666666\] in_progress \| Planning task/);
  assert.match(output, /\[task 66666666-6666-4666-8666-666666666666\] still planning the task\.\.\./);
  assert.match(output, /\[task 66666666-6666-4666-8666-666666666666\] done \| Done/);
});
