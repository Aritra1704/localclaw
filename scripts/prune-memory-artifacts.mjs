import { closePool, getPool } from '../src/db/client.js';
import { getMemoryRetentionPolicy, pruneMemoryArtifactsWithPool } from '../src/memory/retention.js';

async function main() {
  const policy = getMemoryRetentionPolicy();
  const summary = await pruneMemoryArtifactsWithPool(getPool(), policy, {
    maxRows: policy.maxPrune,
  });

  console.log(JSON.stringify(summary, null, 2));
}

main()
  .then(async () => {
    await closePool();
  })
  .catch(async (error) => {
    console.error('Memory prune failed:', error);
    await closePool().catch(() => {});
    process.exit(1);
  });

