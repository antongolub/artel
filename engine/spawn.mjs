#!/usr/bin/env node
// High-level dispatch CLI. Parses argv/stdin and delegates the actual dispatch
// lifecycle to dispatch_lifecycle.mjs.

import { readFileSync } from 'node:fs'
import {
  defaultDispatchTimeoutMs,
  dispatchLifecycle,
} from './dispatch_lifecycle.mjs'
import {
  mergeTaskAttrs,
  parseJsonObject,
  parseTaskAttrAssignment,
} from './dispatch_api.mjs'

const usage = (code = 2) => {
  console.error(
    'Usage: node collab/engine/spawn.mjs <role> <task-slug> [--engine <name>] [--codex-effort <value>] [--timeout-ms <n>] [--attrs <json>] -p "prompt"',
  )
  console.error(
    '       node collab/engine/spawn.mjs <role> <task-slug> [--engine <name>] [--codex-effort <value>] [--timeout-ms <n>] [--attrs-file file.json] -f <prompt-file>',
  )
  console.error(
    '       node collab/engine/spawn.mjs <role> <task-slug> [--engine <name>] [--codex-effort <value>] [--timeout-ms <n>] [--attr key=value] < prompt-stdin',
  )
  console.error(
    `       default timeout: ${defaultDispatchTimeoutMs}ms (override with --timeout-ms or COLLAB_DISPATCH_TIMEOUT_MS)`,
  )
  process.exit(code)
}

const argv = process.argv.slice(2)
if (argv.length < 2 || argv[0] === '-h' || argv[0] === '--help') usage(argv[0] ? 0 : 2)

const [role, task, ...rest] = argv
let engine = null
let prompt = null
let taskAttrs = null
let codexEffort = null
let timeoutMs = null

for (let i = 0; i < rest.length; i++) {
  if (rest[i] === '--engine' && rest[i + 1]) engine = rest[++i]
  else if (rest[i] === '-p' && rest[i + 1]) prompt = rest[++i]
  else if (rest[i] === '-f' && rest[i + 1]) prompt = readFileSync(rest[++i], 'utf8')
  else if (rest[i] === '--codex-effort' && rest[i + 1]) codexEffort = rest[++i]
  else if (rest[i] === '--timeout-ms' && rest[i + 1]) timeoutMs = rest[++i]
  else if (rest[i] === '--attrs' && rest[i + 1]) taskAttrs = mergeTaskAttrs(taskAttrs, parseJsonObject(rest[++i], '--attrs'))
  else if (rest[i] === '--attrs-file' && rest[i + 1]) {
    taskAttrs = mergeTaskAttrs(taskAttrs, parseJsonObject(readFileSync(rest[++i], 'utf8'), '--attrs-file'))
  } else if (rest[i] === '--attr' && rest[i + 1]) taskAttrs = mergeTaskAttrs(taskAttrs, parseTaskAttrAssignment(rest[++i]))
}

if (prompt === null) {
  if (process.stdin.isTTY) {
    console.error('No prompt provided (use -p / -f / stdin)')
    usage(1)
  }
  prompt = readFileSync(0, 'utf8')
}

try {
  const result = await dispatchLifecycle({
    role,
    task,
    engine,
    prompt,
    taskAttrs,
    codexEffort,
    timeoutMs,
  })
  process.exit(result.exitCode)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
