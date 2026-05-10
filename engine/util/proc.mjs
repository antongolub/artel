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
