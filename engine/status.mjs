#!/usr/bin/env node
// Status snapshot for the collab agent platform — see AGENTS.md.
// Reads project-local runtime (.collab/QUEUE/state/events/journal/dispatcher_state),
// platform-wide role files (agents/<role>.md), open agent branches, and
// provider session jsonl files for token accounting; prints a single-screen
// text summary with token usage charts.
//
//   node $COLLAB_HOME/engine/status.mjs              # one-shot snapshot
//   node $COLLAB_HOME/engine/status.mjs --watch      # dashboard mode, refresh every 30s
//   node $COLLAB_HOME/engine/status.mjs --watch 10   # refresh every 10s

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
// Platform dir: agents/ + engine/ skeleton, reusable across projects.
const PLATFORM_DIR = dirname(here)
// Project paths: each consuming repo holds its own .collab/ runtime. Resolve
// from cwd (or env override) — never from `here`, since one platform serves
// many projects.
const PROJECT_DIR = process.env.COLLAB_PROJECT_DIR || process.cwd()
const PROJECT_COLLAB = join(PROJECT_DIR, '.collab')
const PROJECT_NAME = basename(PROJECT_DIR)
const STATE_PATH = join(PROJECT_COLLAB, 'state.md')
const EVENTS_PATH = join(PROJECT_COLLAB, 'events.jsonl')
const DISPATCHER_STATE_PATH = join(PROJECT_COLLAB, 'dispatcher_state.json')
const CLAUDE_PROJECT_DIR = join(
  homedir(),
  '.claude/projects',
  '-' + PROJECT_DIR.replace(/^\//, '').replace(/\//g, '-'),
)
const CODEX_SESSIONS_DIR = join(homedir(), '.codex/sessions')
const COPILOT_SESSION_DIR = join(homedir(), '.copilot/session-state')
const DAYS = 7

// --- formatting ---

const tty = process.stdout.isTTY
const c = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s)
const bold = (s) => c('1', s)
const dim = (s) => c('2', s)
const cyan = (s) => c('36', s)
const yellow = (s) => c('33', s)

const fmt = (n) => {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'
  if (n >= 1e3) return Math.round(n / 1e3) + 'k'
  return String(n)
}

const truncate = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s)

