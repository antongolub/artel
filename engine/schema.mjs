// Event schema v1 — validators, UUID v7 generator, reserved namespaces.
// See DESIGN.md §4 (event taxonomy) for the full rationale.

import { randomBytes } from 'node:crypto'

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
  ],
  signal: [
    'signal.',
  ],
  control: [
    'control.',
  ],
}

// UUID v7: 48-bit unix-ms timestamp + 4-bit version + 12 bits + 2-bit
// variant + 62 bits random. Time-prefix gives lexicographic sort = causal
// order; collision resistance dominated by 74 random bits — sufficient
// for our scale.
export function uuidv7 () {
  const ms = Date.now()
  const random = randomBytes(10)
  const buf = Buffer.alloc(16)
  buf.writeUIntBE(ms, 0, 6)
  buf[6] = 0x70 | (random[0] & 0x0f)
  buf[7] = random[1]
  buf[8] = 0x80 | (random[2] & 0x3f)
  buf[9] = random[3]
  random.copy(buf, 10, 4, 10)
  const hex = buf.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
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
      `Add to RESERVED_TYPE_PREFIXES in engine/schema.mjs first.`,
    )
  }
}
