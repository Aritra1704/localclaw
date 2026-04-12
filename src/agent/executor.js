import path from 'node:path';

import { config } from '../config.js';
import { removeWorkspaceJunk, seedRepoContract } from '../project/contract.js';
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

export function shouldAttemptAutoPublish(task, plan) {
  const taskText = `${task.title ?? ''}\n${task.description ?? ''}`.toLowerCase();

  const explicitlyLocalOnly =
    /\b(local[-\s]?only|no\s+publish|no\s+deploy|dry\s+run|test\s+only)\b/.test(taskText);
  if (explicitlyLocalOnly) {
    return false;
  }

  const explicitPublishIntent =
    /\b(github|publish|repository|repo|deploy|railway|release|ship)\b/.test(taskText);
  if (explicitPublishIntent) {
    return true;
  }

  const planSteps = Array.isArray(plan?.steps) ? plan.steps : [];
  if (planSteps.length === 0) {
    return true;
  }

  const runSkillOnly = planSteps.every((step) => step?.tool === 'run_skill');
  if (runSkillOnly) {
    return false;
  }

  return true;
}

export function createTaskExecutor({ planner, verifier, toolRegistry, router }) {
  async function previewTaskPlan(task, options = {}) {
    const workspaceRoot = options.workspaceRoot ?? '.';
    const workspaceSnapshot =
      options.workspaceSnapshot ??
      (await collectWorkspaceSnapshot(workspaceRoot, {
        recursive: true,
        limit: 50,
      }));

    return planner.planTask(task, {
      workspaceRoot,
      workspaceSnapshot,
      workspaceSnapshot,
      toolCatalog: toolRegistry.plannerCatalog(),
      retrievalContext: options.retrievalContext ?? null,
      overrideRole: options.overrideRole ?? null,
    });
  }

  return {
    previewTaskPlan,

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

      const repoContractResult = await seedRepoContract({
        workspaceRoot,
        task,
      });

      artifacts.push(...repoContractResult.artifacts);

      await hooks.logStep?.({
        stepNumber: logStepNumber,
        stepType: 'system',
        status: 'success',
        inputSummary: 'Seed repo contract kit',
        outputSummary: repoContractResult.summary,
      });
      logStepNumber += 1;

      const seedWorkspaceResult = await toolRegistry.runTool(
        'write_file',
        {
          path: 'TASK.md',
          content: buildTaskBrief(task),
        },
        { workspaceRoot, taskId: task.id }
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

      const removedJunk = await removeWorkspaceJunk(workspaceRoot);
      if (removedJunk.length > 0) {
        await hooks.logStep?.({
          stepNumber: logStepNumber,
          stepType: 'system',
          status: 'success',
          inputSummary: 'Remove OS junk before planning',
          outputSummary: `Removed ${removedJunk.length} ignored workspace path(s)`,
        });
        logStepNumber += 1;
      }

      const actorRole = router ? await router.classifyTask(task) : 'planner';

      const planning = await previewTaskPlan(task, {
        workspaceRoot,
        retrievalContext: hooks.retrievalContext ?? null,
        overrideRole: actorRole,
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
            taskId: task.id,
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

      const publishRequested = shouldAttemptAutoPublish(task, planning.plan);

      if (
        verification.review.status === 'passed' &&
        hooks.publisher?.isEnabled?.() &&
        publishRequested
      ) {
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
      } else if (verification.review.status === 'passed' && !publishRequested) {
        await hooks.logStep?.({
          stepNumber: logStepNumber,
          stepType: 'publish',
          status: 'success',
          inputSummary: workspaceName,
          outputSummary: 'Skipped auto-publish for local-only skill execution task',
        });

        logStepNumber += 1;
      }

      return {
        executionMode: hooks.deployer?.isEnabled?.()
          ? 'phase4_controlled'
          : hooks.publisher?.isEnabled?.()
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
