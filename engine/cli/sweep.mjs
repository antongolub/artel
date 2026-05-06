#!/usr/bin/env node
// `artel sweep` — housekeeping for `.artel/.dispatches/`.
//
// Removes `<task>.meta`, `<task>.out`, `<task>.prompt` triplets older
// than the threshold, **except**:
//   - tasks still listed under For Owner / In progress / Pending /
//     Blocked in QUEUE.md (active work — never sweep)
//   - the `--keep N` newest dispatches regardless of age (so `artel
//     logs` and `artel status RECENT` keep something to show)
//   - dispatches without a `completedAt` (never finished — keep for
//     debugging)
//
// Emits a single `infra` event `cluster.swept` with file count + bytes
// freed. Per-file events would be noisy in events.jsonl; one summary
// per sweep is enough for audit.

import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { appendInfraEvent } from '../util/audit.mjs'

const PROJECT_DIR = process.env.ARTEL_PROJECT_DIR || process.cwd()
const PROJECT_ARTEL = join(PROJECT_DIR, '.artel')
const DISPATCHES_DIR = join(PROJECT_ARTEL, '.dispatches')
const QUEUE_PATH = join(PROJECT_ARTEL, 'QUEUE.md')

const tty = process.stdout.isTTY
const c = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s)
const dim = (s) => c('2', s)
const bold = (s) => c('1', s)
const green = (s) => c('32', s)
const yellow = (s) => c('33', s)

const usage = (code = 0) => {
  console.log(`\
Usage: artel sweep [options]

Removes <task>.{meta,out,prompt} from .artel/.dispatches/ when the
dispatch completed before the threshold, isn't currently active in
QUEUE.md, and isn't among the latest --keep dispatches.

Options:
  --older-than <d>   age threshold; suffixes s/m/h/d (default 30d)
  --keep <N>         always keep the newest N dispatches (default 20)
  --dry-run          print plan, don't delete
  --json             machine-readable summary
  -h, --help         this`)
  process.exit(code)
}

let values
try {
  ({ values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      'older-than': { type: 'string' },
      keep: { type: 'string' },
      'dry-run': { type: 'boolean' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  }))
} catch (err) {
  console.error(err.message)
  process.exit(2)
}

if (values.help) usage(0)

const parseDuration = (s) => {
  const m = s.match(/^(\d+)([smhd])$/)
  if (!m) {
    console.error(`--older-than must look like 30s / 5m / 2h / 1d (got: ${s})`)
    process.exit(2)
  }
  const mult = { s: 1000, m: 60000, h: 3600000, d: 86400000 }[m[2]]
  return Number(m[1]) * mult
}

const olderThanMs = parseDuration(values['older-than'] || '30d')
const keepN = values.keep !== undefined ? Number(values.keep) : 20
if (Number.isNaN(keepN) || keepN < 0) {
  console.error(`--keep must be a non-negative integer (got: ${values.keep})`)
  process.exit(2)
}

// --- collect active task slugs from QUEUE.md ---

const ACTIVE_SECTIONS = new Set(['For Owner', 'In progress', 'Pending', 'Blocked'])

const activeTaskSlugs = () => {
  if (!existsSync(QUEUE_PATH)) return new Set()
  const slugs = new Set()
  let inActive = false
  for (const line of readFileSync(QUEUE_PATH, 'utf8').split('\n')) {
    const sec = line.match(/^## (.+)$/)
    if (sec) {
      inActive = ACTIVE_SECTIONS.has(sec[1])
      continue
    }
    if (!inActive) continue
    // Match `[task: slug]` or `[task=slug]` or fall back to first slug-like token.
    const tagged = line.match(/\[task[:= ]\s*([a-z0-9][a-z0-9._-]*)\]/i)
    if (tagged) { slugs.add(tagged[1]); continue }
    const m = line.match(/^- (?:\[[^\]]+\]\s*)?([a-z0-9][a-z0-9._-]+)/i)
    if (m) slugs.add(m[1])
  }
  return slugs
}

// --- gather candidate dispatches ---

const now = Date.now()
const cutoffMs = now - olderThanMs
const active = activeTaskSlugs()

