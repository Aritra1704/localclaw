import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildPersonaArtifactsForExecution,
  buildPersonaArtifactsForRepairApproval,
  buildPersonaProfileArtifact,
  hydratePersonaArtifacts,
} from '../src/persona/artifacts.js';

test('buildPersonaProfileArtifact creates a non-authoritative default profile', () => {
  const artifact = buildPersonaProfileArtifact({
    id: '11111111-1111-4111-8111-111111111111',
  });

  assert.equal(artifact.artifactType, 'persona_profile_v1');
  assert.equal(artifact.metadata.nonAuthoritative, true);
  assert.equal(artifact.metadata.channels.telegram.verbosity, 'concise');
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
  assert.equal(persona.observationNotes.length, 1);
  assert.match(persona.observationNotes[0].note, /By the way/i);
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
