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

import { writeFileSync } from 'node:fs'
import { readClusterIdentity } from '../core/cluster.mjs'
import { listDispatches } from '../core/dispatches.mjs'
import { QUEUE_SECTIONS as SECTIONS, readQueueMd } from '../core/queue_md.mjs'
import { tryGit } from '../git/git.mjs'
import { listDirBy, readJson, readJsonl } from '../util/fs.mjs'
import { config } from '../config/env.mjs'

const {
  projectDir,
  agentsDir,
  platformDriversDir: driversDir,
  artelDir: projectArtelDir,
  queuePath,
  dispatchesDir: dispatchDir,
  eventsPath,
  dispatcherStatePath,
  statePath: outPath,
} = config

const knownRoles = () => listDirBy(agentsDir, '.md').filter((n) => n !== 'README')
const knownEngines = () => listDirBy(driversDir, '.mjs')

const loadMetas = () => listDispatches(dispatchDir).map(({ meta }) => meta)

const gitOut = (args) => tryGit(projectDir, args) || 'unknown'

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

const queue = readQueueMd(queuePath).sections
const metas = loadMetas()
const events = readJsonl(eventsPath)
const dispatcherState = readJson(dispatcherStatePath)
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
  ['branch', gitOut(['branch', '--show-current'])],
  ['commit', gitOut(['rev-parse', 'HEAD'])],
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
