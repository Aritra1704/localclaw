import path from 'node:path';

function unique(values = []) {
  return [...new Set(values.filter(Boolean))];
}

function compactText(value, maxLength = 600) {
  const text = `${value ?? ''}`.replace(/\s+/g, ' ').trim();
  if (!text) {
    return '';
  }

  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

function basenameOrValue(value) {
  if (!value) {
    return null;
  }

  try {
    return path.basename(value) || value;
  } catch {
    return value;
  }
}

function summarizePublication(publication = {}) {
  if (!publication?.attempted) {
    return 'Publish was not requested for this task.';
  }

  if (publication?.published) {
    const repoName = publication.repo?.name ?? 'the target repository';
    return `I published the verified workspace to ${repoName}.`;
  }

  return `I could not publish the workspace: ${publication?.error?.message ?? 'publish failed'}.`;
}

function summarizeExecution(result = {}) {
  const successfulRuns = (result.toolRuns ?? []).filter((run) => run.status === 'success');
  if (successfulRuns.length === 0) {
    return 'Execution did not complete any planned steps.';
  }

  const highlights = successfulRuns.slice(0, 2).map((run) => compactText(run.summary, 110));
  if (highlights.length === 1) {
    return `I completed the main implementation step: ${highlights[0]}`;
  }

  return `I completed the core implementation steps: ${highlights.join(' Then ')}`;
}

function summarizeVerification(result = {}) {
  const review = result?.verification?.review ?? {};
  if (!review.summary) {
    return 'Verification summary is not available yet.';
  }

  if (review.status === 'passed') {
    return `Verification passed: ${compactText(review.summary, 180)}`;
  }

  if (review.status === 'needs_human_review') {
    return `Verification needs human review: ${compactText(review.summary, 180)}`;
  }

  return `Verification failed: ${compactText(review.summary, 180)}`;
}

function summarizeSpecializedReview(result = {}) {
  const specialized = result?.specializedReview ?? {};
  if (!specialized.summary) {
    return null;
  }

  if (specialized.status === 'passed') {
    return compactText(specialized.summary, 180);
  }

  return `Specialized review flagged follow-up work: ${compactText(specialized.summary, 180)}`;
}

function buildEvidence(result = {}) {
  const stepNumbers = unique((result.toolRuns ?? []).map((run) => run.stepNumber))
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value))
    .sort((left, right) => left - right);

  const changedFiles = unique(
    (result?.verification?.workspaceFiles ?? []).map((filePath) => basenameOrValue(filePath))
  );

  return {
    stepNumbers,
    changedFiles,
    artifactHints: unique(
      [
        result?.publication?.published ? 'repository' : null,
        changedFiles.length > 0 ? 'workspace_files' : null,
        result?.specializedReview?.followUpTasks?.length ? 'follow_up_tasks' : null,
      ].filter(Boolean)
    ),
  };
}

function buildFacts(task, result, taskStatus) {
  return {
    taskId: task.id,
    taskTitle: task.title,
    taskStatus,
    workspaceRoot: result?.workspaceRoot ?? task.project_path ?? null,
    repoUrl: result?.publication?.repo?.htmlUrl ?? task.repo_url ?? null,
    planSummary: result?.plan?.summary ?? task?.result?.preExecutionPlan?.plan?.summary ?? null,
    verificationStatus: result?.verification?.review?.status ?? null,
    verificationSummary: result?.verification?.review?.summary ?? null,
    specializedReviewStatus: result?.specializedReview?.status ?? null,
    specializedReviewSummary: result?.specializedReview?.summary ?? null,
    publishAttempted: result?.publication?.attempted === true,
    publishSucceeded: result?.publication?.published === true,
    blockedReason:
      taskStatus === 'blocked' || taskStatus === 'failed'
        ? result?.publication?.error?.message ??
          result?.specializedReview?.summary ??
          result?.verification?.review?.summary ??
          null
        : null,
  };
}

function buildNarrativeText(task, result, taskStatus) {
  const execution = summarizeExecution(result);
  const verification = summarizeVerification(result);
  const specialized = summarizeSpecializedReview(result);
  const publication = summarizePublication(result.publication);

  if (taskStatus === 'done') {
    return compactText(
      `I finished "${task.title}". ${execution} ${verification} ${specialized ?? ''} ${publication}`.trim(),
      700
    );
  }

  if (taskStatus === 'waiting_approval') {
    return compactText(
      `I finished the code and validation work for "${task.title}". ${execution} ${verification} ${publication} The next step is your deploy approval.`,
      700
    );
  }

  if (taskStatus === 'blocked') {
    return compactText(
      `I got "${task.title}" through the implementation path, but I am blocked before final completion. ${verification} ${specialized ?? publication}`,
      700
    );
  }

  if (taskStatus === 'needs_repair') {
    return compactText(
      `I hit a wall while working on "${task.title}" and drafted a repair path instead of guessing. ${result?.repairProposal?.reasoning ?? 'A planned step failed.'}`,
      700
    );
  }

  return compactText(
    `I ran into a failure on "${task.title}". ${verification} ${result?.publication?.error?.message ?? ''}`.trim(),
    700
  );
}

