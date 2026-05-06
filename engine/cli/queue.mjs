#!/usr/bin/env node
// `artel queue <subcommand>` — programmatic editor for `.artel/QUEUE.md`.
//
// Subcommands:
//   list                              show counts + entries per section
//   add <task> [--section S] [--tag]  append a new entry
//   move <task> --to <section>        relocate an existing entry
//   done <task>                       shorthand for `move --to "Recently done"`
//   rm <task>                         remove
//
// Sections: For Owner | In progress | Pending | Blocked | Recently done.
// Tasks are matched by slug (the `<task>` token after the optional
// `[lane]` tag, or by an explicit `[task: slug]` annotation).

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { appendInfraEvent } from '../util/audit.mjs'

const PROJECT_DIR = process.env.ARTEL_PROJECT_DIR || process.cwd()
const QUEUE_PATH = join(PROJECT_DIR, '.artel', 'QUEUE.md')

const SECTIONS = ['For Owner', 'In progress', 'Pending', 'Blocked', 'Recently done']

const tty = process.stdout.isTTY
const c = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s)
const dim = (s) => c('2', s)
const bold = (s) => c('1', s)
const cyan = (s) => c('36', s)
const yellow = (s) => c('33', s)
const green = (s) => c('32', s)

const die = (msg, code = 1) => { console.error(msg); process.exit(code) }

const usage = (code = 2) => {
  console.error(`\
Usage: artel queue <subcommand>

  list [--section S] [--json]        show queue contents
  add <task> [--section S] [--tag T] append a new entry
       (default --section Pending)
  move <task> --to <section>         relocate between sections
  done <task>                        move to Recently done
  rm <task>                          remove

Sections: ${SECTIONS.map((s) => `'${s}'`).join(' | ')}`)
  process.exit(code)
}

const subArgs = process.argv.slice(2)
if (!subArgs.length) usage(2)
const sub = subArgs[0]
const subRest = subArgs.slice(1)
if (sub === '-h' || sub === '--help') usage(0)

// --- QUEUE.md parser/serializer (preserves headers + whitespace) ---

