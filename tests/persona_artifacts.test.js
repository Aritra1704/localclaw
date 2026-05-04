import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_PERSONA_SETTINGS,
  applyPersonaPreferencesToSettings,
  buildPersonaArtifactsForExecution,
  buildPersonaArtifactsForRepairApproval,
  buildPersonaProfileArtifact,
  hydratePersonaArtifacts,
  mergePersonaPreferenceProfile,
  normalizePersonaSettings,
  recordChatSummaryPreferences,
  resolvePersonaPreferences,
} from '../src/persona/artifacts.js';

test('buildPersonaProfileArtifact creates a non-authoritative default profile', () => {
  const artifact = buildPersonaProfileArtifact({
    id: '11111111-1111-4111-8111-111111111111',
  });

  assert.equal(artifact.artifactType, 'persona_profile_v1');
  assert.equal(artifact.metadata.nonAuthoritative, true);
  assert.equal(artifact.metadata.channels.telegram.verbosity, 'concise');
});

test('normalizePersonaSettings preserves defaults while applying overrides', () => {
  const settings = normalizePersonaSettings({
    channels: {
      ui: {
        verbosity: 'concise',
      },
    },
    controls: {
      githubVoiceEnabled: true,
    },
  });

  assert.equal(settings.channels.telegram.verbosity, DEFAULT_PERSONA_SETTINGS.channels.telegram.verbosity);
  assert.equal(settings.channels.ui.verbosity, 'concise');
  assert.equal(settings.controls.githubVoiceEnabled, true);
});

test('persona preference profiles honor explicit overrides and expire stale inferred entries', () => {
  const now = Date.parse('2026-05-04T00:00:00.000Z');
  const profile = mergePersonaPreferenceProfile(
    null,
    {
      explicit: {
        verbosity: { value: 'concise', evidence: 'operator said keep it short' },
      },
      inferred: {
        explanationDepth: {
          value: 'high',
          confidence: 0.78,
          evidence: 'chat asked for why',
          expiresAt: '2026-05-20T00:00:00.000Z',
        },
        commentNoise: {
          value: 'high',
          confidence: 0.61,
          evidence: 'older session liked more commentary',
          expiresAt: '2026-04-20T00:00:00.000Z',
        },
      },
    },
    '2026-05-01T00:00:00.000Z'
  );
  const resolved = resolvePersonaPreferences(profile, null, now);
  const settings = applyPersonaPreferencesToSettings(DEFAULT_PERSONA_SETTINGS, resolved.active);

  assert.equal(resolved.active.verbosity.value, 'concise');
  assert.equal(resolved.active.explanationDepth.value, 'high');
  assert.equal(resolved.active.commentNoise, undefined);
  assert.equal(settings.channels.telegram.verbosity, 'concise');
  assert.equal(settings.channels.ui.teachingDepth, 'high');
});

test('chat summary preferences persist into the persona preference profile with explicit and inferred buckets', () => {
  const next = recordChatSummaryPreferences(
    null,
    {
      updatedAt: '2026-05-04T10:00:00.000Z',
      preferences: {
        verbosity: {
          value: 'concise',
          source: 'explicit',
          confidence: 0.98,
          evidence: 'keep it concise',
        },
        interactionMode: {
          value: 'execution_oriented',
          source: 'inferred',
          confidence: 0.72,
          evidence: 'create the file',
        },
      },
    },
    '2026-05-04T10:00:00.000Z'
  );

  assert.equal(next.explicit.verbosity.value, 'concise');
  assert.equal(next.explicit.verbosity.source, 'explicit');
  assert.equal(next.inferred.interactionMode.value, 'execution_oriented');
  assert.equal(next.inferred.interactionMode.source, 'inferred');
  assert.match(next.inferred.interactionMode.expiresAt, /^2026-06-/);
});

