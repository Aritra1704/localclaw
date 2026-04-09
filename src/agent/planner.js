import { z } from 'zod';

import { extractJsonObjectText } from '../llm/ollama.js';
import { TOOL_DEFINITIONS, TOOL_NAMES } from '../tools/registry.js';

const toolArgsSchemaByName = Object.fromEntries(
  TOOL_DEFINITIONS.map((tool) => [tool.name, tool.argsSchema])
);

const plannerStepSchema = z.object({
  stepNumber: z.number().int().positive(),
  objective: z.string().min(1),
  tool: z.enum(TOOL_NAMES),
  args: z.record(z.string(), z.unknown()).default({}),
});

const plannerOutputSchema = z.object({
  summary: z.string().min(1),
  reasoning: z.string().min(1),
  executionMode: z.literal('workspace_controlled'),
  steps: z.array(plannerStepSchema).min(1).max(6),
  successCriteria: z.array(z.string().min(1)).min(1).max(6),
  notesForVerifier: z.array(z.string().min(1)).max(6).default([]),
});

function deriveSuccessCriteria(candidate) {
  const normalizedCriteria = Array.isArray(candidate.successCriteria)
    ? candidate.successCriteria
        .map((item) => (typeof item === 'string' ? item.trim() : ''))
        .filter(Boolean)
        .slice(0, 6)
    : [];

  if (normalizedCriteria.length > 0) {
    return normalizedCriteria;
  }

  const stepDerivedCriteria = Array.isArray(candidate.steps)
    ? candidate.steps
        .map((step) =>
          typeof step?.objective === 'string' ? step.objective.trim() : ''
        )
        .filter(Boolean)
        .slice(0, 3)
        .map((objective) => `Complete: ${objective}`)
    : [];

  if (stepDerivedCriteria.length > 0) {
    return stepDerivedCriteria;
  }

  return ['Leave the workspace ready for verification.'];
}

function sanitizePlannerCandidate(candidate) {
  return {
    ...candidate,
    summary:
      typeof candidate.summary === 'string' ? candidate.summary.trim() : candidate.summary,
    reasoning:
      typeof candidate.reasoning === 'string'
        ? candidate.reasoning.trim()
        : candidate.reasoning,
    executionMode:
      typeof candidate.executionMode === 'string' && candidate.executionMode.trim().length > 0
        ? candidate.executionMode.trim()
        : 'workspace_controlled',
    successCriteria: deriveSuccessCriteria(candidate),
    notesForVerifier: Array.isArray(candidate.notesForVerifier)
      ? candidate.notesForVerifier
          .map((item) => (typeof item === 'string' ? item.trim() : ''))
          .filter(Boolean)
          .slice(0, 6)
      : [],
  };
}

function normalizePlan(plan) {
  const normalizedSteps = [...plan.steps]
    .sort((left, right) => left.stepNumber - right.stepNumber)
    .map((step, index) => ({
      ...step,
      stepNumber: index + 1,
      args: toolArgsSchemaByName[step.tool].parse(step.args ?? {}),
    }));

  return {
    ...plan,
    steps: normalizedSteps,
  };
}

function parsePlannerOutput(text) {
  const candidate = sanitizePlannerCandidate(
    JSON.parse(extractJsonObjectText(text))
  );
  return normalizePlan(plannerOutputSchema.parse(candidate));
}

function buildPlannerPrompt(task, context) {
  const existingFiles =
    context.workspaceSnapshot.length > 0
      ? context.workspaceSnapshot
          .map((entry) => `- ${entry.path} (${entry.type})`)
          .join('\n')
      : '- workspace is currently empty';

  return `You are the LocalClaw planner.
Return exactly one JSON object and nothing else.

Rules:
- executionMode must be "workspace_controlled"
- use only the allowed tools
- keep the plan to 1-6 steps
- stepNumber must start at 1 and increment by 1
- every step args object must match the selected tool schema exactly
- all file paths must be relative to the workspace root
- do not use shell, git, network, docker, or deployment actions
- create concrete artifacts when useful
- keep file content concise enough for a local development task

Allowed tools:
${context.toolCatalog}

Task title:
${task.title}

Task description:
${task.description}

Workspace root:
${context.workspaceRoot}

Existing workspace entries:
${existingFiles}

JSON contract:
{
  "summary": "short plan summary",
  "reasoning": "why these steps are sufficient",
  "executionMode": "workspace_controlled",
  "steps": [
    {
      "stepNumber": 1,
      "objective": "what this step does",
      "tool": "one allowed tool",
      "args": { "must_match_the_tool_schema": true }
    }
  ],
  "successCriteria": ["criterion 1"],
  "notesForVerifier": ["optional verifier note"]
}`;
}

function buildRepairPrompt(rawOutput, validationError) {
  return `Repair the following planner output into valid JSON only.
Do not add markdown fences.

Validation error:
${validationError}

Required rules:
- executionMode must be "workspace_controlled"
- stepNumber values must be sequential starting at 1
- tool must be one of: ${TOOL_NAMES.join(', ')}
- the args object must include every required field for the selected tool
- successCriteria must contain at least one concrete item

Malformed planner output:
${rawOutput}`;
}

export function createPlanner({ client, modelSelector }) {
  return {
    async planTask(task, context) {
      const prompt = buildPlannerPrompt(task, context);
      const startedAt = Date.now();
      const primaryModel = modelSelector.select('planner');
      const primaryResponse = await client.generate({
        model: primaryModel,
        prompt,
        format: 'json',
        options: {
          temperature: 0.1,
        },
      });

      try {
        const plan = parsePlannerOutput(primaryResponse.responseText);
        return {
          plan,
          modelUsed: primaryModel,
          repaired: false,
          durationMs: Date.now() - startedAt,
        };
      } catch (error) {
        const repairModel = modelSelector.select('fast');
        const repairedResponse = await client.generate({
          model: repairModel,
          prompt: buildRepairPrompt(primaryResponse.responseText, error.message),
          format: 'json',
          options: {
            temperature: 0,
          },
        });

        const plan = parsePlannerOutput(repairedResponse.responseText);

        return {
          plan,
          modelUsed: repairModel,
          repaired: true,
          durationMs: Date.now() - startedAt,
        };
      }
    },
  };
}
