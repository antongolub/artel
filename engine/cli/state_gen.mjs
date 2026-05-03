#!/usr/bin/env node
// Persisted projection of platform state. Reads canonical inputs
// (events.jsonl, .dispatches/*.meta, dispatcher_state.json, cluster.json,
// QUEUE.md) and writes `.artel/state.md` — a YAML-frontmatter snapshot for
// cold-pickup consumers (replacement agents, audit tooling).
//
// state.md is **not** a source of truth — regenerate any time. Source of
// truth is the event stream + sidecars. Other projections (e.g. the live
// CLI dashboard in status.mjs) read the same canonical inputs directly,
// not state.md.

import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { readClusterIdentity } from '../core/cluster.mjs'

const here = dirname(fileURLToPath(import.meta.url))
// `here` is engine/cli/, so platform root is two levels up.
const platformDir = dirname(dirname(here))
const agentsDir = join(platformDir, 'agents')
const driversDir = join(platformDir, 'engine', 'drivers')
const projectDir = process.env.ARTEL_PROJECT_DIR || process.cwd()
const projectArtelDir = join(projectDir, '.artel')
const queuePath = join(projectArtelDir, 'QUEUE.md')
const dispatchDir = join(projectArtelDir, '.dispatches')
const eventsPath = join(projectArtelDir, 'events.jsonl')
const dispatcherStatePath = join(projectArtelDir, 'dispatcher_state.json')
const outPath = join(projectArtelDir, 'state.md')

const SECTIONS = ['For Owner', 'In progress', 'Pending', 'Blocked', 'Recently done']

const listDir = (dir, ext) =>
  existsSync(dir)
    ? readdirSync(dir).filter((f) => f.endsWith(ext)).map((f) => f.slice(0, -ext.length))
    : []
const knownRoles = () => listDir(agentsDir, '.md').filter((n) => n !== 'README')
const knownEngines = () => listDir(driversDir, '.mjs')

// --- input loaders ---

const parseQueue = (text) => {
  const out = Object.fromEntries(SECTIONS.map((s) => [s, []]))
  let cur = null
  let item = null
  const flush = () => { if (item && cur) out[cur].push(item); item = null }
  for (const line of text.split('\n')) {
    const sec = line.match(/^## (.+)$/)
    if (sec) { flush(); cur = SECTIONS.includes(sec[1]) ? sec[1] : null; continue }
    if (!cur) continue
    const bullet = line.match(/^- (.+)$/)
    if (bullet) { flush(); item = { text: bullet[1], details: [] }; continue }
    const cont = line.match(/^  (.+)$/)
    if (cont && item) item.details.push(cont[1])
  }
  flush()
  return out
}

const loadJson = (path) => {
  if (!existsSync(path)) return null
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}

const loadMetas = () =>
  existsSync(dispatchDir)
    ? readdirSync(dispatchDir).filter((n) => n.endsWith('.meta'))
        .map((n) => loadJson(join(dispatchDir, n))).filter(Boolean)
    : []

const loadEvents = () =>
  existsSync(eventsPath)
    ? readFileSync(eventsPath, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
        try { return [JSON.parse(line)] } catch { return [] }
      })
    : []

const gitOut = (cmd) => {
  try { return execSync(cmd, { cwd: projectDir, encoding: 'utf8' }).trim() || 'unknown' }
  catch { return 'unknown' }
}

// --- derivations ---