test('buildPersonaArtifactsForExecution creates narrated summary, handover, observations, and review draft', () => {
  const task = {
    id: '22222222-2222-4222-8222-222222222222',
    title: 'Improve README and dependency notes',
  };
  const result = {
    workspaceRoot: '/tmp/demo',
    plan: {
      summary: 'Refresh README and update dependency policy',
    },
    toolRuns: [
      {
        stepNumber: 1,
        objective: 'Update README',
        tool: 'write_file',
        status: 'success',
        summary: 'Updated README.md with current setup steps.',
      },
    ],
    verification: {
      review: {
        status: 'passed',
        summary: 'Workspace task completed and passed deterministic verification.',
      },
      workspaceFiles: ['README.md', 'docs/ARCHITECTURE.md'],
    },
    specializedReview: {
      status: 'needs_human_review',
      summary: 'Dependency Agent found 1 dependency maintenance issue.',
      followUpTasks: [
        {
          title: 'Upgrade axios to latest safe release',
          description: 'axios is behind the recommended baseline and should be updated soon.',
          priority: 'high',
          source: 'phase10_dependency_agent',
        },
      ],
    },
    publication: {
      attempted: true,
      published: true,
      repo: {
        name: 'demo-repo',
        htmlUrl: 'https://github.com/example/demo-repo',
      },
    },
  };

  const artifacts = buildPersonaArtifactsForExecution({
    task,
    result,
    taskStatus: 'blocked',
  });
  const persona = hydratePersonaArtifacts(
    artifacts.map((artifact) => ({
      artifact_type: artifact.artifactType,
      artifact_path: artifact.artifactPath,
      metadata: artifact.metadata,
      created_at: '2026-04-19T00:00:00.000Z',
    }))
  );

  assert.equal(persona.narratedSummary.taskStatus, 'blocked');
  assert.match(persona.narratedSummary.summary, /blocked/i);
  assert.deepEqual(persona.narratedSummary.evidence.stepNumbers, [1]);
  assert.deepEqual(persona.narratedSummary.evidence.changedFiles, ['README.md', 'ARCHITECTURE.md']);
  assert.equal(persona.handoverSummary.taskStatus, 'blocked');
  assert.equal(persona.reviewCommentDraft.mode, 'draft');
  assert.equal(persona.reviewCommentDraft.body, persona.narratedSummary.channelDrafts.github);
  assert.equal(persona.observationNotes.length, 1);
  assert.match(persona.observationNotes[0].note, /By the way/i);
});

test('buildPersonaArtifactsForExecution respects persona settings for channel drafts and observations', () => {
  const task = {
    id: '25252525-2525-4252-8252-252525252525',
    title: 'Tune review voice',
  };
  const result = {
    toolRuns: [
      {
        stepNumber: 1,
        objective: 'Update docs',
        tool: 'write_file',
        status: 'success',
        summary: 'Updated onboarding docs.',
      },
    ],
    verification: {
      review: {
        status: 'passed',
        summary: 'Verification passed and the docs build is green.',
      },
      workspaceFiles: ['README.md'],
    },
    specializedReview: {
      status: 'needs_human_review',
      summary: 'Dependency drift was detected.',
      followUpTasks: [
        {
          title: 'Review dependency drift',
          description: 'A dependency follow-up may be needed.',
          priority: 'medium',
        },
      ],
    },
    publication: {
      attempted: false,
      published: false,
    },
  };

  const artifacts = buildPersonaArtifactsForExecution({
    task,
    result,
    taskStatus: 'done',
    settings: {
      channels: {
        telegram: { verbosity: 'detailed' },
        ui: { verbosity: 'concise' },
      },
      controls: {
        proactiveObservations: false,
        githubVoiceEnabled: true,
      },
    },
    preferenceSource: 'operator_settings',
  });
  const persona = hydratePersonaArtifacts(
    artifacts.map((artifact) => ({
      artifact_type: artifact.artifactType,
      artifact_path: artifact.artifactPath,
      metadata: artifact.metadata,
      created_at: '2026-04-19T00:00:00.000Z',
    }))
  );

  assert.match(persona.narratedSummary.channelDrafts.telegram, /Execution:/);
  assert.equal(persona.narratedSummary.channelDrafts.ui, persona.narratedSummary.summary);
  assert.match(persona.narratedSummary.channelDrafts.github, /Evidence:/);
  assert.equal(persona.observationNotes.length, 0);
  assert.equal(persona.reviewCommentDraft.githubVoiceEnabled, true);
  assert.equal(persona.reviewCommentDraft.body, persona.narratedSummary.channelDrafts.github);
  assert.equal(persona.profile.preferenceSource, 'operator_settings');
});