const bar = (val, max, width = 20) => {
  if (max === 0) return '░'.repeat(width)
  const filled = Math.round((val / max) * width)
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

const SPARK = '▁▂▃▄▅▆▇█'
const sparkChar = (val, max) => {
  if (max === 0 || val === 0) return SPARK[0]
  return SPARK[Math.min(7, Math.max(1, Math.round((val / max) * 7)))]
}

const cutoff = (days) => Date.now() - days * 86400000
const dayKey = (ts) => new Date(ts).toISOString().slice(0, 10)

const relativeTime = (iso) => {
  const ms = Date.now() - Date.parse(iso.replace(' ', 'T') + (iso.endsWith('Z') ? '' : 'Z'))
  if (isNaN(ms)) return '?'
  const min = Math.round(ms / 60000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const d = Math.floor(hr / 24)
  return `${d}d ago`
}
const dayLabel = (iso) => {
  const d = new Date(iso + 'T00:00:00Z')
  const m = d.toLocaleString('en', { month: 'short', timeZone: 'UTC' })
  return `${m} ${String(d.getUTCDate()).padStart(2)}`
}

// --- QUEUE parsing ---

const SECTIONS = ['For Owner', 'In progress', 'Pending', 'Blocked', 'Recently done']

const parseQueue = () => {
  const text = readFileSync(join(PROJECT_COLLAB, 'QUEUE.md'), 'utf8')
  const out = Object.fromEntries(SECTIONS.map((s) => [s, []]))
  let cur = null
  let item = null
  const flush = () => {
    if (item && cur) out[cur].push(item)
    item = null
  }
  for (const line of text.split('\n')) {
    const sec = line.match(/^## (.+)$/)
    if (sec) {
      flush()
      cur = SECTIONS.includes(sec[1]) ? sec[1] : null
      continue
    }
    if (!cur) continue
    const li = line.match(/^- (.+)$/)
    if (li) {
      flush()
      item = li[1]
      continue
    }
    const cont = line.match(/^  (.+)$/)
    if (cont && item) item += ' ' + cont[1]
  }
  flush()
  for (const k of SECTIONS) out[k] = out[k].filter((s) => !s.startsWith('(none)'))
  return out
}

// --- Claude tokens ---

const getClaudeTokens = (days = DAYS) => {
  const totals = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }
  const perDay = {}
  const since = cutoff(days)
  if (!existsSync(CLAUDE_PROJECT_DIR)) return { totals, perDay }
  for (const f of readdirSync(CLAUDE_PROJECT_DIR)) {
    if (!f.endsWith('.jsonl')) continue
    const content = readFileSync(join(CLAUDE_PROJECT_DIR, f), 'utf8')
    for (const line of content.split('\n')) {
      if (!line) continue
      let e
      try { e = JSON.parse(line) } catch { continue }
      if (e.type !== 'assistant') continue
      const ts = Date.parse(e.timestamp)
      if (!ts || ts < since) continue
      const u = e.message?.usage
      if (!u) continue
      totals.input += u.input_tokens || 0
      totals.output += u.output_tokens || 0
      totals.cacheRead += u.cache_read_input_tokens || 0
      totals.cacheCreation += u.cache_creation_input_tokens || 0
      const day = dayKey(ts)
      perDay[day] = (perDay[day] || 0) + (u.output_tokens || 0)
    }
  }
  return { totals, perDay }
}

// --- Shared telemetry feed (provider-neutral) ---

const parseStateFrontmatter = () => {
  if (!existsSync(STATE_PATH)) return null
  const text = readFileSync(STATE_PATH, 'utf8')
  const m = text.match(/^---\n([\s\S]*?)\n---/)
  if (!m) return null
  const meta = {}
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/)
    if (kv) meta[kv[1]] = kv[2].replace(/^"|"$/g, '')
  }
  return meta
}

const readDispatcherState = () => {
  if (!existsSync(DISPATCHER_STATE_PATH)) return null
  try {
    return JSON.parse(readFileSync(DISPATCHER_STATE_PATH, 'utf8'))
  } catch {
    return null
  }
}

const readEvents = () => {
  if (!existsSync(EVENTS_PATH)) return []
  return readFileSync(EVENTS_PATH, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line) } catch { return null }
    })
    .filter((e) => e && e.type !== 'schema')
}

const summarizeEvent = (e) => {
  // dispatch.start / dispatch.end are canonical (DESIGN.md §4.5); legacy
  // 'claim' / 'release' accepted for one back-compat cycle.
  if (e.type === 'dispatch.start' || e.type === 'claim') {
    const actor = e.owner_role || 'agent'
    return `${actor} claimed ${e.task}${e.branch ? ` on ${e.branch}` : ''}`
  }
  if (e.type === 'dispatch.end' || e.type === 'release') {
    const actor = e.owner_role || 'agent'
    return `${actor} released ${e.task} (${e.disposition || 'unknown'})`
  }
  if (e.type === 'review-result') {
    return `review ${e.review_kind || '?'} on ${e.task || e.artefact} → gate ${e.gate_state || '?'}`
  }
  if (e.type === 'anton-answer') {
    return `owner answered ${e.topic || e.task || '?'}`
  }
  if (e.type === 'parked') {
    return `${e.task} parked (${e.reason || 'unknown'})`
  }
  if (e.type === 'unparked') {
    return `${e.task} unparked (${e.reason || 'unknown'})`
  }
  if (e.type === 'escalation') {
    return `${e.from_role || '?'} → ${e.to_role || '?'} on ${e.task} (${e.reason || 'unknown'})`
  }
  if (e.type === 'superseded') {
    return `${e.task} superseded by ${e.replacement_task || '?'}`
  }
  if (e.type === 'checkpoint') {
    return `${e.task} checkpoint: ${e.last_completed_step || '?'} → ${e.next_safe_step || '?'}`
  }
  return `${e.type} ${e.task || e.topic || ''}`.trim()
}

