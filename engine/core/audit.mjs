// Append-only event helper for entries emitted from non-dispatch
// contexts (CLI mutators, maintenance tools, queue graph operations).
//
// Dispatch lifecycle uses createDispatchApi — that path attaches
// dispatch_id / trace_id / fence_token automatically. CLI commands
// (artel trust / sweep / queue / etc.) need a lower-friction surface;
// this module wraps the baseline-fields boilerplate.

import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { SCHEMA_VERSION, validateEventType } from './schema.mjs'
import { ensureClusterIdentity, instanceId as getInstanceId } from './cluster.mjs'
import { uuidv7 } from '../util/ids.mjs'

// Shared envelope writer. `kind` may be infra | workload | signal |
// control. Workload events get fence_token: 0 (V1 federation
// reservation; enforcement deferred). Bootstraps cluster identity if
// absent so events land cleanly on fresh projects.
const writeEvent = (projectDir, kind, type, payload = {}) => {
  const projectArtelDir = join(projectDir, '.artel')
  const eventsPath = join(projectArtelDir, 'events.jsonl')
  const cluster = ensureClusterIdentity(projectArtelDir)
  const event = {
    schema: SCHEMA_VERSION,
    kind,
    type,
    id: uuidv7(),
    at: new Date().toISOString(),
    cluster_id: cluster.cluster_id,
    instance_id: getInstanceId(),
    ...(kind === 'workload' ? { fence_token: 0 } : {}),
    ...payload,
  }
  validateEventType(event.kind, event.type)
  mkdirSync(dirname(eventsPath), { recursive: true })
  appendFileSync(eventsPath, JSON.stringify(event) + '\n')
  return event
}

export const appendInfraEvent = (projectDir, type, payload = {}) =>
  writeEvent(projectDir, 'infra', type, payload)

export const appendWorkloadEvent = (projectDir, type, payload = {}) =>
  writeEvent(projectDir, 'workload', type, payload)