function buildChannelDrafts({ task, result, taskStatus, narrative }) {
  const shortVerification = compactText(result?.verification?.review?.summary, 140);
  const telegramLines = [
    taskStatus === 'done'
      ? `Task finished: ${task.title}`
      : taskStatus === 'waiting_approval'
        ? `Ready for deploy approval: ${task.title}`
        : taskStatus === 'needs_repair'
          ? `Repair handoff: ${task.title}`
          : `Task needs attention: ${task.title}`,
    narrative,
    shortVerification && shortVerification !== narrative ? `Verification: ${shortVerification}` : null,
  ].filter(Boolean);

  return {
    telegram: compactText(telegramLines.join('\n'), 900),
    ui: narrative,
  };
}

function buildReviewCommentDraft(task, result, taskStatus) {
  const verification = result?.verification?.review?.summary ?? 'Verification summary unavailable.';
  const specialized = result?.specializedReview?.summary ?? null;
  const body = compactText(
    [
      `Hey! I ran LocalClaw on "${task.title}".`,
      taskStatus === 'done'
        ? 'The implementation path completed and verification passed.'
        : taskStatus === 'waiting_approval'
          ? 'The implementation path completed and is waiting on deploy approval.'
          : 'The run did not fully close cleanly and needs follow-up.',
      `Verification: ${verification}`,
      specialized ? `Specialized review: ${specialized}` : null,
    ]
      .filter(Boolean)
      .join(' '),
    900
  );

  return {
    artifactType: 'review_comment_draft_v1',
    artifactPath: `task://${task.id}/review_comment_draft_v1`,
    metadata: {
      version: 'review_comment_draft_v1',
      mode: 'draft',
      audience: 'github',
      approvalRequired: true,
      taskStatus,
      body,
    },
  };
}

function buildObservationArtifacts(task, result) {
  return (result?.specializedReview?.followUpTasks ?? []).map((followUpTask, index) => ({
    artifactType: 'observation_note_v1',
    artifactPath: `task://${task.id}/observation_note_v1/${index + 1}`,
    metadata: {
      version: 'observation_note_v1',
      source: followUpTask.source ?? 'specialized_review',
      title: followUpTask.title,
      note: `By the way, I noticed ${compactText(followUpTask.description, 220)}`,
      priority: followUpTask.priority ?? 'medium',
      suggestedAction: 'Create or review the follow-up task before the issue compounds.',
    },
  }));
}

export function buildPersonaProfileArtifact(task, options = {}) {
  return {
    artifactType: 'persona_profile_v1',
    artifactPath: `task://${task.id}/persona_profile_v1`,
    metadata: {
      version: 'persona_profile_v1',
      voice: 'grounded_engineering_teammate',
      nonAuthoritative: true,
      preferenceSource: options.preferenceSource ?? 'platform_defaults',
      channels: {
        telegram: { verbosity: 'concise', teachingDepth: 'low' },
        ui: { verbosity: 'detailed', teachingDepth: 'medium' },
        github: { verbosity: 'concise', mode: 'draft_or_approval_gated' },
      },
      controls: {
        proactiveObservations: true,
        githubVoiceEnabled: false,
      },
    },
  };
}

export function buildPersonaArtifactsForExecution({ task, result, taskStatus }) {
  const evidence = buildEvidence(result);
  const facts = buildFacts(task, result, taskStatus);
  const narrative = buildNarrativeText(task, result, taskStatus);
  const channelDrafts = buildChannelDrafts({
    task,
    result,
    taskStatus,
    narrative,
  });

  const artifacts = [
    {
      artifactType: 'narrated_summary_v1',
      artifactPath: `task://${task.id}/narrated_summary_v1`,
      metadata: {
        version: 'narrated_summary_v1',
        taskStatus,
        summary: narrative,
        voice: 'grounded_engineering_teammate',
        generatedBy: 'deterministic_fact_narrator',
        facts,
        evidence,
        channelDrafts,
      },
    },
    buildReviewCommentDraft(task, result, taskStatus),
    ...buildObservationArtifacts(task, result),
  ];

  if (taskStatus === 'blocked' || taskStatus === 'failed' || taskStatus === 'waiting_approval') {
    artifacts.push({
      artifactType: 'handover_summary_v1',
      artifactPath: `task://${task.id}/handover_summary_v1`,
      metadata: {
        version: 'handover_summary_v1',
        taskStatus,
        summary:
          taskStatus === 'waiting_approval'
            ? 'Execution is complete. Review the verified state and decide whether to deploy.'
            : facts.blockedReason ?? 'This task needs operator follow-up.',
        whatWasTried: compactText(
          (result.toolRuns ?? [])
            .slice(0, 3)
            .map((run) => `${run.stepNumber}. ${run.objective}`)
            .join(' | '),
          260
        ),
        nextAction:
          taskStatus === 'waiting_approval'
            ? 'Approve or reject deployment from the approval queue.'
            : 'Inspect the verification summary, specialized review notes, and execution log before resuming.',
        evidence,
      },
    });
  }

  return artifacts;
}

