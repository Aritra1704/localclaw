import path from 'node:path';

export const DEFAULT_PERSONA_SETTINGS = Object.freeze({
  version: 'persona_settings_v1',
  voice: 'grounded_engineering_teammate',
  channels: {
    telegram: { verbosity: 'concise', teachingDepth: 'low' },
    ui: { verbosity: 'detailed', teachingDepth: 'medium' },
    github: {
      verbosity: 'concise',
      teachingDepth: 'low',
      mode: 'draft_or_approval_gated',
    },
  },
  controls: {
    proactiveObservations: true,
    githubVoiceEnabled: false,
  },
});

function unique(values = []) {
  return [...new Set(values.filter(Boolean))];
}

function cloneDefaultPersonaSettings() {
  return JSON.parse(JSON.stringify(DEFAULT_PERSONA_SETTINGS));
}

function normalizeEnum(value, allowed, fallback) {
  return allowed.has(value) ? value : fallback;
}

export function normalizePersonaSettings(input = {}) {
  const defaults = cloneDefaultPersonaSettings();
  const settings = input && typeof input === 'object' ? input : {};

  return {
    version: DEFAULT_PERSONA_SETTINGS.version,
    voice: `${settings.voice ?? defaults.voice}`.trim() || defaults.voice,
    channels: {
      telegram: {
        verbosity: normalizeEnum(
          settings.channels?.telegram?.verbosity,
          new Set(['concise', 'detailed']),
          defaults.channels.telegram.verbosity
        ),
        teachingDepth: normalizeEnum(
          settings.channels?.telegram?.teachingDepth,
          new Set(['low', 'medium', 'high']),
          defaults.channels.telegram.teachingDepth
        ),
      },
      ui: {
        verbosity: normalizeEnum(
          settings.channels?.ui?.verbosity,
          new Set(['concise', 'detailed']),
          defaults.channels.ui.verbosity
        ),
        teachingDepth: normalizeEnum(
          settings.channels?.ui?.teachingDepth,
          new Set(['low', 'medium', 'high']),
          defaults.channels.ui.teachingDepth
        ),
      },
      github: {
        verbosity: normalizeEnum(
          settings.channels?.github?.verbosity,
          new Set(['concise', 'detailed']),
          defaults.channels.github.verbosity
        ),
        teachingDepth: normalizeEnum(
          settings.channels?.github?.teachingDepth,
          new Set(['low', 'medium', 'high']),
          defaults.channels.github.teachingDepth
        ),
        mode: normalizeEnum(
          settings.channels?.github?.mode,
          new Set(['draft_or_approval_gated', 'approval_gated_only']),
          defaults.channels.github.mode
        ),
      },
    },
    controls: {
      proactiveObservations:
        typeof settings.controls?.proactiveObservations === 'boolean'
          ? settings.controls.proactiveObservations
          : defaults.controls.proactiveObservations,
      githubVoiceEnabled:
        typeof settings.controls?.githubVoiceEnabled === 'boolean'
          ? settings.controls.githubVoiceEnabled
          : defaults.controls.githubVoiceEnabled,
    },
  };
}

export function applyChatPreferencesToPersonaSettings(settings, summaryState = null) {
  const next = normalizePersonaSettings(settings);
  const preferences = summaryState?.preferences ?? {};
  const verbosity = preferences.verbosity?.value ?? null;
  const explanationDepth = preferences.explanationDepth?.value ?? null;

  if (verbosity === 'concise') {
    next.channels.ui.verbosity = 'concise';
    next.channels.github.verbosity = 'concise';
  } else if (verbosity === 'detailed') {
    next.channels.ui.verbosity = 'detailed';
    next.channels.github.verbosity = 'detailed';
  }

  if (explanationDepth === 'low') {
    next.channels.ui.teachingDepth = 'low';
    next.channels.github.teachingDepth = 'low';
  } else if (explanationDepth === 'high') {
    next.channels.ui.teachingDepth = 'high';
    next.channels.github.teachingDepth = 'high';
  }

  return next;
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
  const repairState = result?.repairState ?? {};
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
    repairAttemptCount: repairState.attemptCount ?? null,
    repairMaxAttempts: repairState.maxAttempts ?? null,
    repairNextEligibleAt: repairState.nextEligibleAt ?? null,
    repairLastOutcome: repairState.lastOutcome ?? null,
    blockedReason:
      taskStatus === 'blocked' || taskStatus === 'failed'
        ? (repairState.status === 'exhausted'
            ? `Repair budget exhausted after ${repairState.exhaustedAfterAttempt ?? repairState.attemptCount ?? 0} attempt(s).`
            : null) ??
          result?.publication?.error?.message ??
          result?.specializedReview?.summary ??
          result?.verification?.review?.summary ??
          null
        : null,
  };
}