const getSharedFeed = (n = 5) => {
  const out = []
  const state = parseStateFrontmatter()
  if (state?.generated_at) {
    out.push({
      ts: state.generated_at,
      role: 'state',
      text: `snapshot generated (${state.acting_role || 'unknown'}/${state.acting_provider || 'unknown'})`,
    })
  }
  for (const e of readEvents()) {
    const role = e.owner_role || e.from_role || e.type
    out.push({ ts: e.at, role, text: summarizeEvent(e) })
  }
  return out
    .filter((x) => x.ts && x.text)
    .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))
    .slice(0, n)
}

const getDispatcherStatus = () => {
  const disk = readDispatcherState()
  const state = parseStateFrontmatter()
  return {
    role: disk?.role || state?.acting_role || 'dispatcher',
    provider: disk?.provider || state?.acting_provider || 'unknown',
    controlStatus: disk?.control_status || state?.dispatcher_status || 'unknown',
    session: disk?.session || state?.dispatcher_session || 'unknown',
    orchestratorEngine: disk?.orchestrator_engine || state?.orchestrator_engine || 'unknown',
    orchestratorSessionId: disk?.orchestrator_session_id || state?.orchestrator_session_id || 'unknown',
    lastActionAt: disk?.last_action_at || state?.generated_at || null,
    lastActionKind: disk?.last_action_kind || 'snapshot-generated',
    lastActionTask: disk?.last_action_task || null,
    notes: disk?.notes || null,
  }
}

// --- Recent dispatches (read .out files) ---

const ROLES = ['orchestrator', 'architect', 'implementer', 'cold-reader', 'adversary', 'maintainer']

const getRecentDispatches = (n = 5) => {
  const dir = join(PROJECT_COLLAB, '.dispatches')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.out'))
    .map((f) => {
      const path = join(dir, f)
      const stat = statSync(path)
      const base = f.replace(/\.out$/, '')
      let summary = ''
      let head = ''
      try {
        const content = readFileSync(path, 'utf8').trim()
        summary = content.split('\n').find((l) => l.trim()) || ''
        head = content.slice(0, 512)
      } catch {}
      // Prefer meta sidecar (written by spawn.mjs) — authoritative for role+engine+task
      let role = null
      let engine = null
      let task = null
      let usage = null
      let retryCount = 0
      let dispatchId = null
      let traceId = null
      const metaPath = join(dir, `${base}.meta`)
      if (existsSync(metaPath)) {
        try {
          const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
          role = meta.role
          engine = meta.engine
          task = meta.task
          usage = meta.usage || null
          retryCount = meta.retryCount || 0
          dispatchId = meta.dispatchId || null
          traceId = meta.traceId || null
        } catch {}
      }
      // Legacy fallback: detect from filename (`<role>-<task>.out`) and content
      if (!role) role = ROLES.find((r) => f.startsWith(r + '-')) || '?'
      if (!engine) {
        if (/OpenAI Codex/.test(head)) engine = 'codex'
        else if (/Copilot CLI/i.test(head)) engine = 'copilot'
        else engine = roleEngineFromFile(role) || 'claude'
      }
      if (!task) {
        // Strip role prefix from base if present
        task = role !== '?' && f.startsWith(role + '-') ? base.slice(role.length + 1) : base
      }
      const version = probeEngineVersion(engine)
      return { role, mtime: stat.mtimeMs, summary, engine, version, task, usage, retryCount, dispatchId, traceId }
    })
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, n)
}

// --- Parked dispatches (recoverable tail markers) ---

