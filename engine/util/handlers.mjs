// Pipeline handler builtins (V3.7.a).
//
// Handlers are pipeline nodes that perform a platform action without
// dispatching an LLM. They share the same edge-routing machinery as
// `dispatch` (disposition flows through `on_disposition` edges) but
// don't go through `dispatchLifecycle` — no role, no engine, no
// worktree, no `.meta` sidecar.
//
// Each builtin is a small async function `(node, ctx) =>
// { disposition, exitCode?, signal?, durationMs }`. Add a new builtin
// = register its name in `VALID_HANDLERS` (engine/util/pipelines.mjs)
// AND its implementation in the BUILTINS map below.
//
// V3.7.a ships `builtin.exec` only. Others (`builtin.assert`,
// `builtin.set_attr`, `builtin.git_squash`) deferred — keep the
// surface minimal until a concrete pipeline needs them.

import { spawn } from 'node:child_process'

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

const BUILTINS = {
  'builtin.exec': execBuiltin,
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
