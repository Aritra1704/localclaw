import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import pino from 'pino';

import { ReflectionEngine } from '../src/selfimprovement/reflectionEngine.js';

const logger = pino({ level: 'fatal' });

test('reflection engine uses postgres MCP server for task discovery, logs, and learning persistence', async () => {
  const rulesDir = await fs.mkdtemp(path.join(os.tmpdir(), 'localclaw-reflection-'));
  const rulesPath = path.join(rulesDir, 'PROJECT_RULES.md');
  const calls = [];

  const engine = new ReflectionEngine({
    pool: {
      async query() {
        throw new Error('Direct pool.query should not be used when MCP server is available');
      },
      async connect() {
        throw new Error('pool.connect should not be used when MCP server is available');
      },
    },
    ollamaClient: {
      async generate() {
        return {
          responseText: JSON.stringify({
            category: 'system-reflection',
            observation: 'Failures lacked a bounded retry rule.',
            new_rule: 'Always cap deployment retries after one no-log retry.',
            keywords: ['deploy', 'retry'],
          }),
        };
      },
    },
    logger,
    rulesPath,
    mcpRegistry: {
      getServer(name) {
        if (name !== 'postgres') {
          return null;
        }

        return {
          async callTool(toolName, args) {
            calls.push({ toolName, args });

            switch (toolName) {
              case 'list_recent_failed_tasks_without_reflection':
                return {
                  rows: [
                    {
                      id: 'task-1',
                      title: 'Deploy sample app',
                      description: 'Ship the latest release',
                      blocked_reason: 'Deploy failed',
                      result: {},
                    },
                  ],
                };
              case 'list_task_logs':
                return {
                  rows: [
                    {
                      step_number: 1,
                      step_type: 'deploy',
                      tool_called: 'railway_deploy',
                      status: 'error',
                      error_message: 'No logs returned',
                      output_summary: 'deployment failed',
                    },
                  ],
                };
              case 'insert_learning':
                return { rows: [{ id: 'learning-1' }] };
              default:
                throw new Error(`Unexpected MCP tool: ${toolName}`);
            }
          },
        };
      },
    },
  });

  await engine.runReflectionCycle();

  const rules = await fs.readFile(rulesPath, 'utf8');
  assert.match(rules, /Always cap deployment retries after one no-log retry/);
  assert.deepEqual(
    calls.map((entry) => entry.toolName),
    [
      'list_recent_failed_tasks_without_reflection',
      'list_task_logs',
      'insert_learning',
    ]
  );
});