const getParked = () => {
  const dir = join(PROJECT_COLLAB, '.dispatches')
  if (!existsSync(dir)) return []
  const out = []
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.meta')) continue
    try {
      const meta = JSON.parse(readFileSync(join(dir, f), 'utf8'))
      if (meta.parked && meta.completedAt) out.push(meta)
    } catch {}
  }
  return out
    .sort((a, b) => Date.parse(b.completedAt) - Date.parse(a.completedAt))
    .slice(0, 10)
}

const getTimedOut = () => {
  const dir = join(PROJECT_COLLAB, '.dispatches')
  if (!existsSync(dir)) return []
  const out = []
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.meta')) continue
    try {
      const meta = JSON.parse(readFileSync(join(dir, f), 'utf8'))
      if (meta.status === 'timed-out' && meta.completedAt) out.push(meta)
    } catch {}
  }
  return out
    .sort((a, b) => Date.parse(b.completedAt) - Date.parse(a.completedAt))
    .slice(0, 10)
}

// --- Running subprocesses ---

const ENGINE_VERSION_CACHE = {}

const probeEngineVersion = (engine) => {
  if (ENGINE_VERSION_CACHE[engine] !== undefined) return ENGINE_VERSION_CACHE[engine]
  let cmd
  if (engine === 'claude') cmd = 'claude --version'
  else if (engine === 'codex') cmd = 'codex --version'
  else if (engine === 'copilot') cmd = 'gh copilot -- --version'
  else { ENGINE_VERSION_CACHE[engine] = '?'; return '?' }
  try {
    const out = execSync(cmd, { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    const m = out.match(/\d+\.\d+\.\d+/)
    ENGINE_VERSION_CACHE[engine] = m ? m[0] : (out.split('\n')[0] || '?').slice(0, 12)
  } catch {
    ENGINE_VERSION_CACHE[engine] = '?'
  }
  return ENGINE_VERSION_CACHE[engine]
}

const parseRunArgs = (command) => {
  const m = command.match(/run\.mjs\s+(.+)$/)
  if (!m) return { role: null, engine: null }
  const tokens = m[1].split(/\s+/)
  let role = null
  let engine = null
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === '--engine' && tokens[i + 1]) {
      engine = tokens[++i]
    } else if ((tokens[i] === '--resume' || tokens[i] === '--session-id') && tokens[i + 1]) {
      i++
      continue
    } else if (tokens[i].startsWith('-')) {
      continue
    } else if (!role) {
      role = tokens[i]
    }
  }
  return { role, engine }
}

const roleEngineFromFile = (role) => {
  try {
    const text = readFileSync(join(PLATFORM_DIR, 'agents', `${role}.md`), 'utf8')
    const fm = text.match(/^---\n([\s\S]*?)\n---/)
    if (!fm) return null
    const eng = fm[1].match(/^engine:\s*(\S+)/m)
    return eng ? eng[1] : null
  } catch {
    return null
  }
}

const readMetaByPid = () => {
  const dir = join(PROJECT_COLLAB, '.dispatches')
  if (!existsSync(dir)) return new Map()
  const m = new Map()
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.meta')) continue
    try {
      const meta = JSON.parse(readFileSync(join(dir, f), 'utf8'))
      if (meta.pid && !meta.completedAt) m.set(String(meta.pid), meta)
    } catch {}
  }
  return m
}

const getRunning = () => {
  try {
    const out = execSync(
      `ps -axo pid,etime,command | grep -E "node.*engine/run\\.mjs" | grep -v grep || true`,
      { encoding: 'utf8' },
    )
    const metaByPid = readMetaByPid()
    return out
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const m = line.trim().match(/^(\d+)\s+(\S+)\s+(.+)$/)
        if (!m) return null
        const command = m[3]
        if (!/^(?:\S+\/)?node\b/.test(command)) return null
        const meta = metaByPid.get(m[1])
        const { role: cliRole, engine: cliEngine } = parseRunArgs(command)
        const role = (meta && meta.role) || cliRole
        if (!role) return null
        const engine = (meta && meta.engine) || cliEngine || roleEngineFromFile(role) || 'claude'
        const version = probeEngineVersion(engine)
        const task = meta ? meta.task : null
        return { pid: m[1], etime: m[2], role, engine, version, task }
      })
      .filter(Boolean)
  } catch {
    return []
  }
}

