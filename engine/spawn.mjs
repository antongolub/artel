#!/usr/bin/env node
// High-level dispatch CLI. Parses argv/stdin and delegates the actual dispatch
// lifecycle to dispatch_lifecycle.mjs.
//
// Universal terms (DESIGN.md §5): --model / --effort / --sandbox / --tools /
// --permission-mode propagate to run.mjs and through to drivers.

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
    'Usage: node $ARTEL_HOME/engine/spawn.mjs <role> <task-slug> [options] (-p "prompt" | -f file | < stdin)',
  )
  console.error('')
  console.error('Options:')
  console.error('  --engine <name>            override engine driver')
  console.error('  --model <name>             override model')
  console.error('  --effort <level>           reasoning effort (codex)')
  console.error('  --sandbox <mode>           read-only|workspace-write|full-access')
  console.error('  --tools <list>             tool allowlist (comma-sep)')
  console.error('  --permission-mode <mode>   permission mode (claude)')
  console.error('  --timeout-ms <n>           dispatch wall-clock timeout')
  console.error('  --retry-of <dispatch_id>   mark this as retry of <id>')
  console.error('  --attrs <json>             merge JSON object into task attrs')
  console.error('  --attrs-file <path>        merge JSON file into task attrs')
  console.error('  --attr key=value           set single task attr')
  console.error(
    `default timeout: ${defaultDispatchTimeoutMs}ms (override with --timeout-ms or ARTEL_DISPATCH_TIMEOUT_MS)`,
  )
  process.exit(code)
}

const argv = process.argv.slice(2)
if (argv.length < 2 || argv[0] === '-h' || argv[0] === '--help') usage(argv[0] ? 0 : 2)

const [role, task, ...rest] = argv
let engine = null
let prompt = null
let taskAttrs = null
let model = null
let effort = null
let sandbox = null
let tools = null
let permissionMode = null
let timeoutMs = null
let retryOf = null

for (let i = 0; i < rest.length; i++) {
  if (rest[i] === '--engine' && rest[i + 1]) engine = rest[++i]
  else if (rest[i] === '-p' && rest[i + 1]) prompt = rest[++i]
  else if (rest[i] === '-f' && rest[i + 1]) prompt = readFileSync(rest[++i], 'utf8')
  else if (rest[i] === '--model' && rest[i + 1]) model = rest[++i]
  else if (rest[i] === '--effort' && rest[i + 1]) effort = rest[++i]
  else if (rest[i] === '--codex-effort' && rest[i + 1]) {
    // Deprecated alias for --effort. Kept for one cycle of back-compat.
    console.error('warning: --codex-effort is deprecated; use --effort')
    effort = rest[++i]
  }
  else if (rest[i] === '--sandbox' && rest[i + 1]) sandbox = rest[++i]
  else if (rest[i] === '--tools' && rest[i + 1]) tools = rest[++i]
  else if (rest[i] === '--permission-mode' && rest[i + 1]) permissionMode = rest[++i]
  else if (rest[i] === '--timeout-ms' && rest[i + 1]) timeoutMs = rest[++i]
  else if (rest[i] === '--retry-of' && rest[i + 1]) retryOf = rest[++i]
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
    model,
    effort,
    sandbox,
    tools,
    permissionMode,
    retryOf,
    timeoutMs,
  })
  process.exit(result.exitCode)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
