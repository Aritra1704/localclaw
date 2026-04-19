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

function buildChecklist(steps, options = {}) {
  const completedCount = Math.max(options.completedCount ?? 0, 0);
  const currentStepNumber = options.currentStepNumber ?? null;
  const failedStepNumber = options.failedStepNumber ?? null;

  return (steps ?? []).map((step, index) => {
    let status = 'pending';
    if (failedStepNumber === step.stepNumber) {
      status = 'failed';
    } else if (step.stepNumber === currentStepNumber) {
      status = 'current';
    } else if (index < completedCount) {
      status = 'completed';
    }

    return {
      stepNumber: step.stepNumber,
      objective: step.objective,
      tool: step.tool,
      status,
    };
  });
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

export function createTaskExecutor({
  planner,
  verifier,
  toolRegistry,
  router,
  repairEngine = null,
  specializedReviewer = null,
}) {
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
      toolCatalog: toolRegistry.plannerCatalog(),
      retrievalContext: options.retrievalContext ?? null,
      overrideRole: options.overrideRole ?? null,
      onStart: options.onStart,
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
      let specializedReview = {
        status: 'passed',
        summary: 'Specialized review was not configured.',
        agents: [],
        artifacts: [],
        followUpTasks: [],
      };
      hooks.runtimeUpdate?.({
        phase: 'preparing',
        phaseLabel: 'Preparing workspace',
        detail: 'Creating the task workspace and seeding local context.',
        currentModel: null,
        modelRole: null,
        usage: null,
        checklist: [],
        counts: {
          completed: 0,
          total: 0,
        },
        currentStep: null,
      });

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
      hooks.runtimeUpdate?.({
        phase: 'preparing',
        phaseLabel: 'Preparing workspace',
        detail: 'Task brief is written. Cleaning the workspace before planning.',
      });

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
      hooks.runtimeUpdate?.({
        phase: 'planning',
        phaseLabel: 'Planning task',
        detail: 'Building a bounded execution plan from the approved task.',
        currentModel: null,
        modelRole: 'planner',
        usage: null,
      });

      const planning = await previewTaskPlan(task, {
        workspaceRoot,
        retrievalContext: hooks.retrievalContext ?? null,
        overrideRole: actorRole,
        onStart: ({ stage, model }) => {
          hooks.runtimeUpdate?.({
            phase: 'planning',
            phaseLabel: stage === 'repair' ? 'Repairing planner output' : 'Planning task',
            detail:
              stage === 'repair'
                ? 'Primary planner output was invalid. Repairing it with a fallback model.'
                : 'Planner model is generating the execution checklist.',
            currentModel: model,
            modelRole: 'planner',
            usage: null,
          });
        },
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
      hooks.runtimeUpdate?.({
        phase: 'acting',
        phaseLabel: 'Executing plan',
        detail: planning.plan.summary,
        currentModel: planning.modelUsed,
        modelRole: 'planner',
        usage: planning.usage ?? null,
        checklist: buildChecklist(planning.plan.steps, {
          completedCount: 0,
          currentStepNumber: planning.plan.steps[0]?.stepNumber ?? null,
        }),
        counts: {
          completed: 0,
          total: planning.plan.steps.length,
        },
        currentStep: planning.plan.steps[0]
          ? {
              stepNumber: planning.plan.steps[0].stepNumber,
              objective: planning.plan.steps[0].objective,
              tool: planning.plan.steps[0].tool,
            }
          : null,
        summary: planning.plan.summary,
      });

      for (const planStep of planning.plan.steps) {
        const toolStartedAt = Date.now();
        hooks.runtimeUpdate?.({
          phase: 'acting',
          phaseLabel: 'Executing plan',
          detail: `Running step ${planStep.stepNumber} of ${planning.plan.steps.length}.`,
          currentModel: null,
          modelRole: null,
          usage: null,
          checklist: buildChecklist(planning.plan.steps, {
            completedCount: Math.max(planStep.stepNumber - 1, 0),
            currentStepNumber: planStep.stepNumber,
          }),
          counts: {
            completed: Math.max(planStep.stepNumber - 1, 0),
            total: planning.plan.steps.length,
          },
          currentStep: {
            stepNumber: planStep.stepNumber,
            objective: planStep.objective,
            tool: planStep.tool,
          },
        });

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

          if (repairEngine) {
            hooks.runtimeUpdate?.({
              phase: 'repairing',
              phaseLabel: 'Analyzing failure',
              detail: `Step ${planStep.stepNumber} failed. Generating repair proposal...`,
              currentModel: null,
              modelRole: 'repair',
            });

            try {
              const workspaceSnapshot = await collectWorkspaceSnapshot(workspaceRoot, {
                recursive: true,
                limit: 100,
              });

              const repair = await repairEngine.generateRepairProposal(task, {
                workspaceRoot,
                failedStep: planStep,
                errorMessage: error.message,
                executionLogs: toolRuns,
                workspaceSnapshot,
              });

              return {
                status: 'needs_repair',
                repairProposal: repair.proposal,
                workspaceRoot,
                workspaceName,
                plan: planning.plan,
                toolRuns,
                artifacts,
              };
            } catch (repairError) {
              // If repair engine fails, fall back to normal failure
              console.error('Repair engine failed:', repairError);
            }
          }

          hooks.runtimeUpdate?.({
            phase: 'failed',
            phaseLabel: 'Execution failed',
            detail: error.message,
            currentModel: null,
            modelRole: null,
            usage: null,
            checklist: buildChecklist(planning.plan.steps, {
              completedCount: Math.max(planStep.stepNumber - 1, 0),
              failedStepNumber: planStep.stepNumber,
            }),
            counts: {
              completed: Math.max(planStep.stepNumber - 1, 0),
              total: planning.plan.steps.length,
            },
            currentStep: {
              stepNumber: planStep.stepNumber,
              objective: planStep.objective,
              tool: planStep.tool,
            },
          });

          throw error;
        }

        logStepNumber += 1;
        hooks.runtimeUpdate?.({
          phase: 'acting',
          phaseLabel: 'Executing plan',
          detail: `Completed step ${planStep.stepNumber} of ${planning.plan.steps.length}.`,
          currentModel: null,
          modelRole: null,
          usage: null,
          checklist: buildChecklist(planning.plan.steps, {
            completedCount: planStep.stepNumber,
            currentStepNumber:
              planning.plan.steps[planStep.stepNumber]?.stepNumber ?? null,
          }),
          counts: {
            completed: planStep.stepNumber,
            total: planning.plan.steps.length,
          },
          currentStep: planning.plan.steps[planStep.stepNumber]
            ? {
                stepNumber: planning.plan.steps[planStep.stepNumber].stepNumber,
                objective: planning.plan.steps[planStep.stepNumber].objective,
                tool: planning.plan.steps[planStep.stepNumber].tool,
              }
            : null,
        });
      }

      if (specializedReviewer) {
        hooks.runtimeUpdate?.({
          phase: 'reviewing',
          phaseLabel: 'Running specialized agents',
          detail: 'Documentation, security, and dependency agents are reviewing the workspace.',
          currentModel: null,
          modelRole: null,
          usage: null,
          checklist: buildChecklist(planning.plan.steps, {
            completedCount: planning.plan.steps.length,
          }),
          counts: {
            completed: planning.plan.steps.length,
            total: planning.plan.steps.length,
          },
          currentStep: null,
        });

        specializedReview = await specializedReviewer.reviewTask(task, {
          workspaceRoot,
          workspaceName,
          plan: planning.plan,
          toolRuns,
        });
        artifacts.push(...(specializedReview.artifacts ?? []));

        for (const agentReview of specializedReview.agents ?? []) {
          await hooks.logStep?.({
            stepNumber: logStepNumber,
            stepType: 'review',
            toolCalled: `${agentReview.name}_agent`,
            status: agentReview.status === 'failed' ? 'error' : 'success',
            inputSummary: agentReview.name,
            outputSummary: agentReview.summary,
          });
          logStepNumber += 1;
        }
      }

      hooks.runtimeUpdate?.({
        phase: 'verifying',
        phaseLabel: 'Verifying result',
        detail: 'Reviewing the workspace against the requested success criteria.',
        currentModel: null,
        modelRole: 'verifier',
        usage: null,
        checklist: buildChecklist(planning.plan.steps, {
          completedCount: planning.plan.steps.length,
        }),
        counts: {
          completed: planning.plan.steps.length,
          total: planning.plan.steps.length,
        },
        currentStep: null,
      });
      const verification = await verifier.verifyTask(task, {
        workspaceRoot,
        plan: planning.plan,
        toolRuns,
        onStart: ({ model }) => {
          hooks.runtimeUpdate?.({
            phase: 'verifying',
            phaseLabel: 'Verifying result',
            detail: 'Verifier model is reviewing the completed workspace output.',
            currentModel: model,
            modelRole: 'verifier',
            usage: null,
          });
        },
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
      hooks.runtimeUpdate?.({
        phase:
          verification.review.status === 'passed' &&
          specializedReview.status === 'passed'
            ? 'publishing'
            : 'blocked',
        phaseLabel:
          verification.review.status === 'passed' &&
          specializedReview.status === 'passed'
            ? 'Preparing finalization'
            : 'Needs review',
        detail:
          specializedReview.status === 'passed'
            ? verification.review.summary
            : specializedReview.summary,
        currentModel: verification.modelUsed,
        modelRole: verification.modelUsed ? 'verifier' : null,
        usage: verification.usage ?? null,
        checklist: buildChecklist(planning.plan.steps, {
          completedCount: planning.plan.steps.length,
        }),
        counts: {
          completed: planning.plan.steps.length,
          total: planning.plan.steps.length,
        },
        currentStep: null,
      });

      const publishRequested = shouldAttemptAutoPublish(task, planning.plan);

      if (
        verification.review.status === 'passed' &&
        specializedReview.status === 'passed' &&
        hooks.publisher?.isEnabled?.() &&
        publishRequested
      ) {
        const publishStartedAt = Date.now();
        hooks.runtimeUpdate?.({
          phase: 'publishing',
          phaseLabel: 'Publishing workspace',
          detail: 'Pushing the verified workspace to the configured repository.',
          currentModel: null,
          modelRole: null,
          usage: null,
        });
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
          hooks.runtimeUpdate?.({
            phase: 'blocked',
            phaseLabel: 'Publishing failed',
            detail: error.message,
            currentModel: null,
            modelRole: null,
            usage: null,
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
        specializedReview,
        verification: {
          review: verification.review,
          workspaceFiles: verification.workspaceFiles,
          modelUsed: verification.modelUsed,
          usedFallback: verification.usedFallback,
        },
        publication,
        artifacts,
      };
    },
  };
}
