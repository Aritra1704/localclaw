import path from 'node:path';

import { z } from 'zod';

import { extractJsonObjectText } from '../llm/json.js';
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

const relativePathArgKeysByTool = {
  append_file: ['path'],
  browser_automate: ['screenshotPath'],
  list_files: ['path'],
  make_dir: ['path'],
  read_file: ['path'],
  security_audit: ['path'],
  write_file: ['path'],
};

function assertRelativePlannerPaths(tool, args, workspaceRoot) {
  const keys = relativePathArgKeysByTool[tool] ?? [];
  for (const key of keys) {
    const value = args?.[key];
    if (typeof value !== 'string' || value.trim().length === 0) {
      continue;
    }

    if (path.isAbsolute(value)) {
      if (workspaceRoot) {
        const relative = path.relative(workspaceRoot, value);
        if (relative && !relative.startsWith('..')) {
          args[key] = relative;
          continue;
        }
      }
      throw new Error(`${tool}.${key} must be relative to the workspace root: ${value}`);
    }
  }
}

function assertTaskAlignedSteps(task, steps) {
  const taskText = `${task?.title ?? ''}\n${task?.description ?? ''}`.toLowerCase();
  const planOnlyTask =
    /\b(task plan|ordered task list|dependencies|approval points)\b/.test(taskText) ||
    /\bdo not execute commands\b/.test(taskText);
  const readmeRequested = /\breadme\b/.test(taskText);
  const deployRequested = /\b(deploy|deployment|railway|readiness)\b/.test(taskText);
  const auditRequested = /\b(audit|security)\b/.test(taskText);

  for (const step of steps) {
    const stepText = JSON.stringify(step).toLowerCase();

    if (!readmeRequested && /\breadme\b/.test(stepText)) {
      throw new Error('Planner introduced README work that the task did not request');
    }

    if (!deployRequested && /\b(deploy|deployment|railway|readiness)\b/.test(stepText)) {
      throw new Error('Planner introduced deploy-related work that the task did not request');
    }

    if (!auditRequested && /\bsecurity_audit\b/.test(stepText)) {
      throw new Error('Planner introduced security audit work that the task did not request');
    }

    if (
      planOnlyTask &&
      ['browser_automate', 'bootstrap_model', 'run_terminal_command', 'system_prune'].includes(
        step.tool
      )
    ) {
      throw new Error(`Planner introduced executable ${step.tool} work for a planning-only task`);
    }
  }
}

function isPlanningOnlyTask(task) {
  const taskText = `${task?.title ?? ''}\n${task?.description ?? ''}`.toLowerCase();
  if (/\brun_skill\b/.test(taskText)) {
    return false;
  }

  return (
    /\b(task plan|ordered task list|dependencies|approval points)\b/.test(taskText) ||
    /\bdo not execute commands\b/.test(taskText)
  );
}

