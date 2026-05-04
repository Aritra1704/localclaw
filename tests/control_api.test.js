import assert from 'node:assert/strict';
import test from 'node:test';

import pino from 'pino';

import { createControlApiServer } from '../src/control/api.js';

const logger = pino({ level: 'fatal' });

const validContract = {
  version: 'task_contract_v1',
  projectName: 'phase7-prep',
  objective: 'Implement CLI-first control API with strict plan+approve execution.',
  inScope: ['Add local control API', 'Add CLI interface'],
  outOfScope: ['Build web UI'],
  constraints: ['Keep deploy approval gates unchanged'],
  successCriteria: ['API can create plan previews', 'CLI can approve execution'],
  priority: 'medium',
  skillHints: ['scaffold_node_http_service'],
  repoIntent: {
    publish: false,
    deploy: false,
  },
};

test('control API enforces token on mutating routes and returns deterministic responses', async () => {
  const callLog = [];
  const orchestrator = {
    async getStatusSnapshot() {
      return {
        status: 'running',
        queue: {
          pending_count: 1,
          in_progress_count: 0,
          blocked_count: 0,
          waiting_approval_count: 1,
        },
      };
    },
    getMcpStatus() {
      return {
        servers: [
          {
            name: 'filesystem',
            description: 'files',
            tools: [{ name: 'write_file', description: 'write' }],
          },
        ],
      };
    },
    async listTasks() {
      return [];
    },
    async listPendingApprovals() {
      return [];
    },
    async listSkills() {
      return [];
    },
    async getTaskDetails(taskId) {
      return {
        task: {
          id: taskId,
          status: 'waiting_approval',
          repo_url: 'https://github.com/example/demo-repo',
        },
        logs: [],
        persona: {
          reviewCommentDraft: {
            body: 'LocalClaw review draft body',
            publicationMode: 'draft_or_approval_gated',
            approvalRequired: true,
          },
        },
      };
    },
    async createPlannedTask(contract) {
      callLog.push({ fn: 'createPlannedTask', contract });
      return {
        task: {
          id: '11111111-1111-4111-8111-111111111111',
          title: 'phase7-prep: plan',
          status: 'waiting_approval',
        },
        plan: {
          summary: 'Create strict plan and wait for execution approval',
          steps: [
            {
              stepNumber: 1,
              objective: 'Write file',
              tool: 'write_file',
              args: { path: 'README.md', content: 'x' },
            },
          ],
        },
        planner: {
          modelUsed: 'test',
          repaired: false,
          fallback: false,
        },
      };
    },
    async approveTaskExecution(taskId) {
      callLog.push({ fn: 'approveTaskExecution', taskId });
      return {
        task_id: taskId,
        status: 'approved',
      };
    },
    async rejectTaskExecution(taskId, options) {
      callLog.push({ fn: 'rejectTaskExecution', taskId, options });
      return {
        task_id: taskId,
        status: 'rejected',
        reason: options.reason,
      };
    },
    async approveApproval(approvalId) {
      callLog.push({ fn: 'approveApproval', approvalId });
      return {
        id: approvalId,
        task_id: '11111111-1111-4111-8111-111111111111',
      };
    },
    async rejectApproval(approvalId, options) {
      callLog.push({ fn: 'rejectApproval', approvalId, options });
      return {
        id: approvalId,
        task_id: '11111111-1111-4111-8111-111111111111',
      };
    },
    async pause() {},
    async resume() {},
    async getPersonaSettings() {
      return {
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
      };
    },
    async getPersonaPreferenceProfile() {
      return {
        version: 'persona_preference_profile_v1',
        explicit: {
          reviewTone: {
            value: 'direct',
            source: 'explicit',
            confidence: 1,
            evidence: 'operator profile',
            updatedAt: '2026-05-04T00:00:00.000Z',
            expiresAt: null,
          },
        },
        inferred: {},
        updatedAt: '2026-05-04T00:00:00.000Z',
      };
    },
    async updatePersonaSettings(settings) {
      return settings;
    },
    async updatePersonaPreferenceProfile(profile) {
      return {
        version: 'persona_preference_profile_v1',
        explicit: {
          reviewTone: {
            value: profile.explicit?.reviewTone?.value ?? 'direct',
            source: 'explicit',
            confidence: 1,
            evidence: profile.explicit?.reviewTone?.evidence ?? 'operator profile',
            updatedAt: '2026-05-04T00:00:00.000Z',
            expiresAt: null,
          },
        },
        inferred: {},
        updatedAt: '2026-05-04T00:00:00.000Z',
      };
    },
    async publishTaskReviewDraft(taskId, input) {
      callLog.push({ fn: 'publishTaskReviewDraft', taskId, input });
      return {
        taskId,
        owner: input.owner ?? 'example',
        repo: input.repo ?? 'demo-repo',
        issueNumber: input.issueNumber,
        commentUrl: 'https://github.com/example/demo-repo/pull/12#issuecomment-1',
      };
    },
  };

  const api = createControlApiServer({
    orchestrator,
    logger,
    host: '127.0.0.1',
    port: 0,
    token: 'test-token',
  });

  const bound = await api.start();
  const baseUrl = `http://${bound.host}:${bound.port}`;

  try {
    const statusResponse = await fetch(`${baseUrl}/v1/status`);
    assert.equal(statusResponse.status, 200);

    const mcpResponse = await fetch(`${baseUrl}/v1/mcp`);
    assert.equal(mcpResponse.status, 200);
    const mcpPayload = await mcpResponse.json();
    assert.equal(mcpPayload.data.servers[0].name, 'filesystem');

    const unauthorizedResponse = await fetch(`${baseUrl}/v1/tasks/plan`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ contract: validContract }),
    });
    assert.equal(unauthorizedResponse.status, 401);

    const invalidContractResponse = await fetch(`${baseUrl}/v1/tasks/plan`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ contract: { ...validContract, objective: '' } }),
    });
    assert.equal(invalidContractResponse.status, 400);
    const invalidPayload = await invalidContractResponse.json();
    assert.equal(invalidPayload.error, 'validation_error');

    const planResponse = await fetch(`${baseUrl}/v1/tasks/plan`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ contract: validContract }),
    });
    assert.equal(planResponse.status, 201);
    const plannedPayload = await planResponse.json();
    assert.equal(plannedPayload.data.task.status, 'waiting_approval');
    assert.equal(plannedPayload.data.task.id, '11111111-1111-4111-8111-111111111111');

    const runResponse = await fetch(`${baseUrl}/v1/tasks/run`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        contract: validContract,
        approveExecution: true,
      }),
    });
    assert.equal(runResponse.status, 201);
    const runPayload = await runResponse.json();
    assert.equal(runPayload.data.executionApproval.status, 'approved');

    const publishReviewResponse = await fetch(
      `${baseUrl}/v1/tasks/11111111-1111-4111-8111-111111111111/publish-review-draft`,
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer test-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          owner: 'example',
          repo: 'demo-repo',
          issueNumber: 12,
        }),
      }
    );
    assert.equal(publishReviewResponse.status, 200);
    const publishReviewPayload = await publishReviewResponse.json();
    assert.equal(publishReviewPayload.data.issueNumber, 12);

    const callSummary = callLog.map((entry) => entry.fn);
    assert.deepEqual(callSummary, [
      'createPlannedTask',
      'createPlannedTask',
      'approveTaskExecution',
      'publishTaskReviewDraft',
    ]);
  } finally {
    await api.stop();
  }
});

