#!/usr/bin/env node
// `artel logs <task-slug>` — drill into a single dispatch.
// Reads .meta + .out + .prompt sidecars from .artel/.dispatches/ and the
// matching events from events.jsonl, renders one cohesive view. Useful
// when status / probe says something failed and you want the full
// picture for a single task.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'
import { parseArgs } from 'node:util'
import { chalk } from '../util/chalk.mjs'
import { config } from '../config/env.mjs'

const { dispatchesDir: DISPATCHES_DIR, eventsPath: EVENTS_PATH } = config

const usage = (code = 2) => {
  console.error(`\
Usage: artel logs <task-slug> [options]

Drill into a single dispatch — reads .meta / .out / .prompt and the
matching events.jsonl entries.

Options:
  --json           machine-readable; emit { meta, events, prompt, out }
  --lines <n>      tail N lines of .out (default 30; -1 = full)
  --events-only    skip prompt + .out, show only meta + events
  -h, --help       this`)
  process.exit(code)
}

let values, positionals
try {
  ({ values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      json: { type: 'boolean' },
      lines: { type: 'string' },
      'events-only': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
  }))
} catch (err) {
  console.error(err.message)
  usage(2)
}

if (values.help) usage(0)
if (positionals.length !== 1) usage(2)
const taskSlug = positionals[0]

// ---- meta + sidecar files ----