const parseQueue = () => {
  if (!existsSync(QUEUE_PATH)) {
    return { header: ['# Work queue', ''], sections: SECTIONS.map((name) => ({ name, items: [] })) }
  }
  const lines = readFileSync(QUEUE_PATH, 'utf8').split('\n')
  const sections = []
  const header = []
  let cur = null
  let item = null
  const flush = () => {
    if (item && cur) cur.items.push(item)
    item = null
  }
  for (const line of lines) {
    const sec = line.match(/^## (.+)$/)
    if (sec) {
      flush()
      cur = { name: sec[1], items: [] }
      sections.push(cur)
      continue
    }
    if (!cur) {
      header.push(line)
      continue
    }
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
  // Drop empty placeholders (`- (none)`).
  for (const s of sections) s.items = s.items.filter((it) => !it.startsWith('(none)'))
  // Backfill missing canonical sections in canonical order so writes are stable.
  const byName = new Map(sections.map((s) => [s.name, s]))
  const ordered = SECTIONS.map((name) => byName.get(name) || { name, items: [] })
  // Trailing trim of the header to a single blank line.
  while (header.length && header[header.length - 1].trim() === '') header.pop()
  header.push('')
  return { header, sections: ordered }
}

const serializeQueue = ({ header, sections }) => {
  const out = [...header]
  for (const s of sections) {
    out.push(`## ${s.name}`)
    out.push('')
    if (s.items.length === 0) {
      out.push('- (none)')
    } else {
      for (const it of s.items) out.push(`- ${it}`)
    }
    out.push('')
  }
  return out.join('\n').replace(/\n+$/, '\n')
}

const slugOf = (item) => {
  const tagged = item.match(/\[task[:= ]\s*([a-z0-9][a-z0-9._-]*)\]/i)
  if (tagged) return tagged[1]
  // After an optional `[lane]` tag, take the first word-ish token.
  // `*` (not `+`) on the body so single-char slugs (`a`, `1`) match too.
  const m = item.match(/^(?:\[[^\]]+\]\s*)?([a-z0-9][a-z0-9._-]*)/i)
  return m ? m[1] : null
}

const findItem = (queue, slug) => {
  for (const s of queue.sections) {
    const idx = s.items.findIndex((it) => slugOf(it) === slug)
    if (idx >= 0) return { section: s, index: idx, item: s.items[idx] }
  }
  return null
}

const sectionByName = (queue, name) => {
  const s = queue.sections.find((sec) => sec.name === name)
  if (!s) die(`unknown section '${name}' (valid: ${SECTIONS.join(' | ')})`, 2)
  return s
}

const writeQueue = (queue) => writeFileSync(QUEUE_PATH, serializeQueue(queue))

// --- list ---

if (sub === 'list') {
  let values
  try {
    ({ values } = parseArgs({
      args: subRest,
      options: {
        section: { type: 'string' },
        json: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    }))
  } catch (err) { die(err.message, 2) }
  if (values.help) usage(0)

  const queue = parseQueue()
  if (values.json) {
    const filtered = values.section
      ? queue.sections.filter((s) => s.name === values.section)
      : queue.sections
    console.log(JSON.stringify(filtered, null, 2))
    process.exit(0)
  }

  console.log(`\n${bold('artel queue')} ${dim(`— ${QUEUE_PATH}`)}\n`)
  for (const s of queue.sections) {
    if (values.section && s.name !== values.section) continue
    const head = `${bold(s.name)} ${dim(`(${s.items.length})`)}`
    console.log(head)
    if (!s.items.length) {
      console.log(`  ${dim('(none)')}`)
    } else {
      for (const it of s.items) {
        const slug = slugOf(it) || '?'
        const marker = s.name === 'For Owner' ? yellow('•')
          : s.name === 'Blocked' ? yellow('!')
          : s.name === 'Recently done' ? green('✓')
          : dim('•')
        console.log(`  ${marker} ${cyan(slug.padEnd(28))} ${dim(it.replace(slug, '').replace(/^\s*[\[\]a-zA-Z0-9_-]+\s*/, '').trim())}`)
      }
    }
    console.log()
  }
  process.exit(0)
}

// --- add ---

if (sub === 'add') {
  let values, positionals
  try {
    ({ values, positionals } = parseArgs({
      args: subRest,
      options: {
        section: { type: 'string' },
        tag: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
      allowPositionals: true,
    }))
  } catch (err) { die(err.message, 2) }
  if (values.help) usage(0)
  const [task, ...descParts] = positionals
  if (!task) die('add: <task> is required', 2)
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(task)) {
    die(`add: invalid task slug '${task}' (alphanumeric + . _ -; no leading dot/dash)`, 2)
  }
  const sectionName = values.section || 'Pending'
  if (!SECTIONS.includes(sectionName)) {
    die(`add: invalid section '${sectionName}' (valid: ${SECTIONS.join(' | ')})`, 2)
  }
  const queue = parseQueue()
  if (findItem(queue, task)) die(`add: '${task}' already in queue`, 1)
  const tag = values.tag ? `[${values.tag}] ` : ''
  const desc = descParts.length ? ' — ' + descParts.join(' ') : ''
  const item = `${tag}${task}${desc}`
  sectionByName(queue, sectionName).items.push(item)
  writeQueue(queue)
  appendInfraEvent(PROJECT_DIR, 'queue.entry.added', { task, section: sectionName, tag: values.tag || null })
  console.error(`${green('+')} '${task}' added to ${sectionName}`)
  process.exit(0)
}

// --- move ---

const moveTask = (slug, target, label = 'move') => {
  if (!SECTIONS.includes(target)) {
    die(`${label}: invalid section '${target}' (valid: ${SECTIONS.join(' | ')})`, 2)
  }
  const queue = parseQueue()
  const found = findItem(queue, slug)
  if (!found) die(`${label}: '${slug}' not found in queue`, 1)
  const { section: from, index, item } = found
  if (from.name === target) {
    console.error(`${dim(`'${slug}' already in ${target}`)}`)
    process.exit(0)
  }
  from.items.splice(index, 1)
  // When moving INTO 'In progress', stamp [since <iso>] for status' relativeTime calc.
  let next = item
  if (target === 'In progress') {
    const cleaned = item.replace(/\s*\[since [^\]]+\]/g, '').trim()
    next = `${cleaned} [since ${new Date().toISOString()}]`
  } else if (from.name === 'In progress') {
    // Strip any old [since ...] tag — it's stale once the task moves out.
    next = item.replace(/\s*\[since [^\]]+\]/g, '').trim()
  }
  sectionByName(queue, target).items.push(next)
  writeQueue(queue)
  appendInfraEvent(PROJECT_DIR, 'queue.entry.moved', {
    task: slug, from: from.name, to: target,
  })
  console.error(`${green('→')} '${slug}' moved: ${from.name} → ${target}`)
}

if (sub === 'move') {
  let values, positionals
  try {
    ({ values, positionals } = parseArgs({
      args: subRest,
      options: {
        to: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
      allowPositionals: true,
    }))
  } catch (err) { die(err.message, 2) }
  if (values.help) usage(0)
  const [task] = positionals
  if (!task) die('move: <task> is required', 2)
  if (!values.to) die('move: --to <section> is required', 2)
  moveTask(task, values.to, 'move')
  process.exit(0)
}

// --- done (alias for move --to "Recently done") ---

if (sub === 'done') {
  const [task] = subRest
  if (!task) die('done: <task> is required', 2)
  moveTask(task, 'Recently done', 'done')
  process.exit(0)
}

// --- rm ---

if (sub === 'rm') {
  const [task] = subRest
  if (!task) die('rm: <task> is required', 2)
  const queue = parseQueue()
  const found = findItem(queue, task)
  if (!found) die(`rm: '${task}' not found in queue`, 1)
  const { section, index } = found
  section.items.splice(index, 1)
  writeQueue(queue)
  appendInfraEvent(PROJECT_DIR, 'queue.entry.removed', { task, section: section.name })
  console.error(`${yellow('−')} '${task}' removed from ${section.name}`)
  process.exit(0)
}

console.error(`unknown subcommand: ${sub}`)
usage(2)
