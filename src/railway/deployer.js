import { config } from '../config.js';
import {
  RAILWAY_ACTIVE_STATUSES,
  RAILWAY_FAILURE_STATUSES,
  RAILWAY_SUCCESS_STATUSES,
} from './client.js';

function toTimestamp(value) {
  const parsed = Date.parse(value ?? '');
  return Number.isNaN(parsed) ? null : parsed;
}

function normalizeDeployment(snapshot, timeoutMs) {
  if (!snapshot) {
    throw new Error('Railway deployment was not found');
  }

  const status = snapshot.status ?? 'UNKNOWN';
  const url = snapshot.staticUrl ?? snapshot.url ?? null;
  const createdAt = toTimestamp(snapshot.createdAt);
  const updatedAt = toTimestamp(snapshot.updatedAt);
  const startedAt = updatedAt ?? createdAt;
  const timedOut =
    startedAt !== null &&
    RAILWAY_ACTIVE_STATUSES.has(status) &&
    Date.now() - startedAt > timeoutMs;

  if (timedOut) {
    return {
      ...snapshot,
      url,
      status: 'TIMEOUT',
      state: 'failed',
    };
  }

  if (RAILWAY_SUCCESS_STATUSES.has(status)) {
    return {
      ...snapshot,
      url,
      state: 'success',
    };
  }

  if (RAILWAY_FAILURE_STATUSES.has(status)) {
    return {
      ...snapshot,
      url,
      state: 'failed',
    };
  }

  return {
    ...snapshot,
    url,
    state: 'pending',
  };
}

export function createRailwayDeployer(options = {}) {
  const client = options.client;
  const timeoutMs = options.timeoutMs ?? config.railwayDeployTimeoutMs;
  const target = {
    projectId: options.projectId ?? config.railwayProjectId,
    environmentId: options.environmentId ?? config.railwayEnvironmentId,
    serviceId: options.serviceId ?? config.railwayServiceId,
    environmentName:
      options.environmentName ??
      config.railwayEnvironmentId ??
      'production',
  };

  if (!client) {
    throw new Error('Railway deployer requires a Railway client');
  }

  return {
    isEnabled() {
      return (
        config.railwayDeployEnabled &&
        Boolean(config.railwayApiToken) &&
        Boolean(target.projectId) &&
        Boolean(target.environmentId) &&
        Boolean(target.serviceId)
      );
    },

    getTarget() {
      return target;
    },

    async triggerDeployment(input = {}) {
      return client.triggerDeployment({
        serviceId: input.serviceId ?? target.serviceId,
        environmentId: input.environmentId ?? target.environmentId,
        commitSha: input.commitSha ?? null,
      });
    },

    async getDeployment(deploymentId) {
      const snapshot = await client.getDeployment(deploymentId);
      return normalizeDeployment(snapshot, timeoutMs);
    },

    async getDeploymentLogs(deploymentId, limit = 50) {
      return client.getDeploymentLogs(deploymentId, limit);
    },
  };
}