// --- Codex tokens (delta-based, cumulative source) ---

const walkJsonl = (dir) => {
  if (!existsSync(dir)) return []
  const out = []
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    const s = statSync(p)
    if (s.isDirectory()) out.push(...walkJsonl(p))
    else if (e.endsWith('.jsonl')) out.push(p)
  }
  return out
}

const getCodexTokens = (days = DAYS) => {
  const totals = { input: 0, output: 0, cached: 0 }
  const perDay = {}
  const since = cutoff(days)
  for (const path of walkJsonl(CODEX_SESSIONS_DIR)) {
    if (statSync(path).mtimeMs < since) continue
    const content = readFileSync(path, 'utf8')
    let inProject = false
    let prev = { input: 0, output: 0, cached: 0 }
    for (const line of content.split('\n')) {
      if (!line) continue
      let e
      try { e = JSON.parse(line) } catch { continue }
      if (e.type === 'session_meta') {
        const cwd = e.payload?.cwd || ''
        inProject = cwd.includes(PROJECT_NAME)
        if (!inProject) break
        continue
      }
      if (!inProject) continue
      if (e.type !== 'event_msg') continue
      const p = e.payload
      if (p?.type !== 'token_count') continue
      const tot = p.info?.total_token_usage
      if (!tot) continue
      const ts = Date.parse(e.timestamp)
      const di = (tot.input_tokens || 0) - prev.input
      const dop = (tot.output_tokens || 0) - prev.output
      const dc = (tot.cached_input_tokens || 0) - prev.cached
      const reset = di < 0 || dop < 0
      const ai = reset ? (tot.input_tokens || 0) : di
      const ao = reset ? (tot.output_tokens || 0) : dop
      const ac = reset ? (tot.cached_input_tokens || 0) : dc
      totals.input += ai
      totals.output += ao
      totals.cached += ac
      if (ts && ts >= since) {
        const day = dayKey(ts)
        perDay[day] = (perDay[day] || 0) + ao
      }
      prev = {
        input: tot.input_tokens || 0,
        output: tot.output_tokens || 0,
        cached: tot.cached_input_tokens || 0,
      }
    }
  }
  return { totals, perDay }
}

// --- Copilot tokens (per-session shutdown events) ---

const getCopilotTokens = (days = DAYS) => {
  const totals = { input: 0, output: 0, cached: 0, reasoning: 0 }
  const perDay = {}
  const since = cutoff(days)
  if (!existsSync(COPILOT_SESSION_DIR)) return { totals, perDay }
  for (const sid of readdirSync(COPILOT_SESSION_DIR)) {
    const dir = join(COPILOT_SESSION_DIR, sid)
    let isDir = false
    try { isDir = statSync(dir).isDirectory() } catch {}
    if (!isDir) continue
    const wsPath = join(dir, 'workspace.yaml')
    const evPath = join(dir, 'events.jsonl')
    if (!existsSync(wsPath) || !existsSync(evPath)) continue
    if (statSync(evPath).mtimeMs < since) continue
    let inProject = false
    try {
      const ws = readFileSync(wsPath, 'utf8')
      const cwdMatch = ws.match(/^cwd:\s*(.+)$/m)
      if (cwdMatch && cwdMatch[1].includes(PROJECT_NAME)) inProject = true
    } catch {}
    if (!inProject) continue
    const content = readFileSync(evPath, 'utf8')
    for (const line of content.split('\n')) {
      if (!line) continue
      let e
      try { e = JSON.parse(line) } catch { continue }
      if (e.type !== 'session.shutdown') continue
      const m = e.data?.modelMetrics
      if (!m) continue
      const ts = Date.parse(e.timestamp)
      let dayOut = 0
      for (const model of Object.keys(m)) {
        const u = m[model].usage || {}
        totals.input += u.inputTokens || 0
        totals.output += u.outputTokens || 0
        totals.cached += u.cacheReadTokens || 0
        totals.reasoning += u.reasoningTokens || 0
        dayOut += u.outputTokens || 0
      }
      if (ts && ts >= since && dayOut > 0) {
        const day = dayKey(ts)
        perDay[day] = (perDay[day] || 0) + dayOut
      }
    }
  }
  return { totals, perDay }
}