test('buildPersonaArtifactsForExecution renders distinct channel policies from the same evidence bundle', () => {
  const task = {
    id: '26262626-2626-4262-8262-262626262626',
    title: 'Refine operator handoff copy',
  };
  const result = {
    plan: {
      summary: 'Refresh operator-facing wording and keep the handoff audit-friendly.',
    },
    toolRuns: [
      {
        stepNumber: 2,
        objective: 'Update handoff copy',
        tool: 'write_file',
        status: 'success',
        summary: 'Updated handoff copy in the operator panel.',
      },
    ],
    verification: {
      review: {
        status: 'passed',
        summary: 'Verification passed and operator copy stays evidence-bound.',
      },
      workspaceFiles: ['web/src/main.jsx'],
    },
    specializedReview: {
      status: 'needs_human_review',
      summary: 'Docs Agent flagged nearby copy drift.',
    },
    publication: {
      attempted: false,
      published: false,
    },
  };

  const artifacts = buildPersonaArtifactsForExecution({
    task,
    result,
    taskStatus: 'done',
    settings: {
      channels: {
        telegram: { verbosity: 'detailed' },
        ui: { verbosity: 'detailed', teachingDepth: 'high' },
        github: { verbosity: 'detailed', teachingDepth: 'high' },
      },
      controls: {
        githubVoiceEnabled: true,
      },
    },
  });
  const persona = hydratePersonaArtifacts(
    artifacts.map((artifact) => ({
      artifact_type: artifact.artifactType,
      artifact_path: artifact.artifactPath,
      metadata: artifact.metadata,
      created_at: '2026-04-19T00:00:00.000Z',
    }))
  );

  assert.equal(
    persona.narratedSummary.channelDrafts.telegram,
    [
      'Task finished: Refine operator handoff copy',
      'I finished "Refine operator handoff copy". I completed the main implementation step: Updated handoff copy in the operator panel. Verification passed: Verification passed and operator copy stays evidence-bound. Specialized review flagged follow-up work: Docs Agent flagged nearby copy drift. Publish was not requested for this task.',
      'Execution: I completed the main implementation step: Updated handoff copy in the operator panel.',
      'Verification: Verification passed: Verification passed and operator copy stays evidence-bound.',
      'Specialized review: Specialized review flagged follow-up work: Docs Agent flagged nearby copy drift.',
      'Publish was not requested for this task.',
      'Next action: Review the verified result and decide whether a publish or follow-up task is needed.',
      'Evidence: steps 2; files main.jsx; artifacts workspace_files',
    ].join(' ')
  );
  assert.equal(
    persona.narratedSummary.channelDrafts.ui,
    [
      'I finished "Refine operator handoff copy". I completed the main implementation step: Updated handoff copy in the operator panel. Verification passed: Verification passed and operator copy stays evidence-bound. Specialized review flagged follow-up work: Docs Agent flagged nearby copy drift. Publish was not requested for this task.',
      'Execution: I completed the main implementation step: Updated handoff copy in the operator panel.',
      'Verification: Verification passed: Verification passed and operator copy stays evidence-bound.',
      'Specialized review: Specialized review flagged follow-up work: Docs Agent flagged nearby copy drift.',
      'Publish was not requested for this task.',
      'Plan context: Refresh operator-facing wording and keep the handoff audit-friendly.',
      'Next action: Review the verified result and decide whether a publish or follow-up task is needed.',
      'Evidence: steps 2; files main.jsx; artifacts workspace_files',
    ].join(' ')
  );
  assert.equal(
    persona.narratedSummary.channelDrafts.github,
    [
      'LocalClaw review draft for "Refine operator handoff copy".',
      'Status: implementation completed and verification passed.',
      'Verification: Verification passed: Verification passed and operator copy stays evidence-bound.',
      'Specialized review: Specialized review flagged follow-up work: Docs Agent flagged nearby copy drift.',
      'Plan context: Refresh operator-facing wording and keep the handoff audit-friendly.',
      'Recommended next action: Review the verified result and decide whether a publish or follow-up task is needed.',
      'Evidence: steps 2; files main.jsx; artifacts workspace_files',
    ].join(' ')
  );
  assert.equal(persona.reviewCommentDraft.body, persona.narratedSummary.channelDrafts.github);
});

