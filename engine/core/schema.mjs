// Event schema v1 — version constant, validators, reserved namespaces.
// See DESIGN.md §4 (event taxonomy) for the full rationale.
//
// Generic id helpers (`uuidv7`, `nonce`) live in ../util/ids.mjs.

export const SCHEMA_VERSION = 'v1'

export const VALID_KINDS = new Set(['workload', 'infra', 'signal', 'control'])

// Reserved type prefixes per kind (DESIGN.md §4.4–4.7). Validator rejects
// unknown types: avoids silent typos, future-proofs against schema-drift.
//
// Entries ending with '.' match by prefix; bare entries match exactly.
// Legacy aliases (`claim`, `release`) are kept for one back-compat cycle —
// dropped after C4's rename window closes.
export const RESERVED_TYPE_PREFIXES = {
  workload: [
    'dispatch.',
    'checkpoint',
    'heartbeat',
    'parked',
    'unparked',
    'escalation',
    'review-result',
    'superseded',
    'owner-answer',
    'queue_node.',
    'queue_edge.',
    'pipeline.',
    'pipeline_run.',
    // legacy (one cycle)
    'claim',
    'release',
  ],
  infra: [
    'cluster.',
    'role.',
    'engine.',
    'model.',
    'policy.',
    'trust.',
  ],
  signal: [
    'signal.',
  ],
  control: [
    'control.',
  ],
}

export function validateEventType (kind, type) {
  if (!VALID_KINDS.has(kind)) {
    throw new Error(`Invalid event kind: "${kind}" (valid: ${[...VALID_KINDS].join(', ')})`)
  }
  const prefixes = RESERVED_TYPE_PREFIXES[kind]
  const matches = prefixes.some((p) =>
    p.endsWith('.') ? type.startsWith(p) : type === p,
  )
  if (!matches) {
    throw new Error(
      `Event type "${type}" not in reserved prefixes for kind "${kind}". ` +
      `Add to RESERVED_TYPE_PREFIXES in engine/core/schema.mjs first.`,
    )
  }
}