// --- render ---

const renderFeed = (items) => {
  let out = `\n${bold('FEED')} ${dim('(shared telemetry, last 5 events)')}\n`
  if (!items.length) return out + `  ${dim('(none)')}\n`
  const cols = process.stdout.columns || 120
  const trunc = Math.min(140, cols - 18)
  for (const t of items) {
    const time = new Date(t.ts).toISOString().slice(11, 16)
    const role = (t.role === 'the owner' ? yellow(t.role.padEnd(12)) : cyan(String(t.role).padEnd(12)))
    const text = t.text.replace(/\s+/g, ' ')
    out += `  ${dim(time)}  ${role}  ${truncate(text, trunc)}\n`
  }
  return out
}

const renderRunning = (dispatcher, procs) => {
  let out = `\n${bold('RUNNING')} ${dim('(background subprocesses)')}\n`
  const status = dispatcher.controlStatus === 'active' ? yellow(dispatcher.controlStatus) : dim(dispatcher.controlStatus)
  const last = dispatcher.lastActionAt ? relativeTime(dispatcher.lastActionAt) : '?'
  const orch = `${dispatcher.orchestratorEngine}/${dispatcher.orchestratorSessionId ? truncate(dispatcher.orchestratorSessionId, 12) : 'unknown'}`
  out += `  ${cyan(String(dispatcher.role).padEnd(13))}  ${truncate('(shared control actor)', 30).padEnd(30)}  ${dim(`${dispatcher.provider} / ${dispatcher.session}`.padEnd(18))}  ${dim('status')} ${status}  ${dim('last')} ${last}\n`
  out += `  ${dim(' '.repeat(15) + `orchestrator ${orch}`)}`
  if (dispatcher.lastActionTask || dispatcher.lastActionKind) {
    out += `${dim(' · ')}${dispatcher.lastActionKind || 'unknown'}`
    if (dispatcher.lastActionTask) out += ` → ${dispatcher.lastActionTask}`
  }
  out += '\n'
  if (!procs.length) return out
  for (const p of procs) {
    const role = cyan(p.role.padEnd(13))
    const exec = `${p.engine} ${p.version}`
    const task = p.task ? truncate(p.task, 28) : dim('—')
    out += `  ${role}  ${task.padEnd(30)}  ${dim(exec.padEnd(18))}  ${dim('pid')} ${p.pid}  ${dim(p.etime)}\n`
  }
  return out
}

const renderRecent = (items) => {
  const cols = process.stdout.columns || 120
  const trunc = Math.min(110, cols - 100)
  let out = `\n${bold('RECENT')} ${dim('(last 5 dispatches)')}\n`
  if (!items.length) return out + `  ${dim('(none)')}\n`
  for (const item of items) {
    const age = relativeTime(new Date(item.mtime).toISOString())
    const role = cyan(item.role.padEnd(13))
    const exec = `${item.engine} ${item.version}`
    const task = item.task ? truncate(item.task, 28).padEnd(30) : ' '.repeat(30)
    // Suffix with usage / retry signals when present (DESIGN.md §C5–C6).
    const annot = []
    if (item.usage && (item.usage.tokens_in || item.usage.tokens_out)) {
      annot.push(`${fmt(item.usage.tokens_in || 0)}/${fmt(item.usage.tokens_out || 0)}t`)
    }
    if (item.retryCount > 0) annot.push(yellow(`r${item.retryCount}`))
    const annotStr = annot.length ? `${dim('[')}${annot.join(' ')}${dim(']')} ` : ''
    const summary = truncate(item.summary.replace(/\s+/g, ' '), trunc)
    out += `  ${dim(age.padEnd(9))} ${role} ${dim(exec.padEnd(18))} ${task} ${annotStr}${summary}\n`
  }
  return out
}

