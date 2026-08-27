export const CONTINUITY_VALUES = ['one-off', 'persistent', 'unknown'];
export const WORK_VALUES = ['product', 'implementation', 'review', 'mixed', 'unknown'];
export const ACTIVATION_ACTIONS = [
  'resume-existing-identity',
  'stay-ephemeral',
  'suggest-product-architect',
  'suggest-fullstack',
  'suggest-reviewer',
];

export class ActivationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ActivationError';
    this.code = code;
  }
}

function assertOneOf(name, value, allowed) {
  if (!allowed.includes(value)) {
    throw new ActivationError(
      'INVALID_ACTIVATION_INPUT',
      `${name} must be one of ${allowed.join(', ')}, got ${JSON.stringify(value)}`,
    );
  }
}

const ROLE_FOR_WORK = {
  product: 'product-architect',
  implementation: 'fullstack',
  review: 'reviewer',
};

/**
 * Decide whether an unbound window should remain ephemeral or propose one durable role.
 *
 * This function deliberately does not inspect natural language and never writes identity state.
 * The Agent/harness owns the semantic observation (`continuity` and `work`); this module owns the
 * irreversible-policy boundary: no persistence without continuity value, no role guessing, and no
 * role switching once a worktree is bound.
 */
export function activationDecision({
  binding = null,
  continuity = 'unknown',
  work = 'unknown',
} = {}) {
  if (binding) {
    if (typeof binding.agentId !== 'string' || binding.agentId === '' || typeof binding.role !== 'string' || binding.role === '') {
      throw new ActivationError('INVALID_BINDING', 'binding must include non-empty agentId and role');
    }
    return {
      status: 'bound',
      action: 'resume-existing-identity',
      role: binding.role,
      agentId: binding.agentId,
      confirmationRequired: false,
      reasons: [
        `this worktree is already bound to ${binding.agentId} as ${binding.role}; activation never reclassifies a durable identity`,
      ],
    };
  }

  assertOneOf('continuity', continuity, CONTINUITY_VALUES);
  assertOneOf('work', work, WORK_VALUES);

  if (continuity === 'one-off') {
    return {
      status: 'ephemeral',
      action: 'stay-ephemeral',
      role: null,
      agentId: null,
      confirmationRequired: false,
      reasons: ['the work is one-off; durable identity would add ceremony without continuity value'],
    };
  }

  if (continuity === 'unknown') {
    return {
      status: 'ephemeral',
      action: 'stay-ephemeral',
      role: null,
      agentId: null,
      confirmationRequired: false,
      reasons: ['long-term continuity value is not established; the safe default is ephemeral'],
    };
  }

  const role = ROLE_FOR_WORK[work] ?? null;
  if (!role) {
    return {
      status: 'ephemeral',
      action: 'stay-ephemeral',
      role: null,
      agentId: null,
      confirmationRequired: false,
      reasons: [
        'the work is worth persisting, but role ownership is mixed or unknown; do not guess a durable role',
      ],
    };
  }

  return {
    status: 'claim-suggested',
    action: `suggest-${role}`,
    role,
    agentId: null,
    confirmationRequired: true,
    reasons: [
      `the work has durable continuity value and its primary ownership maps cleanly to ${role}`,
      'activation is advisory only; claim the role with setup only after the user accepts the recommendation',
    ],
  };
}
