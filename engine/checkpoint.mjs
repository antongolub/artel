#!/usr/bin/env node
// Sub-role self-reporting CLI. Called by a dispatched sub-role between
// phases of its work to record progress. Appends a `checkpoint` event
// (kind=workload) with last_completed_step / next_safe_step / artefact /
// notes. See DESIGN.md §9.
//
// Required env (auto-set by run.mjs when launching a sub-role):
//   ARTEL_TASK, ARTEL_ROLE, ARTEL_DISPATCH_ID, ARTEL_TRACE_ID
//
// Usage:
//   node $ARTEL_HOME/engine/checkpoint.mjs \
//     --completed "parsed registry feed" \
//     --next "validate against schema" \
//     [--artefact path] [--notes "..."]

import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { SCHEMA_VERSION, uuidv7, validateEventType } from './schema.mjs'
import { ensureClusterIdentity, instanceId } from './cluster.mjs'

const usage = (code = 2) => {
  console.error(
    'Usage: node $ARTEL_HOME/engine/checkpoint.mjs --completed <text> --next <text> [--artefact <path>] [--notes <text>]',
  )
  console.error('Reads task/role/dispatch_id/trace_id from ARTEL_* env (auto-set by run.mjs).')
  process.exit(code)
}

const argv = process.argv.slice(2)
if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') usage(argv[0] ? 0 : 2)

let completed = null
let next = null
let artefact = null
let notes = null
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--completed' && argv[i + 1]) completed = argv[++i]
  else if (argv[i] === '--next' && argv[i + 1]) next = argv[++i]
  else if (argv[i] === '--artefact' && argv[i + 1]) artefact = argv[++i]
  else if (argv[i] === '--notes' && argv[i + 1]) notes = argv[++i]
}

if (!completed || !next) {
  console.error('checkpoint: --completed and --next are required')
  usage(2)
}

const task = process.env.ARTEL_TASK
const role = process.env.ARTEL_ROLE
const dispatchId = process.env.ARTEL_DISPATCH_ID
const traceId = process.env.ARTEL_TRACE_ID || dispatchId

if (!task || !role || !dispatchId) {
  console.error('checkpoint: required env vars missing (ARTEL_TASK / ARTEL_ROLE / ARTEL_DISPATCH_ID).')
  console.error('Are you running inside a dispatched sub-role? checkpoint.mjs is meant to be invoked from within a dispatch.')
  process.exit(2)
}

const PROJECT_DIR = process.env.ARTEL_PROJECT_DIR || process.cwd()
const PROJECT_ARTEL = join(PROJECT_DIR, '.artel')
const EVENTS_PATH = join(PROJECT_ARTEL, 'events.jsonl')

const cluster = ensureClusterIdentity(PROJECT_ARTEL)

const event = {
  schema: SCHEMA_VERSION,
  kind: 'workload',
  type: 'checkpoint',
  id: uuidv7(),
  at: new Date().toISOString(),
  cluster_id: cluster.cluster_id,
  instance_id: instanceId(),
  task,
  dispatch_id: dispatchId,
  trace_id: traceId,
  fence_token: 0,
  owner_role: role,
  last_completed_step: completed,
  next_safe_step: next,
  ...(artefact ? { artefact } : {}),
  ...(notes ? { notes } : {}),
}
validateEventType(event.kind, event.type)

mkdirSync(dirname(EVENTS_PATH), { recursive: true })
appendFileSync(EVENTS_PATH, JSON.stringify(event) + '\n')
console.log(`checkpoint: ${task} → ${next}`)