function buildNarrativeText(task, result, taskStatus) {
  const repairState = result?.repairState ?? {};
  const execution = summarizeExecution(result);
  const verification = summarizeVerification(result);
  const specialized = summarizeSpecializedReview(result);
  const publication = summarizePublication(result.publication);

  if (repairState.status === 'exhausted') {
    return compactText(
      `I stopped retrying "${task.title}" because the repair budget was exhausted after ${repairState.exhaustedAfterAttempt ?? repairState.attemptCount ?? 0} attempt(s). ${repairState.lastFailureMessage ?? 'The latest failure did not produce a safe next step.'}`,
      700
    );
  }

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

function buildChannelDrafts({ task, result, taskStatus, narrative, settings }) {
  const resolvedSettings = normalizePersonaSettings(settings);
  const shortVerification = compactText(result?.verification?.review?.summary, 140);
  const execution = summarizeExecution(result);
  const verification = summarizeVerification(result);
  const specialized = summarizeSpecializedReview(result);
  const publication = summarizePublication(result.publication);
  const telegramLines = resolvedSettings.channels.telegram.verbosity === 'detailed'
    ? [
        taskStatus === 'done'
          ? `Task finished: ${task.title}`
          : taskStatus === 'waiting_approval'
            ? `Ready for deploy approval: ${task.title}`
            : taskStatus === 'needs_repair'
              ? `Repair handoff: ${task.title}`
              : `Task needs attention: ${task.title}`,
        narrative,
        `Execution: ${execution}`,
        `Verification: ${verification}`,
        specialized ? `Specialized review: ${specialized}` : null,
        publication,
      ].filter(Boolean)
    : [
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

  const uiDraft =
    resolvedSettings.channels.ui.verbosity === 'detailed'
      ? compactText(
          [narrative, `Execution: ${execution}`, `Verification: ${verification}`, specialized, publication]
            .filter(Boolean)
            .join('\n\n'),
          1400
        )
      : narrative;

  return {
    telegram: compactText(telegramLines.join('\n'), 900),
    ui: uiDraft,
  };
}

function buildReviewCommentDraft(task, result, taskStatus, settings = DEFAULT_PERSONA_SETTINGS) {
  const resolvedSettings = normalizePersonaSettings(settings);
  const verification = result?.verification?.review?.summary ?? 'Verification summary unavailable.';
  const specialized = result?.specializedReview?.summary ?? null;
  const body = compactText(
    resolvedSettings.controls.githubVoiceEnabled
      ? [
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
          .join(' ')
      : [
          `LocalClaw run summary for "${task.title}".`,
          taskStatus === 'done' ? 'Verification passed.' : 'Follow-up is still required.',
          `Verification: ${verification}`,
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
      publicationMode: resolvedSettings.channels.github.mode,
      githubVoiceEnabled: resolvedSettings.controls.githubVoiceEnabled,
      taskStatus,
      body,
    },
  };
}

function buildObservationArtifacts(task, result, settings = DEFAULT_PERSONA_SETTINGS) {
  const resolvedSettings = normalizePersonaSettings(settings);
  if (resolvedSettings.controls.proactiveObservations !== true) {
    return [];
  }

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

function buildSelfHealingDiagnosticArtifact(task, result, taskStatus) {
  const repairState = result?.repairState ?? {};
  const repairProposal = result?.repairProposal ?? {};
  const failedRuns = (result?.toolRuns ?? []).filter((run) => run?.status === 'failed');
  const lastFailedRun = failedRuns.at(-1) ?? null;
  const attemptCount = repairState.attemptCount ?? 0;
  const maxAttempts = repairState.maxAttempts ?? null;

  if (
    !repairState.status &&
    !repairProposal.reasoning &&
    !lastFailedRun &&
    taskStatus !== 'needs_repair'
  ) {
    return null;
  }

  const inspectTargets = unique(
    [
      lastFailedRun?.tool ? `tool:${lastFailedRun.tool}` : null,
      Number.isInteger(lastFailedRun?.stepNumber) ? `step:${lastFailedRun.stepNumber}` : null,
      result?.workspaceRoot ? `workspace:${result.workspaceRoot}` : null,
      'artifact:handover_summary_v1',
      repairProposal.reasoning ? 'artifact:repair_proposal' : null,
    ].filter(Boolean)
  );

  const recommendedActions = [];
  if (repairState.nextEligibleAt) {
    recommendedActions.push(`Wait until ${repairState.nextEligibleAt} before expecting the approved repair to resume.`);
  }
  if (repairProposal.reasoning) {
    recommendedActions.push('Review the repair proposal reasoning before approving another attempt.');
  }
  if (repairState.status === 'exhausted') {
    recommendedActions.push('Inspect the latest failed repair step and decide whether the next fix requires human guidance or a broader task rewrite.');
  } else if (taskStatus === 'needs_repair') {
    recommendedActions.push('Confirm the proposed repair steps are safe and narrowly scoped before approval.');
  } else if (repairState.status === 'failed') {
    recommendedActions.push('Inspect the repair-step logs first, then compare the resumed task state against the original failure.');
  }

  return {
    artifactType: 'self_healing_diagnostic_v1',
    artifactPath: `task://${task.id}/self_healing_diagnostic_v1`,
    metadata: {
      version: 'self_healing_diagnostic_v1',
      taskStatus,
      repairStatus: repairState.status ?? (taskStatus === 'needs_repair' ? 'pending_review' : null),
      attemptCount,
      maxAttempts,
      attemptsRemaining: repairState.attemptsRemaining ?? null,
      nextEligibleAt: repairState.nextEligibleAt ?? null,
      backoffMs: repairState.backoffMs ?? null,
      lastOutcome: repairState.lastOutcome ?? null,
      lastFailureMessage:
        repairState.lastFailureMessage ??
        lastFailedRun?.summary ??
        repairProposal.reasoning ??
        null,
      failedStepNumber:
        repairState.lastFailureStepNumber ??
        lastFailedRun?.stepNumber ??
        null,
      failedTool: lastFailedRun?.tool ?? null,
      repairSummary: repairProposal.summary ?? null,
      repairReasoning: repairProposal.reasoning ?? null,
      inspectTargets,
      recommendedActions,
    },
  };
}

export function buildPersonaProfileArtifact(task, options = {}) {
  const settings = normalizePersonaSettings(options.settings);
  return {
    artifactType: 'persona_profile_v1',
    artifactPath: `task://${task.id}/persona_profile_v1`,
    metadata: {
      version: 'persona_profile_v1',
      voice: settings.voice,
      nonAuthoritative: true,
      preferenceSource: options.preferenceSource ?? 'platform_defaults',
      channels: settings.channels,
      controls: settings.controls,
    },
  };
}

export function buildPersonaArtifactsForExecution({ task, result, taskStatus, settings, preferenceSource }) {
  const resolvedSettings = normalizePersonaSettings(settings);
  const evidence = buildEvidence(result);
  const facts = buildFacts(task, result, taskStatus);
  const narrative = buildNarrativeText(task, result, taskStatus);
  const channelDrafts = buildChannelDrafts({
    task,
    result,
    taskStatus,
    narrative,
    settings: resolvedSettings,
  });

  const artifacts = [
    buildPersonaProfileArtifact(task, {
      settings: resolvedSettings,
      preferenceSource: preferenceSource ?? 'platform_defaults',
    }),
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
    buildReviewCommentDraft(task, result, taskStatus, resolvedSettings),
    ...buildObservationArtifacts(task, result, resolvedSettings),
  ];
  const selfHealingDiagnostic = buildSelfHealingDiagnosticArtifact(task, result, taskStatus);
  if (selfHealingDiagnostic) {
    artifacts.push(selfHealingDiagnostic);
  }

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

export function buildPersonaArtifactsForRepairApproval({ task, result, settings, preferenceSource }) {
  const resolvedSettings = normalizePersonaSettings(settings);
  const repairProposal = result?.repairProposal ?? {};
  const repairState = result?.repairState ?? {};
  const steps = (repairProposal.steps ?? [])
    .map((step) => `${step.objective} (${step.tool})`)
    .slice(0, 4);

  const artifacts = [
    buildPersonaProfileArtifact(task, {
      settings: resolvedSettings,
      preferenceSource: preferenceSource ?? 'platform_defaults',
    }),
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
          repairAttemptCount: repairState.attemptCount ?? null,
          repairMaxAttempts: repairState.maxAttempts ?? null,
          repairNextEligibleAt: repairState.nextEligibleAt ?? null,
        },
        evidence: {
          stepNumbers: unique((repairProposal.steps ?? []).map((step, index) => step.stepNumber ?? index + 1)),
          changedFiles: [],
          artifactHints: ['repair_proposal'],
        },
        channelDrafts: {
          telegram:
            resolvedSettings.channels.telegram.verbosity === 'detailed'
              ? compactText(
                  `Repair handoff: ${task.title}\n${repairProposal.reasoning ?? 'A repair proposal is ready for review.'}\nAttempts: ${repairState.attemptCount ?? 'n/a'} / ${repairState.maxAttempts ?? 'n/a'}`,
                  900
                )
              : compactText(
                  `Repair handoff: ${task.title}\n${repairProposal.reasoning ?? 'A repair proposal is ready for review.'}`,
                  900
                ),
          ui:
            resolvedSettings.channels.ui.verbosity === 'detailed'
              ? compactText(
                  `I stopped after a failed step and drafted a repair path instead of improvising. ${repairProposal.reasoning ?? ''}\n\nAttempts: ${repairState.attemptCount ?? 'n/a'} / ${repairState.maxAttempts ?? 'n/a'}`,
                  900
                )
              : compactText(
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
        nextAction: repairState.nextEligibleAt
          ? `Approve the repair proposal if the plan looks safe. Execution will resume after ${repairState.nextEligibleAt}.`
          : 'Approve the repair proposal if the plan looks safe, or reject it and inspect the logs for missing context.',
        proposedSteps: steps,
      },
    },
  ];
  const selfHealingDiagnostic = buildSelfHealingDiagnosticArtifact(task, result, 'needs_repair');
  if (selfHealingDiagnostic) {
    artifacts.push(selfHealingDiagnostic);
  }

  return artifacts;
}

export function buildPersonaArtifactsForExecutionError({ task, error, settings, preferenceSource }) {
  const resolvedSettings = normalizePersonaSettings(settings);
  const message = compactText(error?.message ?? 'Execution failed unexpectedly.', 240);

  return [
    buildPersonaProfileArtifact(task, {
      settings: resolvedSettings,
      preferenceSource: preferenceSource ?? 'platform_defaults',
    }),
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
          telegram:
            resolvedSettings.channels.telegram.verbosity === 'detailed'
              ? compactText(`Task failed: ${task.title}\n${message}\nInspect the latest logs before retrying.`, 900)
              : `Task failed: ${task.title}\n${message}`,
          ui:
            resolvedSettings.channels.ui.verbosity === 'detailed'
              ? compactText(`I hit a failure while working on "${task.title}". ${message}\n\nInspect the latest logs before retrying.`, 900)
              : `I hit a failure while working on "${task.title}". ${message}`,
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
    selfHealingDiagnostic: latestByType('self_healing_diagnostic_v1')?.metadata ?? null,
    reviewCommentDraft: latestByType('review_comment_draft_v1')?.metadata ?? null,
    observationNotes: typed
      .filter((artifact) => artifact.artifact_type === 'observation_note_v1')
      .map((artifact) => artifact.metadata ?? {}),
  };
}
