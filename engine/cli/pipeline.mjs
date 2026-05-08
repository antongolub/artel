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
  aggregateForJoin,
  evaluatePredicate,
  listPipelineFiles,
  listPipelineRuns,
  loadPipelineFile,
  pipelinePath,
  pipelinesDir,
  pipelineRunDetail,
  quorumOf,
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
                                or no transition matches
  runs [--limit N] [--pipeline <id>] [--json]
                              past pipeline runs from events.jsonl, newest
                                first
  status <run-id> [--json]    drilldown for one run (summary + per-node
                                timeline)`)
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
      const join = node.join || 'all-complete'
      const kSuffix = join === 'k-of-n' ? ` k=${node.k}` : ''
      console.log(`    ${cyan(nid.padEnd(20))} ${dim('parallel')} branches=[${node.branches.join(', ')}] join=${join}${kSuffix}`)
    } else if (node.type === 'condition') {
      const op = ['equals', 'in', 'exists'].find((k) => k in node.if)
      const opVal = op === 'in' ? `[${node.if.in.join(', ')}]` : JSON.stringify(node.if[op])
      console.log(`    ${cyan(nid.padEnd(20))} ${dim('condition')} if(${node.if.attr} ${op} ${opVal}) then=${node.then} else=${node.else}`)
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
        abortSignal: opts.signal || null,
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
      // race across siblings.
      // V3.3.c: progressive quorum collection. For all-complete the
      // walker waits for every branch (Promise.all-equivalent). For
      // any-complete (k=1) and k-of-n (k=node.k), each branch gets an
      // AbortController; once `k` successes are observed the walker
      // aborts the rest, then waits for them to settle as
      // `cancelled`. Cancelled branches are excluded from the
      // worst-of-children aggregate.
      const join = node.join || 'all-complete'
      const quorum = quorumOf(node)
      console.error(`${bold('▥')} ${cyan(nodeId)} ${dim('→')} parallel branches=[${node.branches.join(', ')}] join=${join}${join === 'k-of-n' ? ` k=${node.k}` : ''} ${dim('(concurrent worktrees)')}`)

      const aborts = node.branches.map(() => new AbortController())
      const promises = node.branches.map((branchId, i) =>
        runDispatchNode(branchId, nodeId, { useWorktree: true, signal: aborts[i].signal })
          .then((result) => ({ index: i, branchId, result })),
      )
      const settledByIndex = new Array(node.branches.length).fill(null)
      const remaining = new Set(promises)
      let succeeded = 0
      let parallelAbort = null

      while (remaining.size && succeeded < quorum) {
        const r = await Promise.race(remaining)
        // Find the original promise for this resolution to delete
        // from `remaining` (Promise.race resolves to value, not
        // promise — so we look up by index).
        for (const p of remaining) {
          if (promises[r.index] === p) { remaining.delete(p); break }
        }
        settledByIndex[r.index] = r.result
        if (r.result.__error) {
          parallelAbort = `branch '${r.branchId}' threw: ${r.result.__error}`
          break
        }
        console.error(`  ${dim('branch')} ${cyan(r.branchId)} ${dim('disposition:')} ${r.result.disposition}`)
        if (r.result.disposition === 'success') succeeded++
      }

      if (parallelAbort) {
        // One branch threw — cancel siblings + bail.
        for (let i = 0; i < node.branches.length; i++) {
          if (settledByIndex[i] === null) aborts[i].abort()
        }
        await Promise.allSettled([...remaining])
        abortReason = `parallel '${nodeId}': ${parallelAbort}`
        finalState = 'failed'
        break
      }

      // Quorum met (or all settled). If anyone's still in flight,
      // cancel them and collect their (cancelled) results.
      if (remaining.size > 0) {
        for (let i = 0; i < node.branches.length; i++) {
          if (settledByIndex[i] === null) aborts[i].abort()
        }
        const trailing = await Promise.allSettled([...remaining])
        for (const t of trailing) {
          if (t.status !== 'fulfilled') continue
          const { index, result } = t.value
          settledByIndex[index] = result
          console.error(`  ${dim('branch')} ${cyan(node.branches[index])} ${dim('disposition:')} ${result.disposition}${result.disposition === 'cancelled' ? dim(' (cancelled — quorum met)') : ''}`)
        }
      }

      const dispositions = settledByIndex.map((r) => (r ? r.disposition : 'cancelled'))
      stepDisposition = aggregateForJoin(dispositions, join, node.k)
      console.error(`  ${dim('aggregate:')} ${stepDisposition} ${dim('(' + join + ': ' + succeeded + '/' + quorum + ' succeeded, ' + dispositions.length + ' branches)')}`)
    } else if (node.type === 'condition') {
      // V3.2.b — pure routing. Predicate evaluated against the run's
      // task attrs (user-supplied + pipeline-injected ids). No
      // dispatch, no edges — direct jump to .then or .else.
      const attrs = {
        ...userAttrs,
        pipeline_run_id: runId,
        pipeline_id: def.id,
        pipeline_node_id: nodeId,
      }
      const matched = evaluatePredicate(node.if, attrs)
      const branchTaken = matched ? node.then : node.else
      console.error(`${bold('?')} ${cyan(nodeId)} ${dim('→')} condition ${dim('attr=')}${node.if.attr} ${dim('→')} ${matched ? green('then') : yellow('else')} ${dim('→')} ${cyan(branchTaken)}`)
      // Conditions don't generate a step disposition — short-circuit
      // straight to the chosen target.
      nodeId = branchTaken
      continue
    } else {
      abortReason = `unsupported node type '${node.type}' at '${nodeId}' (V3.2.b supports: dispatch | parallel | condition | terminal)`
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

// --- runs (V3.4.a — observability) ---

if (sub === 'runs') {
  let values
  try {
    ({ values } = parseArgs({
      args: subRest,
      options: {
        limit: { type: 'string' },
        pipeline: { type: 'string' },
        json: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    }))
  } catch (err) { die(err.message, 2) }
  if (values.help) usage(0)

  const limit = values.limit !== undefined ? Number(values.limit) : 20
  if (Number.isNaN(limit) || limit < 0) die(`runs: --limit must be a non-negative integer (got: ${values.limit})`, 2)
  const runs = listPipelineRuns(PROJECT_DIR, {
    limit,
    pipelineId: values.pipeline || null,
  })

  if (values.json) {
    console.log(JSON.stringify(runs, null, 2))
    process.exit(0)
  }

  console.log(`\n${bold('artel pipeline runs')} ${dim(`— ${runs.length} ${values.pipeline ? `for ${values.pipeline}` : 'most recent'}`)}\n`)
  if (!runs.length) {
    console.log(`  ${dim('(no runs yet — try: artel pipeline run <id>)')}`)
    console.log()
    process.exit(0)
  }
  const fmtDur = (ms) => {
    if (ms == null) return dim('—')
    if (ms < 1000) return `${ms}ms`
    if (ms < 60000) return `${Math.round(ms / 1000)}s`
    if (ms < 3600000) return `${Math.round(ms / 60000)}m`
    return `${(ms / 3600000).toFixed(1)}h`
  }
  for (const r of runs) {
    const stateColour =
      r.final_state === 'completed' ? green
      : r.final_state === 'aborted' ? yellow
      : r.final_state ? red
      : dim
    const state = r.final_state ? stateColour(r.final_state) : dim('in-flight')
    const when = (r.started_at || '').replace('T', ' ').slice(0, 19) + 'Z'
    const tail = r.run_id.slice(-8)
    console.log(`  ${dim(when)}  ${cyan(tail)}  ${cyan(r.pipeline_id?.padEnd(20) || '?'.padEnd(20))} ${state.padEnd(20)} ${dim(fmtDur(r.duration_ms).padStart(6))} ${r.last_node ? dim(`→ ${r.last_node}`) : ''}`)
  }
  console.log()
  process.exit(0)
}

// --- status (V3.4.a — drilldown) ---

if (sub === 'status') {
  let values, positionals
  try {
    ({ values, positionals } = parseArgs({
      args: subRest,
      options: { json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
      allowPositionals: true,
    }))
  } catch (err) { die(err.message, 2) }
  if (values.help) usage(0)
  const [runIdArg] = positionals
  if (!runIdArg) die('status: <run-id> is required (full UUID or trailing fragment)', 2)

  // Allow short fragments — match against last 12 chars of any
  // known run_id. If multiple match, error out asking for more chars.
  // (Pass null limit so listPipelineRuns returns the full set; -1
  //  would trigger Array.prototype.slice's drop-last semantics.)
  const allRuns = listPipelineRuns(PROJECT_DIR, { limit: null })
  const matched = allRuns.filter((r) => r.run_id === runIdArg || r.run_id.endsWith(runIdArg))
  if (!matched.length) die(`status: no run matches '${runIdArg}'`, 1)
  if (matched.length > 1 && !matched.some((r) => r.run_id === runIdArg)) {
    die(`status: '${runIdArg}' matches ${matched.length} runs — use a longer fragment or full UUID`, 1)
  }
  const fullRunId = matched.length === 1 ? matched[0].run_id : runIdArg
  const detail = pipelineRunDetail(PROJECT_DIR, fullRunId)
  if (!detail) die(`status: no events found for run '${fullRunId}'`, 1)

  if (values.json) {
    console.log(JSON.stringify(detail, null, 2))
    process.exit(0)
  }

  console.log(`\n${bold('artel pipeline status')} ${cyan(detail.run_id)}\n`)
  console.log(`  ${dim('pipeline:'.padEnd(14))} ${cyan(detail.pipeline_id)} ${dim('v' + detail.pipeline_version)}`)
  console.log(`  ${dim('entry:'.padEnd(14))}    ${cyan(detail.entry_node)}`)
  console.log(`  ${dim('started:'.padEnd(14))}  ${detail.started_at?.replace('T', ' ').slice(0, 19) || '?'} UTC`)
  if (detail.ended_at) {
    const colour =
      detail.final_state === 'completed' ? green
      : detail.final_state === 'aborted' ? yellow : red
    console.log(`  ${dim('ended:'.padEnd(14))}    ${detail.ended_at.replace('T', ' ').slice(0, 19)} UTC ${dim(`(duration ${detail.duration_ms ?? '?'}ms)`)}`)
    console.log(`  ${dim('final state:'.padEnd(14))} ${colour(detail.final_state || '?')}`)
    if (detail.last_node) console.log(`  ${dim('last node:'.padEnd(14))}  ${cyan(detail.last_node)} ${dim(`disposition=${detail.last_disposition || '?'}`)}`)
    if (detail.abort_reason) console.log(`  ${dim('abort:'.padEnd(14))}    ${red(detail.abort_reason)}`)
  } else {
    console.log(`  ${dim('ended:'.padEnd(14))}    ${yellow('still in flight')}`)
  }

  console.log(`\n  ${bold('Steps')} ${dim(`(${detail.steps.length})`)}`)
  if (!detail.steps.length) {
    console.log(`    ${dim('(no dispatches recorded yet)')}`)
  } else {
    for (const s of detail.steps) {
      const dispoColour =
        s.disposition === 'success' ? green
        : s.disposition === 'parked' ? yellow
        : s.disposition === 'timeout' || s.disposition === 'error' ? red
        : dim
      const dispo = s.disposition ? dispoColour(s.disposition) : dim('in-flight')
      const parallelHint = s.parallel_of ? ` ${dim('(parallel of ' + s.parallel_of + ')')}` : ''
      console.log(`    ${cyan(s.node_id?.padEnd(14) || '?'.padEnd(14))} ${dim(s.task?.padEnd(28) || '')} ${s.role?.padEnd(12) || ''} ${dim(s.engine?.padEnd(8) || '')} ${dispo}${parallelHint}`)
    }
  }
  console.log(`\n  ${dim(`drilldown: artel logs <task>`)}\n`)
  process.exit(0)
}

console.error(`unknown subcommand: ${sub}`)
usage(2)
