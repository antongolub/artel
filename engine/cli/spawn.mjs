#!/usr/bin/env node
// High-level dispatch CLI. Parses argv/stdin and delegates to dispatchLifecycle.
//
// Universal terms (DESIGN.md §5): --model / --effort / --sandbox / --tools /
// --permission-mode propagate through to drivers.

import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { defaultDispatchTimeoutMs, dispatchLifecycle } from '../core/dispatch_lifecycle.mjs'
import { mergeTaskAttrs, parseJsonObject, parseTaskAttrAssignment } from '../core/dispatch_api.mjs'

const usage = (code = 2) => {
  console.error(`\
Usage: artel spawn <role> <task-slug> [options] (-p "prompt" | -f file | < stdin)

Options:
  --engine <name>            override engine driver
  --model <name>             override model
  --effort <level>           reasoning effort (codex)
  --sandbox <mode>           read-only|workspace-write|full-access
  --tools <list>             tool allowlist (comma-sep)
  --permission-mode <mode>   permission mode (claude)
  --timeout-ms <n>           dispatch wall-clock timeout
  --retry-of <dispatch_id>   mark this as retry of <id>
  --identity <name>          git identity from .artel/trust/identities.json
  --worktree                 run dispatch in .artel/.worktrees/<branch>/ instead of
                              the operator's main checkout (V3.3)
  --keep-worktree            keep the worktree even on success (default: remove)
  --attrs <json>             merge JSON object into task attrs
  --attrs-file <path>        merge JSON file into task attrs
  --attr key=value           set single task attr (repeatable)

default timeout: ${defaultDispatchTimeoutMs}ms (override with --timeout-ms or ARTEL_DISPATCH_TIMEOUT_MS)`)
  process.exit(code)
}

const OPTIONS = {
  engine: { type: 'string' },
  p: { type: 'string', short: 'p' },
  f: { type: 'string', short: 'f' },
  model: { type: 'string' },
  effort: { type: 'string' },
  'codex-effort': { type: 'string' }, // deprecated alias
  sandbox: { type: 'string' },
  tools: { type: 'string' },
  'permission-mode': { type: 'string' },
  'timeout-ms': { type: 'string' },
  'retry-of': { type: 'string' },
  identity: { type: 'string' },
  worktree: { type: 'boolean' },
  'keep-worktree': { type: 'boolean' },
  attrs: { type: 'string', multiple: true },
  'attrs-file': { type: 'string', multiple: true },
  attr: { type: 'string', multiple: true },
  help: { type: 'boolean', short: 'h' },
}

let values, positionals
try {
  ({ values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: OPTIONS,
    allowPositionals: true,
  }))
} catch (err) {
  console.error(err.message)
  usage(2)
}

if (values.help || positionals.length < 2) usage(values.help ? 0 : 2)

if (values['codex-effort'] && !values.effort) {
  console.error('warning: --codex-effort is deprecated; use --effort')
  values.effort = values['codex-effort']
}

const [role, task] = positionals

const promptFromFlag = values.p ?? (values.f ? readFileSync(values.f, 'utf8') : null)
const prompt = promptFromFlag !== null
  ? promptFromFlag
  : process.stdin.isTTY
    ? (console.error('No prompt provided (use -p / -f / stdin)'), usage(1))
    : readFileSync(0, 'utf8')

const taskAttrs = [
  ...(values.attrs || []).map((s) => parseJsonObject(s, '--attrs')),
  ...(values['attrs-file'] || []).map((p) => parseJsonObject(readFileSync(p, 'utf8'), '--attrs-file')),
  ...(values.attr || []).map(parseTaskAttrAssignment),
].reduce((acc, part) => mergeTaskAttrs(acc, part), null)

try {
  const result = await dispatchLifecycle({
    role,
    task,
    prompt,
    engine: values.engine ?? null,
    model: values.model ?? null,
    effort: values.effort ?? null,
    sandbox: values.sandbox ?? null,
    tools: values.tools ?? null,
    permissionMode: values['permission-mode'] ?? null,
    timeoutMs: values['timeout-ms'] ?? null,
    retryOf: values['retry-of'] ?? null,
    identity: values.identity ?? null,
    useWorktree: !!values.worktree,
    keepWorktreeOnSuccess: !!values['keep-worktree'],
    taskAttrs,
  })
  process.exit(result.exitCode)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