const slugify = (text) =>
  text.toLowerCase().replace(/`/g, '').replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 48) || 'unknown'

const taskIdOf = (item) => {
  const joined = [item.text, ...item.details].join(' ')
  const explicit = joined.match(/\btask:\s*([a-z0-9][a-z0-9-]{0,80})\b/i)
  return explicit ? explicit[1] : slugify(item.text)
}

// Branch convention: `<role|engine>/<slug>` (AGENTS.md§Branching).
// Role and engine names are project-defined — derive from filesystem.
const branchHint = (text) => {
  const names = [...knownRoles(), ...knownEngines()]
  if (names.length === 0) return 'unknown'
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`\\b(${names.map(escape).join('|')})/[a-z0-9-]+\\b`, 'i')
  return text.match(re)?.[1] || 'unknown'
}

const blockingClass = (bucket, text) => {
  if (bucket === 'For Owner') return 'owner'
  const t = text.toLowerCase()
  if (/provider-limit|rate limit|quota|resets at/.test(t)) return 'provider'
  if (/blocked|timeout|network|etimedout|hang/.test(t)) return 'infra'
  if (/review|panel|persona/.test(t)) return 'review'
  return 'none'
}

const reviewGate = (text) => {
  const t = text.toLowerCase()
  if (/accepted|done|shipped/.test(t)) return 'closed'
  if (/panel|review|stable/.test(t)) return 'open'
  return 'unknown'
}

const recentMetaForTask = (metas, task) => {
  const direct = metas.filter((m) => m.task === task)
  return direct.length
    ? direct.sort((a, b) => String(b.dispatchedAt || '').localeCompare(String(a.dispatchedAt || '')))[0]
    : null
}

const recentEventForTask = (events, task, type) => {
  const direct = events.filter((e) => e.task === task && (!type || e.type === type))
  return direct.length
    ? direct.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')))[0]
    : null
}

const activeTasks = (queue, metas, events) => {
  const out = []
  for (const bucket of ['For Owner', 'In progress', 'Pending', 'Blocked']) {
    for (const item of queue[bucket]) {
      if (item.text === '(none)') continue
      const fullText = [item.text, ...item.details].join(' ')
      const task = taskIdOf(item)
      const meta = recentMetaForTask(metas, task)
      // Accept legacy 'claim' alongside canonical 'dispatch.start' for one cycle.
      const claim = recentEventForTask(events, task, 'dispatch.start')
        || recentEventForTask(events, task, 'claim')
      out.push({
        task,
        queue_bucket: bucket,
        owner_role: meta?.role || claim?.owner_role || 'unknown',
        owner_provider: meta?.engine || claim?.owner_provider || 'unknown',
        branch: meta?.branch || claim?.branch || branchHint(fullText),
        latest_dispatch_id: meta?.dispatchId || null,
        review_gate: reviewGate(fullText),
        blocking_class: blockingClass(bucket, fullText),
      })
    }
  }
  return out
}

// --- output ---

const yamlEscape = (v) => JSON.stringify(v)
const yamlList = (xs, indent = '  ') =>
  xs.length === 0 ? '[]' : '\n' + xs.map((x) => `${indent}- ${x}`).join('\n')
const yamlObj = (entries, indent = '  ') =>
  '\n' + entries.map(([k, v]) => `${indent}${k}: ${yamlEscape(v ?? null)}`).join('\n')

const queue = existsSync(queuePath)
  ? parseQueue(readFileSync(queuePath, 'utf8'))
  : Object.fromEntries(SECTIONS.map((s) => [s, []]))
const metas = loadMetas()
const events = loadEvents()
const dispatcherState = loadJson(dispatcherStatePath)
const cluster = readClusterIdentity(projectArtelDir)
const tasks = activeTasks(queue, metas, events)

const frontmatter = `\
---
schema: state-v1
generated_at: ${yamlEscape(new Date().toISOString())}
canonical_inputs:
  - .artel/events.jsonl
  - .artel/.dispatches/*.meta
  - .artel/dispatcher_state.json
  - .artel/cluster.json
  - .artel/QUEUE.md
cluster:${yamlObj([
  ['id', cluster?.cluster_id ?? null],
  ['name', cluster?.name ?? null],
])}
repo:${yamlObj([
  ['branch', gitOut('git branch --show-current')],
  ['commit', gitOut('git rev-parse HEAD')],
])}
dispatcher:${yamlObj([
  ['role', dispatcherState?.role ?? null],
  ['provider', dispatcherState?.provider ?? null],
  ['control_status', dispatcherState?.control_status ?? null],
  ['session', dispatcherState?.session ?? null],
  ['orchestrator_engine', dispatcherState?.orchestrator_engine ?? null],
  ['orchestrator_session_id', dispatcherState?.orchestrator_session_id ?? null],
  ['last_action_at', dispatcherState?.last_action_at ?? null],
  ['last_action_kind', dispatcherState?.last_action_kind ?? null],
  ['last_action_task', dispatcherState?.last_action_task ?? null],
])}
tasks:${tasks.length === 0 ? ' []' : '\n' + tasks.map((t) => `  - ${
  Object.entries(t).map(([k, v]) => `${k}: ${yamlEscape(v)}`).join('\n    ')
}`).join('\n')}
---
`

// Optional human-glance body — a single ASCII table of active tasks.
// Keep minimal: no platform-narrative, no schema documentation (those
// belong in DESIGN.md, not in the projection).
const body = tasks.length === 0
  ? '> No active tasks.\n'
  : [
      '| Task | Bucket | Owner | Provider | Branch | Blocking | Review |',
      '|------|--------|-------|----------|--------|----------|--------|',
      ...tasks.map((t) =>
        `| ${t.task} | ${t.queue_bucket} | ${t.owner_role} | ${t.owner_provider} | ${t.branch} | ${t.blocking_class} | ${t.review_gate} |`),
      '',
    ].join('\n')

writeFileSync(outPath, frontmatter + '\n' + body)
console.log(`wrote ${outPath}`)