export function buildPersonaArtifactsForRepairApproval({ task, result }) {
  const repairProposal = result?.repairProposal ?? {};
  const steps = (repairProposal.steps ?? [])
    .map((step) => `${step.objective} (${step.tool})`)
    .slice(0, 4);

  return [
    {
      artifactType: 'narrated_summary_v1',
      artifactPath: `task://${task.id}/narrated_summary_v1`,
      metadata: {
        version: 'narrated_summary_v1',
        taskStatus: 'needs_repair',
        summary: buildNarrativeText(task, result, 'needs_repair'),
        voice: 'grounded_engineering_teammate',
        generatedBy: 'deterministic_fact_narrator',
        facts: {
          taskId: task.id,
          taskTitle: task.title,
          taskStatus: 'needs_repair',
          repairReason: repairProposal.reasoning ?? null,
        },
        evidence: {
          stepNumbers: unique((repairProposal.steps ?? []).map((step, index) => step.stepNumber ?? index + 1)),
          changedFiles: [],
          artifactHints: ['repair_proposal'],
        },
        channelDrafts: {
          telegram: compactText(
            `Repair handoff: ${task.title}\n${repairProposal.reasoning ?? 'A repair proposal is ready for review.'}`,
            900
          ),
          ui: compactText(
            `I stopped after a failed step and drafted a repair path instead of improvising. ${repairProposal.reasoning ?? ''}`,
            700
          ),
        },
      },
    },
    {
      artifactType: 'handover_summary_v1',
      artifactPath: `task://${task.id}/handover_summary_v1`,
      metadata: {
        version: 'handover_summary_v1',
        taskStatus: 'needs_repair',
        summary: repairProposal.reasoning ?? 'A repair proposal is ready for operator review.',
        whatWasTried: steps.join(' | '),
        nextAction: 'Approve the repair proposal if the plan looks safe, or reject it and inspect the logs for missing context.',
        proposedSteps: steps,
      },
    },
  ];
}

export function buildPersonaArtifactsForExecutionError({ task, error }) {
  const message = compactText(error?.message ?? 'Execution failed unexpectedly.', 240);

  return [
    {
      artifactType: 'narrated_summary_v1',
      artifactPath: `task://${task.id}/narrated_summary_v1`,
      metadata: {
        version: 'narrated_summary_v1',
        taskStatus: 'failed',
        summary: `I hit a failure while working on "${task.title}". ${message}`,
        voice: 'grounded_engineering_teammate',
        generatedBy: 'deterministic_fact_narrator',
        facts: {
          taskId: task.id,
          taskTitle: task.title,
          taskStatus: 'failed',
          blockedReason: message,
        },
        evidence: {
          stepNumbers: [],
          changedFiles: [],
          artifactHints: ['system_error'],
        },
        channelDrafts: {
          telegram: `Task failed: ${task.title}\n${message}`,
          ui: `I hit a failure while working on "${task.title}". ${message}`,
        },
      },
    },
    {
      artifactType: 'handover_summary_v1',
      artifactPath: `task://${task.id}/handover_summary_v1`,
      metadata: {
        version: 'handover_summary_v1',
        taskStatus: 'failed',
        summary: message,
        whatWasTried: 'The task aborted before a clean execution summary could be assembled.',
        nextAction: 'Inspect the latest system and execution logs before retrying.',
      },
    },
  ];
}

export function hydratePersonaArtifacts(artifacts = []) {
  const typed = Array.isArray(artifacts) ? artifacts : [];
  const latestByType = (type) => typed.find((artifact) => artifact.artifact_type === type) ?? null;

  return {
    profile: latestByType('persona_profile_v1')?.metadata ?? null,
    narratedSummary: latestByType('narrated_summary_v1')?.metadata ?? null,
    handoverSummary: latestByType('handover_summary_v1')?.metadata ?? null,
    reviewCommentDraft: latestByType('review_comment_draft_v1')?.metadata ?? null,
    observationNotes: typed
      .filter((artifact) => artifact.artifact_type === 'observation_note_v1')
      .map((artifact) => artifact.metadata ?? {}),
  };
}
