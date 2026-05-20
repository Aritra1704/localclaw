import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createGraphifyAdapter } from '../src/memory/graphifyAdapter.js';

test('graphify adapter normalizes file-oriented graph exports', async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'localclaw-graphify-'));
  const indexDir = path.join(projectRoot, '.localclaw');
  await fs.mkdir(indexDir, { recursive: true });
  await fs.writeFile(
    path.join(indexDir, 'graphify-index.json'),
    JSON.stringify({
      files: [
        {
          path: 'src/index.js',
          symbols: [{ name: 'bootstrap', kind: 'function', exported: true }],
          imports: [{ specifier: './config.js' }],
          references: [{ path: 'README.md' }],
        },
      ],
    })
  );

  const adapter = createGraphifyAdapter();
  const normalized = await adapter.loadNormalizedGraph({ projectRoot });

  assert.equal(normalized.source, 'graphify');
  assert.equal(normalized.nodes.some((node) => node.nodeKey === 'file:src/index.js'), true);
  assert.equal(
    normalized.nodes.some((node) => node.nodeKey === 'symbol:src/index.js:bootstrap'),
    true
  );
  assert.equal(
    normalized.edges.some((edge) => edge.edgeType === 'contains' && edge.toNodeKey === 'symbol:src/index.js:bootstrap'),
    true
  );
});
