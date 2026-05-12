#!/usr/bin/env node
// `artel sweep` — housekeeping for `.artel/.dispatches/` and (V3.3.b)
// `.artel/.worktrees/` and (V3.8.b) `.artel/.pipeline-cancels/`.
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
// Pipeline-cancel sentinels (V3.8.b): removes
// `.artel/.pipeline-cancels/<run-id>` files for runs that have
// already terminated (events.jsonl carries a `pipeline_run.ended`
// for that run_id). In-flight sentinels are NEVER swept — they're
// the live cancel signal. Aged sentinels for runs whose `.ended` is
// missing (process died mid-flight) are also kept for forensics
// unless `--older-than` ages them out, but the run has to be at
// least believed-terminal (no in-flight signal of life). We rely on
// the same age threshold; the operator can clear them by hand if
// they want immediate cleanup.
//
// Emits a single `infra` event `cluster.swept` with totals.

import { existsSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { appendInfraEvent } from '../core/audit.mjs'
import { listDispatches } from '../core/dispatches.mjs'
import { readQueueMd, flattenItem } from '../core/queue_md.mjs'
import { defaultGit, listWorktrees, removeWorktree } from '../git/worktree.mjs'
import { listPipelineRuns } from '../pipelines/pipelines.mjs'
import { chalk } from '../util/chalk.mjs'
import { config } from '../config/env.mjs'

const {
  projectDir: PROJECT_DIR,
  dispatchesDir: DISPATCHES_DIR,
  worktreesDir: WORKTREES_DIR,
  pipelineCancelsDir: PIPELINE_CANCELS_DIR,
  queuePath: QUEUE_PATH,
} = config

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

const ACTIVE_SECTIONS = ['For Owner', 'In progress', 'Pending', 'Blocked']

const activeTaskSlugs = () => {
  const { sections } = readQueueMd(QUEUE_PATH)
  const slugs = new Set()
  for (const sec of ACTIVE_SECTIONS) {
    for (const item of sections[sec]) {
      const line = flattenItem(item)
      // Match `[task: slug]` or `[task=slug]` or fall back to first slug-like token.
      const tagged = line.match(/\[task[:= ]\s*([a-z0-9][a-z0-9._-]*)\]/i)
      if (tagged) { slugs.add(tagged[1]); continue }
      const m = line.match(/^(?:\[[^\]]+\]\s*)?([a-z0-9][a-z0-9._-]+)/i)
      if (m) slugs.add(m[1])
    }
  }
  return slugs
}

// --- gather candidate dispatches ---

const now = Date.now()
const cutoffMs = now - olderThanMs
const active = activeTaskSlugs()

const dispatches = listDispatches(DISPATCHES_DIR)
  .filter(({ meta }) => meta.completedAt)            // unfinished — never sweep
  .map(({ stem, meta }) => ({
    stem,
    task: meta.task || stem,
    completedAt: meta.completedAt,
    completedMs: Date.parse(meta.completedAt) || 0,
  }))

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

// --- pipeline-cancel sentinels (V3.8.b) ---
//
// Sentinels at .artel/.pipeline-cancels/<run-id> are stale once the
// run is terminal — events.jsonl carries `pipeline_run.ended` for
// that run_id. In-flight sentinels are the live cancel signal and
// must never be swept; missing-`.ended` sentinels older than the
// threshold are treated as zombie processes and pruned (operator
// can recreate by re-running cancel if a run somehow comes back).

const collectPipelineCancels = () => {
  const remove = []
  const skipped = []
  if (!existsSync(PIPELINE_CANCELS_DIR)) return { remove, skipped }

  // Build a set of terminated run_ids. listPipelineRuns walks
  // events.jsonl and returns one entry per run, with `final_state`
  // set when an `.ended` event exists. Pass limit: null for full
  // history (some sentinels may belong to old runs).
  const terminalRunIds = new Set()
  for (const r of listPipelineRuns(PROJECT_DIR, { limit: null })) {
    if (r.final_state) terminalRunIds.add(r.run_id)
  }

  for (const name of readdirSync(PIPELINE_CANCELS_DIR)) {
    const path = join(PIPELINE_CANCELS_DIR, name)
    let stat
    try { stat = statSync(path) } catch { continue }
    if (!stat.isFile()) continue
    const runId = name  // filename = full UUIDv7 run_id

    if (!terminalRunIds.has(runId)) {
      // Run not yet terminated. If it's still actively cancelling
      // (the walker hasn't picked up the sentinel yet, or is in the
      // SIGTERM grace window), the sentinel is the live signal —
      // never sweep. If the process truly died mid-cancel, the
      // sentinel is harmless residue, but we err on the side of
      // forensic preservation. Operator can rm by hand if needed.
      skipped.push({ runId, path, mtimeMs: stat.mtimeMs, reason: 'in-flight' })
      continue
    }
    if (stat.mtimeMs > cutoffMs) {
      skipped.push({ runId, path, mtimeMs: stat.mtimeMs, reason: 'fresh' })
      continue
    }
    remove.push({ runId, path, mtimeMs: stat.mtimeMs })
  }
  return { remove, skipped }
}

