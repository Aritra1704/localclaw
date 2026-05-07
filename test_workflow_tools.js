import { getPool } from './src/db/client.js';
import { createToolRegistry } from './src/tools/registry.js';

async function testSpawn() {
  const pool = getPool();
  
  // Mock orchestrator
  const mockOrchestrator = {
    createTask: async (description, options) => {
      console.log('Orchestrator.createTask called with:', { description, options });
      return { id: 'test-uuid', title: options.title, status: 'pending' };
    },
    getTaskDetails: async (taskId) => {
      return { id: taskId, status: 'done' };
    }
  };

  const registry = createToolRegistry({ orchestrator: mockOrchestrator });

  console.log('Testing spawn_subtask...');
  const spawnResult = await registry.runTool('spawn_subtask', {
    title: 'Test Subtask',
    description: 'This is a test'
  }, { workspaceRoot: '.' });
  console.log('Spawn Result:', spawnResult.summary);

  console.log('\nTesting get_task_status...');
  const statusResult = await registry.runTool('get_task_status', {
    taskId: '550e8400-e29b-41d4-a716-446655440000'
  }, { workspaceRoot: '.' });
  console.log('Status Result:', statusResult.summary);

  await pool.end();
}

testSpawn().catch(console.error);
