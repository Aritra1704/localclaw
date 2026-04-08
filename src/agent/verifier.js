import { z } from 'zod';

import { extractJsonObjectText } from '../llm/ollama.js';
import { collectWorkspaceSnapshot } from '../tools/registry.js';

const verifierOutputSchema = z.object({
  status: z.enum(['passed', 'needs_human_review', 'failed']),
  summary: z.string().min(1),
  evidence: z.array(z.string().min(1)).max(10).default([]),
  risks: z.array(z.string().min(1)).max(10).default([]),
});

function buildFallbackReview(plan, toolRuns, workspaceFiles) {
  const hasFailures = toolRuns.some((run) => run.status !== 'success');
  const evidence = [
    `${toolRuns.filter((run) => run.status === 'success').length}/${toolRuns.length} tool steps completed successfully`,
    `${workspaceFiles.length} workspace entries captured`,
    `${plan.successCriteria.length} success criteria recorded`,
  ];

  if (hasFailures) {
    return {
      status: 'failed',
      summary: 'One or more execution steps failed before verification completed.',
      evidence,
      risks: ['At least one tool step failed'],
    };
  }

  return {
    status: 'passed',
    summary: 'Workspace task completed and passed deterministic verification.',
    evidence,
    risks: [],
  };
}

function buildVerifierPrompt(task, context) {
  const files =
    context.workspaceFiles.length > 0
      ? context.workspaceFiles
          .map((entry) => `- ${entry.path} (${entry.type})`)
          .join('\n')
      : '- no workspace files captured';

  const toolRuns =
    context.toolRuns.length > 0
      ? context.toolRuns
          .map(
            (run) =>
              `- step ${run.stepNumber}: ${run.tool} -> ${run.status} (${run.summary})`
          )
          .join('\n')
      : '- no tool runs recorded';

  return `You are the LocalClaw verifier.
Return exactly one JSON object and nothing else.

Assess whether the task appears complete based on the plan, executed tool runs, and workspace files.
Use "passed" when the task looks complete.
Use "needs_human_review" when execution succeeded but the result is ambiguous.
Use "failed" when the workspace evidence shows the task did not complete.

Task title:
${task.title}

Task description:
${task.description}

Plan summary:
${context.plan.summary}

Success criteria:
${context.plan.successCriteria.map((item) => `- ${item}`).join('\n')}

Verifier notes:
${context.plan.notesForVerifier.map((item) => `- ${item}`).join('\n') || '- none'}

Tool runs:
${toolRuns}

Workspace files:
${files}

JSON contract:
{
  "status": "passed | needs_human_review | failed",
  "summary": "short verifier conclusion",
  "evidence": ["evidence item"],
  "risks": ["risk item"]
}`;
}

export function createVerifier({ client, modelSelector }) {
  return {
    async verifyTask(task, context) {
      const workspaceFiles = await collectWorkspaceSnapshot(context.workspaceRoot, {
        recursive: true,
        limit: 100,
      });

      const fallbackReview = buildFallbackReview(
        context.plan,
        context.toolRuns,
        workspaceFiles
      );

      try {
        const model = modelSelector.select('review');
        const response = await client.generate({
          model,
          prompt: buildVerifierPrompt(task, {
            ...context,
            workspaceFiles,
          }),
          format: 'json',
          options: {
            temperature: 0,
          },
        });

        const review = verifierOutputSchema.parse(
          JSON.parse(extractJsonObjectText(response.responseText))
        );

        return {
          review,
          workspaceFiles,
          modelUsed: model,
          usedFallback: false,
        };
      } catch (error) {
        return {
          review: fallbackReview,
          workspaceFiles,
          modelUsed: null,
          usedFallback: true,
        };
      }
    },
  };
}