const { remove: cancelsToRemove, skipped: cancelsSkipped } = collectPipelineCancels()

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
    pipeline_cancels_swept: cancelsToRemove.map((c) => ({
      run_id: c.runId, path: c.path, mtime_iso: new Date(c.mtimeMs).toISOString(),
    })),
    pipeline_cancels_held: cancelsSkipped.length,
  }, null, 2))
} else {
  console.log(`\n${chalk.bold('artel sweep')} ${chalk.dim(`— older than ${values['older-than'] || '30d'}, keep newest ${keepN}`)}\n`)
  if (!toRemove.length && !worktreesToRemove.length && !cancelsToRemove.length) {
    console.log(`  ${chalk.dim('nothing to sweep — all dispatches/worktrees/cancel-sentinels are fresh, active, or within --keep')}`)
  }
  if (toRemove.length) {
    console.log(`  ${chalk.bold('dispatches')}`)
    for (const d of toRemove) {
      console.log(`  ${chalk.yellow('×')} ${d.task.padEnd(36)} ${chalk.dim(d.completedAt.replace('T', ' ').slice(0, 19) + 'Z')}  ${chalk.dim(fmtBytes(d.bytes).padStart(7))}`)
    }
    console.log(`  ${chalk.dim(`subtotal: ${toRemove.length} dispatches · ${fmtBytes(totalBytes)}`)}`)
  }
  if (worktreesToRemove.length) {
    console.log(`\n  ${chalk.bold('worktrees')}`)
    for (const wt of worktreesToRemove) {
      console.log(`  ${chalk.yellow('×')} ${wt.branch.padEnd(36)} ${chalk.dim(new Date(wt.mtimeMs).toISOString().replace('T', ' ').slice(0, 19) + 'Z')}  ${chalk.dim(wt.path)}`)
    }
    console.log(`  ${chalk.dim(`subtotal: ${worktreesToRemove.length} worktrees`)}`)
  }
  if (cancelsToRemove.length) {
    console.log(`\n  ${chalk.bold('pipeline-cancel sentinels')}`)
    for (const c of cancelsToRemove) {
      console.log(`  ${chalk.yellow('×')} ${c.runId.slice(-12).padEnd(36)} ${chalk.dim(new Date(c.mtimeMs).toISOString().replace('T', ' ').slice(0, 19) + 'Z')}  ${chalk.dim(c.path)}`)
    }
    console.log(`  ${chalk.dim(`subtotal: ${cancelsToRemove.length} cancel sentinels`)}`)
  }
  const allSkipped = [...skipped, ...worktreesSkipped, ...cancelsSkipped]
  if (allSkipped.length) {
    const counts = allSkipped.reduce((acc, s) => ((acc[s.reason] = (acc[s.reason] || 0) + 1), acc), {})
    const parts = Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(' · ')
    console.log(`\n  ${chalk.dim(`held: ${parts}`)}`)
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

let cancelsRemovedOk = 0
for (const c of cancelsToRemove) {
  try { rmSync(c.path); cancelsRemovedOk++ } catch {}
}

if (toRemove.length || worktreesToRemove.length || cancelsToRemove.length) {
  appendInfraEvent(PROJECT_DIR, 'cluster.swept', {
    older_than_ms: olderThanMs,
    keep: keepN,
    dispatches_removed: toRemove.length,
    files_removed: removed,
    bytes_freed: totalBytes,
    worktrees_removed: worktreesRemovedOk,
    pipeline_cancels_removed: cancelsRemovedOk,
  })
  if (!values.json) {
    const parts = []
    if (toRemove.length) parts.push(`${toRemove.length} dispatches (${removed} files, ${fmtBytes(totalBytes)})`)
    if (worktreesRemovedOk) parts.push(`${worktreesRemovedOk} worktrees`)
    if (cancelsRemovedOk) parts.push(`${cancelsRemovedOk} cancel sentinels`)
    if (parts.length) console.log(`${chalk.green('✓')} swept ${parts.join(', ')}\n`)
  }
}
