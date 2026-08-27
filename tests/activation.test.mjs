import test from 'node:test';
import assert from 'node:assert/strict';

import {
  activationDecision, ActivationError,
} from '../src/activation.mjs';


test('unbound work stays ephemeral until continuity value is established', () => {
  const result = activationDecision({ continuity: 'unknown', work: 'implementation' });
  assert.equal(result.status, 'ephemeral');
  assert.equal(result.action, 'stay-ephemeral');
  assert.equal(result.confirmationRequired, false);
});


test('one-off work stays ephemeral even when role ownership is clear', () => {
  const result = activationDecision({ continuity: 'one-off', work: 'product' });
  assert.equal(result.action, 'stay-ephemeral');
  assert.equal(result.role, null);
});


test('persistent work recommends exactly one role and requires confirmation', () => {
  const cases = [
    ['product', 'product-architect', 'suggest-product-architect'],
    ['implementation', 'fullstack', 'suggest-fullstack'],
    ['review', 'reviewer', 'suggest-reviewer'],
  ];
  for (const [work, role, action] of cases) {
    const result = activationDecision({ continuity: 'persistent', work });
    assert.equal(result.status, 'claim-suggested');
    assert.equal(result.role, role);
    assert.equal(result.action, action);
    assert.equal(result.confirmationRequired, true);
  }
});


test('persistent mixed or unknown ownership does not guess a durable role', () => {
  for (const work of ['mixed', 'unknown']) {
    const result = activationDecision({ continuity: 'persistent', work });
    assert.equal(result.action, 'stay-ephemeral');
    assert.equal(result.role, null);
    assert.match(result.reasons[0], /do not guess/);
  }
});


test('an existing binding always wins over new classification pressure', () => {
  const result = activationDecision({
    binding: { agentId: 'fullstack-01', role: 'fullstack' },
    continuity: 'persistent',
    work: 'product',
  });
  assert.equal(result.status, 'bound');
  assert.equal(result.action, 'resume-existing-identity');
  assert.equal(result.agentId, 'fullstack-01');
  assert.equal(result.role, 'fullstack');
  assert.equal(result.confirmationRequired, false);
});


test('invalid semantic observations are refused rather than widened', () => {
  assert.throws(
    () => activationDecision({ continuity: 'probably', work: 'review' }),
    (error) => error instanceof ActivationError && error.code === 'INVALID_ACTIVATION_INPUT',
  );
});
