import { z } from 'zod';
import pino from 'pino';
import { config } from '../config.js';
import { createOllamaClient, extractJsonObjectText } from '../llm/ollama.js';
import { TOOL_DEFINITIONS, TOOL_NAMES } from '../tools/registry.js';

const logger = pino({
  name: 'localclaw-repair-engine',
  level: config.nodeEnv === 'development' ? 'debug' : 'info',
});

const toolArgsSchemaByName = Object.fromEntries(
  TOOL_DEFINITIONS.map((tool) => [tool.name, tool.argsSchema])
);

const repairStepSchema = z.object({
  stepNumber: z.number().int().positive(),
  objective: z.string().min(1),
  tool: z.enum(TOOL_NAMES),
  args: z.record(z.string(), z.unknown()).default({}),
});

const repairProposalSchema = z.object({
  summary: z.string().min(1),
  reasoning: z.string().min(1),
  steps: z.array(repairStepSchema).min(1).max(3),
});

function parseRepairOutput(text) {
  const jsonText = extractJsonObjectText(text);
  const parsed = JSON.parse(jsonText);
  
  // Normalize steps
  if (Array.isArray(parsed.steps)) {
    parsed.steps = parsed.steps.map((step, index) => ({
      ...step,
      stepNumber: index + 1,
      args: toolArgsSchemaByName[step.tool] ? toolArgsSchemaByName[step.tool].parse(step.args ?? {}) : step.args,
    }));
  }

  return repairProposalSchema.parse(parsed);
}

function buildRepairPrompt(task, context) {
  const existingFiles =
    context.workspaceSnapshot.length > 0
      ? context.workspaceSnapshot
          .map((entry) => `- ${entry.path} (${entry.type})`)
          .join('\n')
      : '- workspace is currently empty';

  const logContext = context.executionLogs.map(l => 
    `Step ${l.stepNumber} [${l.step_type}]: Tool=${l.tool_called || 'N/A'}, Status=${l.status}, Error=${l.error_message || 'None'}\nOutput: ${l.output_summary || 'N/A'}`
  ).join('\n---\n');

  return `You are the LocalClaw Repair Engine.
A tool execution has failed, and you must propose a repair plan to fix the issue and allow the task to continue.

Task Title: ${task.title}
Task Description: ${task.description}

Failed Step:
- Objective: ${context.failedStep.objective}
- Tool: ${context.failedStep.tool}
- Args: ${JSON.stringify(context.failedStep.args)}
- Error: ${context.errorMessage}

Execution Logs so far:
${logContext}

Workspace entries:
${existingFiles}

Analyze the failure. Propose a short repair plan (1-3 steps) to fix the immediate cause of the failure.
Common repairs:
- Creating a missing directory or file.
- Fixing a syntax error in a file.
- Using a different tool or different arguments for the failed step.

Return exactly one JSON object:
{
  "summary": "Short summary of the repair",
  "reasoning": "Detailed explanation of why the repair will fix the issue",
  "steps": [
    {
      "stepNumber": 1,
      "objective": "Step objective",
      "tool": "one of: ${TOOL_NAMES.join(', ')}",
      "args": { ... }
    }
  ]
}

Rules:
- Use ONLY allowed tools.
- All paths must be relative to the workspace root.
- Keep the repair plan concise.`;
}

export class RepairEngine {
  constructor(options = {}) {
    this.ollama = options.ollamaClient ?? createOllamaClient();
    this.modelName = options.modelName ?? config.modelReview;
    this.logger = options.logger ?? logger;
  }

  async generateRepairProposal(task, context) {
    this.logger.info({ taskId: task.id }, 'Generating repair proposal');

    const prompt = buildRepairPrompt(task, context);
    
    const response = await this.ollama.generate({
      model: this.modelName,
      prompt,
      format: 'json',
      options: {
        temperature: 0.1,
      },
    });

    try {
      const proposal = parseRepairOutput(response.responseText);
      return {
        proposal,
        modelUsed: this.modelName,
        durationMs: response.totalDuration ? response.totalDuration / 1000000 : null,
      };
    } catch (error) {
      this.logger.error({ err: error, output: response.responseText }, 'Failed to parse repair proposal');
      throw new Error(`Repair engine failed to generate valid proposal: ${error.message}`);
    }
  }
}