const renderParked = (items) => {
  if (!items.length) return ''
  const cols = process.stdout.columns || 120
  const trunc = Math.min(80, cols - 90)
  let out = `\n${bold('PARKED')} ${dim('(recoverable dispatch failures)')}\n`
  for (const p of items) {
    const role = cyan((p.role || '?').padEnd(13))
    const exec = `${p.engine || 'claude'} ${probeEngineVersion(p.engine || 'claude')}`
    const task = p.task ? truncate(p.task, 28).padEnd(30) : ' '.repeat(30)
    const reset = p.parked.reason === 'auth-expired'
      ? 'relogin required'
      : p.parked.resetAt ? `resets ${p.parked.resetAt}` : dim('no reset time')
    const raw = truncate((p.parked.raw || '').replace(/\s+/g, ' '), Math.max(20, trunc))
    out += `  ${role}  ${dim(exec.padEnd(18))}  ${task}  ${reset.padEnd(20)}  ${dim(raw)}\n`
  }
  return out
}

const renderTimedOut = (items) => {
  if (!items.length) return ''
  const cols = process.stdout.columns || 120
  const trunc = Math.min(80, cols - 90)
  let out = `\n${bold('TIMED-OUT')} ${dim('(dispatch timeout releases)')}\n`
  for (const p of items) {
    const role = cyan((p.role || '?').padEnd(13))
    const exec = `${p.engine || 'claude'} ${probeEngineVersion(p.engine || 'claude')}`
    const task = p.task ? truncate(p.task, 28).padEnd(30) : ' '.repeat(30)
    const timeout = p.timeout?.timeoutMs ? `timeout ${p.timeout.timeoutMs}ms` : 'timeout'
    const raw = truncate(
      [`exit ${p.exitCode ?? '?'}`, p.timeout?.signal].filter(Boolean).join(' · '),
      Math.max(20, trunc),
    )
    out += `  ${role}  ${dim(exec.padEnd(18))}  ${task}  ${timeout.padEnd(20)}  ${dim(raw)}\n`
  }
  return out
}

const renderQueue = (q) => {
  const cols = process.stdout.columns || 120
  const trunc = Math.min(120, cols - 4)
  const counts = SECTIONS.map((s) => {
    const n = q[s].length
    const v = `${s}: ${n}`
    return s === 'For Owner' && n > 0 ? yellow(v) : v
  }).join('    ')
  let out = `\n${bold('QUEUE')}\n  ${counts}\n`
  if (q['For Owner'].length) {
    out += `\n${bold('FOR ANTON')}\n`
    for (const it of q['For Owner']) out += `  ${yellow('•')} ${truncate(it, trunc)}\n`
  }
  if (q['In progress'].length) {
    out += `\n${bold('ACTIVE')} ${dim('(in progress)')}\n`
    for (const it of q['In progress']) {
      const m = it.match(/\[since ([^\]]+)\]/)
      const since = m ? m[1].trim() : null
      const cleaned = m ? it.replace(/\s*\[since [^\]]+\]/, '').trim() : it
      const prefix = since ? dim(relativeTime(since).padEnd(9)) : ' '.repeat(9)
      out += `  ${prefix}${truncate(cleaned, trunc - 11)}\n`
    }
  }
  return out
}

