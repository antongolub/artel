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
import { spawn } from 'node:child_process'
import { parseArgs } from 'node:util'
import { appendWorkloadEvent } from '../util/audit.mjs'
import {
  aggregateDisposition,
  aggregateForJoin,
  deepMergeAttrs,
  deletePath,
  evaluatePredicate,
  listPipelineFiles,
  listPipelineRuns,
  loadPipelineFile,
  pipelineCancelPath,
  pipelineCancelsDir,
  pipelinePath,
  pipelinesDir,
  pipelineRunDetail,
  quorumOf,
  renderTemplate,
  resolveNext,
  validatePipeline,
} from '../util/pipelines.mjs'
import { dispatchLifecycle } from '../core/dispatch_lifecycle.mjs'
import { runHandler } from '../util/handlers.mjs'
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

// V3.6 — pretty-print one predicate for `show`. Recurses through
// compound shapes (not/and/or). Atomic shape covers all of
// equals/ne/in/exists/gt/gte/lt/lte. Falls back to a `?` marker
// rather than throwing — `show` should still render even if the
// predicate slipped through validator changes.
const renderPredicate = (pred) => {
  if (!pred || typeof pred !== 'object') return '?'
  if ('not' in pred) return `not(${renderPredicate(pred.not)})`
  if ('and' in pred) return `(${pred.and.map(renderPredicate).join(' and ')})`
  if ('or' in pred) return `(${pred.or.map(renderPredicate).join(' or ')})`
  const ATOMIC = ['equals', 'ne', 'in', 'exists', 'gt', 'gte', 'lt', 'lte']
  const op = ATOMIC.find((k) => k in pred)
  if (!op) return '?'
  const opVal = op === 'in' ? `[${pred.in.join(', ')}]` : JSON.stringify(pred[op])
  return `${pred.attr} ${op} ${opVal}`
}

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
                                timeline)
  cancel <run-id>             signal an in-flight run to abort; walker
                                picks up the sentinel at next step
                                boundary, aborts in-flight branches,
                                emits pipeline_run.ended (final_state:
                                aborted)`)
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
      console.log(`    ${cyan(nid.padEnd(20))} ${dim('dispatch')} role=${node.role}${node.engine ? ` engine=${node.engine}` : ''}${node.model ? ` model=${node.model}` : ''}${node.timeout_ms ? ` timeout_ms=${node.timeout_ms}` : ''}`)
    } else if (node.type === 'terminal') {
      const colour = node.final_state === 'completed' ? green
        : node.final_state === 'aborted' ? yellow : red
      console.log(`    ${cyan(nid.padEnd(20))} ${dim('terminal')} → ${colour(node.final_state)}`)
    } else if (node.type === 'parallel') {
      const join = node.join || 'all-complete'
      const kSuffix = join === 'k-of-n' ? ` k=${node.k}` : ''
      console.log(`    ${cyan(nid.padEnd(20))} ${dim('parallel')} branches=[${node.branches.join(', ')}] join=${join}${kSuffix}`)
    } else if (node.type === 'condition') {
      // V3.6 — recursive renderer covers atomic (equals/ne/in/exists/
      // gt/gte/lt/lte) and compound (not/and/or) shapes.
      console.log(`    ${cyan(nid.padEnd(20))} ${dim('condition')} if(${renderPredicate(node.if)}) then=${node.then} else=${node.else}`)
    } else if (node.type === 'handler') {
      // V3.7.a/c — render builtin name + key fields. `cmd` quoted as
      // JSON so spaces / quotes round-trip readably; assert prints
      // the predicate via the same renderPredicate as condition.
      const detail =
        node.handler === 'builtin.exec'
          ? ` cmd=${JSON.stringify(node.cmd)}${node.timeout_ms ? ` timeout_ms=${node.timeout_ms}` : ''}`
        : node.handler === 'builtin.assert'
          ? ` if(${renderPredicate(node.if)})${node.message ? ` message=${JSON.stringify(node.message)}` : ''}`
        : node.handler === 'builtin.set_attr'
          ? `${node.set ? ` set=${JSON.stringify(node.set)}` : ''}${node.unset ? ` unset=${JSON.stringify(node.unset)}` : ''}`
        : node.handler === 'builtin.git_tag'
          ? ` name=${JSON.stringify(node.name)}${node.lightweight === true ? ' lightweight' : ` message=${JSON.stringify(node.message)}`}${node.target ? ` target=${JSON.stringify(node.target)}` : ''}`
        : ''
      console.log(`    ${cyan(nid.padEnd(20))} ${dim('handler')} ${node.handler}${detail}`)
    } else if (node.type === 'subpipeline') {
      // V3.10.a — show the child pipeline_id + attrs spec
      // (templates unrendered). V3.10.c — `inherit` flag.
      const attrsDetail = node.attrs ? ` attrs=${JSON.stringify(node.attrs)}` : ''
      const inheritDetail = node.inherit_attrs === true ? ' inherit_attrs' : ''
      console.log(`    ${cyan(nid.padEnd(20))} ${dim('subpipeline')} pipeline_id=${cyan(node.pipeline_id)}${inheritDetail}${attrsDetail}`)
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
        // V3.10.a — set when this run is a subpipeline child; the
        // values land in pipeline_run.started for trace correlation.
        'parent-run': { type: 'string' },
        'parent-node': { type: 'string' },
        // V3.10.b — chain of ancestor pipeline_ids (comma-separated)
        // for arbitrary-depth cycle detection. Parent appends its
        // own def.id when spawning child.
        'parent-chain': { type: 'string' },
        // V3.10.b — parent-controlled run_id. When omitted the
        // walker generates one (back-compat for top-level runs);
        // subpipeline parents pre-allocate it so they know where
        // the child's cancel sentinel will land.
        'run-id': { type: 'string' },
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

  // V3.10.b — cycle detection. parent-chain is a comma-separated
  // list of ancestor pipeline_ids; if our own def.id appears in it,
  // a subpipeline cycle is closing and we abort before any side
  // effects (no pipeline_run.started, no dispatches).
  const parentChain = values['parent-chain']
    ? values['parent-chain'].split(',').map((s) => s.trim()).filter(Boolean)
    : []
  if (parentChain.includes(def.id)) {
    const trace = [...parentChain, def.id].join(' → ')
    die(`run: subpipeline cycle detected — '${def.id}' already in ancestor chain: ${trace}`, 1)
  }

  let userAttrs = {}
  if (values.attrs) {
    try { userAttrs = JSON.parse(values.attrs) }
    catch (err) { die(`run: --attrs is not valid JSON: ${err.message}`, 2) }
  }

  const runId = values['run-id'] || uuidv7()
  const taskPrefix = values['task-prefix'] || `${id}-${runId.slice(-6)}`

  appendWorkloadEvent(PROJECT_DIR, 'pipeline_run.started', {
    pipeline_run_id: runId,
    pipeline_id: def.id,
    pipeline_version: def.version,
    entry_node: def.entry,
    // V3.10.a — child-of-subpipeline correlation
    ...(values['parent-run'] ? { parent_pipeline_run_id: values['parent-run'] } : {}),
    ...(values['parent-node'] ? { parent_pipeline_node_id: values['parent-node'] } : {}),
  })

  console.error(`${bold('▶')} pipeline ${cyan(def.id)} v${def.version} run=${dim(runId.slice(-12))} prefix=${dim(taskPrefix)}`)

  let nodeId = def.entry
  let lastDisposition = null
  let finalState = null
  let abortReason = null

  // V3.8 — operator cancel watcher. The walker creates a master
  // AbortController and polls for the sentinel file
  // `.artel/.pipeline-cancels/<run-id>`; on detection it aborts the
  // master controller, which cascades to in-flight dispatch +
  // handler.exec branches via their abortSignal plumbing. Polling
  // (rather than fs.watch) for cross-platform reliability; 500ms
  // is responsive enough for an interactive cancel without burning
  // CPU.
  const runAbort = new AbortController()
  const sentinelPath = pipelineCancelPath(PROJECT_DIR, runId)
  let sentinelFragment = null
  const cancelWatcher = setInterval(() => {
    if (existsSync(sentinelPath) && !runAbort.signal.aborted) {
      sentinelFragment = runId.slice(-12)
      runAbort.abort()
    }
  }, 500)
  // unref so a stuck watcher can't keep node alive past walker exit
  cancelWatcher.unref?.()

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
    // V3.5 — render `{{ attr }}` substitutions in the prompt against
    // the same merged attrs blob that flows through as `task_attrs`.
    // Built once here so the rendered prompt and the passed-through
    // attrs stay synchronized — no risk of substituting against a
    // stale view. Render errors (missing attr, non-scalar value)
    // surface as the dispatch's __error so the run aborts cleanly.
    const taskAttrs = {
      ...userAttrs,
      pipeline_run_id: runId,
      pipeline_id: def.id,
      pipeline_node_id: id,
      ...(parallelOf ? { pipeline_parallel_of: parallelOf } : {}),
    }
    let renderedPrompt
    try { renderedPrompt = renderTemplate(node.prompt, taskAttrs) }
    catch (err) {
      return { __error: `prompt template at node '${id}': ${err.message}`, node: id }
    }
    try {
      return await dispatchLifecycle({
        role: node.role,
        task: taskSlug,
        prompt: renderedPrompt,
        engine: node.engine || null,
        model: node.model || null,
        effort: node.effort || null,
        sandbox: node.sandbox || null,
        tools: node.tools || null,
        permissionMode: node['permission-mode'] || null,
        useWorktree: !!opts.useWorktree,
        // V3.9 — per-node timeout. dispatchLifecycle falls back to
        // env / default when null, so passing through unconditionally
        // preserves prior behavior for nodes that don't set it.
        timeoutMs: node.timeout_ms ?? null,
        abortSignal: opts.signal || null,
        taskAttrs,
      })
    } catch (err) {
      return { __error: err?.message || String(err), node: id }
    }
  }

  // V3.7.e — handler walker logic extracted from the inline block so
  // parallel branches can call it via runBranchNode. Returns the same
  // shape as runDispatchNode: `{ disposition, ... }` on settle or
  // `{ __error, node }` on a thrown handler. Mutation
  // (`result.attrs`) is applied here only when this is a top-level
  // step (parallelOf == null). For parallel branches, set_attr is
  // disallowed at the validator level, so result.attrs would never
  // appear there anyway — the guard is belt-and-suspenders.
  const runHandlerNode = async (id, parallelOf = null, opts = {}) => {
    const node = def.nodes[id]
    const handlerAttrs = {
      ...userAttrs,
      pipeline_run_id: runId,
      pipeline_id: def.id,
      pipeline_node_id: id,
      ...(parallelOf ? { pipeline_parallel_of: parallelOf } : {}),
    }
    const setAttrDetail = () => {
      const parts = []
      if (node.set) parts.push(`${dim('set=')}${JSON.stringify(node.set)}`)
      if (node.unset) parts.push(`${dim('unset=')}${JSON.stringify(node.unset)}`)
      return parts.length ? ' ' + parts.join(' ') : ''
    }
    const detail =
      node.handler === 'builtin.exec' ? ` ${dim('cmd=')}${JSON.stringify(node.cmd)}` :
      node.handler === 'builtin.assert' ? ` ${dim('if=')}${renderPredicate(node.if)}` :
      node.handler === 'builtin.set_attr' ? setAttrDetail() :
      node.handler === 'builtin.git_tag' ? ` ${dim('name=')}${JSON.stringify(node.name)}${node.target ? ` ${dim('target=')}${JSON.stringify(node.target)}` : ''}` :
      ''
    console.error(`${bold('●')} ${cyan(id)} ${dim('→')} handler ${node.handler}${detail}`)
    const handlerId = uuidv7()
    appendWorkloadEvent(PROJECT_DIR, 'pipeline_handler.start', {
      handler_id: handlerId,
      handler: node.handler,
      pipeline_run_id: runId,
      pipeline_id: def.id,
      pipeline_node_id: id,
      ...(parallelOf ? { pipeline_parallel_of: parallelOf } : {}),
      ...(node.handler === 'builtin.exec' ? {
        cmd: node.cmd,
        ...(node.timeout_ms != null ? { timeout_ms: node.timeout_ms } : {}),
      } : {}),
      ...(node.handler === 'builtin.assert' ? {
        predicate: node.if,
        ...(node.message ? { message_template: node.message } : {}),
      } : {}),
      ...(node.handler === 'builtin.set_attr' ? {
        // V3.7.d.b — set + unset are both optional but at least
        // one is required (validator-enforced). Snapshot what's
        // present; templates are unrendered here, end event
        // carries set_resolved.
        ...(node.set ? { set: node.set } : {}),
        ...(node.unset ? { unset: node.unset } : {}),
      } : {}),
      ...(node.handler === 'builtin.git_tag' ? {
        // V3.7.f — name / message / target snapshotted verbatim
        // (templates unrendered); end event carries tag_name +
        // target (resolved).
        name: node.name,
        ...(node.message != null ? { message: node.message } : {}),
        ...(node.target != null ? { target: node.target } : {}),
        annotated: node.lightweight !== true,
      } : {}),
    })
    try {
      const result = await runHandler(node, {
        projectDir: PROJECT_DIR,
        attrs: handlerAttrs,
        abortSignal: opts.signal || null,
      })
      const ec = result.exitCode == null ? '?' : result.exitCode
      const durLabel =
        node.handler === 'builtin.assert' || node.handler === 'builtin.set_attr'
          ? `${result.durationMs}ms`
        : node.handler === 'builtin.git_tag'
          ? `${result.tag_name ? `tag=${result.tag_name}, ` : ''}${result.durationMs}ms`
          : `exit=${ec}, ${result.durationMs}ms`
      console.error(`  ${dim('disposition:')} ${result.disposition} ${dim(`(${durLabel})`)}${result.error ? ` ${dim('error:')} ${result.error}` : ''}`)
      appendWorkloadEvent(PROJECT_DIR, 'pipeline_handler.end', {
        handler_id: handlerId,
        handler: node.handler,
        pipeline_run_id: runId,
        pipeline_id: def.id,
        pipeline_node_id: id,
        ...(parallelOf ? { pipeline_parallel_of: parallelOf } : {}),
        disposition: result.disposition,
        exit_code: result.exitCode ?? null,
        signal: result.signal ?? null,
        duration_ms: result.durationMs,
        ...(result.error ? { error: result.error } : {}),
        ...(result.set_resolved && Object.keys(result.set_resolved).length
          ? { set_resolved: result.set_resolved } : {}),
        ...(Array.isArray(result.unsets) && result.unsets.length
          ? { unset_resolved: result.unsets } : {}),
        // V3.7.f — git_tag forensics
        ...(result.tag_name != null ? { tag_name: result.tag_name } : {}),
        ...(result.target != null ? { target_resolved: result.target } : {}),
        ...(typeof result.annotated === 'boolean' ? { annotated: result.annotated } : {}),
      })
      // Apply mutation only at top level — parallel branches don't
      // run set_attr (validator rejects it). Defensive guard
      // preserves the rule even if the validator ever changes.
      // V3.7.d.b — `result.attrs` is the nested form (built via
      // writePath); deepMergeAttrs preserves siblings under shared
      // top keys. `result.unsets` is dotted-path strings; deletePath
      // removes each. set + unset both apply on success — no partial
      // (handler returned atomically).
      if (parallelOf == null && result.disposition === 'success') {
        if (result.attrs && Object.keys(result.attrs).length) {
          deepMergeAttrs(userAttrs, result.attrs)
        }
        if (Array.isArray(result.unsets)) {
          for (const path of result.unsets) deletePath(userAttrs, path)
        }
      }
      return result
    } catch (err) {
      appendWorkloadEvent(PROJECT_DIR, 'pipeline_handler.end', {
        handler_id: handlerId,
        handler: node.handler,
        pipeline_run_id: runId,
        pipeline_id: def.id,
        pipeline_node_id: id,
        ...(parallelOf ? { pipeline_parallel_of: parallelOf } : {}),
        disposition: 'error',
        error: err.message,
      })
      return { __error: err.message, node: id }
    }
  }

  // V3.10.a inline; V3.10.d extracted so runBranchNode can call it
  // for subpipeline branches. Returns runDispatchNode-shape:
  // `{ disposition }` on settle, `{ __error, node }` on a thrown /
  // unregistered child. opts.signal — when fires, write the child's
  // V3.8 cancel sentinel so the child's poller aborts the run
  // gracefully (~500ms + SIGTERM grace). Tracks whether the cancel
  // already fired to skip double-write on the rare double-fire.
  const runSubpipelineNode = async (id, parallelOf = null, opts = {}) => {
    const node = def.nodes[id]
    const childPath = pipelinePath(PROJECT_DIR, node.pipeline_id)
    if (!existsSync(childPath)) {
      return {
        __error: `child pipeline '${node.pipeline_id}' not registered`,
        node: id,
      }
    }
    const parentScope = {
      ...userAttrs,
      pipeline_run_id: runId,
      pipeline_id: def.id,
      pipeline_node_id: id,
      ...(parallelOf ? { pipeline_parallel_of: parallelOf } : {}),
    }
    let childAttrs = node.inherit_attrs === true ? { ...userAttrs } : {}
    if (node.attrs) {
      for (const [k, raw] of Object.entries(node.attrs)) {
        try {
          childAttrs[k] = typeof raw === 'string' ? renderTemplate(raw, parentScope) : raw
        } catch (err) {
          return {
            __error: `template render failed: attrs['${k}']: ${err.message}`,
            node: id,
          }
        }
      }
    }
    const childRunId = uuidv7()
    const childChain = [...parentChain, def.id].join(',')
    console.error(`${bold('▦')} ${cyan(id)} ${dim('→')} subpipeline ${cyan(node.pipeline_id)} ${dim(`run=${childRunId.slice(-12)}`)}${node.attrs ? ` ${dim('attrs=')}${JSON.stringify(childAttrs)}` : ''}`)
    const childArgs = [
      process.argv[1], 'run', node.pipeline_id,
      '--run-id', childRunId,
      '--parent-run', runId,
      '--parent-node', id,
      '--parent-chain', childChain,
    ]
    if (Object.keys(childAttrs).length) {
      childArgs.push('--attrs', JSON.stringify(childAttrs))
    }
    let childCancelled = false
    const cancelChild = () => {
      if (childCancelled) return
      childCancelled = true
      try {
        mkdirSync(pipelineCancelsDir(PROJECT_DIR), { recursive: true })
        writeFileSync(pipelineCancelPath(PROJECT_DIR, childRunId), '')
      } catch {}
    }
    let abortHandler = null
    if (opts.signal) {
      if (opts.signal.aborted) {
        cancelChild()
      } else {
        abortHandler = cancelChild
        opts.signal.addEventListener('abort', abortHandler, { once: true })
      }
    }
    // V3.10.d — when this subpipeline is itself a parallel branch
    // (parallelOf set), force the child's dispatches to use
    // worktrees. Otherwise the child's `git checkout -B` on the
    // shared main checkout would race against sibling branches'
    // git operations on the same repo.
    const childEnv = parallelOf
      ? { ...process.env, ARTEL_PIPELINE_FORCE_WORKTREE: '1' }
      : process.env
    const childExit = await new Promise((resolveExit) => {
      const child = spawn(process.argv0, childArgs, {
        cwd: PROJECT_DIR, stdio: 'inherit', env: childEnv,
      })
      child.on('error', () => resolveExit(-1))
      child.on('exit', (code) => resolveExit(code ?? -1))
    })
    if (abortHandler && opts.signal) {
      opts.signal.removeEventListener('abort', abortHandler)
    }
    const disposition = childExit === 0 ? 'success' : 'error'
    console.error(`  ${dim('disposition:')} ${disposition} ${dim(`(child exit=${childExit})`)}`)
    return { disposition, child_run_id: childRunId, child_pipeline_id: node.pipeline_id, exit_code: childExit }
  }

  // V3.7.e — branch dispatcher used by the parallel walker. Routes
  // by node type so parallel can mix dispatch + handler + subpipeline
  // branches (V3.10.d). Other types (parallel / condition / terminal)
  // aren't legal branches; the validator rejects them at register
  // time, so this dispatcher just trusts the def shape.
  const runBranchNode = async (id, parentId, opts) => {
    const node = def.nodes[id]
    if (node.type === 'dispatch') {
      return runDispatchNode(id, parentId, { useWorktree: true, signal: opts.signal })
    }
    if (node.type === 'handler') {
      return runHandlerNode(id, parentId, { signal: opts.signal })
    }
    if (node.type === 'subpipeline') {
      return runSubpipelineNode(id, parentId, { signal: opts.signal })
    }
    return { __error: `branch '${id}' has unsupported type '${node.type}'`, node: id }
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

    // V3.8 — operator cancel can fire between steps; check before
    // committing to a new step.
    if (runAbort.signal.aborted) {
      abortReason = `cancelled by operator: ${sentinelFragment}`
      finalState = 'aborted'
      break
    }

    let stepDisposition = null
    if (node.type === 'dispatch') {
      // V3.8 — pass runAbort.signal so a cancel during the dispatch
      // (which can be long-lived) terminates the child via V3.3.c's
      // SIGTERM→SIGKILL plumbing. Linear dispatch was previously
      // signal-less; cancel only took effect at next step boundary.
      // V3.10.d — when this run was spawned as a parallel-branch
      // subpipeline, ARTEL_PIPELINE_FORCE_WORKTREE=1 forces every
      // dispatch to isolate via worktree (otherwise the child's
      // `git checkout -B` would race against sibling branches'
      // operations on the parent's main checkout).
      const forceWorktree = process.env.ARTEL_PIPELINE_FORCE_WORKTREE === '1'
      const result = await runDispatchNode(nodeId, null, {
        signal: runAbort.signal,
        useWorktree: forceWorktree,
      })
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
      // V3.8 — operator cancel cascades into every branch. If
      // runAbort fires while the parallel block is active, abort
      // each per-branch controller; their existing V3.3.c
      // cancellation paths handle the SIGTERM dance for dispatches +
      // handler.exec; assert/set_attr never appear in branches.
      const cascadeAbort = () => {
        for (const c of aborts) {
          if (!c.signal.aborted) c.abort()
        }
      }
      if (runAbort.signal.aborted) {
        cascadeAbort()
      } else {
        runAbort.signal.addEventListener('abort', cascadeAbort, { once: true })
      }
      const promises = node.branches.map((branchId, i) =>
        // V3.7.e — runBranchNode dispatches by node type so dispatch
        // and handler branches can coexist. Each gets its own
        // AbortController for V3.3.c quorum-met cancellation.
        runBranchNode(branchId, nodeId, { signal: aborts[i].signal })
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
      // V3.8 — if cancel fired during the parallel block, the
      // branches settled (cancelled / error / partial success) but
      // the run as a whole is aborted. Set the outcome here rather
      // than letting the disposition flow through edges — operator
      // cancel always terminates with `aborted`, regardless of
      // which branches happened to finish.
      if (runAbort.signal.aborted) {
        abortReason = `cancelled by operator: ${sentinelFragment}`
        finalState = 'aborted'
        break
      }
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
      console.error(`${bold('?')} ${cyan(nodeId)} ${dim('→')} condition ${dim('→')} ${matched ? green('then') : yellow('else')} ${dim('→')} ${cyan(branchTaken)}`)
      // Conditions don't generate a step disposition — short-circuit
      // straight to the chosen target.
      nodeId = branchTaken
      continue
    } else if (node.type === 'handler') {
      // V3.7.a-d inline; V3.7.e extracted into runHandlerNode so the
      // parallel walker can call it for handler branches via
      // runBranchNode. V3.8 — pass runAbort.signal so a cancel
      // during a long-running builtin.exec terminates via SIGTERM.
      const result = await runHandlerNode(nodeId, null, { signal: runAbort.signal })
      if (result.__error) {
        abortReason = `handler '${nodeId}' threw: ${result.__error}`
        finalState = 'failed'
        break
      }
      stepDisposition = result.disposition
    } else if (node.type === 'subpipeline') {
      // V3.10.a inline; V3.10.d extracted into runSubpipelineNode so
      // parallel branches can call it via runBranchNode.
      const result = await runSubpipelineNode(nodeId, null, { signal: runAbort.signal })
      if (result.__error) {
        abortReason = `subpipeline '${nodeId}': ${result.__error}`
        finalState = 'failed'
        break
      }
      stepDisposition = result.disposition
    } else {
      abortReason = `unsupported node type '${node.type}' at '${nodeId}' (V3.10.d supports: dispatch | parallel | condition | handler | subpipeline | terminal)`
      finalState = 'failed'
      break
    }

    lastDisposition = stepDisposition
    // V3.8 — cancel could have fired mid-step (e.g. during a
    // long-running dispatch where SIGTERM aborted it). The step's
    // disposition becomes `cancelled`, but at the run level we want
    // `aborted` regardless of how each step settled.
    if (runAbort.signal.aborted) {
      abortReason = `cancelled by operator: ${sentinelFragment}`
      finalState = 'aborted'
      break
    }
    const next = resolveNext(def, nodeId, stepDisposition)
    if (!next) {
      abortReason = `no transition for disposition '${stepDisposition}' from node '${nodeId}'`
      finalState = 'failed'
      break
    }
    console.error(`  ${dim('disposition:')} ${stepDisposition} ${dim('→')} ${cyan(next)}`)
    nodeId = next
  }

  // V3.8 — release the sentinel watcher; without unref this would
  // keep the node loop alive past process.exit on some platforms.
  clearInterval(cancelWatcher)

  appendWorkloadEvent(PROJECT_DIR, 'pipeline_run.ended', {
    pipeline_run_id: runId,
    pipeline_id: def.id,
    final_state: finalState,
    last_node: nodeId,
    last_disposition: lastDisposition,
    ...(abortReason ? { abort_reason: abortReason } : {}),
    // V3.10.b — mirror parent linkage from `.started` so trace tools
    // can join `.ended` events to parent runs without back-walking
    // through `.started`.
    ...(values['parent-run'] ? { parent_pipeline_run_id: values['parent-run'] } : {}),
    ...(values['parent-node'] ? { parent_pipeline_node_id: values['parent-node'] } : {}),
  })

  if (abortReason) {
    console.error(`${red('✗')} pipeline run ${dim(runId.slice(-12))} ${red(finalState)}: ${abortReason}`)
  } else {
    console.error(`${green('✓')} pipeline run ${dim(runId.slice(-12))} ${green(finalState)}`)
  }
  process.exit(finalState === 'completed' ? 0 : 1)
}

// --- cancel (V3.8 — operator cancel) ---

if (sub === 'cancel') {
  let values, positionals
  try {
    ({ values, positionals } = parseArgs({
      args: subRest,
      options: { help: { type: 'boolean', short: 'h' } },
      allowPositionals: true,
    }))
  } catch (err) { die(err.message, 2) }
  if (values.help) usage(0)
  const [runIdArg] = positionals
  if (!runIdArg) die('cancel: <run-id> is required (full UUID or trailing fragment)', 2)

  // Resolve fragment → full run_id (same logic as `status`).
  const allRuns = listPipelineRuns(PROJECT_DIR, { limit: null })
  const matched = allRuns.filter((r) => r.run_id === runIdArg || r.run_id.endsWith(runIdArg))
  if (!matched.length) die(`cancel: no run matches '${runIdArg}'`, 1)
  if (matched.length > 1 && !matched.some((r) => r.run_id === runIdArg)) {
    die(`cancel: '${runIdArg}' matches ${matched.length} runs — use a longer fragment`, 1)
  }
  const fullRunId = matched.length === 1 ? matched[0].run_id : runIdArg
  const summary = matched.find((r) => r.run_id === fullRunId)

  // Refuse to cancel a terminated run — leaves no useful effect.
  if (summary?.final_state) {
    die(`cancel: run '${runIdArg}' already terminal (final_state=${summary.final_state})`, 1)
  }

  // Drop the sentinel. Walker's poller picks it up at next tick;
  // empty-file-presence is the entire signal (no payload). We don't
  // rm the file here — leave it for forensics. `artel sweep` can
  // prune stale ones (deferred).
  mkdirSync(pipelineCancelsDir(PROJECT_DIR), { recursive: true })
  const sentinel = pipelineCancelPath(PROJECT_DIR, fullRunId)
  writeFileSync(sentinel, '')

  console.error(`${yellow('⚑')} cancel signal sent for run ${dim(fullRunId.slice(-12))} ${dim(`→ ${sentinel}`)}`)
  process.exit(0)
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
    // V3.10.b — annotate child runs with the parent's tail
    // fragment so operators can spot composition relationships at a
    // glance. Two-space indent for the row keeps alignment.
    const parentHint = r.parent_run_id ? ` ${dim(`↳ child of ${r.parent_run_id.slice(-8)}`)}` : ''
    console.log(`  ${dim(when)}  ${cyan(tail)}  ${cyan(r.pipeline_id?.padEnd(20) || '?'.padEnd(20))} ${state.padEnd(20)} ${dim(fmtDur(r.duration_ms).padStart(6))} ${r.last_node ? dim(`→ ${r.last_node}`) : ''}${parentHint}`)
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
    console.log(`    ${dim('(no steps recorded yet)')}`)
  } else {
    for (const s of detail.steps) {
      const dispoColour =
        s.disposition === 'success' ? green
        : s.disposition === 'parked' ? yellow
        : s.disposition === 'timeout' || s.disposition === 'error' ? red
        : dim
      const dispo = s.disposition ? dispoColour(s.disposition) : dim('in-flight')
      if (s.kind === 'handler') {
        // V3.7.b — handler row. Mirrors dispatch column layout but
        // role/engine slots become handler / cmd-fragment so the
        // alignment stays. cmd is truncated to keep the row scannable.
        const cmdFrag = s.cmd ? (s.cmd.length > 26 ? s.cmd.slice(0, 25) + '…' : s.cmd) : ''
        console.log(`    ${cyan(s.node_id?.padEnd(14) || '?'.padEnd(14))} ${dim((cmdFrag || '').padEnd(28))} ${dim('handler'.padEnd(12))} ${dim((s.handler || '').replace(/^builtin\./, '').padEnd(8))} ${dispo}`)
      } else {
        const parallelHint = s.parallel_of ? ` ${dim('(parallel of ' + s.parallel_of + ')')}` : ''
        console.log(`    ${cyan(s.node_id?.padEnd(14) || '?'.padEnd(14))} ${dim(s.task?.padEnd(28) || '')} ${s.role?.padEnd(12) || ''} ${dim(s.engine?.padEnd(8) || '')} ${dispo}${parallelHint}`)
      }
    }
  }
  console.log(`\n  ${dim(`drilldown: artel logs <task>`)}\n`)
  process.exit(0)
}

console.error(`unknown subcommand: ${sub}`)
usage(2)
