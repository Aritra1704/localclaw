import 'dotenv/config';
import { getPool } from './src/db/client.js';
import { createToolRegistry } from './src/tools/registry.js';
import { createMcpRegistry } from './src/mcp/registry.js';
import { createSkillManager } from './src/skills/manager.js';
import { createTaskExecutor } from './src/agent/executor.js';
import pino from 'pino';

const logger = pino();

async function runDiagnostics() {
  console.log('--- localclaw Diagnostic Check ---');

  // 1. Database
  try {
    const pool = getPool();
    const result = await pool.query('SELECT NOW()');
    console.log('✅ Database connection: OK');
  } catch (err) {
    console.error('❌ Database connection: FAILED', err.message);
  }

  // 2. Tool Registry & Executor
  try {
    const mcpRegistry = createMcpRegistry();
    const skillManager = createSkillManager({ logger, mcpRegistry });
    const toolRegistry = createToolRegistry({ skillManager, mcpRegistry });
    
    const taskExecutor = createTaskExecutor({
      toolRegistry,
      planner: {},
      verifier: {},
      router: null
    });

    console.log('Checking taskExecutor structure:');
    console.log('- taskExecutor exists:', !!taskExecutor);
    console.log('- taskExecutor.toolRegistry exists:', !!taskExecutor.toolRegistry);
    
    if (taskExecutor.toolRegistry && typeof taskExecutor.toolRegistry.runTool === 'function') {
      console.log('✅ taskExecutor.toolRegistry.runTool is a function');
    } else {
      console.error('❌ taskExecutor.toolRegistry.runTool is MISSING or NOT A FUNCTION');
    }

  } catch (err) {
    console.error('❌ Registry/Executor initialization: FAILED', err.message);
  }

  process.exit(0);
}

runDiagnostics();
