import assert from 'node:assert/strict';
import test from 'node:test';

import { shouldAttemptAutoPublish } from '../src/agent/executor.js';

test('publish policy skips auto-publish for run_skill-only tasks', () => {
  const shouldPublish = shouldAttemptAutoPublish(
    {
      title: 'Use run_skill scaffold_node_http_service to scaffold',
      description: 'Scaffold a local node service named phase6-smoke on port 4100',
    },
    {
      steps: [
        {
          tool: 'run_skill',
        },
      ],
    }
  );

  assert.equal(shouldPublish, false);
});

test('publish policy allows auto-publish when intent is explicit', () => {
  const shouldPublish = shouldAttemptAutoPublish(
    {
      title: 'Create app and deploy to railway',
      description: 'Publish to GitHub and deploy to Railway production',
    },
    {
      steps: [
        {
          tool: 'run_skill',
        },
      ],
    }
  );

  assert.equal(shouldPublish, true);
});

test('publish policy allows non-skill plans by default', () => {
  const shouldPublish = shouldAttemptAutoPublish(
    {
      title: 'phase4-sample-app',
      description: 'Create deploy-ready app',
    },
    {
      steps: [
        {
          tool: 'write_file',
        },
      ],
    }
  );

  assert.equal(shouldPublish, true);
});
