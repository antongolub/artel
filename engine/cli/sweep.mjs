#!/usr/bin/env node
// `artel sweep` — housekeeping for `.artel/.dispatches/` and (V3.3.b)
// `.artel/.worktrees/`.
//
// Dispatches: removes `<task>.meta`, `<task>.out`, `<task>.prompt`
// triplets older than the threshold, **except**:
//   - tasks still listed under For Owner / In progress / Pending /
//     Blocked in QUEUE.md (active work — never sweep)
//   - the `--keep N` newest dispatches regardless of age (so `artel
//     logs` and `artel status RECENT` keep something to show)
//   - dispatches without a `completedAt` (never finished — keep for
//     debugging)
//
// Worktrees (V3.3.b): removes orphaned `.artel/.worktrees/<branch>/`
// directories. A worktree is "orphan" when:
//   - its branch is NOT one of For Owner / In progress / Pending /
//     Blocked in QUEUE.md
//   - its mtime is older than the threshold
// Successful dispatches already remove their worktree on settle; this
// catches the leftovers from parked / timeout / errored runs (kept for
// forensics) once the operator no longer needs them.
//
// Emits a single `infra` event `cluster.swept` with totals.

import { existsSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { appendInfraEvent } from '../util/audit.mjs'
import { defaultGit, listWorktrees, removeWorktree } from '../util/worktree.mjs'

const PROJECT_DIR = process.env.ARTEL_PROJECT_DIR || process.cwd()
const PROJECT_ARTEL = join(PROJECT_DIR, '.artel')
const DISPATCHES_DIR = join(PROJECT_ARTEL, '.dispatches')
const WORKTREES_DIR = join(PROJECT_ARTEL, '.worktrees')
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

// --- worktrees (V3.3.b) ---

// Collect worktree paths under .artel/.worktrees/ that are eligible
// for pruning: branch not in active QUEUE sections AND mtime older
// than threshold. Cross-check `git worktree list` so we don't blindly
// rm directories git doesn't know about (those need different
// handling — fs-only rm would corrupt git's worktree registry).

const collectWorktrees = () => {
  const remove = []
  const skipped = []
  if (!existsSync(WORKTREES_DIR)) return { remove, skipped }
  const gitImpl = defaultGit(PROJECT_DIR)
  const knownPaths = new Set()
  for (const w of listWorktrees(PROJECT_DIR, gitImpl)) {
    knownPaths.add(w.path)
    try { knownPaths.add(realpathSync(w.path)) } catch {}
  }
  const walk = (dir) => {
    const out = []
    if (!existsSync(dir)) return out
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      let stat
      try { stat = statSync(path) } catch { continue }
      if (!stat.isDirectory()) continue
      let real = path
      try { real = realpathSync(path) } catch {}
      if (knownPaths.has(path) || knownPaths.has(real)) {
        out.push({ path, mtimeMs: stat.mtimeMs })
      } else {
        out.push(...walk(path))
      }
    }
    return out
  }
  for (const wt of walk(WORKTREES_DIR)) {
    // Branch name = path under WORKTREES_DIR (`implementer/some-task`).
    const branch = wt.path.slice(WORKTREES_DIR.length + 1)
    // Check both the full branch ("implementer/foo") and the trailing
    // task slug ("foo") — QUEUE.md tracks slugs, not full branches.
    const taskSlug = branch.includes('/') ? branch.split('/').slice(1).join('/') : branch
    if (active.has(branch) || active.has(taskSlug)) {
      skipped.push({ ...wt, branch, reason: 'active' })
      continue
    }
    if (wt.mtimeMs > cutoffMs) {
      skipped.push({ ...wt, branch, reason: 'fresh' })
      continue
    }
    remove.push({ ...wt, branch })
  }
  return { remove, skipped }
}

const { remove: worktreesToRemove, skipped: worktreesSkipped } = collectWorktrees()

// --- render ---

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
    worktrees_swept: worktreesToRemove.map((w) => ({
      branch: w.branch, path: w.path, mtime_iso: new Date(w.mtimeMs).toISOString(),
    })),
    worktrees_held: worktreesSkipped.length,
  }, null, 2))
} else {
  console.log(`\n${bold('artel sweep')} ${dim(`— older than ${values['older-than'] || '30d'}, keep newest ${keepN}`)}\n`)
  if (!toRemove.length && !worktreesToRemove.length) {
    console.log(`  ${dim('nothing to sweep — all dispatches/worktrees are fresh, active, or within --keep')}`)
  }
  if (toRemove.length) {
    console.log(`  ${bold('dispatches')}`)
    for (const d of toRemove) {
      console.log(`  ${yellow('×')} ${d.task.padEnd(36)} ${dim(d.completedAt.replace('T', ' ').slice(0, 19) + 'Z')}  ${dim(fmtBytes(d.bytes).padStart(7))}`)
    }
    console.log(`  ${dim(`subtotal: ${toRemove.length} dispatches · ${fmtBytes(totalBytes)}`)}`)
  }
  if (worktreesToRemove.length) {
    console.log(`\n  ${bold('worktrees')}`)
    for (const wt of worktreesToRemove) {
      console.log(`  ${yellow('×')} ${wt.branch.padEnd(36)} ${dim(new Date(wt.mtimeMs).toISOString().replace('T', ' ').slice(0, 19) + 'Z')}  ${dim(wt.path)}`)
    }
    console.log(`  ${dim(`subtotal: ${worktreesToRemove.length} worktrees`)}`)
  }
  const allSkipped = [...skipped, ...worktreesSkipped]
  if (allSkipped.length) {
    const counts = allSkipped.reduce((acc, s) => ((acc[s.reason] = (acc[s.reason] || 0) + 1), acc), {})
    const parts = Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(' · ')
    console.log(`\n  ${dim(`held: ${parts}`)}`)
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

let worktreesRemovedOk = 0
const gitImpl = defaultGit(PROJECT_DIR)
for (const wt of worktreesToRemove) {
  const r = removeWorktree(wt.path, gitImpl)
  if (!r || r.ok) worktreesRemovedOk++
}

if (toRemove.length || worktreesToRemove.length) {
  appendInfraEvent(PROJECT_DIR, 'cluster.swept', {
    older_than_ms: olderThanMs,
    keep: keepN,
    dispatches_removed: toRemove.length,
    files_removed: removed,
    bytes_freed: totalBytes,
    worktrees_removed: worktreesRemovedOk,
  })
  if (!values.json) {
    const parts = []
    if (toRemove.length) parts.push(`${toRemove.length} dispatches (${removed} files, ${fmtBytes(totalBytes)})`)
    if (worktreesRemovedOk) parts.push(`${worktreesRemovedOk} worktrees`)
    if (parts.length) console.log(`${green('✓')} swept ${parts.join(', ')}\n`)
  }
}
