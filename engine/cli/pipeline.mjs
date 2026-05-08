#!/usr/bin/env node
// `artel pipeline <subcommand>` — register / list / show / run pipelines.
//
// V3.1: linear sequential runs. `register` validates a JSON definition
// and copies it into `.artel/pipelines/<id>.json`. `run` walks
// dispatch nodes synchronously, picks the next via outgoing edges
// matched on disposition, terminates on a `terminal` node. Each
// dispatch carries `pipeline_run_id` + `pipeline_node_id` in task
// attrs so the chain reconstructs from events.jsonl.
//
// V3.2+ deferred:
//   - parallel (fan-out + join), condition (decisions), pause (signals)
//   - subpipeline composition
//   - cron / queue.pull entry triggers
//   - prompt template substitution

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { appendWorkloadEvent } from '../util/audit.mjs'
import {
  aggregateDisposition,
  listPipelineFiles,
  loadPipelineFile,
  pipelinePath,
  pipelinesDir,
  resolveNext,
  validatePipeline,
} from '../util/pipelines.mjs'
import { dispatchLifecycle } from '../core/dispatch_lifecycle.mjs'
import { uuidv7 } from '../util/ids.mjs'

const PROJECT_DIR = process.env.ARTEL_PROJECT_DIR || process.cwd()

const tty = process.stdout.isTTY
const c = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s)
const dim = (s) => c('2', s)
const bold = (s) => c('1', s)
const cyan = (s) => c('36', s)
const green = (s) => c('32', s)
const yellow = (s) => c('33', s)
const red = (s) => c('31', s)

const die = (msg, code = 1) => { console.error(msg); process.exit(code) }

const usage = (code = 2) => {
  console.error(`\
Usage: artel pipeline <subcommand>

  register <file>             validate JSON and copy into .artel/pipelines/
  list [--json]               list registered pipelines
  show <id> [--json]          render one pipeline
  run <id> [--attrs <json>]   walk the pipeline, dispatch each node, follow
                                edges on disposition; emits pipeline_run.*
                                events; returns when a terminal is reached
                                or no transition matches`)
  process.exit(code)
}

const subArgs = process.argv.slice(2)
if (!subArgs.length) usage(2)
const sub = subArgs[0]
const subRest = subArgs.slice(1)
if (sub === '-h' || sub === '--help') usage(0)

// --- register ---

if (sub === 'register') {
  const [filePath] = subRest
  if (!filePath) die('register: <file> is required', 2)
  let def
  try { def = loadPipelineFile(resolve(filePath)) }
  catch (err) { die(`register: ${err.message}`, 1) }

  const target = pipelinePath(PROJECT_DIR, def.id)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, JSON.stringify(def, null, 2) + '\n')

  appendWorkloadEvent(PROJECT_DIR, 'pipeline.registered', {
    pipeline_id: def.id,
    pipeline_version: def.version,
    source_path: filePath,
    node_count: Object.keys(def.nodes).length,
    edge_count: def.edges.length,
  })

  console.error(`${green('✓')} pipeline '${def.id}' v${def.version} registered → ${target}`)
  process.exit(0)
}

// --- list ---

