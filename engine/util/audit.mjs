// Append-only audit helper for events.jsonl entries emitted from
// non-dispatch contexts (CLI mutators, maintenance tools).
//
// Dispatch lifecycle uses createDispatchApi — that path attaches
// dispatch_id / trace_id / fence_token automatically. Trust mutators
// and similar one-shot CLIs need a lower-friction surface; this
// module wraps the baseline-fields boilerplate.

import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { SCHEMA_VERSION, validateEventType } from '../core/schema.mjs'
import { ensureClusterIdentity, instanceId as getInstanceId } from '../core/cluster.mjs'
import { uuidv7 } from './ids.mjs'

// Append an `infra` event to .artel/events.jsonl. Bootstraps cluster
// identity if absent (so audit lands cleanly on a fresh project).
// `payload` is shallow-merged with the standard envelope — schema /
// kind / type / id / at / cluster_id / instance_id always come from
// the helper.
export const appendInfraEvent = (projectDir, type, payload = {}) => {
  const projectArtelDir = join(projectDir, '.artel')
  const eventsPath = join(projectArtelDir, 'events.jsonl')
  const cluster = ensureClusterIdentity(projectArtelDir)
  const event = {
    schema: SCHEMA_VERSION,
    kind: 'infra',
    type,
    id: uuidv7(),
    at: new Date().toISOString(),
    cluster_id: cluster.cluster_id,
    instance_id: getInstanceId(),
    ...payload,
  }
  validateEventType(event.kind, event.type)
  mkdirSync(dirname(eventsPath), { recursive: true })
  appendFileSync(eventsPath, JSON.stringify(event) + '\n')
  return event
}