function extractReferencedPath(task, workspaceRoot) {
  const taskText = `${task?.title ?? ''}\n${task?.description ?? ''}`;
  const pathMatch = taskText.match(/([A-Za-z]:\\[^\s"']+\.[A-Za-z0-9]+|\/[^\s"']+\.[A-Za-z0-9]+|(?:^|[\s(])([A-Za-z0-9_./-]+\.(?:md|mdx|txt|json|ya?ml|js|ts|tsx|jsx)))/);
  const rawPath = pathMatch?.[1] ?? pathMatch?.[2] ?? null;
  if (!rawPath) {
    return null;
  }

  const normalized = rawPath.trim().replace(/^[("' ]+|[)"' ]+$/g, '');

  if (path.isAbsolute(normalized) && task.project_path) {
    const relativeToProject = path.relative(task.project_path, normalized);
    if (relativeToProject && !relativeToProject.startsWith('..')) {
      return relativeToProject;
    }
  }

  if (path.isAbsolute(normalized) && path.isAbsolute(workspaceRoot)) {
    const relativePath = path.relative(workspaceRoot, normalized);
    if (relativePath && !relativePath.startsWith('..')) {
      return relativePath;
    }
  }

  return normalized;
}

function extractStagePlanPath(task) {
  const taskText = `${task?.title ?? ''}\n${task?.description ?? ''}`;
  const stageMatch = taskText.match(/\bStage\s+(\d+)\b/i);
  if (!stageMatch) {
    return 'docs/task-plan.md';
  }

  return `docs/stage-${stageMatch[1]}-task-plan.md`;
}

function buildDeterministicPlanningOnlyPlan(task, context) {
  const referencedPath = extractReferencedPath(task, context.workspaceRoot);
  const outputPath = extractStagePlanPath(task);
  const steps = [];

  if (referencedPath) {
    steps.push({
      stepNumber: steps.length + 1,
      objective: 'Read the requested guide file',
      tool: 'read_file',
      args: {
        path: referencedPath,
        maxChars: 12000,
      },
    });
  } else {
    steps.push({
      stepNumber: 1,
      objective: 'List the docs files that are relevant to the requested plan',
      tool: 'list_files',
      args: {
        path: 'docs',
        recursive: true,
        limit: 60,
      },
    });
  }

  steps.push({
    stepNumber: steps.length + 1,
    objective: 'Write the requested stage task plan document',
    tool: 'write_file',
    args: {
      path: outputPath,
      content: `# Stage Task Plan\n\n## Ordered Tasks\n1. Extract Stage 1 tasks from the requested guide.\n2. Record dependencies between those tasks.\n3. Record checks and verification points.\n4. Record explicit approval points.\n\n## Dependencies\n- Populate from the guide.\n\n## Checks\n- Populate from the guide.\n\n## Approval Points\n- Populate from the guide.\n`,
      overwrite: true,
    },
  });

  return normalizePlan(task, {
    summary: 'Read the requested guide and prepare the requested stage task plan.',
    reasoning:
      'This request is planning-only, so the safe deterministic path is to read the referenced guide and draft the requested task-plan artifact without introducing unrelated execution work.',
    executionMode: 'workspace_controlled',
    steps,
    successCriteria: [
      'The referenced guide is inspected or identified',
      'A stage task plan artifact is prepared',
      'The plan stays scoped to dependencies, checks, and approval points',
    ],
    notesForVerifier: ['Planning-only requests should not introduce unrelated deploy, README, or audit work.'],
  }, context.workspaceRoot);
}

function coerceStepCandidate(step) {
  if (!step || typeof step === 'undefined') {
    return null;
  }

  if (typeof step === 'string') {
    const trimmed = step.trim();
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
      return null;
    }

    try {
      const parsed = JSON.parse(trimmed);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }

  return typeof step === 'object' ? step : null;
}

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
  const normalizedSteps = Array.isArray(candidate.steps)
    ? candidate.steps.map((step) => coerceStepCandidate(step)).filter(Boolean)
    : candidate.steps;

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
    steps: normalizedSteps,
    successCriteria: deriveSuccessCriteria(candidate),
    notesForVerifier: Array.isArray(candidate.notesForVerifier)
      ? candidate.notesForVerifier
          .map((item) => (typeof item === 'string' ? item.trim() : ''))
          .filter(Boolean)
          .slice(0, 6)
      : [],
  };
}

function extractRequestedSkillName(task) {
  const text = `${task.title ?? ''}\n${task.description ?? ''}`;
  const runSkillMatch = text.match(/\brun_skill\s+([a-z][a-z0-9_.-]{2,63})\b/i);
  if (runSkillMatch) {
    return runSkillMatch[1];
  }

  const scaffoldSkillMatch = text.match(
    /\b(scaffold_node_http_service|add_deploy_readiness_notes)\b/i
  );
  if (scaffoldSkillMatch) {
    return scaffoldSkillMatch[1];
  }

  return null;
}

function extractProjectName(task) {
  const text = `${task.title ?? ''}\n${task.description ?? ''}`;
  const namedMatch = text.match(/\bnamed\s+([a-z0-9][a-z0-9-]{1,63})\b/i);
  if (namedMatch) {
    return namedMatch[1];
  }

  return null;
}

function extractServicePort(task) {
  const text = `${task.title ?? ''}\n${task.description ?? ''}`;
  const portMatch = text.match(/\bport\s+(\d{2,5})\b/i);
  if (!portMatch) {
    return null;
  }

  const parsed = Number(portMatch[1]);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    return null;
  }

  return String(parsed);
}

function buildDeterministicFallbackPlan(task) {
  const skillName = extractRequestedSkillName(task);
  const projectName = extractProjectName(task);
  const servicePort = extractServicePort(task);

  if (skillName) {
    const skillInput = {};
    if (projectName) {
      skillInput.projectName = projectName;
    }
    if (servicePort) {
      skillInput.servicePort = servicePort;
    }

    return {
      summary: `Execute requested skill ${skillName} with deterministic fallback planning.`,
      reasoning:
        'Model output was malformed after repair. Falling back to a safe, schema-valid skill execution path.',
      executionMode: 'workspace_controlled',
      steps: [
        {
          stepNumber: 1,
          objective: `Run skill ${skillName}`,
          tool: 'run_skill',
          args: {
            name: skillName,
            input: skillInput,
          },
        },
        {
          stepNumber: 2,
          objective: 'List generated workspace files for verification context',
          tool: 'list_files',
          args: {
            path: '.',
            recursive: true,
            limit: 80,
          },
        },
      ],
      successCriteria: [
        `Skill ${skillName} executes successfully`,
        'Workspace includes generated service files',
      ],
      notesForVerifier: [
        'Planner used deterministic fallback due to invalid LLM JSON output.',
      ],
    };
  }

  return {
    summary: 'Deterministic fallback plan created due to malformed planner output.',
    reasoning:
      'Both primary and repair planner outputs were invalid. Fallback keeps execution bounded and verifiable.',
    executionMode: 'workspace_controlled',
    steps: [
      {
        stepNumber: 1,
        objective: 'Inspect current workspace entries',
        tool: 'list_files',
        args: {
          path: '.',
          recursive: true,
          limit: 80,
        },
      },
      {
        stepNumber: 2,
        objective: 'Draft implementation notes from task description',
        tool: 'write_file',
        args: {
          path: 'docs/IMPLEMENTATION_NOTES.md',
          content: `# Implementation Notes\n\nTask: ${task.title}\n\n${task.description}\n\n## Developer Note\nLocalClaw models failed to generate a precise execution plan. This document captures the intent to allow for manual intervention or a retry with stronger models.`,
          overwrite: true,
        },
      },
      {
        stepNumber: 3,
        objective: 'Write fallback execution note',
        tool: 'write_file',
        args: {
          path: 'FALLBACK_PLAN.md',
          content: `# Fallback Plan\n\nTask: ${task.title}\n\nThis task was executed using a deterministic fallback plan because the primary LLM planner failed to produce a valid JSON schema.\n`,
          overwrite: true,
        },
      },
    ],
    successCriteria: [
      'Workspace is inspected',
      'Implementation notes are drafted',
      'Fallback plan note is created for operator follow-up',
    ],
    notesForVerifier: [
      'Planner used deterministic fallback due to invalid LLM JSON output.',
    ],
  };
}

function normalizePlan(task, plan, workspaceRoot = null) {
  const normalizedSteps = [...plan.steps]
    .sort((left, right) => left.stepNumber - right.stepNumber)
    .map((step, index) => {
      const args = toolArgsSchemaByName[step.tool].parse(step.args ?? {});
      assertRelativePlannerPaths(step.tool, args, workspaceRoot);
      return {
        ...step,
        stepNumber: index + 1,
        args,
      };
    });

  assertTaskAlignedSteps(task, normalizedSteps);

  return {
    ...plan,
    steps: normalizedSteps,
  };
}

function parsePlannerOutput(task, text, workspaceRoot = null) {
  const candidate = sanitizePlannerCandidate(
    JSON.parse(extractJsonObjectText(text))
  );
  return normalizePlan(task, plannerOutputSchema.parse(candidate), workspaceRoot);
}

function buildPlannerPrompt(task, context) {
  const existingFiles =
    context.workspaceSnapshot.length > 0
      ? context.workspaceSnapshot
          .map((entry) => `- ${entry.path} (${entry.type})`)
          .join('\n')
      : '- workspace is currently empty';
  const retrievedContext =
    typeof context.retrievalContext === 'string' && context.retrievalContext.trim().length > 0
      ? context.retrievalContext.trim()
      : '- none';

  const chatHistory = 
    typeof context.chatHistory === 'string' && context.chatHistory.trim().length > 0
      ? `Recent Conversation Context:\n${context.chatHistory.trim()}`
      : '';
  const plannerContext =
    typeof context.plannerContext === 'string' && context.plannerContext.trim().length > 0
      ? context.plannerContext.trim()
      : '';
  const soul =
    typeof context.soulContext === 'string' && context.soulContext.trim().length > 0
      ? `## Core Identity and Guidelines:\n${context.soulContext.trim()}`
      : '';

  return `You are the LocalClaw planner.

${soul}

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
- if the request is analysis, planning, or documentation only, do not add unrelated implementation, deploy-readiness, or README update steps

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

Retrieved historical context:
${retrievedContext}

${chatHistory}

${plannerContext}

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

function buildUsage(response) {
  return {
    promptEvalCount: response?.promptEvalCount ?? null,
    evalCount: response?.evalCount ?? null,
    totalDuration: response?.totalDuration ?? null,
    loadDuration: response?.loadDuration ?? null,
  };
}

export function createPlanner({ client, modelSelector }) {
  return {
    async planTask(task, context) {
      if (isPlanningOnlyTask(task)) {
        const plan = buildDeterministicPlanningOnlyPlan(task, context);
        return {
          plan,
          modelUsed: 'deterministic_planning_only',
          repaired: false,
          fallback: true,
          durationMs: 0,
          usage: null,
        };
      }

      const prompt = buildPlannerPrompt(task, context);
      const startedAt = Date.now();
      const primaryModel = modelSelector.select(context.overrideRole ?? 'planner');
      context.onStart?.({
        stage: 'primary',
        model: primaryModel,
      });
      const primaryResponse = await client.generate({
        model: primaryModel,
        prompt,
        format: 'json',
        options: {
          temperature: 0.1,
        },
      });

      try {
        const plan = parsePlannerOutput(task, primaryResponse.responseText, context.workspaceRoot);
        return {
          plan,
          modelUsed: primaryModel,
          repaired: false,
          durationMs: Date.now() - startedAt,
          usage: buildUsage(primaryResponse),
        };
      } catch (error) {
        const repairModel = modelSelector.select('fast');
        context.onStart?.({
          stage: 'repair',
          model: repairModel,
        });
        const repairedResponse = await client.generate({
          model: repairModel,
          prompt: buildRepairPrompt(primaryResponse.responseText, error.message),
          format: 'json',
          options: {
            temperature: 0,
          },
        });
        try {
          const plan = parsePlannerOutput(task, repairedResponse.responseText, context.workspaceRoot);

          return {
            plan,
            modelUsed: repairModel,
            repaired: true,
            durationMs: Date.now() - startedAt,
            usage: buildUsage(repairedResponse),
          };
        } catch (repairError) {
          const plan = normalizePlan(task, buildDeterministicFallbackPlan(task), context.workspaceRoot);

          return {
            plan,
            modelUsed: 'deterministic_fallback',
            repaired: true,
            fallback: true,
            fallbackReason: `${error.message} | ${repairError.message}`,
            durationMs: Date.now() - startedAt,
            usage: buildUsage(repairedResponse),
          };
        }
      }
    },
  };
}