test('buildPersonaArtifactsForRepairApproval creates narrated and handover summaries', () => {
  const artifacts = buildPersonaArtifactsForRepairApproval({
    task: {
      id: '33333333-3333-4333-8333-333333333333',
      title: 'Fix failing test run',
    },
    result: {
      repairState: {
        status: 'pending_approval',
        attemptCount: 2,
        maxAttempts: 3,
        nextEligibleAt: '2026-04-19T00:10:00.000Z',
        backoffMs: 30000,
        lastOutcome: 'repair_proposal_generated',
        lastFailureMessage: 'Missing environment variable',
        lastFailureStepNumber: 3,
      },
      repairProposal: {
        summary: 'Add the missing test env var',
        reasoning: 'The test command fails because the environment variable is missing.',
        steps: [
          {
            stepNumber: 1,
            objective: 'Add the missing test env var',
            tool: 'write_file',
          },
        ],
      },
    },
  });

  const persona = hydratePersonaArtifacts(
    artifacts.map((artifact) => ({
      artifact_type: artifact.artifactType,
      artifact_path: artifact.artifactPath,
      metadata: artifact.metadata,
      created_at: '2026-04-19T00:00:00.000Z',
    }))
  );

  assert.equal(persona.narratedSummary.taskStatus, 'needs_repair');
  assert.match(persona.handoverSummary.summary, /environment variable/i);
  assert.equal(persona.handoverSummary.proposedSteps.length, 1);
  assert.match(persona.narratedSummary.channelDrafts.github, /repair draft/i);
  assert.match(persona.narratedSummary.channelDrafts.github, /Evidence:/);
  assert.equal(persona.selfHealingDiagnostic.repairStatus, 'pending_approval');
  assert.equal(persona.selfHealingDiagnostic.attemptCount, 2);
  assert.equal(persona.selfHealingDiagnostic.failedStepNumber, 3);
  assert.match(persona.selfHealingDiagnostic.recommendedActions[0], /Wait until/);
});

test('buildPersonaArtifactsForExecution includes self-healing diagnostic for exhausted repair budget', () => {
  const artifacts = buildPersonaArtifactsForExecution({
    task: {
      id: '44444444-4444-4444-8444-444444444444',
      title: 'Unstick flaky migration run',
    },
    result: {
      workspaceRoot: '/tmp/migration-run',
      repairState: {
        status: 'exhausted',
        attemptCount: 3,
        maxAttempts: 3,
        attemptsRemaining: 0,
        exhaustedAfterAttempt: 3,
        lastOutcome: 'repair_budget_exhausted',
        lastFailureMessage: 'Migration still fails due to conflicting schema change.',
        lastFailureStepNumber: 5,
      },
      toolRuns: [
        {
          stepNumber: 5,
          objective: 'Run the migration',
          tool: 'run_command',
          status: 'failed',
          summary: 'Migration still fails due to conflicting schema change.',
        },
      ],
      verification: {
        review: {
          status: 'failed',
          summary: 'Migration verification never stabilized.',
        },
      },
      publication: {
        attempted: false,
        published: false,
      },
    },
    taskStatus: 'failed',
  });

  const persona = hydratePersonaArtifacts(
    artifacts.map((artifact) => ({
      artifact_type: artifact.artifactType,
      artifact_path: artifact.artifactPath,
      metadata: artifact.metadata,
      created_at: '2026-04-19T00:00:00.000Z',
    }))
  );

  assert.equal(persona.selfHealingDiagnostic.repairStatus, 'exhausted');
  assert.equal(persona.selfHealingDiagnostic.failedTool, 'run_command');
  assert.match(persona.selfHealingDiagnostic.lastFailureMessage, /conflicting schema change/i);
  assert.match(persona.narratedSummary.summary, /repair budget was exhausted/i);
});
