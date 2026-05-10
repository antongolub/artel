// Pipeline handler builtins (V3.7.a + V3.7.c + V3.7.d + V3.7.f).
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
// V3.7.d added `builtin.set_attr`. V3.7.f adds `builtin.git_tag`.
// `builtin.git_squash`, `builtin.git_merge` deferred — they need
// merge-conflict + worktree-target design.
//
// Mutation contract (V3.7.d): a builtin returns `{ ..., attrs: {…} }`
// to ask the walker to merge new attrs into the run state.
// Walker shallow-merges over `userAttrs` so subsequent dispatches /
// conditions / asserts see the change. Pipeline-injected ids
// (pipeline_run_id, pipeline_id, pipeline_node_id) are respread per
// step regardless, so a builtin can't actually override them — but
// the validator rejects reserved keys for clarity.

import { spawn } from 'node:child_process'
import { evaluatePredicate, renderTemplate, writePath } from './pipelines.mjs'
import { parseDuration } from './proc.mjs'

// builtin.exec: run a shell command via `bash -c`. Disposition is
// `success` on exit 0, `error` on non-zero, `timeout` if
// `node.timeout_ms` elapses, `cancelled` if `ctx.abortSignal` fires
// (V3.7.e — for handlers in parallel branches that lose a race).
// stdout/stderr go straight to the parent's tty — operator sees the
// command output inline with the walker's progress.
//
// `bash -c` so quoting / piping / && in the cmd just works the way
// operators expect. The trade-off: no shell-injection guard. Handler
// cmds come from the pipeline definition file, which the operator
// authored — same trust model as a Makefile or package.json script.
//
// Cancel mechanics: SIGTERM immediately, then SIGKILL after
// `cancelGraceMs` (default 5000) if the child hasn't exited.
// Matches V3.3.c dispatch cancel semantics.
const EXEC_CANCEL_GRACE_MS = 5000

