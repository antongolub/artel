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

import { evaluatePredicate, renderTemplate, writePath } from './pipelines.mjs'
import { parseDuration, spawnCancellable } from './proc.mjs'

// builtin.exec — run `bash -c <cmd>`; stdio inherited so the operator
// sees command output inline with the walker. Disposition mapping:
// success on exit 0, error on non-zero, timeout if node.timeout_ms
// elapses, cancelled if ctx.abortSignal fires. Cancel takes
// precedence (intentional teardown beats budget exhaustion).
//
// `bash -c` so quoting / piping / && just work as operators expect.
// Trust model: cmds come from the pipeline definition the operator
// authored — same as a Makefile target.
const EXEC_CANCEL_GRACE_MS = 5000

const execBuiltin = async (node, ctx) => {
  const r = await spawnCancellable('bash', ['-c', node.cmd], {
    cwd: ctx.projectDir,
    timeoutMs: parseDuration(node.timeout_ms),
    signal: ctx.abortSignal,
    cancelGraceMs: EXEC_CANCEL_GRACE_MS,
  })
  if (r.error) return { disposition: 'error', exitCode: null, signal: null, durationMs: r.durationMs, error: r.error.message }
  if (r.cancelled) return { disposition: 'cancelled', exitCode: r.exitCode, signal: r.signal, durationMs: r.durationMs }
  if (r.timedOut)  return { disposition: 'timeout',   exitCode: r.exitCode, signal: r.signal, durationMs: r.durationMs }
  return { disposition: r.exitCode === 0 ? 'success' : 'error', exitCode: r.exitCode, signal: r.signal, durationMs: r.durationMs }
}

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
  // V3.7.d.c — `unset` entries are V3.5 template-rendered against
  // ctx.attrs the same way set values are. Lets pipelines remove
  // scope-dependent keys like `'{{ scope }}.tmp'`. Render failure
  // → atomic error (no partial mutation reaches the walker).
  const unsetResolved = []
  if (Array.isArray(node.unset)) {
    for (const path of node.unset) {
      try {
        unsetResolved.push(renderTemplate(path, attrs))
      } catch (err) {
        return {
          disposition: 'error',
          durationMs: Date.now() - start,
          error: `set_attr: render of .unset entry '${path}' failed: ${err.message}`,
        }
      }
    }
  }
  return {
    disposition: 'success',
    durationMs: Date.now() - start,
    attrs: resolved,         // walker deep-merges over userAttrs
    set_resolved: setResolved,
    unsets: unsetResolved,
  }
}

// builtin.git_tag (V3.7.f) — tag a commit in ctx.projectDir.
// Annotated by default (`message` required); `lightweight: true`
// skips the message. `name` / `message` / `target` (default HEAD)
// V3.5-templated. Stderr captured for forensics; first line lands
// in event.error on failure (duplicate tag, missing ref, etc.).
//
// V3.7.f.b — short-circuits before spawn on a pre-aborted signal so
// the op is guaranteed side-effect-free. Mid-flight aborts SIGTERM
// the git child but git may race ahead and write the tag anyway;
// disposition still `cancelled` in that case.
const gitTagBuiltin = async (node, ctx) => {
  const start = Date.now()
  const attrs = ctx.attrs || {}
  let name, message, target
  try {
    name = renderTemplate(node.name, attrs)
    if (node.message != null) message = renderTemplate(node.message, attrs)
    if (node.target != null) target = renderTemplate(node.target, attrs)
  } catch (err) {
    return { disposition: 'error', durationMs: Date.now() - start, error: `git_tag: template render failed: ${err.message}` }
  }
  if (ctx.abortSignal?.aborted) {
    return { disposition: 'cancelled', exitCode: null, signal: null, durationMs: Date.now() - start, tag_name: name }
  }
  const args = ['-C', ctx.projectDir, 'tag']
  if (node.lightweight !== true) args.push('-a', name, '-m', message)
  else args.push(name)
  if (target) args.push(target)

  const r = await spawnCancellable('git', args, {
    cwd: ctx.projectDir,
    stdio: ['ignore', 'ignore', 'pipe'],
    captureStderr: true,
    signal: ctx.abortSignal,
  })
  if (r.error) return { disposition: 'error', exitCode: null, durationMs: r.durationMs, error: `git_tag: spawn failed: ${r.error.message}`, tag_name: name }
  if (r.cancelled) return { disposition: 'cancelled', exitCode: r.exitCode, signal: r.signal, durationMs: r.durationMs, tag_name: name }
  if (r.exitCode === 0) {
    return { disposition: 'success', exitCode: 0, signal: r.signal, durationMs: r.durationMs, tag_name: name, target: target || null, annotated: node.lightweight !== true }
  }
  // First-line of git's diagnostic; capped to keep events readable.
  const firstLine = (r.stderr || '').split('\n')[0].slice(0, 200)
  return { disposition: 'error', exitCode: r.exitCode, signal: r.signal, durationMs: r.durationMs, error: `git_tag: ${firstLine || `git exit ${r.exitCode}`}`, tag_name: name }
}

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
