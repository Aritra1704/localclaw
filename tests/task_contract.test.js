import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildTaskDescriptionFromContract,
  buildTaskTitleFromContract,
  normalizeTaskContract,
} from '../src/control/taskContract.js';

const validContract = {
  version: 'task_contract_v1',
  projectName: 'phase7-contract',
  objective: 'Implement strict contract parsing for control-plane requests.',
  inScope: ['Parse input payloads', 'Validate required fields'],
  outOfScope: ['Build frontend UI'],
  constraints: ['Preserve current deploy gate behavior'],
  successCriteria: ['Validation errors are deterministic'],
  priority: 'medium',
  skillHints: ['add_deploy_readiness_notes'],
  repoIntent: {
    publish: false,
    deploy: false,
  },
};

test('normalizeTaskContract accepts valid task_contract_v1 payload', () => {
  const parsed = normalizeTaskContract(validContract);

  assert.equal(parsed.version, 'task_contract_v1');
  assert.equal(parsed.projectName, 'phase7-contract');
  assert.equal(parsed.successCriteria.length, 1);
});

test('normalizeTaskContract rejects missing required fields', () => {
  assert.throws(
    () =>
      normalizeTaskContract({
        ...validContract,
        objective: 'short',
      }),
    /objective/
  );

  assert.throws(
    () =>
      normalizeTaskContract({
        ...validContract,
        inScope: [],
      }),
    /inScope/
  );
});

test('contract helpers build title and markdown description', () => {
  const parsed = normalizeTaskContract(validContract);
  const title = buildTaskTitleFromContract(parsed);
  const description = buildTaskDescriptionFromContract(parsed);

  assert.match(title, /^phase7-contract:/);
  assert.match(description, /\[task_contract_v1\]/);
  assert.match(description, /## Success Criteria/);
  assert.match(description, /Parse input payloads/);
});