if (sub === 'list') {
  let values
  try {
    ({ values } = parseArgs({
      args: subRest,
      options: { json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
    }))
  } catch (err) { die(err.message, 2) }
  if (values.help) usage(0)

  const files = listPipelineFiles(PROJECT_DIR)
  const pipelines = files.map(({ id, path }) => {
    try {
      const body = JSON.parse(readFileSync(path, 'utf8'))
      return {
        id,
        version: body.version,
        description: body.description || null,
        node_count: Object.keys(body.nodes || {}).length,
        edge_count: (body.edges || []).length,
        path,
      }
    } catch (err) {
      return { id, error: err.message, path }
    }
  })

  if (values.json) {
    console.log(JSON.stringify(pipelines, null, 2))
    process.exit(0)
  }

  console.log(`\n${bold('artel pipeline list')} ${dim(`— ${pipelinesDir(PROJECT_DIR)}`)}\n`)
  if (!pipelines.length) {
    console.log(`  ${dim('(no pipelines registered — try: artel pipeline register <file>)')}`)
  } else {
    for (const p of pipelines) {
      if (p.error) {
        console.log(`  ${red('!')} ${cyan(p.id)} ${dim('— parse error:')} ${p.error}`)
        continue
      }
      const desc = p.description ? ` ${dim('—')} ${dim(p.description)}` : ''
      console.log(`  ${cyan(p.id.padEnd(28))} ${dim(`v${p.version}`)} ${dim(`(${p.node_count} nodes, ${p.edge_count} edges)`)}${desc}`)
    }
  }
  console.log()
  process.exit(0)
}

// --- show ---

if (sub === 'show') {
  let values, positionals
  try {
    ({ values, positionals } = parseArgs({
      args: subRest,
      options: { json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
      allowPositionals: true,
    }))
  } catch (err) { die(err.message, 2) }
  if (values.help) usage(0)
  const [id] = positionals
  if (!id) die('show: <id> is required', 2)

  const path = pipelinePath(PROJECT_DIR, id)
  if (!existsSync(path)) die(`show: pipeline '${id}' not registered (looked at ${path})`, 1)
  let def
  try { def = JSON.parse(readFileSync(path, 'utf8')) }
  catch (err) { die(`show: failed to parse ${path}: ${err.message}`, 1) }

  if (values.json) {
    console.log(JSON.stringify(def, null, 2))
    process.exit(0)
  }

  console.log(`\n${bold('artel pipeline show')} ${cyan(def.id)} ${dim(`v${def.version}`)}\n`)
  if (def.description) console.log(`  ${dim(def.description)}\n`)
  console.log(`  ${dim('entry:')} ${cyan(def.entry)}\n`)
  console.log(`  ${bold('Nodes')}`)
  for (const [nid, node] of Object.entries(def.nodes)) {
    if (node.type === 'dispatch') {
      console.log(`    ${cyan(nid.padEnd(20))} ${dim('dispatch')} role=${node.role}${node.engine ? ` engine=${node.engine}` : ''}${node.model ? ` model=${node.model}` : ''}`)
    } else if (node.type === 'terminal') {
      const colour = node.final_state === 'completed' ? green
        : node.final_state === 'aborted' ? yellow : red
      console.log(`    ${cyan(nid.padEnd(20))} ${dim('terminal')} → ${colour(node.final_state)}`)
    } else if (node.type === 'parallel') {
      console.log(`    ${cyan(nid.padEnd(20))} ${dim('parallel')} branches=[${node.branches.join(', ')}] join=${node.join || 'all-complete'}`)
    }
  }
  console.log(`\n  ${bold('Edges')}`)
  for (const e of def.edges) {
    console.log(`    ${cyan(e.from)} ${dim('--')} on_${e.on_disposition} ${dim('->')} ${cyan(e.to)}`)
  }
  console.log()
  process.exit(0)
}

// --- run ---

if (sub === 'run') {
  let values, positionals
  try {
    ({ values, positionals } = parseArgs({
      args: subRest,
      options: {
        attrs: { type: 'string' },
        'task-prefix': { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
      allowPositionals: true,
    }))
  } catch (err) { die(err.message, 2) }
  if (values.help) usage(0)
  const [id] = positionals
  if (!id) die('run: <id> is required', 2)

  const path = pipelinePath(PROJECT_DIR, id)
  if (!existsSync(path)) die(`run: pipeline '${id}' not registered (looked at ${path})`, 1)
  let def
  try { def = validatePipeline(JSON.parse(readFileSync(path, 'utf8')), path) }
  catch (err) { die(`run: ${err.message}`, 1) }

  let userAttrs = {}
  if (values.attrs) {
    try { userAttrs = JSON.parse(values.attrs) }
    catch (err) { die(`run: --attrs is not valid JSON: ${err.message}`, 2) }
  }

  const runId = uuidv7()
  const taskPrefix = values['task-prefix'] || `${id}-${runId.slice(-6)}`

  appendWorkloadEvent(PROJECT_DIR, 'pipeline_run.started', {
    pipeline_run_id: runId,
    pipeline_id: def.id,
    pipeline_version: def.version,
    entry_node: def.entry,
  })

  console.error(`${bold('▶')} pipeline ${cyan(def.id)} v${def.version} run=${dim(runId.slice(-12))} prefix=${dim(taskPrefix)}`)

  let nodeId = def.entry
  let lastDisposition = null
  let finalState = null
  let abortReason = null

  // V3.2.a — extracted dispatch helper used by both the linear walker
  // and the parallel fan-out path. Wraps dispatchLifecycle with
  // pipeline-aware taskAttrs + slug generation; propagates throws as
  // `null` (caller turns that into an abort).
  // V3.3.a — `useWorktree` plumbed through so parallel branches each
  // run in their own `.artel/.worktrees/<branch>/` checkout, enabling
  // true concurrency via Promise.all without working-tree races.
  const runDispatchNode = async (id, parallelOf = null, opts = {}) => {
    const taskSlug = parallelOf
      ? `${taskPrefix}-${parallelOf}-${id}`
      : `${taskPrefix}-${id}`
    const node = def.nodes[id]
    console.error(`${bold('◆')} ${cyan(id)} ${dim('→')} dispatch role=${node.role}${node.engine ? ` engine=${node.engine}` : ''} task=${dim(taskSlug)}`)
    try {
      return await dispatchLifecycle({
        role: node.role,
        task: taskSlug,
        prompt: node.prompt,
        engine: node.engine || null,
        model: node.model || null,
        effort: node.effort || null,
        sandbox: node.sandbox || null,
        tools: node.tools || null,
        permissionMode: node['permission-mode'] || null,
        useWorktree: !!opts.useWorktree,
        taskAttrs: {
          ...userAttrs,
          pipeline_run_id: runId,
          pipeline_id: def.id,
          pipeline_node_id: id,
          ...(parallelOf ? { pipeline_parallel_of: parallelOf } : {}),
        },
      })
    } catch (err) {
      return { __error: err?.message || String(err), node: id }
    }
  }

  // Synchronous walk: dispatch each `dispatch` node, fan out + join
  // each `parallel` node, follow edge by disposition, end on `terminal`.
  // Failure to find a transition for a non-success disposition is an
  // explicit "stuck" — surfaced to the operator rather than silently
  // terminated.
  while (true) {
    const node = def.nodes[nodeId]
    if (node.type === 'terminal') {
      finalState = node.final_state
      console.error(`${bold('■')} terminal ${cyan(nodeId)} → ${node.final_state === 'completed' ? green : node.final_state === 'aborted' ? yellow : red}(${node.final_state})`)
      break
    }

    let stepDisposition = null
    if (node.type === 'dispatch') {
      const result = await runDispatchNode(nodeId)
      if (result.__error) {
        abortReason = `dispatch threw at node '${nodeId}': ${result.__error}`
        finalState = 'failed'
        break
      }
      stepDisposition = result.disposition
    } else if (node.type === 'parallel') {
      // V3.3.a: branches each get their own worktree under
      // `.artel/.worktrees/<branch>/` so working-tree state doesn't
      // race across siblings. Promise.all gives true wall-clock
      // concurrency — N branches finish in roughly max(t_i) instead
      // of sum(t_i). One branch throwing aborts the parallel block;
      // the others' settled results are still collected (they ran
      // in their own worktrees, no rollback semantics).
      console.error(`${bold('▥')} ${cyan(nodeId)} ${dim('→')} parallel branches=[${node.branches.join(', ')}] join=${node.join || 'all-complete'} ${dim('(concurrent worktrees)')}`)
      const settled = await Promise.all(
        node.branches.map((branchId) =>
          runDispatchNode(branchId, nodeId, { useWorktree: true })),
      )
      const errored = settled.find((r) => r.__error)
      if (errored) {
        abortReason = `parallel '${nodeId}': branch '${errored.node}' threw: ${errored.__error}`
        finalState = 'failed'
        break
      }
      const dispositions = settled.map((r) => r.disposition)
      for (let i = 0; i < node.branches.length; i++) {
        console.error(`  ${dim('branch')} ${cyan(node.branches[i])} ${dim('disposition:')} ${dispositions[i]}`)
      }
      stepDisposition = aggregateDisposition(dispositions)
      console.error(`  ${dim('aggregate:')} ${stepDisposition} ${dim('(' + (node.join || 'all-complete') + ' of ' + dispositions.length + ')')}`)
    } else {
      abortReason = `unsupported node type '${node.type}' at '${nodeId}' (V3.2.a supports: dispatch | parallel | terminal)`
      finalState = 'failed'
      break
    }

    lastDisposition = stepDisposition
    const next = resolveNext(def, nodeId, stepDisposition)
    if (!next) {
      abortReason = `no transition for disposition '${stepDisposition}' from node '${nodeId}'`
      finalState = 'failed'
      break
    }
    console.error(`  ${dim('disposition:')} ${stepDisposition} ${dim('→')} ${cyan(next)}`)
    nodeId = next
  }

  appendWorkloadEvent(PROJECT_DIR, 'pipeline_run.ended', {
    pipeline_run_id: runId,
    pipeline_id: def.id,
    final_state: finalState,
    last_node: nodeId,
    last_disposition: lastDisposition,
    ...(abortReason ? { abort_reason: abortReason } : {}),
  })

  if (abortReason) {
    console.error(`${red('✗')} pipeline run ${dim(runId.slice(-12))} ${red(finalState)}: ${abortReason}`)
  } else {
    console.error(`${green('✓')} pipeline run ${dim(runId.slice(-12))} ${green(finalState)}`)
  }
  process.exit(finalState === 'completed' ? 0 : 1)
}

console.error(`unknown subcommand: ${sub}`)
usage(2)