const dispatches = []
if (existsSync(DISPATCHES_DIR)) {
  for (const f of readdirSync(DISPATCHES_DIR)) {
    if (!f.endsWith('.meta')) continue
    const stem = f.replace(/\.meta$/, '')
    let meta
    try { meta = JSON.parse(readFileSync(join(DISPATCHES_DIR, f), 'utf8')) } catch { continue }
    if (!meta.completedAt) continue            // unfinished — never sweep
    const completedMs = Date.parse(meta.completedAt) || 0
    dispatches.push({
      stem,
      task: meta.task || stem,
      completedAt: meta.completedAt,
      completedMs,
    })
  }
}

// Newest-first so --keep N wins over age filter.
dispatches.sort((a, b) => b.completedMs - a.completedMs)
const protectedByKeep = new Set(dispatches.slice(0, keepN).map((d) => d.stem))

const sidecarPaths = (stem) => [
  join(DISPATCHES_DIR, `${stem}.meta`),
  join(DISPATCHES_DIR, `${stem}.out`),
  join(DISPATCHES_DIR, `${stem}.prompt`),
]

const toRemove = []
const skipped = []
for (const d of dispatches) {
  if (active.has(d.task)) { skipped.push({ ...d, reason: 'active' }); continue }
  if (protectedByKeep.has(d.stem)) { skipped.push({ ...d, reason: 'keep' }); continue }
  if (d.completedMs > cutoffMs) { skipped.push({ ...d, reason: 'fresh' }); continue }
  // Compute byte cost across the triplet (meta + out + prompt).
  let bytes = 0
  const paths = []
  for (const p of sidecarPaths(d.stem)) {
    if (!existsSync(p)) continue
    paths.push(p)
    try { bytes += statSync(p).size } catch {}
  }
  toRemove.push({ ...d, paths, bytes })
}

const totalBytes = toRemove.reduce((s, d) => s + d.bytes, 0)
const fmtBytes = (n) => {
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}kB`
  return `${(n / 1024 / 1024).toFixed(1)}MB`
}

// --- execute or dry-run ---

if (values.json) {
  console.log(JSON.stringify({
    cutoff_iso: new Date(cutoffMs).toISOString(),
    keep: keepN,
    dry_run: !!values['dry-run'],
    candidates: dispatches.length,
    active_held: skipped.filter((s) => s.reason === 'active').length,
    keep_held: skipped.filter((s) => s.reason === 'keep').length,
    fresh_held: skipped.filter((s) => s.reason === 'fresh').length,
    swept: toRemove.map((d) => ({ task: d.task, completedAt: d.completedAt, bytes: d.bytes })),
    bytes_freed: totalBytes,
  }, null, 2))
} else {
  console.log(`\n${bold('artel sweep')} ${dim(`— older than ${values['older-than'] || '30d'}, keep newest ${keepN}`)}\n`)
  if (!toRemove.length) {
    console.log(`  ${dim('nothing to sweep — all dispatches are fresh, active, or within --keep')}`)
  } else {
    for (const d of toRemove) {
      console.log(`  ${yellow('×')} ${d.task.padEnd(36)} ${dim(d.completedAt.replace('T', ' ').slice(0, 19) + 'Z')}  ${dim(fmtBytes(d.bytes).padStart(7))}`)
    }
    console.log(`\n  ${dim(`total: ${toRemove.length} dispatches · ${fmtBytes(totalBytes)}`)}`)
  }
  if (skipped.length) {
    const counts = skipped.reduce((acc, s) => ((acc[s.reason] = (acc[s.reason] || 0) + 1), acc), {})
    const parts = Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(' · ')
    console.log(`  ${dim(`held: ${parts}`)}`)
  }
  console.log()
}

if (values['dry-run']) process.exit(0)

let removed = 0
for (const d of toRemove) {
  for (const p of d.paths) {
    try { rmSync(p); removed++ } catch {}
  }
}

if (toRemove.length) {
  appendInfraEvent(PROJECT_DIR, 'cluster.swept', {
    older_than_ms: olderThanMs,
    keep: keepN,
    dispatches_removed: toRemove.length,
    files_removed: removed,
    bytes_freed: totalBytes,
  })
  if (!values.json) {
    console.log(`${green('✓')} swept ${toRemove.length} dispatches (${removed} files, ${fmtBytes(totalBytes)})\n`)
  }
}
