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

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { appendWorkloadEvent } from '../core/audit.mjs'
import {
  buildGraph,
  EDGE_RELATIONS,
  effectiveStatus,
  findGatingCycle,
  incomingEdges,
  outgoingEdges,
  readyForDispatch,
} from '../core/queue_graph.mjs'
import { QUEUE_SECTIONS as SECTIONS, readQueueMd, flattenItem } from '../core/queue_md.mjs'

import { chalk, die } from '../util/chalk.mjs'
import { config } from '../config/env.mjs'

const { projectDir: PROJECT_DIR, queuePath: QUEUE_PATH } = config

const usage = (code = 2) => {
  console.error(`\
Usage: artel queue <subcommand>

  list [--section S] [--json]        show queue contents
  add <task> [--section S] [--tag T] append a new entry
       (default --section Pending)
  move <task> --to <section>         relocate between sections
  done <task>                        move to Recently done
  rm <task>                          remove
  ready [--json]                     nodes ready for dispatch (Pending
                                       with no unresolved upstream)
  graph [--json]                     event-sourced graph snapshot
                                       (queue_node.* + queue_edge.*)
  link <from> <to> --relation <R>    add a directed edge between nodes
                                       (rejects cycles for blocks /
                                        depends_on)
  unlink <from> <to> --relation <R>  remove an edge

Sections: ${SECTIONS.map((s) => `'${s}'`).join(' | ')}
Edge relations: ${[...EDGE_RELATIONS].join(' | ')}`)
  process.exit(code)
}

const subArgs = process.argv.slice(2)
if (!subArgs.length) usage(2)
const sub = subArgs[0]
const subRest = subArgs.slice(1)
if (sub === '-h' || sub === '--help') usage(0)

// --- QUEUE.md parser/serializer (preserves headers + whitespace) ---

