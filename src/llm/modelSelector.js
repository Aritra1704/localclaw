import { config } from '../config.js';

export function createModelSelector(overrides = {}) {
  const models = {
    planner: config.modelPlanner,
    coder: config.modelCoder,
    fast: config.modelFast,
    review: config.modelReview,
    embed: config.modelEmbed,
    ...overrides,
  };

  return {
    list() {
      return { ...models };
    },

    select(role) {
      const model = models[role];
      if (!model) {
        throw new Error(`Unknown LocalClaw model role: ${role}`);
      }

      return model;
    },

    selectWithFallback(role) {
      const planner = models.planner;
      const fast = models.fast;

      switch (role) {
        case 'planner':
          return [models.planner, fast].filter(Boolean);
        case 'coder':
          return [models.coder, planner, fast].filter(Boolean);
        case 'review':
          return [models.review, planner, fast].filter(Boolean);
        case 'fast':
          return [fast, planner].filter(Boolean);
        case 'embed':
          return [models.embed].filter(Boolean);
        default:
          throw new Error(`Unknown LocalClaw model role: ${role}`);
      }
    },
  };
}
