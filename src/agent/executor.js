import path from 'node:path';

import { config } from '../config.js';
import { collectWorkspaceSnapshot } from '../tools/registry.js';

function slugifyTaskTitle(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

function buildTaskBrief(task) {
  return `# ${task.title}

## Task Description

${task.description}

## Metadata

- task_id: ${task.id}
- priority: ${task.priority}
- source: ${task.source}
- created_at: ${task.created_at}
`;
}

export function createTaskExecutor({ planner, verifier, toolRegistry }) {
  return {
    async executeTask(task, hooks = {}) {
      const workspaceName = `${slugifyTaskTitle(task.title) || 'task'}-${task.id.slice(0, 8)}`;
      const workspaceRoot = path.join(config.ssdBasePath, 'workspace', workspaceName);
      const artifacts = [
        {
          artifactType: 'workspace',
          artifactPath: workspaceRoot,
          metadata: {
            workspaceName,
          },
        },
      ];
      const toolRuns = [];
      let logStepNumber = hooks.startStepNumber ?? 2;
      let publication = {
        attempted: false,
        published: false,
        repo: null,
        commit: null,
        error: null,
      };

      const seedWorkspaceResult = await toolRegistry.runTool(
        'write_file',
        {
          path: 'TASK.md',
          content: buildTaskBrief(task),
        },
        { workspaceRoot }
      );

      artifacts.push(...seedWorkspaceResult.artifacts);

      await hooks.logStep?.({
        stepNumber: logStepNumber,
        stepType: 'system',
        status: 'success',
        toolCalled: 'write_file',
        inputSummary: 'Seed workspace with task brief',
        outputSummary: seedWorkspaceResult.summary,
      });
      logStepNumber += 1;

      const workspaceSnapshot = await collectWorkspaceSnapshot(workspaceRoot, {
        recursive: true,
        limit: 50,
      });

      const planning = await planner.planTask(task, {
        workspaceRoot,
        workspaceSnapshot,
        toolCatalog: toolRegistry.plannerCatalog(),
      });

      await hooks.logStep?.({
        stepNumber: logStepNumber,
        stepType: 'plan',
        modelUsed: planning.modelUsed,
        status: 'success',
        inputSummary: task.title,
        outputSummary: planning.plan.summary,
        durationMs: planning.durationMs,
      });
      logStepNumber += 1;

      for (const planStep of planning.plan.steps) {
        const toolStartedAt = Date.now();

        try {
          const toolResult = await toolRegistry.runTool(planStep.tool, planStep.args, {
            workspaceRoot,
          });

          toolRuns.push({
            stepNumber: planStep.stepNumber,
            objective: planStep.objective,
            tool: planStep.tool,
            status: 'success',
            summary: toolResult.summary,
            args: planStep.args,
          });
          artifacts.push(...toolResult.artifacts);

          await hooks.logStep?.({
            stepNumber: logStepNumber,
            stepType: 'act',
            toolCalled: planStep.tool,
            status: 'success',
            inputSummary: planStep.objective,
            outputSummary: toolResult.summary,
            durationMs: Date.now() - toolStartedAt,
          });
        } catch (error) {
          toolRuns.push({
            stepNumber: planStep.stepNumber,
            objective: planStep.objective,
            tool: planStep.tool,
            status: 'failed',
            summary: error.message,
            args: planStep.args,
          });

          await hooks.logStep?.({
            stepNumber: logStepNumber,
            stepType: 'act',
            toolCalled: planStep.tool,
            status: 'error',
            inputSummary: planStep.objective,
            outputSummary: null,
            errorMessage: error.message,
            durationMs: Date.now() - toolStartedAt,
          });

          throw error;
        }

        logStepNumber += 1;
      }

      const verification = await verifier.verifyTask(task, {
        workspaceRoot,
        plan: planning.plan,
        toolRuns,
      });

      await hooks.logStep?.({
        stepNumber: logStepNumber,
        stepType: 'verify',
        modelUsed: verification.modelUsed,
        status: verification.review.status === 'failed' ? 'error' : 'success',
        inputSummary: planning.plan.summary,
        outputSummary: verification.review.summary,
      });
      logStepNumber += 1;

      if (verification.review.status === 'passed' && hooks.publisher?.isEnabled?.()) {
        const publishStartedAt = Date.now();
        try {
          publication = await hooks.publisher.publishWorkspace(task, {
            workspaceRoot,
            workspaceName,
          });

          artifacts.push({
            artifactType: 'repository',
            artifactPath: publication.repo.htmlUrl,
            metadata: {
              provider: 'github',
              owner: publication.repo.owner,
              name: publication.repo.name,
              commitSha: publication.commit?.sha ?? null,
            },
          });

          await hooks.logStep?.({
            stepNumber: logStepNumber,
            stepType: 'publish',
            status: 'success',
            inputSummary: publication.repo.name,
            outputSummary: publication.repo.htmlUrl,
            durationMs: Date.now() - publishStartedAt,
          });
        } catch (error) {
          publication = {
            attempted: true,
            published: false,
            repo: null,
            commit: null,
            error: {
              message: error.message,
              status: error.status ?? null,
            },
          };

          await hooks.logStep?.({
            stepNumber: logStepNumber,
            stepType: 'publish',
            status: 'error',
            inputSummary: workspaceName,
            outputSummary: null,
            errorMessage: error.message,
            durationMs: Date.now() - publishStartedAt,
          });
        }

        logStepNumber += 1;
      }

      return {
        executionMode: hooks.publisher?.isEnabled?.()
          ? 'phase3_controlled'
          : 'phase2_controlled',
        workspaceRoot,
        workspaceName,
        plan: planning.plan,
        planner: {
          modelUsed: planning.modelUsed,
          repaired: planning.repaired,
        },
        toolRuns,
        verification,
        publication,
        artifacts,
      };
    },
  };
}
