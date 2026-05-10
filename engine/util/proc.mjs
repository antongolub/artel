// Async child-process helper with hard timeout. Used by driver
// `roundtrip()` probes (`artel probe --json`) where we want to invoke
// each engine with a minimal prompt and bound the wait.

import { spawn } from 'node:child_process'

// V3.9.b — parse a duration value into milliseconds. Accepts:
//   - positive integer (already milliseconds)
//   - positive integer string ('60000')
//   - string with suffix: '500ms' / '60s' / '5m' / '2h' / '1d'
//   - null / undefined / '' → returns null (caller decides default)
//
// Used by `dispatchLifecycle` (timeout + termination grace), the
// pipeline validator (`dispatch.timeout_ms`,
// `handler.exec.timeout_ms`), and `handler.exec` itself. Single
// source of truth means the validator's accept-set matches what
// the runtime actually parses.
const SUFFIX_TO_MS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }
// Strict shape: digits + optional suffix, no internal whitespace.
// Trim is applied first, so '  60s  ' works but '60 s' does not —
// readability over flexibility.
const DURATION_RE = /^(\d+)(ms|s|m|h|d)?$/

export const parseDuration = (raw, label = 'duration') => {
  if (raw === undefined || raw === null || raw === '') return null
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || !Number.isInteger(raw) || raw <= 0) {
      throw new Error(`${label} must be a positive integer ms or string with suffix (ms|s|m|h|d), got: ${raw}`)
    }
    return raw
  }
  if (typeof raw === 'string') {
    const m = raw.trim().match(DURATION_RE)
    if (!m) {
      throw new Error(`${label} must be a positive integer ms or string with suffix (ms|s|m|h|d), got: ${JSON.stringify(raw)}`)
    }
    const n = parseInt(m[1], 10)
    if (n <= 0) {
      throw new Error(`${label} must be a positive integer ms or string with suffix (ms|s|m|h|d), got: ${JSON.stringify(raw)}`)
    }
    return n * SUFFIX_TO_MS[m[2] || 'ms']
  }
  throw new Error(`${label} must be a positive integer ms or string with suffix (ms|s|m|h|d), got: ${raw}`)
}

// V3.10.f — cancellable spawn for handler builtins (V3.7.a exec,
// V3.7.f git_tag) that need: SIGTERM on abort, optional timeout
// SIGTERM, optional SIGKILL grace, optional stderr capture. Never
// throws. Resolves with `{ exitCode, signal, durationMs, stderr,
// cancelled, timedOut, error? }` — the builtin maps it to its own
// disposition shape.
//
// opts:
//   cwd            — passed to spawn
//   stdio          — passed to spawn (default 'inherit')
//   env            — passed to spawn (default process.env)
//   timeoutMs      — SIGTERM after this; null/0 = no timeout
//   signal         — AbortSignal; aborting → SIGTERM, then
//                    SIGKILL after cancelGraceMs (if set)
//   cancelGraceMs  — null/0 = no SIGKILL backstop
//   captureStderr  — if true, accumulate stderr; only meaningful
//                    when stdio doesn't inherit stderr
export const spawnCancellable = (bin, args, opts = {}) => new Promise((resolve) => {
  const start = Date.now()
  let child
  try {
    child = spawn(bin, args, {
      cwd: opts.cwd,
      stdio: opts.stdio || 'inherit',
      env: opts.env || process.env,
    })
  } catch (err) {
    resolve({ error: err, exitCode: null, signal: null, durationMs: Date.now() - start, stderr: '', cancelled: false, timedOut: false })
    return
  }
  let stderr = ''
  if (opts.captureStderr) child.stderr?.on('data', (d) => { stderr += d.toString() })
  let timedOut = false
  let cancelled = false
  let timeoutHandle = null
  let killHandle = null
  let abortHandler = null
  const cleanup = () => {
    if (timeoutHandle) clearTimeout(timeoutHandle)
    if (killHandle) clearTimeout(killHandle)
    if (opts.signal && abortHandler) opts.signal.removeEventListener('abort', abortHandler)
  }
  if (opts.timeoutMs) {
    timeoutHandle = setTimeout(() => {
      timedOut = true
      try { child.kill('SIGTERM') } catch {}
    }, opts.timeoutMs)
  }
  if (opts.signal) {
    const triggerAbort = () => {
      if (cancelled) return
      cancelled = true
      try { child.kill('SIGTERM') } catch {}
      if (opts.cancelGraceMs) {
        killHandle = setTimeout(() => {
          try { child.kill('SIGKILL') } catch {}
        }, opts.cancelGraceMs)
      }
    }
    if (opts.signal.aborted) triggerAbort()
    else {
      abortHandler = triggerAbort
      opts.signal.addEventListener('abort', abortHandler, { once: true })
    }
  }
  child.on('error', (err) => {
    cleanup()
    resolve({ error: err, exitCode: null, signal: null, durationMs: Date.now() - start, stderr, cancelled, timedOut })
  })
  child.on('exit', (code, signal) => {
    cleanup()
    resolve({ exitCode: code, signal, durationMs: Date.now() - start, stderr, cancelled, timedOut })
  })
})

// runWithTimeout(bin, args, opts?) — resolves to
//   { code, signal, stdout, stderr, durationMs, timedOut }
// Never throws. Caller decides how to interpret based on code/timedOut.
//
// Defaults: 30s timeout, both streams piped, no stdin.
export const runWithTimeout = (bin, args, { timeoutMs = 30000, env = process.env } = {}) =>
  new Promise((resolve) => {
    const start = Date.now()
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false

    let child
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], env })
    } catch (err) {
      resolve({
        code: -1,
        signal: null,
        stdout: '',
        stderr: err?.message || String(err),
        durationMs: Date.now() - start,
        timedOut: false,
      })
      return
    }

    child.stdout.on('data', (d) => { stdout += d.toString() })
    child.stderr.on('data', (d) => { stderr += d.toString() })

    const settle = (payload) => {
      if (settled) return
      settled = true
      clearTimeout(t)
      resolve(payload)
    }

    const t = setTimeout(() => {
      timedOut = true
      try { child.kill('SIGKILL') } catch {}
    }, timeoutMs)

    child.on('exit', (code, signal) => {
      settle({
        code: code ?? -1,
        signal,
        stdout,
        stderr,
        durationMs: Date.now() - start,
        timedOut,
      })
    })
    child.on('error', (err) => {
      settle({
        code: -1,
        signal: null,
        stdout,
        stderr: stderr || err?.message || String(err),
        durationMs: Date.now() - start,
        timedOut,
      })
    })
  })
