import fs from 'node:fs/promises';
import path from 'node:path';
import pino from 'pino';
import { getPool } from '../db/client.js';
import { createOllamaClient, extractJsonObjectText } from '../llm/ollama.js';
import { config } from '../config.js';

const logger = pino({
  name: 'localclaw-reflection-engine',
  level: config.nodeEnv === 'development' ? 'debug' : 'info',
});

export class ReflectionEngine {
  constructor(options = {}) {
    this.pool = options.pool ?? getPool();
    this.ollama = options.ollamaClient ?? createOllamaClient();
    this.modelName = options.modelName ?? config.modelReview;
    this.logger = options.logger ?? logger;
    this.mcpRegistry = options.mcpRegistry ?? null;
    this.rulesPath = options.rulesPath ?? path.resolve(process.cwd(), 'PROJECT_RULES.md');
  }

  getPostgresMcpServer() {
    return this.mcpRegistry?.getServer?.('postgres') ?? null;
  }

  async callPostgresTool(toolName, args, fallback) {
    const postgresServer = this.getPostgresMcpServer();
    if (postgresServer) {
      return postgresServer.callTool(toolName, args);
    }

    return fallback();
  }

  async runReflectionCycle() {
    this.logger.info('Starting self-reflection cycle on failed tasks');

    const result = await this.callPostgresTool(
      'list_recent_failed_tasks_without_reflection',
      {
        limit: 5,
        hours: 24,
      },
      async () => {
        const client = await this.pool.connect();
        try {
          return client.query(`
            SELECT t.id, t.title, t.description, t.blocked_reason, t.result
            FROM tasks t
            LEFT JOIN learnings l ON l.task_id = t.id AND l.category = 'system-reflection'
            WHERE t.status = 'failed'
              AND t.updated_at >= NOW() - INTERVAL '24 hours'
              AND l.id IS NULL
            LIMIT 5;
          `);
        } finally {
          client.release();
        }
      }
    );
    const failedTasks = result.rows;

    if (failedTasks.length === 0) {
      this.logger.debug('No new failed tasks require reflection.');
      return;
    }

    for (const task of failedTasks) {
      try {
        await this.reflectOnTask(task);
      } catch (error) {
        this.logger.error({ err: error, taskId: task.id }, 'Reflection failed for task');
      }
    }
  }

  async reflectOnTask(task) {
    // 1. Fetch step logs
    const result = await this.callPostgresTool(
      'list_task_logs',
      {
        taskId: task.id,
        limit: 200,
        order: 'asc',
      },
      () =>
        this.pool.query(
          `SELECT step_number, step_type, tool_called, status, error_message, output_summary
           FROM agent_logs
           WHERE task_id = $1
           ORDER BY step_number ASC`,
          [task.id]
        )
    );
    const logs = result.rows;

    if (logs.length === 0) return;

    const repairState = task?.result?.repairState ?? {};

    const logContext = logs.map(l => 
      `Step ${l.step_number} [${l.step_type}]: Tool=${l.tool_called || 'N/A'}, Status=${l.status}, Error=${l.error_message || 'None'}\nOutput: ${l.output_summary || 'N/A'}`
    ).join('\n---\n');

    // 2. Build Prompt
    const prompt = `You are the LocalClaw Reflection Engine.
Your job is to analyze a failed task and extract a single, actionable architectural rule to prevent this failure in the future.

Task Title: ${task.title}
Task Description: ${task.description}
Failure Reason: ${task.blocked_reason}
Repair State:
- status: ${repairState.status ?? 'none'}
- attemptCount: ${repairState.attemptCount ?? 0}
- maxAttempts: ${repairState.maxAttempts ?? 0}
- lastOutcome: ${repairState.lastOutcome ?? 'none'}
- lastFailureMessage: ${repairState.lastFailureMessage ?? 'none'}

Execution Logs:
${logContext}

Analyze why the agent failed. Extract ONE clear, universal programming or workflow constraint the agent must follow next time to avoid this.
Respond ONLY with a JSON object in this format:
{
  "category": "system-reflection",
  "observation": "Provide a detailed but concise explanation of the failure pattern.",
  "new_rule": "The exact sentence to append to PROJECT_RULES.md (e.g. 'Never use deprecated require() syntax').",
  "keywords": ["tag1", "tag2"]
}`;

    // 3. Generate Reflection
    const generation = await this.ollama.generate({
      model: this.modelName,
      prompt,
      format: 'json',
      temperature: 0.1
    });

    const jsonText = extractJsonObjectText(generation.responseText);
    const parsed = JSON.parse(jsonText);

    if (!parsed.new_rule || !parsed.observation) {
      throw new Error('LLM failed to output the required rule/observation format');
    }

    // 4. Persist in Database
    await this.callPostgresTool(
      'insert_learning',
      {
        taskId: task.id,
        category: 'system-reflection',
        observation: parsed.observation,
        keywords: parsed.keywords || [],
        confidenceScore: 8,
      },
      () =>
        this.pool.query(
          `INSERT INTO learnings (task_id, category, observation, keywords, confidence_score)
           VALUES ($1, $2, $3, $4::text[], $5)`,
          [task.id, 'system-reflection', parsed.observation, parsed.keywords || [], 8]
        )
    );

    // 5. Append to PROJECT_RULES.md
    try {
      let currentRules = await fs.readFile(this.rulesPath, 'utf8');
      if (!currentRules.includes(parsed.new_rule)) {
        await fs.appendFile(this.rulesPath, `\n- ${parsed.new_rule}\n`);
        this.logger.info({ rule: parsed.new_rule }, 'Appended new self-improvement rule to PROJECT_RULES.md');
      }
    } catch (fsError) {
      this.logger.warn({ err: fsError }, 'Could not append to PROJECT_RULES.md. It may not exist.');
      // If it doesn't exist, create it
      await fs.writeFile(this.rulesPath, `# LocalClaw Dynamic Rules\n\n- ${parsed.new_rule}\n`);
    }
  }
}
