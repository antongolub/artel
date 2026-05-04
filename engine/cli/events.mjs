#!/usr/bin/env node
// `artel events` — tail / filter the event stream.
//
// Replaces the manual `tail -f .artel/events.jsonl | jq` workflow. Renders
// one line per event with structured key=val context, supports filters by
// task / trace / kind / type / time, and a follow mode that polls the
// jsonl for new appends.

import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

const PROJECT_DIR = process.env.ARTEL_PROJECT_DIR || process.cwd()
const EVENTS_PATH = join(PROJECT_DIR, '.artel', 'events.jsonl')

const tty = process.stdout.isTTY
const c = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s)
const dim = (s) => c('2', s)
const cyan = (s) => c('36', s)
const yellow = (s) => c('33', s)
const green = (s) => c('32', s)
const red = (s) => c('31', s)
const magenta = (s) => c('35', s)

const usage = (code = 0) => {
  console.log(`\
Usage: artel events [options]

Tail / filter .artel/events.jsonl. One line per event with structured
key=val context. Color by kind: workload cyan · signal/infra yellow ·
control magenta.

Options:
  -n, --limit <N>        last N events (default 20; -1 = all)
  -f, --follow           follow mode — poll for new appends every 500ms
  --task <slug>          filter by task
  --trace <id>           filter by trace_id (group a dispatch chain)
  --kind <k>             filter by kind (workload | infra | signal | control)
  --type <t>             filter by type (e.g. dispatch.start, checkpoint)
  --since <d>            include events newer than <d>; suffixes s/m/h/d
                         e.g. --since 1h, --since 30m
  --json                 raw jsonl pass-through (filtered, no formatting)
  -h, --help             this`)
  process.exit(code)
}

let values
try {
  ({ values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      limit: { type: 'string', short: 'n' },
      follow: { type: 'boolean', short: 'f' },
      task: { type: 'string' },
      trace: { type: 'string' },
      kind: { type: 'string' },
      type: { type: 'string' },
      since: { type: 'string' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  }))
} catch (err) {
  console.error(err.message)
  process.exit(2)
}

if (values.help) usage(0)

const parseSince = (s) => {
  if (!s) return null
  const m = s.match(/^(\d+)([smhd])$/)
  if (!m) {
    console.error(`--since must look like 30s / 5m / 2h / 1d (got: ${s})`)
    process.exit(2)
  }
  const mult = { s: 1000, m: 60000, h: 3600000, d: 86400000 }[m[2]]
  return Date.now() - Number(m[1]) * mult
}
const sinceMs = parseSince(values.since)
const limit = values.limit !== undefined ? Number(values.limit) : 20
if (Number.isNaN(limit)) usage(2)

const matches = (e) => {
  if (values.task && e.task !== values.task) return false
  if (values.trace && e.trace_id !== values.trace) return false
  if (values.kind && e.kind !== values.kind) return false
  if (values.type && e.type !== values.type) return false
  if (sinceMs != null) {
    const ts = Date.parse(e.at || '')
    if (!ts || ts < sinceMs) return false
  }
  return true
}

const readEvents = () => {
  if (!existsSync(EVENTS_PATH)) return []
  const out = []
  for (const line of readFileSync(EVENTS_PATH, 'utf8').split('\n')) {
    if (!line) continue
    try { out.push(JSON.parse(line)) } catch {}
  }
  return out
}

// --- formatting ---

const KIND_COLOR = {
  workload: cyan,
  infra: yellow,
  signal: yellow,
  control: magenta,
}

const DISPOSITION_COLOR = {
  success: green,
  parked: yellow,
  timeout: red,
  error: red,
}

const formatEvent = (e) => {
  const t = e.at ? new Date(e.at).toISOString().slice(11, 19) : '?'
  const kindColor = KIND_COLOR[e.kind] || dim
  const type = kindColor((e.type || '?').padEnd(20))
  const role = e.owner_role || e.from_role
  const roleStr = role ? cyan(role.padEnd(12)) : ' '.repeat(12)
  const ctx = []
  if (e.task) ctx.push(`task=${e.task}`)
  if (e.disposition) {
    const col = DISPOSITION_COLOR[e.disposition] || dim
    ctx.push(`disposition=${col(e.disposition)}`)
  }
  if (e.engine && !e.disposition) ctx.push(`engine=${e.engine}`)
  if (e.branch && !e.disposition) ctx.push(`branch=${e.branch}`)
  if (e.model && !e.disposition) ctx.push(`model=${e.model}`)
  if (e.last_completed_step) ctx.push(`done=${JSON.stringify(e.last_completed_step)}`)
  if (e.next_safe_step) ctx.push(`next=${JSON.stringify(e.next_safe_step)}`)
  if (e.reason) ctx.push(`reason=${e.reason}`)
  if (e.retry_count) ctx.push(`retry=${e.retry_count}`)
  if (e.delta) ctx.push(`${green('+' + (e.delta.lines_added || 0))}/${red('-' + (e.delta.lines_removed || 0))}`)
  if (e.usage) ctx.push(`tokens=${(e.usage.tokens_in || 0)}/${(e.usage.tokens_out || 0)}`)
  return `${dim(t)}  ${type} ${roleStr} ${dim(ctx.join(' '))}`
}

// --- run ---

const initial = readEvents().filter(matches)
const slice = limit < 0 ? initial : initial.slice(-limit)

if (values.json) {
  for (const e of slice) console.log(JSON.stringify(e))
} else {
  for (const e of slice) console.log(formatEvent(e))
}

if (!values.follow) process.exit(0)

// --- follow mode (poll mtime + size) ---

let lastSize = existsSync(EVENTS_PATH) ? statSync(EVENTS_PATH).size : 0
let lastSeenLine = slice.length ? readEvents().findIndex((e) => e === initial[initial.length - 1]) : -1

// Cleaner approach: track the byte offset we've already consumed and only
// read past it. jsonl events.jsonl is append-only — events never re-written,
// so byte offsets are stable.
const tail = () => {
  if (!existsSync(EVENTS_PATH)) return
  const sz = statSync(EVENTS_PATH).size
  if (sz <= lastSize) {
    lastSize = sz
    return
  }
  // Read from lastSize to end. node fs has no positional read on a
  // synchronously-opened path; just re-read whole file and pick lines past
  // the byte cursor — events.jsonl is small enough for this.
  const buf = readFileSync(EVENTS_PATH)
  const fresh = buf.slice(lastSize).toString('utf8')
  lastSize = sz
  for (const line of fresh.split('\n')) {
    if (!line) continue
    let e
    try { e = JSON.parse(line) } catch { continue }
    if (!matches(e)) continue
    if (values.json) console.log(JSON.stringify(e))
    else console.log(formatEvent(e))
  }
}

const interval = setInterval(tail, 500)
process.on('SIGINT', () => { clearInterval(interval); process.exit(0) })
process.on('SIGTERM', () => { clearInterval(interval); process.exit(0) })
