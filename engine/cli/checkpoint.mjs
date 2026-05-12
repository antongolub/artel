#!/usr/bin/env node
// Sub-role self-reporting CLI. Called by a dispatched sub-role between
// phases to record progress. Appends a `checkpoint` event with
// last_completed_step / next_safe_step / artefact / notes (DESIGN.md §9).
//
// Required env (auto-set by 'artel run' when launching a sub-role):
//   ARTEL_TASK, ARTEL_ROLE, ARTEL_DISPATCH_ID, ARTEL_TRACE_ID

import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { parseArgs } from 'node:util'
import { SCHEMA_VERSION, validateEventType } from '../core/schema.mjs'
import { ensureClusterIdentity, instanceId } from '../core/cluster.mjs'
import { uuidv7 } from '../util/ids.mjs'
import { config, dispatchEnv } from '../config/env.mjs'

const usage = (code = 2) => {
  console.error(`\
Usage: artel checkpoint --completed <text> --next <text> [--artefact <path>] [--notes <text>]
Reads task / role / dispatch_id / trace_id from ARTEL_* env (auto-set by 'artel run').`)
  process.exit(code)
}

let values
try {
  ({ values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      completed: { type: 'string' },
      next: { type: 'string' },
      artefact: { type: 'string' },
      notes: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  }))
} catch (err) {
  console.error(err.message)
  usage(2)
}

if (values.help) usage(0)
if (!values.completed || !values.next) {
  console.error('checkpoint: --completed and --next are required')
  usage(2)
}

const ctx = dispatchEnv()
if (!ctx.task || !ctx.role || !ctx.dispatchId) {
  console.error(`\
checkpoint: required env vars missing (ARTEL_TASK / ARTEL_ROLE / ARTEL_DISPATCH_ID).
Are you running inside a dispatched sub-role? 'artel checkpoint' is meant to
be invoked from within a dispatch.`)
  process.exit(2)
}

const eventsPath = config.eventsPath
const cluster = ensureClusterIdentity(config.artelDir)

const event = {
  schema: SCHEMA_VERSION,
  kind: 'workload',
  type: 'checkpoint',
  id: uuidv7(),
  at: new Date().toISOString(),
  cluster_id: cluster.cluster_id,
  instance_id: instanceId(),
  task: ctx.task,
  dispatch_id: ctx.dispatchId,
  trace_id: ctx.traceId || ctx.dispatchId,
  fence_token: 0,
  owner_role: ctx.role,
  last_completed_step: values.completed,
  next_safe_step: values.next,
  ...(values.artefact ? { artefact: values.artefact } : {}),
  ...(values.notes ? { notes: values.notes } : {}),
}
validateEventType(event.kind, event.type)

mkdirSync(dirname(eventsPath), { recursive: true })
appendFileSync(eventsPath, JSON.stringify(event) + '\n')
console.log(`checkpoint: ${ctx.task} → ${values.next}`)