const renderTokens = (claude, codex, copilot) => {
  const rows = [
    {
      label: 'Claude',
      input: claude.totals.input + claude.totals.cacheCreation + claude.totals.cacheRead,
      output: claude.totals.output,
      cached: claude.totals.cacheRead,
    },
    {
      label: 'Codex',
      input: codex.totals.input + codex.totals.cached,
      output: codex.totals.output,
      cached: codex.totals.cached,
    },
    {
      label: 'Copilot',
      input: copilot.totals.input + copilot.totals.cached,
      output: copilot.totals.output,
      cached: copilot.totals.cached,
    },
  ]
  const max = Math.max(...rows.map((x) => x.output), 1)
  let out = `\n${bold('TOKENS')} ${dim(`(last ${DAYS}d, project-scoped)`)}\n`
  for (const x of rows) {
    const cachePct = x.input > 0 ? Math.round((x.cached / x.input) * 100) : 0
    out +=
      `  ${x.label.padEnd(8)} ${bar(x.output, max)}   ` +
      `out: ${fmt(x.output).padEnd(6)} ${dim('·')} in: ${fmt(x.input)} ${dim(`(${cachePct}% cached)`)}\n`
  }
  return out
}

const renderPerDay = (claude, codex, copilot) => {
  const days = []
  for (let i = DAYS - 1; i >= 0; i--) {
    days.push(new Date(Date.now() - i * 86400000).toISOString().slice(0, 10))
  }
  const merged = days.map((d) => ({
    date: d,
    out: (claude.perDay[d] || 0) + (codex.perDay[d] || 0) + (copilot.perDay[d] || 0),
  }))
  const max = Math.max(...merged.map((x) => x.out), 1)
  const spark = merged.map((x) => sparkChar(x.out, max)).join('')
  const peak = merged.reduce((p, x) => (x.out > p.out ? x : p), merged[0])
  const peakLabel = peak.out > 0 ? `peak ${dayLabel(peak.date)}: ${fmt(peak.out)}` : 'no activity'
  return `\n${bold('PER DAY')} ${dim(`(${DAYS}d output, today rightmost)`)}  ${spark}   ${dim(peakLabel)}\n`
}

// --- main ---

const args = process.argv.slice(2)
const watchIdx = args.indexOf('--watch')
const watchSec = watchIdx >= 0 ? Number(args[watchIdx + 1]) || 30 : 0

// Take over the terminal: alt screen buffer + raw stdin (silently consume mouse/key
// escapes the terminal injects, so they don't get echoed). Same approach as htop/top.
if (watchSec) {
  process.stdout.write('\x1b[?1049h\x1b[H')
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.on('data', (buf) => {
      if (buf.includes(0x03) || buf.includes(0x04) || buf[0] === 0x71) process.exit(0)
    })
  }
  process.on('exit', () => {
    if (process.stdin.isTTY) process.stdin.setRawMode(false)
    process.stdout.write('\x1b[?1049l')
  })
  process.on('SIGINT', () => process.exit(0))
  process.on('SIGTERM', () => process.exit(0))
}

const render = () => {
  const feed = getSharedFeed(5)
  const dispatcher = getDispatcherStatus()
  const running = getRunning()
  const recent = getRecentDispatches(5)
  const timedOut = getTimedOut()
  const parked = getParked()
  const queue = parseQueue()
  const claude = getClaudeTokens()
  const codex = getCodexTokens()
  const copilot = getCopilotTokens()
  const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ')
  if (watchSec) process.stdout.write('\x1b[H\x1b[2J')
  console.log(`${bold(`=== ${PROJECT_NAME} collab status ===`)}                       ${dim(stamp + ' UTC')}`)
  process.stdout.write(renderFeed(feed))
  process.stdout.write(renderRunning(dispatcher, running))
  process.stdout.write(renderRecent(recent))
  process.stdout.write(renderTimedOut(timedOut))
  process.stdout.write(renderParked(parked))
  process.stdout.write(renderQueue(queue))
  process.stdout.write(renderTokens(claude, codex, copilot))
  process.stdout.write(renderPerDay(claude, codex, copilot))
  if (watchSec) console.log(dim(`\nrefreshing every ${watchSec}s · q or ctrl+c to exit`))
}

render()
if (watchSec) setInterval(render, watchSec * 1000)
