#!/usr/bin/env node
// `artel replay <task | dispatch-id>` — re-run a past dispatch.
//
// Resolves the target by task slug (most-recent dispatch with that
// slug) or UUID v7 dispatch_id; pulls role + engine + model + prompt
// from the original `.meta` and `.prompt` sidecars; spawns a new
// dispatch with `--retry-of` set to the original dispatch_id (so the
// retry chain reconstructs from events.jsonl).
//
// Common use: re-run a parked or failed dispatch on a different engine.
//   artel replay broken-task --engine claude
// Or: rerun on the same engine to see if the failure is sticky.
//   artel replay broken-task

import { existsSync, readFileSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parseArgs } from 'node:util'
import { listDispatches } from '../core/dispatches.mjs'
import { config } from '../config/env.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const SPAWN_PATH = join(here, 'spawn.mjs')

const DISPATCHES_DIR = config.dispatchesDir

const usage = (code = 2) => {
  console.error(`\
Usage: artel replay <task-slug | dispatch-id> [options]

Re-runs a past dispatch — re-uses original role + prompt, spawns under a
new task slug (auto: <original>-replay-<short>), wires --retry-of to the
original dispatch_id so the retry chain is reconstructible.

Options:
  --engine <name>      override engine for the replay (default: original engine)
  --model <name>       override model (default: original model)
  --task <slug>        override the auto-generated replay task slug
  --effort <level>     reasoning effort (codex)
  --sandbox <mode>     read-only|workspace-write|full-access
  --tools <list>       tool allowlist (comma-sep)
  --permission-mode    permission mode (claude)
  --timeout-ms <n>     dispatch wall-clock timeout
  -h, --help           this`)
  process.exit(code)
}

let values, positionals
try {
  ({ values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      engine: { type: 'string' },
      model: { type: 'string' },
      task: { type: 'string' },
      effort: { type: 'string' },
      sandbox: { type: 'string' },
      tools: { type: 'string' },
      'permission-mode': { type: 'string' },
      'timeout-ms': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
  }))
} catch (err) {
  console.error(err.message)
  usage(2)
}

if (values.help) usage(0)
if (positionals.length !== 1) usage(2)
const target = positionals[0]

// --- resolve target dispatch ---

const isUuidV7 = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)

const resolveTarget = (arg) => {
  const lookupByDispatchId = isUuidV7(arg)
  const all = listDispatches(DISPATCHES_DIR)
  if (lookupByDispatchId) {
    const hit = all.find(({ meta }) => meta.dispatchId === arg)
    return hit ? { meta: hit.meta, stem: hit.stem } : null
  }
  const candidates = all
    .filter(({ meta }) => meta.task === arg)
    .map(({ meta, stem, path }) => ({ meta, stem, mtime: statSync(path).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
  return candidates[0] ? { meta: candidates[0].meta, stem: candidates[0].stem } : null
}

const found = resolveTarget(target)
if (!found) {
  const what = isUuidV7(target) ? 'dispatch_id' : 'task slug'
  console.error(`No dispatch found for ${what} '${target}' under ${DISPATCHES_DIR}`)
  process.exit(1)
}

// --- build new spawn invocation ---

const { meta, stem } = found
const promptPath = join(DISPATCHES_DIR, `${stem}.prompt`)
if (!existsSync(promptPath)) {
  console.error(`Original prompt sidecar not found at ${promptPath} — cannot replay (likely a pre-V1 dispatch)`)
  process.exit(1)
}
const prompt = readFileSync(promptPath, 'utf8')

if (!meta.role) {
  console.error(`Original dispatch ${meta.dispatchId || stem} has no role recorded — cannot replay`)
  process.exit(1)
}

// Auto-generated replay slug: original task + short tail of original
// dispatch_id (or stem) for disambiguation, plus a fresh tail so multiple
// replays don't collide.
const shortTail = (s) => (s || '').replace(/[^0-9a-f]/gi, '').slice(-6) || 'r'
const newTask = values.task
  || `${meta.task || stem}-replay-${shortTail(meta.dispatchId || stem)}`

const engine = values.engine || meta.engine
const model = values.model || meta.model

console.error(`replay: ${meta.task || stem} ${meta.engine || '?'}${meta.model ? ' (' + meta.model + ')' : ''} → ${newTask}${engine !== meta.engine ? ` ${engine || ''}` : ''}${model && model !== meta.model ? ' (' + model + ')' : ''}`)

const args = [SPAWN_PATH, meta.role, newTask, '-p', prompt]
if (engine) args.push('--engine', engine)
if (model) args.push('--model', model)
if (values.effort) args.push('--effort', values.effort)
if (values.sandbox) args.push('--sandbox', values.sandbox)
if (values.tools) args.push('--tools', values.tools)
if (values['permission-mode']) args.push('--permission-mode', values['permission-mode'])
if (values['timeout-ms']) args.push('--timeout-ms', values['timeout-ms'])
if (meta.dispatchId) args.push('--retry-of', meta.dispatchId)

const r = spawnSync(process.execPath, args, { stdio: 'inherit' })
process.exit(r.status ?? 1)