const execBuiltin = (node, ctx) => new Promise((resolve) => {
  const start = Date.now()
  const child = spawn('bash', ['-c', node.cmd], {
    cwd: ctx.projectDir,
    stdio: 'inherit',
    env: process.env,
  })

  let timedOut = false
  let cancelled = false
  let timeoutHandle = null
  let killHandle = null
  let abortHandler = null

  const cleanup = () => {
    if (timeoutHandle) clearTimeout(timeoutHandle)
    if (killHandle) clearTimeout(killHandle)
    if (ctx.abortSignal && abortHandler) {
      ctx.abortSignal.removeEventListener('abort', abortHandler)
    }
  }

  // V3.9.b — accept number (ms) or suffix-string. Validator already
  // enforced the shape at register; parseDuration here turns
  // either form into ms. null → no timeout.
  const timeoutMs = parseDuration(node.timeout_ms)
  if (timeoutMs) {
    timeoutHandle = setTimeout(() => {
      timedOut = true
      try { child.kill('SIGTERM') } catch {}
    }, timeoutMs)
  }

  if (ctx.abortSignal) {
    const triggerAbort = () => {
      if (cancelled) return
      cancelled = true
      try { child.kill('SIGTERM') } catch {}
      // SIGKILL backstop if the child ignores SIGTERM.
      killHandle = setTimeout(() => {
        try { child.kill('SIGKILL') } catch {}
      }, EXEC_CANCEL_GRACE_MS)
    }
    if (ctx.abortSignal.aborted) {
      triggerAbort()
    } else {
      abortHandler = triggerAbort
      ctx.abortSignal.addEventListener('abort', abortHandler, { once: true })
    }
  }

  child.on('error', (err) => {
    cleanup()
    resolve({
      disposition: 'error',
      exitCode: null,
      signal: null,
      durationMs: Date.now() - start,
      error: err.message,
    })
  })

  child.on('exit', (code, signal) => {
    cleanup()
    const durationMs = Date.now() - start
    // Cancel takes precedence over timeout if both fire — a race
    // where the abort beats the timeout still resolves to
    // `cancelled` (it's the explicit-intent disposition).
    if (cancelled) {
      resolve({ disposition: 'cancelled', exitCode: code, signal, durationMs })
      return
    }
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
// V3.7.d.b: keys can be dotted paths for nested mutation; optional
// `unset` array of dotted paths removes keys. String values still
// V3.5 template-rendered against `ctx.attrs` first; validator
// already enforced shape (scalar/null, non-reserved top segment,
// at least one of set/unset).
//
// Atomic: all values are computed first, then returned together.
// If any string value's template render throws (missing attr,
// non-scalar value), disposition flips to error and no partial
// mutation reaches the walker.
//
// Returns:
//   - `attrs` (nested object built via writePath) for deepMergeAttrs
//   - `set_resolved` (flat post-template view) for the end event
//   - `unsets` (verbatim copy of node.unset) for the walker to
//     `deletePath` against userAttrs
const setAttrBuiltin = async (node, ctx) => {
  const start = Date.now()
  const attrs = ctx.attrs || {}
  const resolved = {}     // nested form, ready for deepMergeAttrs
  const setResolved = {}  // flat post-template view for the event
  for (const [key, raw] of Object.entries(node.set || {})) {
    let val = raw
    if (typeof raw === 'string') {
      try {
        val = renderTemplate(raw, attrs)
      } catch (err) {
        return {
          disposition: 'error',
          durationMs: Date.now() - start,
          error: `set_attr: render of .set['${key}'] failed: ${err.message}`,
        }
      }
    }
    setResolved[key] = val
    writePath(resolved, key, val)
  }
  return {
    disposition: 'success',
    durationMs: Date.now() - start,
    attrs: resolved,         // walker deep-merges over userAttrs
    set_resolved: setResolved,
    unsets: Array.isArray(node.unset) ? [...node.unset] : [],
  }
}

// builtin.git_tag (V3.7.f): tag a commit in ctx.projectDir.
// Annotated by default (`message` required); pass `lightweight:
// true` to create a non-annotated tag without a message. `name` /
// `message` / optional `target` are V3.5 template-rendered against
// ctx.attrs. Disposition: success on git exit 0; error on duplicate
// tag, malformed name, missing target ref, or template render
// failure (validator already caught structural issues).
//
// Stderr is captured (not inherited) so the failure reason flows
// into the pipeline_handler.end event's `error` field for
// forensics. Stdout is ignored (git tag is silent on success).
const gitTagBuiltin = (node, ctx) => new Promise((resolve) => {
  const start = Date.now()
  const attrs = ctx.attrs || {}
  let name, message, target
  try {
    name = renderTemplate(node.name, attrs)
    if (node.message != null) message = renderTemplate(node.message, attrs)
    if (node.target != null) target = renderTemplate(node.target, attrs)
  } catch (err) {
    resolve({
      disposition: 'error',
      durationMs: Date.now() - start,
      error: `git_tag: template render failed: ${err.message}`,
    })
    return
  }
  const args = ['-C', ctx.projectDir, 'tag']
  if (node.lightweight !== true) {
    args.push('-a', name, '-m', message)
  } else {
    args.push(name)
  }
  if (target) args.push(target)

  const child = spawn('git', args, {
    cwd: ctx.projectDir,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: process.env,
  })
  let stderr = ''
  child.stderr?.on('data', (d) => { stderr += d.toString() })
  child.on('error', (err) => {
    resolve({
      disposition: 'error',
      exitCode: null,
      durationMs: Date.now() - start,
      error: `git_tag: spawn failed: ${err.message}`,
      tag_name: name,
    })
  })
  child.on('exit', (code, signal) => {
    const durationMs = Date.now() - start
    if (code === 0) {
      resolve({
        disposition: 'success', exitCode: 0, signal, durationMs,
        tag_name: name, target: target || null,
        annotated: node.lightweight !== true,
      })
      return
    }
    // First-line of stderr is git's diagnostic (e.g. "fatal: tag
    // 'foo' already exists"). Capped to keep events readable.
    const firstLine = (stderr || '').split('\n')[0].slice(0, 200)
    resolve({
      disposition: 'error', exitCode: code, signal, durationMs,
      error: `git_tag: ${firstLine || `git exit ${code}`}`,
      tag_name: name,
    })
  })
})

const BUILTINS = {
  'builtin.exec': execBuiltin,
  'builtin.assert': assertBuiltin,
  'builtin.set_attr': setAttrBuiltin,
  'builtin.git_tag': gitTagBuiltin,
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
