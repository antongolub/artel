// Pipeline handler builtins (V3.7.a + V3.7.c + V3.7.d).
//
// Handlers are pipeline nodes that perform a platform action without
// dispatching an LLM. They share the same edge-routing machinery as
// `dispatch` (disposition flows through `on_disposition` edges) but
// don't go through `dispatchLifecycle` — no role, no engine, no
// worktree, no `.meta` sidecar.
//
// Each builtin is a small async function `(node, ctx) =>
// { disposition, exitCode?, signal?, durationMs?, error? }`. Add a
// new builtin = register its name in `VALID_HANDLERS`
// (engine/util/pipelines.mjs) AND its implementation in the BUILTINS
// map below.
//
// `ctx`:
//   { projectDir, attrs }
// `attrs` is the merged blob the walker also exposes as `task_attrs`
// for dispatches (user `--attrs` + pipeline-injected ids). Builtins
// that read from the run state use it; `builtin.exec` ignores it.
//
// V3.7.a shipped `builtin.exec`. V3.7.c added `builtin.assert`.
// V3.7.d adds `builtin.set_attr`. `builtin.git_squash`,
// `builtin.git_merge` deferred.
//
// Mutation contract (V3.7.d): a builtin returns `{ ..., attrs: {…} }`
// to ask the walker to merge new attrs into the run state.
// Walker shallow-merges over `userAttrs` so subsequent dispatches /
// conditions / asserts see the change. Pipeline-injected ids
// (pipeline_run_id, pipeline_id, pipeline_node_id) are respread per
// step regardless, so a builtin can't actually override them — but
// the validator rejects reserved keys for clarity.

import { spawn } from 'node:child_process'
import { evaluatePredicate, renderTemplate } from './pipelines.mjs'

// builtin.exec: run a shell command via `bash -c`. Disposition is
// `success` on exit 0, `error` on non-zero, `timeout` if
// `node.timeout_ms` elapses (SIGTERM the child). stdout/stderr go
// straight to the parent's tty — operator sees the command output
// inline with the walker's progress.
//
// `bash -c` so quoting / piping / && in the cmd just works the way
// operators expect. The trade-off: no shell-injection guard. Handler
// cmds come from the pipeline definition file, which the operator
// authored — same trust model as a Makefile or package.json script.
const execBuiltin = (node, ctx) => new Promise((resolve) => {
  const start = Date.now()
  const child = spawn('bash', ['-c', node.cmd], {
    cwd: ctx.projectDir,
    stdio: 'inherit',
    env: process.env,
  })

  let timedOut = false
  let timeoutHandle = null
  if (node.timeout_ms) {
    timeoutHandle = setTimeout(() => {
      timedOut = true
      try { child.kill('SIGTERM') } catch {}
    }, node.timeout_ms)
  }

  child.on('error', (err) => {
    if (timeoutHandle) clearTimeout(timeoutHandle)
    resolve({
      disposition: 'error',
      exitCode: null,
      signal: null,
      durationMs: Date.now() - start,
      error: err.message,
    })
  })

  child.on('exit', (code, signal) => {
    if (timeoutHandle) clearTimeout(timeoutHandle)
    const durationMs = Date.now() - start
    if (timedOut) {
      resolve({ disposition: 'timeout', exitCode: code, signal, durationMs })
      return
    }
    resolve({
      disposition: code === 0 ? 'success' : 'error',
      exitCode: code,
      signal,
      durationMs,
    })
  })
})

// builtin.assert (V3.7.c): evaluate `node.if` (V3.6 predicate
// vocabulary — atomic or compound, recursive) against `ctx.attrs`.
// `success` on true, `error` on false. Optional `node.message`
// (template-rendered against `ctx.attrs`) lands in the `error`
// field of the result so it surfaces in pipeline_handler.end as
// forensic context.
//
// Synchronous (no I/O), but wrapped to match the async signature.
// durationMs is set even though it's basically zero — keeps the
// shape consistent with builtin.exec for downstream consumers.
const assertBuiltin = async (node, ctx) => {
  const start = Date.now()
  const attrs = ctx.attrs || {}
  const passed = evaluatePredicate(node.if, attrs)
  if (passed) {
    return { disposition: 'success', durationMs: Date.now() - start }
  }
  // Render message lazily — only on the failure path. Bad templates
  // (missing attr, etc.) surface as the error itself rather than
  // crashing the walker.
  let renderedMessage = null
  if (node.message) {
    try {
      renderedMessage = renderTemplate(node.message, attrs)
    } catch (err) {
      renderedMessage = `[message render failed: ${err.message}]`
    }
  }
  return {
    disposition: 'error',
    durationMs: Date.now() - start,
    error: renderedMessage || 'assertion failed',
  }
}

// builtin.set_attr (V3.7.d): mutate run attrs that flow downstream.
// `node.set` is a flat object of { key: scalar | null }; string
// values get V3.5 template-rendered against `ctx.attrs` before
// merge. Validator already enforced the shape (top-level keys,
// scalar/null values, no reserved-key overrides).
//
// Atomic: all values are computed first, then returned together.
// If any string value's template render throws (missing attr,
// non-scalar value), disposition flips to error and no partial
// mutation reaches the walker.
const setAttrBuiltin = async (node, ctx) => {
  const start = Date.now()
  const attrs = ctx.attrs || {}
  const resolved = {}
  for (const [key, raw] of Object.entries(node.set)) {
    if (typeof raw === 'string') {
      try {
        resolved[key] = renderTemplate(raw, attrs)
      } catch (err) {
        return {
          disposition: 'error',
          durationMs: Date.now() - start,
          error: `set_attr: render of .set['${key}'] failed: ${err.message}`,
        }
      }
    } else {
      resolved[key] = raw
    }
  }
  return {
    disposition: 'success',
    durationMs: Date.now() - start,
    attrs: resolved,    // walker merges over userAttrs
    set_resolved: resolved, // for the end-event payload
  }
}

const BUILTINS = {
  'builtin.exec': execBuiltin,
  'builtin.assert': assertBuiltin,
  'builtin.set_attr': setAttrBuiltin,
}

// Run a handler node. `ctx.projectDir` is the project root —
// handlers run there, not in worktrees (handlers don't isolate to a
// branch the way dispatches do).
export const runHandler = async (node, ctx) => {
  const fn = BUILTINS[node.handler]
  if (!fn) {
    throw new Error(`Unknown handler: ${node.handler}`)
  }
  return fn(node, ctx)
}

export const knownHandlers = () => Object.keys(BUILTINS).sort()
