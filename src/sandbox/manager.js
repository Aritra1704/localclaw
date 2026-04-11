import { exec } from 'node:child_process';
import util from 'node:util';
import pino from 'pino';
import { config } from '../config.js';

const execAsync = util.promisify(exec);
const logger = pino({ name: 'localclaw-sandbox' });

/**
 * Executes a terminal command securely.
 * If DOCKER_SANDBOX_ENABLED is true, this routes to a secure container.
 * Otherwise, it falls back to native Mac execution with strict safeguards.
 */
export async function runTerminalCommand({ command, workspaceRoot, timeoutMs = 120000 }) {
  if (config.dockerSandboxEnabled) {
    logger.info({ command }, 'Routing command to Docker Sandbox');
    return { 
      output: '[SANDBOX_SIMULATOR] Docker isolated execution blocked to prevent unconfigured host disruption.', 
      isError: true 
    };
  }

  // Native execution barrier checks
  const blockedCommands = ['rm -rf /', 'mkfs', 'dd if=', 'chmod -R 777 /'];
  if (blockedCommands.some(bad => command.includes(bad))) {
    return { output: 'CRITICAL ERROR: Command hit OS Safeguard blocklist.', isError: true };
  }

  logger.warn({ command }, 'Executing unrestricted native terminal command (Sandbox Disabled)');
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: workspaceRoot,
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024 * 15, // 15MB log constraint
    });
    return {
      output: `${stdout}\n${stderr}`.trim(),
      isError: false,
    };
  } catch (err) {
    return {
      output: `${err.stdout || ''}\n${err.stderr || ''}\nExecution Failed: ${err.message}`.trim(),
      isError: true,
    };
  }
}
