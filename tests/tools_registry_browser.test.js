import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import test from 'node:test';

import { createToolRegistry } from '../src/tools/registry.js';

test('tool registry delegates browser_automate to injected browser automation', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'localclaw-browser-tool-'));
  const calls = [];
  const registry = createToolRegistry({
    browserAutomation: {
      async runScenario(input, context) {
        calls.push({ input, context });
        return {
          summary: 'Browser automation completed',
          output: '{}',
          artifacts: [],
        };
      },
    },
  });

  const result = await registry.runTool(
    'browser_automate',
    {
      url: 'http://127.0.0.1:3000',
      actions: [{ type: 'wait_for', selector: 'body' }],
      captureScreenshot: false,
    },
    {
      workspaceRoot,
      taskId: 'task-1',
      projectTarget: {
        browser_allowed_origins: ['https://example.com'],
      },
    }
  );

  assert.equal(result.summary, 'Browser automation completed');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].context.workspaceRoot, workspaceRoot);
  assert.equal(calls[0].context.taskId, 'task-1');
});
