// Dispatch-tail parking detection. Scans the last 4KB of a .out file for
// recoverable failure markers; returns a parked descriptor or null. Parking is
// a marker — the dispatcher decides retries / relogin / re-dispatch.

import { existsSync, openSync, closeSync, readSync, fstatSync } from 'node:fs'

const PARK_KINDS = [
  {
    reason: 'auth-expired',
    patterns: [/not logged in/i, /please run \/login/i, /authentication required/i],
  },
  {
    reason: 'provider-limit',
    patterns: [
      /hit your limit/i,
      /rate limit/i,
      /quota exceeded/i,
      /resets\s+(?:at\s+)?\S+/i,
      /try again later/i,
      /provider unavailable/i,
    ],
  },
]

export const detectParked = (path) => {
  if (!existsSync(path)) return null
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    const start = Math.max(0, size - 4096)
    const len = size - start
    if (len === 0) return null
    const buf = Buffer.alloc(len)
    readSync(fd, buf, 0, len, start)
    const text = buf.toString('utf8')
    let raw = null
    let reason = null
    for (const line of text.split('\n')) {
      for (const kind of PARK_KINDS) {
        if (kind.patterns.some((re) => re.test(line))) {
          raw = line.trim()
          reason = kind.reason
          break
        }
      }
      if (raw) break
    }
    if (!raw || !reason) return null
    const m = text.match(/resets\s+(?:at\s+)?(\S+)/i)
    return { reason, resetAt: reason === 'provider-limit' && m ? m[1] : null, raw: raw.slice(0, 200) }
  } finally {
    closeSync(fd)
  }
}
