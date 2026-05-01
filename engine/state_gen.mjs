#!/usr/bin/env node

import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
// Platform dir holds the engine itself; project paths are per-consumer.
const platformDir = dirname(here)
const projectDir = process.env.COLLAB_PROJECT_DIR || process.cwd()
const projectCollabDir = join(projectDir, '.collab')
const repo = projectDir
const queuePath = join(projectCollabDir, 'QUEUE.md')
const dispatchDir = join(projectCollabDir, '.dispatches')
const eventsPath = join(projectCollabDir, 'events.jsonl')
const dispatcherStatePath = join(projectCollabDir, 'dispatcher_state.json')
const outPath = join(projectCollabDir, 'state.md')

const SECTIONS = ['For Owner', 'In progress', 'Pending', 'Blocked', 'Recently done']

function parseQueue(text) {
  const out = Object.fromEntries(SECTIONS.map((name) => [name, []]))
  let current = null
  let item = null

  const flush = () => {
    if (item && current) out[current].push(item)
    item = null
  }

  for (const line of text.split('\n')) {
    const sec = line.match(/^## (.+)$/)
    if (sec) {
      flush()
      current = SECTIONS.includes(sec[1]) ? sec[1] : null
      continue
    }
    if (!current) continue
    const bullet = line.match(/^- (.+)$/)
    if (bullet) {
      flush()
      item = { text: bullet[1], details: [], task: null }
      continue
    }
    const cont = line.match(/^  (.+)$/)
    if (cont && item) item.details.push(cont[1])
  }
  flush()
  return out
}

function loadMetas() {
  if (!existsSync(dispatchDir)) return []
  return readdirSync(dispatchDir)
    .filter((name) => name.endsWith('.meta'))
    .map((name) => {
      const path = join(dispatchDir, name)
      try {
        const meta = JSON.parse(readFileSync(path, 'utf8'))
        return { ...meta, __file: path }
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

function loadEvents() {
  if (!existsSync(eventsPath)) return []
  return readFileSync(eventsPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter((event) => event && event.type !== 'schema')
}

function loadDispatcherState() {
  if (!existsSync(dispatcherStatePath)) return null
  try {
    return JSON.parse(readFileSync(dispatcherStatePath, 'utf8'))
  } catch {
    return null
  }
}

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'unknown'
}

function taskIdOf(item) {
  const joined = [item.text, ...item.details].join(' ')
  const explicit = joined.match(/\btask:\s*([a-z0-9][a-z0-9-]{0,80})\b/i)
  return explicit ? explicit[1] : slugify(item.text)
}

function currentBranch() {
  try {
    return execSync('git branch --show-current', { cwd: repo, encoding: 'utf8' }).trim() || 'unknown'
  } catch {
    return 'unknown'
  }
}

function currentCommit() {
  try {
    return execSync('git rev-parse HEAD', { cwd: repo, encoding: 'utf8' }).trim() || 'unknown'
  } catch {
    return 'unknown'
  }
}

function recentMetaForTask(metas, task) {
  const direct = metas.filter((meta) => meta.task === task)
  if (direct.length === 0) return null
  return direct.sort((a, b) => String(b.dispatchedAt || '').localeCompare(String(a.dispatchedAt || '')))[0]
}

function recentEventForTask(events, task, type) {
  const direct = events.filter((event) => event.task === task && (!type || event.type === type))
  if (direct.length === 0) return null
  return direct.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')))[0]
}

function branchHint(text) {
  const match = text.match(/\b(claude|codex|dispatcher|orchestrator|architect|implementer|cold-reader|adversary|maintainer)\/[a-z0-9-]+\b/i)
  return match ? match[1] : 'unknown'
}

function blockingClass(bucket, text) {
  const joined = text.toLowerCase()
  if (bucket === 'For Owner') return 'anton'
  if (/provider-limit|rate limit|quota|resets at/.test(joined)) return 'provider'
  if (/blocked|timeout|network|etimedout|hang/.test(joined)) return 'infra'
  if (/review|panel|persona/.test(joined)) return 'review'
  return 'none'
}

function reviewGate(text) {
  const joined = text.toLowerCase()
  if (/accepted|done|shipped/.test(joined)) return 'closed'
  if (/panel|review|accepted|stable/.test(joined)) return 'open'
  return 'unknown'
}

function activeTasks(queue, metas, events) {
  const tasks = []
  for (const bucket of ['For Owner', 'In progress', 'Pending', 'Blocked']) {
    for (const item of queue[bucket]) {
      if (item.text === '(none)') continue
      const fullText = [item.text, ...item.details].join(' ')
      const task = taskIdOf(item)
      const meta = recentMetaForTask(metas, task)
      const claim = recentEventForTask(events, task, 'claim')
      tasks.push({
        task,
        queueBucket: bucket,
        ownerRole: meta?.role || claim?.owner_role || 'unknown',
        ownerProvider: meta?.engine || claim?.owner_provider || 'unknown',
        branch: meta?.branch || claim?.branch || branchHint(fullText),
        latestDispatch: meta?.task || 'unknown',
        reviewGate: reviewGate(fullText),
        blockingClass: blockingClass(bucket, fullText),
        summary: fullText,
      })
    }
  }
  return tasks
}

function yamlEscape(value) {
  return JSON.stringify(value)
}

const queue = parseQueue(readFileSync(queuePath, 'utf8'))
const metas = loadMetas()
const events = loadEvents()
const dispatcherState = loadDispatcherState()
const tasks = activeTasks(queue, metas, events)
const now = new Date().toISOString()

const frontmatter = [
  '---',
  'schema: state-v1',
  'status: active',
  'authoritative: true',
  'canonical_inputs:',
  '  - .collab/QUEUE.md',
  '  - .collab/.dispatches/*.meta',
  '  - .collab/events.jsonl',
  '  - .collab/dispatcher_state.json',
  'generator: <COLLAB_HOME>/engine/state_gen.mjs',
  `generated_at: ${yamlEscape(now)}`,
  `acting_role: ${yamlEscape(dispatcherState?.role || 'dispatcher')}`,
  `acting_provider: ${yamlEscape(dispatcherState?.provider || 'unknown')}`,
  `dispatcher_status: ${yamlEscape(dispatcherState?.control_status || 'unknown')}`,
  `dispatcher_session: ${yamlEscape(dispatcherState?.session || 'unknown')}`,
  `orchestrator_engine: ${yamlEscape(dispatcherState?.orchestrator_engine || 'unknown')}`,
  `orchestrator_session_id: ${yamlEscape(dispatcherState?.orchestrator_session_id || 'unknown')}`,
  `repo_branch: ${yamlEscape(currentBranch())}`,
  `repo_commit_baseline: ${yamlEscape(currentCommit())}`,
  'lifecycle_source: queue-buckets',
  'tasks:',
  ...tasks.flatMap((task) => [
    `  - task: ${yamlEscape(task.task)}`,
    `    queue_bucket: ${yamlEscape(task.queueBucket)}`,
    `    owner_role: ${yamlEscape(task.ownerRole)}`,
    `    owner_provider: ${yamlEscape(task.ownerProvider)}`,
    `    branch: ${yamlEscape(task.branch)}`,
    `    latest_dispatch: ${yamlEscape(task.latestDispatch)}`,
    `    review_gate: ${yamlEscape(task.reviewGate)}`,
    `    blocking_class: ${yamlEscape(task.blockingClass)}`,
  ]),
  '---',
  '',
].join('\n')

const body = [
  '> Generated snapshot of coordination state. Source-of-truth: .collab/QUEUE.md + .dispatches/*.meta + events.jsonl. Regenerate via `node $COLLAB_HOME/engine/state_gen.mjs`.',
  '',
  '# State Draft v2',
  '',
  '## Generator Status',
  '',
  '- Generated from canonical inputs listed in frontmatter.',
  '- This is a snapshot, not a writable source of truth.',
  `- Events log present: ${existsSync(eventsPath) ? 'yes' : 'no'}.`,
  `- Dispatcher state present: ${dispatcherState ? 'yes' : 'no'}.`,
  '- Unknown-heavy output is expected at this stage; the generator is also a gap detector.',
  '',
  '## Dispatcher',
  '',
  `- Role: ${dispatcherState?.role || 'dispatcher'}`,
  `- Provider: ${dispatcherState?.provider || 'unknown'}`,
  `- Control status: ${dispatcherState?.control_status || 'unknown'}`,
  `- Session: ${dispatcherState?.session || 'unknown'}`,
  `- Orchestrator engine: ${dispatcherState?.orchestrator_engine || 'unknown'}`,
  `- Orchestrator session id: ${dispatcherState?.orchestrator_session_id || 'unknown'}`,
  `- Last action at: ${dispatcherState?.last_action_at || 'unknown'}`,
  `- Last action kind: ${dispatcherState?.last_action_kind || 'unknown'}`,
  `- Last action task: ${dispatcherState?.last_action_task || 'unknown'}`,
  '',
  '## Field Ownership Matrix',
  '',
  '| Field | Owner | Write moment | Source in v2 |',
  '|-------|-------|--------------|--------------|',
  '| `task` | generator-derived | snapshot generation | explicit `task: <slug>` marker in `QUEUE.md`; slugified prose only as legacy fallback |',
  '| `queue_bucket` | generator-derived | snapshot generation | `QUEUE.md` section |',
  '| `owner_role` | `spawn.mjs` at dispatch | claim moment | `.meta.role` |',
  '| `owner_provider` | `spawn.mjs` at dispatch | claim moment | `.meta.engine` |',
  '| `branch` | `spawn.mjs` at dispatch | claim moment | `.meta.branch` once written; `unknown` until then |',
  '| `latest_dispatch` | generator-derived | snapshot generation | newest `.meta.task` for task |',
  '| `review_gate` | orchestrator after decision | review-state transition | `events.jsonl` review/panel events; heuristic fallback from queue prose |',
  '| `blocking_class` | dispatcher manually or orchestrator | observed state transition | `events.jsonl` blocker/escalation events; heuristic fallback from queue prose |',
  '| `last_completed_step` | sub-role itself or orchestrator | checkpoint moment | `events.jsonl` `checkpoint` event |',
  '| `next_safe_step` | sub-role itself or orchestrator | checkpoint/release moment | `events.jsonl` `checkpoint` or `release` event |',
  '| `authoritative_design_artefact` | orchestrator after decision | when authority changes | `events.jsonl` authority-bearing event |',
  '| `authoritative_implementation_artefact` | orchestrator or implementer | when branch/file authority changes | `events.jsonl` authority-bearing event |',
  '| `authoritative_review_artefact` | dispatcher or orchestrator | after panel/review result | `events.jsonl` review-result event |',
  '| `notes_for_replacement_provider` | generator-derived | snapshot generation | current queue prose until a dedicated field exists |',
  '| `rejected_options / no-reopen notes` | orchestrator after decision | decision close-out | `events.jsonl` decision/release event |',
  '',
  'Rule: if a field has no owner, it will remain `unknown` forever. The owner is part of the contract.',
  '',
  '## Stable Task ID Choice',
  '',
  'Choice: explicit `task: <slug>` marker in `QUEUE.md` is the canonical task id.',
  '',
  'Rationale:',
  '',
  '- task ids must exist before dispatch, branch creation, or successful completion;',
  '- branch names are role-prefixed deployment details, not the canonical identity;',
  '- prose-derived slugs drift on wording edits and truncate badly;',
  '- explicit ids make queue ↔ meta ↔ events joins deterministic.',
  '',
  'Fallback in v3:',
  '',
  '- if no explicit `task:` marker exists, the generator falls back to slugified queue prose for legacy entries;',
  '- branch / meta matching remains best-effort only and should not be treated as canonical.',
  '',
  '## Event Taxonomy',
  '',
  '`events.jsonl` is append-only. One JSON object per line.',
  '',
  'Core event kinds:',
  '',
  '| Event | Required fields | Optional fields | Primary writer |',
  '|-------|-----------------|-----------------|----------------|',
  '| `claim` | `type`, `at`, `task`, `queue_bucket`, `owner_role`, `owner_provider` | `branch`, `engine`, `prompt_ref`, `notes`, `task_attrs` | `spawn.mjs` at dispatch |',
  '| `checkpoint` | `type`, `at`, `task`, `owner_role`, `owner_provider`, `last_completed_step`, `next_safe_step` | `branch`, `authoritative_design_artefact`, `authoritative_implementation_artefact`, `authoritative_review_artefact`, `notes` | sub-role itself or orchestrator |',
  '| `release` | `type`, `at`, `task`, `owner_role`, `owner_provider`, `disposition` | `next_safe_step`, `notes`, `replacement_task`, `blocking_class`, `task_attrs` | `spawn.mjs` at exit or dispatcher manually |',
  '| `escalation` | `type`, `at`, `task`, `from_role`, `to_role`, `reason` | `notes`, `blocking_class`, `artefact` | dispatcher or orchestrator |',
  '| `review-result` | `type`, `at`, `task`, `artefact`, `review_kind`, `gate_state` | `required_reviewers`, `completed_reviewers`, `open_findings`, `notes` | dispatcher or orchestrator |',
  '| `anton-answer` | `type`, `at`, `topic`, `blocking_class`, `answer` | `task`, `artefact`, `notes`, `unblocks` | dispatcher manually |',
  '| `parked` | `type`, `at`, `task`, `reason` | `reset_at`, `raw`, `engine`, `notes`, `task_attrs` | `spawn.mjs` at exit or dispatcher manually |',
  '| `unparked` | `type`, `at`, `task`, `reason` | `notes` | dispatcher manually |',
  '| `superseded` | `type`, `at`, `task`, `replacement_task` | `notes` | dispatcher or orchestrator |',
  '',
  'Event field rules:',
  '',
  '- Required fields must always be present, even if some values are `unknown`.',
  '- Optional fields are omitted when not known.',
  '- `at` is always ISO-8601 UTC.',
  '- Writers append events; they do not rewrite prior lines.',
  '- Snapshot generation may derive state from events, but events remain the lineage source.',
  '',
  '## Active Tasks Snapshot',
  '',
  '| Task | Queue bucket | Owner role | Provider | Branch | Blocking | Review gate |',
  '|------|--------------|------------|----------|--------|----------|-------------|',
  ...tasks.map((task) =>
    `| ${task.task} | ${task.queueBucket} | ${task.ownerRole} | ${task.ownerProvider} | ${task.branch} | ${task.blockingClass} | ${task.reviewGate} |`,
  ),
  '',
  '## Task Records',
  '',
  ...tasks.flatMap((task) => [
    `### \`${task.task}\``,
    '',
    `- Queue bucket: ${task.queueBucket}`,
    `- Owner role: ${task.ownerRole}`,
    `- Owner provider: ${task.ownerProvider}`,
    `- Branch: ${task.branch}`,
    `- Latest dispatch: ${task.latestDispatch}`,
    `- Review gate: ${task.reviewGate}`,
    `- Blocking class: ${task.blockingClass}`,
    '- Last completed step: unknown',
    '- Next safe step: unknown',
    '- Authoritative design artefact: unknown',
    '- Authoritative implementation artefact: unknown',
    '- Authoritative review artefact: unknown',
    `- Notes for replacement provider: ${task.summary}`,
    '- Rejected options / no-reopen notes: unknown',
    '',
  ]),
  '## Acceptance Test',
  '',
  'A cold replacement provider should be able to read this file first, then',
  'continue with minimal archaeology. Any `unknown` field here is a concrete',
  'resume gap to close in the next iteration.',
  '',
].join('\n')

writeFileSync(outPath, frontmatter + body)
console.log(`wrote ${outPath}`)