const findDispatchFiles = (slug) => {
  if (!existsSync(DISPATCHES_DIR)) return null
  const exact = (ext) => join(DISPATCHES_DIR, `${slug}.${ext}`)
  let metaPath = existsSync(exact('meta')) ? exact('meta') : null
  let outPath = existsSync(exact('out')) ? exact('out') : null
  let promptPath = existsSync(exact('prompt')) ? exact('prompt') : null
  // Fuzzy: legacy filenames look like `<role>-<task>.out` etc. Fall back to
  // the most-recent file whose basename ends with `<slug>`.
  if (!metaPath || !outPath) {
    const candidates = readdirSync(DISPATCHES_DIR)
      .filter((f) => f.endsWith('.meta') || f.endsWith('.out'))
      .filter((f) => f.replace(/\.(meta|out|prompt)$/, '').endsWith(slug))
      .map((f) => ({ f, t: statSync(join(DISPATCHES_DIR, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
    for (const { f } of candidates) {
      const stem = f.replace(/\.(meta|out|prompt)$/, '')
      const m = join(DISPATCHES_DIR, `${stem}.meta`)
      const o = join(DISPATCHES_DIR, `${stem}.out`)
      const p = join(DISPATCHES_DIR, `${stem}.prompt`)
      if (existsSync(m) && existsSync(o)) {
        metaPath = metaPath || m
        outPath = outPath || o
        promptPath = promptPath || (existsSync(p) ? p : null)
        break
      }
    }
  }
  if (!metaPath && !outPath) return null
  return { metaPath, outPath, promptPath }
}

const files = findDispatchFiles(taskSlug)
if (!files) {
  console.error(`No dispatch artefacts found for '${taskSlug}' under ${DISPATCHES_DIR}`)
  process.exit(1)
}

let meta = null
if (files.metaPath) {
  try { meta = JSON.parse(readFileSync(files.metaPath, 'utf8')) } catch {}
}

const promptText = files.promptPath ? safeRead(files.promptPath) : null
const outText = files.outPath ? safeRead(files.outPath) : null

function safeRead (path) {
  try { return readFileSync(path, 'utf8') } catch { return null }
}

// ---- events for this task ----

const matchedEvents = []
if (existsSync(EVENTS_PATH)) {
  for (const line of readFileSync(EVENTS_PATH, 'utf8').split('\n')) {
    if (!line) continue
    try {
      const e = JSON.parse(line)
      if (e.task === taskSlug || (meta && e.dispatch_id === meta.dispatchId)) {
        matchedEvents.push(e)
      }
    } catch {}
  }
}

// ---- render ----

if (values.json) {
  console.log(JSON.stringify({
    task: taskSlug,
    meta,
    events: matchedEvents,
    prompt: promptText,
    out: outText,
  }, null, 2))
  process.exit(0)
}

const fmtDate = (iso) => {
  if (!iso) return chalk.dim('—')
  return iso.replace('T', ' ').replace(/\.\d{3}Z?$/, ' UTC')
}

const fmtDuration = (start, end) => {
  if (!start || !end) return null
  const ms = Date.parse(end) - Date.parse(start)
  if (!Number.isFinite(ms) || ms < 0) return null
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${Math.round(ms / 1000)}s`
  if (ms < 3600000) return `${Math.round(ms / 60000)}m`
  return `${(ms / 3600000).toFixed(1)}h`
}

const dispoColor = (d) =>
  d === 'success' ? chalk.green(d)
    : d === 'parked' ? chalk.yellow(d)
    : d === 'timeout' ? chalk.red(d)
    : d === 'error' ? chalk.red(d)
    : chalk.dim(d || '—')

console.log(`\n${chalk.bold('artel logs')} ${chalk.cyan(taskSlug)}\n`)

if (meta) {
  const dur = fmtDuration(meta.dispatchedAt, meta.completedAt)
  const lines = [
    ['task', meta.task || taskSlug],
    ['role', meta.role || chalk.dim('—')],
    ['engine', meta.engine ? `${meta.engine}${meta.model ? ` · ${chalk.dim(meta.model)}` : ''}` : chalk.dim('—')],
    ['branch', meta.branch || chalk.dim('—')],
    ['status', meta.status || chalk.dim('—')],
    ['disposition', dispoColor(meta.disposition)],
    ['dispatched', `${fmtDate(meta.dispatchedAt)}${meta.completedAt ? `  ${chalk.dim('→')} completed ${fmtDate(meta.completedAt)}` : ''}${dur ? `  ${chalk.dim(`(${dur})`)}` : ''}`],
  ]
  if (meta.git) {
    lines.push(['git', `${chalk.cyan((meta.git.commit_sha || '').slice(0, 8))} ${chalk.dim('·')} ${meta.git.repo_name || ''} ${chalk.dim('·')} ${meta.git.branch || ''}`])
  }
  if (meta.delta) {
    const d = meta.delta
    lines.push(['delta', `${chalk.green('+' + (d.lines_added || 0))}/${chalk.red('-' + (d.lines_removed || 0))} ${chalk.dim(`(${d.files_changed || 0} files)`)}`])
  }
  if (meta.usage && (meta.usage.tokens_in || meta.usage.tokens_out)) {
    lines.push(['usage', `${meta.usage.tokens_in || 0} in / ${meta.usage.tokens_out || 0} out${meta.usage.cache_read ? ` ${chalk.dim(`(${meta.usage.cache_read} cached)`)}` : ''}`])
  }
  if (meta.dispatchId) lines.push(['dispatch_id', chalk.dim(meta.dispatchId)])
  if (meta.traceId && meta.traceId !== meta.dispatchId) lines.push(['trace_id', chalk.dim(meta.traceId)])
  if (meta.parked) lines.push(['parked', `${chalk.yellow(meta.parked.reason || '?')} ${chalk.dim('·')} ${chalk.dim(meta.parked.raw || '')}`])
  if (meta.timeout) lines.push(['timeout', `${chalk.red('hit')} ${chalk.dim('·')} ${meta.timeout.timeoutMs}ms ${meta.timeout.signal ? chalk.dim(`(${meta.timeout.signal})`) : ''}`])
  if (meta.error) lines.push(['error', chalk.red(meta.error)])

  console.log(chalk.bold('Meta'))
  for (const [k, v] of lines) console.log(`  ${chalk.dim(k.padEnd(13))} ${v}`)
  console.log()
}

console.log(chalk.bold(`Events  ${chalk.dim(`(${matchedEvents.length})`)}`))
if (!matchedEvents.length) {
  console.log(`  ${chalk.dim('(none in events.jsonl)')}`)
} else {
  for (const e of matchedEvents) {
    const t = e.at ? new Date(e.at).toISOString().slice(11, 19) : '?'
    const type = (e.type || '?').padEnd(18)
    const role = e.owner_role || e.from_role
    const extras = []
    if (e.disposition) extras.push(`disposition=${e.disposition}`)
    if (e.engine) extras.push(`engine=${e.engine}`)
    if (e.branch && !e.disposition) extras.push(`branch=${e.branch}`)
    if (e.last_completed_step) extras.push(`done=${JSON.stringify(e.last_completed_step)}`)
    if (e.next_safe_step) extras.push(`next=${JSON.stringify(e.next_safe_step)}`)
    if (e.reason) extras.push(`reason=${e.reason}`)
    console.log(`  ${chalk.dim(t)}  ${chalk.cyan(type)} ${role ? chalk.dim(role.padEnd(12)) : ' '.repeat(12)} ${chalk.dim(extras.join(' '))}`)
  }
}
console.log()

if (!values['events-only']) {
  if (promptText !== null) {
    console.log(chalk.bold('Prompt'))
    console.log(indent(promptText.trim(), '  '))
    console.log()
  }
  if (outText !== null) {
    const linesArg = values.lines ? Number(values.lines) : 30
    const all = linesArg < 0
    const lines = outText.replace(/\n$/, '').split('\n')
    const shown = all ? lines : lines.slice(-linesArg)
    const hidden = all ? 0 : Math.max(0, lines.length - shown.length)
    const head = `Out  ${chalk.dim(`(${all ? 'full' : `last ${shown.length} lines${hidden ? ` of ${lines.length}` : ''}`}, ${files.outPath})`)}`
    console.log(chalk.bold(head))
    console.log(indent(shown.join('\n'), '  '))
    console.log()
  }
}

function indent (text, pad) {
  return text.split('\n').map((l) => pad + l).join('\n')
}