test('control API exposes project and chat operator endpoints', async () => {
  const orchestrator = {
    async getStatusSnapshot() {
      return { status: 'running', queue: {} };
    },
    getMcpStatus() {
      return { servers: [] };
    },
    async listTasks() {
      return [];
    },
    async listPendingApprovals() {
      return [];
    },
    async listSkills() {
      return [];
    },
    async pause() {},
    async resume() {},
    async getPersonaSettings() {
      return {
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
      };
    },
    async getPersonaPreferenceProfile() {
      return {
        version: 'persona_preference_profile_v1',
        explicit: {},
        inferred: {
          verbosity: {
            value: 'concise',
            source: 'inferred',
            confidence: 0.72,
            evidence: 'latest chat session',
            updatedAt: '2026-05-04T00:00:00.000Z',
            expiresAt: '2026-06-03T00:00:00.000Z',
          },
        },
        updatedAt: '2026-05-04T00:00:00.000Z',
      };
    },
    async updatePersonaSettings(settings) {
      return settings;
    },
    async updatePersonaPreferenceProfile(profile) {
      return {
        version: 'persona_preference_profile_v1',
        explicit: {
          ...(profile.explicit ?? {}),
        },
        inferred: {
          verbosity: {
            value: 'concise',
            source: 'inferred',
            confidence: 0.72,
            evidence: 'latest chat session',
            updatedAt: '2026-05-04T00:00:00.000Z',
            expiresAt: '2026-06-03T00:00:00.000Z',
          },
        },
        updatedAt: '2026-05-04T00:00:00.000Z',
      };
    },
    async publishTaskReviewDraft(taskId, input) {
      return {
        taskId,
        owner: input.owner ?? 'example',
        repo: input.repo ?? 'demo-repo',
        issueNumber: input.issueNumber,
        commentUrl: 'https://github.com/example/demo-repo/pull/12#issuecomment-1',
      };
    },
  };
  const projectService = {
    async listProjects() {
      return {
        allowedRoots: ['/tmp'],
        projects: [],
      };
    },
    async addProject(input) {
      return {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        name: input.name ?? 'demo',
        root_path: input.rootPath,
      };
    },
    async deleteProject(id) {
      if (id === 'cccccccc-cccc-4ccc-8ccc-cccccccccccc') {
        return {
          id,
          name: 'demo',
          root_path: '/tmp/demo',
        };
      }

      return null;
    },
  };
  const chatService = {
    async listSessions() {
      return [];
    },
    async createSession(input) {
      return {
        id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        title: input.title,
        actor: input.actor,
        project_path: input.projectPath,
      };
    },
    async getSession(id) {
      return {
        session: {
          id,
          title: 'Operator',
          actor: 'architect',
          summary: 'Latest request: review the billing API',
          summary_state: {
            version: 'chat_summary_v1',
            preferences: {
              verbosity: {
                value: 'concise',
                source: 'explicit',
                confidence: 0.98,
              },
            },
            contractDraft: {
              objective: 'Review the billing API and flag risky changes',
              readyForPlanning: false,
              pendingClarification: true,
              missingContext: ['target_area'],
            },
          },
        },
        messages: [],
        tasks: [],
      };
    },
    async appendMessage(id, input) {
      return {
        user: { session_id: id, content: input.content },
        assistant: { content: 'Safe response' },
      };
    },
    async draftTask() {
      return {
        contract: validContract,
      };
    },
    async planTask() {
      return {
        task: {
          id: '11111111-1111-4111-8111-111111111111',
          status: 'waiting_approval',
        },
        plan: {
          summary: 'Plan preview',
        },
      };
    },
    async approveTask() {
      return {
        task_id: '11111111-1111-4111-8111-111111111111',
        status: 'approved',
      };
    },
  };

  const api = createControlApiServer({
    orchestrator,
    logger,
    host: '127.0.0.1',
    port: 0,
    token: 'test-token',
    projectService,
    chatService,
  });

  const bound = await api.start();
  const baseUrl = `http://${bound.host}:${bound.port}`;

  try {
    const projects = await fetch(`${baseUrl}/v1/projects`);
    assert.equal(projects.status, 200);

    const unauthorizedProject = await fetch(`${baseUrl}/v1/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rootPath: '/tmp/demo' }),
    });
    assert.equal(unauthorizedProject.status, 401);

    const project = await fetch(`${baseUrl}/v1/projects`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ rootPath: '/tmp/demo', name: 'demo' }),
    });
    assert.equal(project.status, 201);

    const deletedProject = await fetch(
      `${baseUrl}/v1/projects/cccccccc-cccc-4ccc-8ccc-cccccccccccc`,
      {
        method: 'DELETE',
        headers: {
          authorization: 'Bearer test-token',
        },
      }
    );
    assert.equal(deletedProject.status, 200);

    const missingProject = await fetch(
      `${baseUrl}/v1/projects/dddddddd-dddd-4ddd-8ddd-dddddddddddd`,
      {
        method: 'DELETE',
        headers: {
          authorization: 'Bearer test-token',
        },
      }
    );
    assert.equal(missingProject.status, 404);

    const session = await fetch(`${baseUrl}/v1/chat/sessions`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        title: 'Operator',
        actor: 'architect',
        projectPath: '/tmp/demo',
      }),
    });
    assert.equal(session.status, 201);
    const sessionPayload = await session.json();
    assert.equal(sessionPayload.data.actor, 'architect');

    const message = await fetch(
      `${baseUrl}/v1/chat/sessions/${sessionPayload.data.id}/messages`,
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer test-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ content: 'Review this project', actor: 'analyst' }),
      }
    );
    assert.equal(message.status, 201);

    const sessionDetail = await fetch(
      `${baseUrl}/v1/chat/sessions/${sessionPayload.data.id}`
    );
    assert.equal(sessionDetail.status, 200);
    const sessionDetailPayload = await sessionDetail.json();
    assert.equal(sessionDetailPayload.data.session.summary_state.version, 'chat_summary_v1');
    assert.equal(
      sessionDetailPayload.data.session.summary_state.contractDraft.pendingClarification,
      true
    );

    const personaSettings = await fetch(`${baseUrl}/v1/persona/settings`);
    assert.equal(personaSettings.status, 200);
    const personaSettingsPayload = await personaSettings.json();
    assert.equal(personaSettingsPayload.data.channels.ui.verbosity, 'detailed');

    const updatedPersonaSettings = await fetch(`${baseUrl}/v1/persona/settings`, {
      method: 'PUT',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        channels: {
          ui: { verbosity: 'concise' },
        },
        controls: {
          githubVoiceEnabled: true,
        },
      }),
    });
    assert.equal(updatedPersonaSettings.status, 200);
    const updatedPersonaPayload = await updatedPersonaSettings.json();
    assert.equal(updatedPersonaPayload.data.channels.ui.verbosity, 'concise');
    assert.equal(updatedPersonaPayload.data.controls.githubVoiceEnabled, true);

    const preferenceProfile = await fetch(`${baseUrl}/v1/persona/preference-profile`);
    assert.equal(preferenceProfile.status, 200);
    const preferenceProfilePayload = await preferenceProfile.json();
    assert.equal(preferenceProfilePayload.data.inferred.verbosity.value, 'concise');

    const updatedPreferenceProfile = await fetch(`${baseUrl}/v1/persona/preference-profile`, {
      method: 'PUT',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        explicit: {
          reviewTone: {
            value: 'supportive',
            evidence: 'team prefers lighter review tone',
          },
        },
      }),
    });
    assert.equal(updatedPreferenceProfile.status, 200);
    const updatedPreferencePayload = await updatedPreferenceProfile.json();
    assert.equal(updatedPreferencePayload.data.explicit.reviewTone.value, 'supportive');
  } finally {
    await api.stop();
  }
});