const parseQueue = () => {
  const { header, sections, missing } = readQueueMd(QUEUE_PATH)
  // Fresh files get a stub heading; existing headers get trailing
  // whitespace trimmed back to a single blank line so writes are stable.
  if (missing) return { header: ['# Work queue', ''], sections: SECTIONS.map((name) => ({ name, items: [] })) }
  while (header.length && header[header.length - 1].trim() === '') header.pop()
  header.push('')
  return {
    header,
    sections: SECTIONS.map((name) => ({ name, items: sections[name].map(flattenItem) })),
  }
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

  console.log(`\n${chalk.bold('artel queue')} ${chalk.dim(`— ${QUEUE_PATH}`)}\n`)
  for (const s of queue.sections) {
    if (values.section && s.name !== values.section) continue
    const head = `${chalk.bold(s.name)} ${chalk.dim(`(${s.items.length})`)}`
    console.log(head)
    if (!s.items.length) {
      console.log(`  ${chalk.dim('(none)')}`)
    } else {
      for (const it of s.items) {
        const slug = slugOf(it) || '?'
        const marker = s.name === 'For Owner' ? chalk.yellow('•')
          : s.name === 'Blocked' ? chalk.yellow('!')
          : s.name === 'Recently done' ? chalk.green('✓')
          : chalk.dim('•')
        console.log(`  ${marker} ${chalk.cyan(slug.padEnd(28))} ${chalk.dim(it.replace(slug, '').replace(/^\s*[\[\]a-zA-Z0-9_-]+\s*/, '').trim())}`)
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
  // Status mirrors the section name 1:1 — see queue_graph#VALID_STATUSES.
  appendWorkloadEvent(PROJECT_DIR, 'queue_node.created', {
    node_id: task,
    status: sectionName,
    ...(values.tag ? { lane: values.tag } : {}),
    ...(descParts.length ? { description: descParts.join(' ') } : {}),
  })
  console.error(`${chalk.green('+')} '${task}' added to ${sectionName}`)
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
    console.error(`${chalk.dim(`'${slug}' already in ${target}`)}`)
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
  // V2.1 — `move` is `queue_node.updated` with status patch. since_at
  // tracks the In-progress timestamp; cleared (`null`) when leaving.
  const fields = { status: target }
  if (target === 'In progress') {
    const m = next.match(/\[since ([^\]]+)\]/)
    if (m) fields.since_at = m[1]
  } else {
    fields.since_at = null
  }
  appendWorkloadEvent(PROJECT_DIR, 'queue_node.updated', {
    node_id: slug,
    fields,
    from_status: from.name,
  })
  console.error(`${chalk.green('→')} '${slug}' moved: ${from.name} → ${target}`)
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
  appendWorkloadEvent(PROJECT_DIR, 'queue_node.deleted', {
    node_id: task,
    from_status: section.name,
  })
  console.error(`${chalk.yellow('−')} '${task}' removed from ${section.name}`)
  process.exit(0)
}

// --- ready (V2.1) ---

if (sub === 'ready') {
  let values
  try {
    ({ values } = parseArgs({
      args: subRest,
      options: { json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
    }))
  } catch (err) { die(err.message, 2) }
  if (values.help) usage(0)

  const graph = buildGraph(PROJECT_DIR)
  const ready = readyForDispatch(graph)
  if (values.json) {
    console.log(JSON.stringify(ready, null, 2))
    process.exit(0)
  }
  // Compute Pending-but-blocked for the human view — useful context
  // when the ready list is empty for a non-obvious reason.
  const pendingBlocked = [...graph.nodes.values()]
    .filter((n) => n.status === 'Pending' && effectiveStatus(graph, n.slug) === 'Blocked')
  console.log(`\n${chalk.bold('artel queue ready')} ${chalk.dim(`— ${ready.length} dispatchable node${ready.length === 1 ? '' : 's'}`)}\n`)
  if (!ready.length) {
    console.log(`  ${chalk.dim('(none — no Pending nodes' + (pendingBlocked.length ? ' with all upstream resolved' : '') + ')')}`)
  } else {
    for (const n of ready) {
      const lane = n.lane ? `${chalk.dim('[')}${n.lane}${chalk.dim(']')} ` : ''
      const desc = n.description ? ` ${chalk.dim('—')} ${chalk.dim(n.description)}` : ''
      console.log(`  ${chalk.green('•')} ${lane}${chalk.cyan(n.slug)}${desc}`)
    }
  }
  if (pendingBlocked.length) {
    console.log(`\n${chalk.bold('Held by upstream')} ${chalk.dim(`(${pendingBlocked.length} Pending nodes blocked on gating edges)`)}`)
    for (const n of pendingBlocked) {
      const upstream = incomingEdges(graph, n.slug)
        .filter((e) => e.relation === 'blocks' || e.relation === 'depends_on')
        .filter((e) => {
          const src = graph.nodes.get(e.from)
          return !src || src.status !== 'Recently done'
        })
        .map((e) => `${e.from} ${chalk.dim('(' + e.relation + ')')}`)
      console.log(`  ${chalk.yellow('!')} ${chalk.cyan(n.slug)} ${chalk.dim('←')} ${upstream.join(', ')}`)
    }
  }
  console.log()
  process.exit(0)
}

// --- graph (V2.1) ---

if (sub === 'graph') {
  let values
  try {
    ({ values } = parseArgs({
      args: subRest,
      options: { json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
    }))
  } catch (err) { die(err.message, 2) }
  if (values.help) usage(0)

  const graph = buildGraph(PROJECT_DIR)
  const allNodes = [...graph.nodes.values()].sort((a, b) =>
    (a.created_at || '').localeCompare(b.created_at || ''))
  const allEdges = [...graph.edges.values()].sort((a, b) =>
    (a.added_at || '').localeCompare(b.added_at || ''))

  if (values.json) {
    // Augment each node with effective status (V2.2 — derives Blocked
    // from upstream gating edges).
    const nodes = allNodes.map((n) => ({
      ...n,
      effective_status: effectiveStatus(graph, n.slug),
    }))
    console.log(JSON.stringify({ nodes, edges: allEdges }, null, 2))
    process.exit(0)
  }

  console.log(`\n${chalk.bold('artel queue graph')} ${chalk.dim(`— ${allNodes.length} node${allNodes.length === 1 ? '' : 's'}, ${allEdges.length} edge${allEdges.length === 1 ? '' : 's'} (event-sourced)`)}\n`)
  if (!allNodes.length) {
    console.log(`  ${chalk.dim('(no queue_node.* events yet — mutate via `artel queue add` etc.)')}`)
  } else {
    console.log(chalk.bold('Nodes'))
    for (const n of allNodes) {
      const lane = n.lane ? `${chalk.dim('[')}${n.lane}${chalk.dim(']')} ` : ''
      const since = n.since_at ? ` ${chalk.dim('· since')} ${n.since_at.replace('T', ' ').slice(0, 19)}` : ''
      const eff = effectiveStatus(graph, n.slug)
      const statusStr = eff !== n.status
        ? `${n.status} ${chalk.dim('→ effective:')} ${chalk.yellow(eff)}`
        : n.status
      console.log(`  ${chalk.cyan(n.slug.padEnd(28))} ${lane}${chalk.dim('status:')} ${statusStr}${since}`)
    }
  }
  if (allEdges.length) {
    console.log(`\n${chalk.bold('Edges')}`)
    for (const e of allEdges) {
      console.log(`  ${chalk.cyan(e.from)} ${chalk.dim('--')} ${e.relation} ${chalk.dim('->')} ${chalk.cyan(e.to)}`)
    }
  }
  console.log()
  process.exit(0)
}

// --- link / unlink (V2.2) ---

const validateLinkArgs = (positionals, values, label) => {
  const [from, to] = positionals
  if (!from || !to) die(`${label}: <from> <to> are required`, 2)
  const relation = values.relation
  if (!relation) die(`${label}: --relation <R> is required (one of: ${[...EDGE_RELATIONS].join(' | ')})`, 2)
  if (!EDGE_RELATIONS.has(relation)) {
    die(`${label}: invalid relation '${relation}' (valid: ${[...EDGE_RELATIONS].join(' | ')})`, 2)
  }
  if (from === to) die(`${label}: self-edges not allowed`, 2)
  return { from, to, relation }
}

if (sub === 'link') {
  let values, positionals
  try {
    ({ values, positionals } = parseArgs({
      args: subRest,
      options: {
        relation: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
      allowPositionals: true,
    }))
  } catch (err) { die(err.message, 2) }
  if (values.help) usage(0)
  const { from, to, relation } = validateLinkArgs(positionals, values, 'link')

  const graph = buildGraph(PROJECT_DIR)
  if (!graph.nodes.has(from)) die(`link: '${from}' is not a known node — add it first`, 1)
  if (!graph.nodes.has(to)) die(`link: '${to}' is not a known node — add it first`, 1)

  const cycle = findGatingCycle(graph, from, to, relation)
  if (cycle) {
    die(`link: would create a cycle in '${relation}' edges: ${cycle.join(' → ')}`, 1)
  }

  appendWorkloadEvent(PROJECT_DIR, 'queue_edge.added', {
    relation, from, to,
  })
  console.error(`${chalk.green('+')} ${from} ${chalk.dim('--')} ${relation} ${chalk.dim('->')} ${to}`)
  process.exit(0)
}

if (sub === 'unlink') {
  let values, positionals
  try {
    ({ values, positionals } = parseArgs({
      args: subRest,
      options: {
        relation: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
      allowPositionals: true,
    }))
  } catch (err) { die(err.message, 2) }
  if (values.help) usage(0)
  const { from, to, relation } = validateLinkArgs(positionals, values, 'unlink')

  const graph = buildGraph(PROJECT_DIR)
  const has = [...graph.edges.values()].some(
    (e) => e.from === from && e.to === to && e.relation === relation,
  )
  if (!has) die(`unlink: edge '${from} -- ${relation} -> ${to}' not found`, 1)

  appendWorkloadEvent(PROJECT_DIR, 'queue_edge.removed', {
    relation, from, to,
  })
  console.error(`${chalk.yellow('−')} ${from} ${chalk.dim('--')} ${relation} ${chalk.dim('->')} ${to}`)
  process.exit(0)
}

console.error(`unknown subcommand: ${sub}`)
usage(2)
