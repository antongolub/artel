// Async child-process helper with hard timeout. Used by driver
// `roundtrip()` probes (`artel probe --json`) where we want to invoke
// each engine with a minimal prompt and bound the wait.

import { spawn } from 'node:child_process'

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
