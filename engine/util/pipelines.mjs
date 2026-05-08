// Pipeline registry — parser + validator (V3.1 + V3.2.a).
//
// Pipelines live as JSON at `.artel/pipelines/<id>.json`. They define a
// directed graph of nodes connected by edges keyed on dispatch
// disposition.
//
// V3.1 node types: `dispatch`, `terminal`.
// V3.2.a adds `parallel` — fan-out + all-complete join. V3.3.a wires
// branches to git worktrees + Promise.all, so they run truly
// concurrently while the operator's main checkout stays put.
//
// V3.2.b adds `condition` — a pure routing node. It evaluates a
// predicate against the run's `task_attrs` (carrying both
// user-supplied `--attrs` JSON and pipeline-injected ids) and jumps
// to `then` or `else` without dispatching. Use case: gate impl on
// `attrs.skip_tests`, branch on `attrs.target = staging|prod`, etc.
//
// `pause` / `handler` / `subpipeline` deferred to V3.2.c+.
//
// V3.1 schema:
//   {
//     "id": "<slug>",                # filename root; matches /^[a-z0-9][a-z0-9._-]*$/i
//     "version": 1,                  # bumped on edit
//     "description": "...",          # optional, free text
//     "entry": "<node-id>",          # which node starts the run
//     "nodes": {
//       "<node-id>": {
//         "type": "dispatch",
//         "role": "<role-name>",     # required for dispatch
//         "engine": "<engine>",      # optional driver override
//         "model": "...", "effort": "...", "sandbox": "...",
//                                    # optional dispatch flags (forwarded to spawn)
//         "prompt": "..."            # required for dispatch (literal in V3.1;
//                                      template substitution lands in V3.2)
//       },
//       "<terminal-id>": {
//         "type": "terminal",
//         "final_state": "completed" | "failed" | "aborted" | "superseded"
//       }
//     },
//     "edges": [
//       { "from": "<node-id>",
//         "on_disposition": "success" | "parked" | "timeout" | "error" | "*",
//         "to": "<node-id>" }
//     ]
//   }

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const PIPELINES_DIR_REL = ['.artel', 'pipelines']

export const pipelinesDir = (projectDir) =>
  join(projectDir, ...PIPELINES_DIR_REL)

export const pipelinePath = (projectDir, id) =>
  join(pipelinesDir(projectDir), `${id}.json`)

const SLUG_RE = /^[a-z0-9][a-z0-9._-]*$/i

export const VALID_NODE_TYPES = new Set(['dispatch', 'terminal', 'parallel', 'condition'])

// V3.3.c — three join policies. all-complete waits for every branch;
// any-complete returns as soon as one succeeds (cancels the rest);
// k-of-n returns as soon as `node.k` succeed (cancels the rest).
// Cancellation rides on AbortSignal plumbed through dispatchLifecycle
// (V3.3.c) — branches each run in their own worktree, so cancelling
// is just SIGTERM + worktree remove, no shared-state cleanup.
export const VALID_JOIN_POLICIES = new Set(['all-complete', 'any-complete', 'k-of-n'])

// V3.2.b condition predicates. Schema:
//   { "attr": "key.path", "equals": <any> }
//   { "attr": "key.path", "in": [<any>, ...] }
//   { "attr": "key.path", "exists": true|false }
// More complex predicates (and/or/not, regex, comparisons) deferred —
// keep the surface small until concrete need.
export const VALID_PREDICATE_OPS = new Set(['equals', 'in', 'exists'])

export const VALID_FINAL_STATES = new Set([
  'completed', 'failed', 'aborted', 'superseded',
])

// Disposition values that match an edge. `*` is the catch-all wildcard.
export const VALID_DISPOSITIONS = new Set([
  'success', 'parked', 'timeout', 'error', '*',
])

// Validate a parsed pipeline definition object. Throws on first
// structural problem with a clear message; returns the def unchanged
// otherwise. Strict on shape, permissive on extra fields (forward-compat
// for V3.2+ additions like `attrs`, `max_visits`, etc.).
export const validatePipeline = (def, source = '<inline>') => {
  if (!def || typeof def !== 'object') {
    throw new Error(`${source}: pipeline must be a JSON object`)
  }
  if (typeof def.id !== 'string' || !SLUG_RE.test(def.id)) {
    throw new Error(`${source}: pipeline id must be a slug (alphanumeric + . _ -; got '${def.id}')`)
  }
  if (!Number.isInteger(def.version) || def.version < 1) {
    throw new Error(`${source}: pipeline version must be a positive integer (got ${def.version})`)
  }
  if (!def.nodes || typeof def.nodes !== 'object' || Array.isArray(def.nodes)) {
    throw new Error(`${source}: pipeline.nodes must be an object`)
  }
  if (typeof def.entry !== 'string' || !(def.entry in def.nodes)) {
    throw new Error(`${source}: pipeline.entry '${def.entry}' is not a registered node`)
  }
  if (!Array.isArray(def.edges)) {
    throw new Error(`${source}: pipeline.edges must be an array`)
  }
  for (const [nid, node] of Object.entries(def.nodes)) {
    if (!SLUG_RE.test(nid)) {
      throw new Error(`${source}: invalid node id '${nid}'`)
    }
    if (!node || typeof node !== 'object') {
      throw new Error(`${source}: node '${nid}' must be an object`)
    }
    if (!VALID_NODE_TYPES.has(node.type)) {
      throw new Error(`${source}: node '${nid}' has invalid type '${node.type}' (V3.1: ${[...VALID_NODE_TYPES].join(' | ')})`)
    }
    if (node.type === 'dispatch') {
      if (typeof node.role !== 'string' || !node.role) {
        throw new Error(`${source}: dispatch node '${nid}' requires a role`)
      }
      if (typeof node.prompt !== 'string') {
        throw new Error(`${source}: dispatch node '${nid}' requires a prompt`)
      }
    } else if (node.type === 'terminal') {
      if (!VALID_FINAL_STATES.has(node.final_state)) {
        throw new Error(`${source}: terminal node '${nid}' has invalid final_state '${node.final_state}' (valid: ${[...VALID_FINAL_STATES].join(' | ')})`)
      }
    } else if (node.type === 'condition') {
      if (typeof node.then !== 'string' || !(node.then in def.nodes)) {
        throw new Error(`${source}: condition node '${nid}' .then '${node.then}' is not a registered node`)
      }
      if (typeof node.else !== 'string' || !(node.else in def.nodes)) {
        throw new Error(`${source}: condition node '${nid}' .else '${node.else}' is not a registered node`)
      }
      if (!node.if || typeof node.if !== 'object') {
        throw new Error(`${source}: condition node '${nid}' requires an .if predicate object`)
      }
      if (typeof node.if.attr !== 'string' || !node.if.attr) {
        throw new Error(`${source}: condition node '${nid}' .if.attr must be a non-empty string`)
      }
      const ops = Object.keys(node.if).filter((k) => VALID_PREDICATE_OPS.has(k))
      if (ops.length !== 1) {
        throw new Error(`${source}: condition node '${nid}' .if must specify exactly one of ${[...VALID_PREDICATE_OPS].join(' | ')} (got: ${ops.join(', ') || '(none)'})`)
      }
      if (ops[0] === 'in' && !Array.isArray(node.if.in)) {
        throw new Error(`${source}: condition node '${nid}' .if.in must be an array`)
      }
      if (ops[0] === 'exists' && typeof node.if.exists !== 'boolean') {
        throw new Error(`${source}: condition node '${nid}' .if.exists must be a boolean`)
      }
    } else if (node.type === 'parallel') {
      if (!Array.isArray(node.branches) || node.branches.length === 0) {
        throw new Error(`${source}: parallel node '${nid}' requires a non-empty branches array`)
      }
      const join = node.join || 'all-complete'
      if (!VALID_JOIN_POLICIES.has(join)) {
        throw new Error(`${source}: parallel node '${nid}' has invalid join '${join}' (valid: ${[...VALID_JOIN_POLICIES].join(' | ')})`)
      }
      // V3.3.c — k-of-n requires `k` integer in [1, branches.length].
      if (join === 'k-of-n') {
        if (!Number.isInteger(node.k) || node.k < 1 || node.k > node.branches.length) {
          throw new Error(`${source}: parallel node '${nid}' join=k-of-n requires .k integer in [1, ${node.branches.length}] (got: ${node.k})`)
        }
      }
      const seen = new Set()
      for (const branchId of node.branches) {
        if (typeof branchId !== 'string' || !(branchId in def.nodes)) {
          throw new Error(`${source}: parallel node '${nid}' references unknown branch '${branchId}'`)
        }
        if (branchId === nid) {
          throw new Error(`${source}: parallel node '${nid}' cannot list itself as a branch`)
        }
        if (seen.has(branchId)) {
          throw new Error(`${source}: parallel node '${nid}' has duplicate branch '${branchId}'`)
        }
        seen.add(branchId)
        // V3.2.a restriction: branches must be dispatch nodes. Nested
        // parallel / condition / subpipeline land in V3.2.b+ once the
        // walker is recursive on aggregate dispositions.
        const branchNode = def.nodes[branchId]
        if (branchNode.type !== 'dispatch') {
          throw new Error(`${source}: parallel node '${nid}' branch '${branchId}' must be a dispatch node (V3.2.a; nesting deferred to V3.2.b)`)
        }
      }
    }
  }
  for (const [i, edge] of def.edges.entries()) {
    if (!edge || typeof edge !== 'object') {
      throw new Error(`${source}: edge[${i}] must be an object`)
    }
    if (!(edge.from in def.nodes)) {
      throw new Error(`${source}: edge[${i}].from='${edge.from}' is not a registered node`)
    }
    if (!(edge.to in def.nodes)) {
      throw new Error(`${source}: edge[${i}].to='${edge.to}' is not a registered node`)
    }
    if (!VALID_DISPOSITIONS.has(edge.on_disposition)) {
      throw new Error(`${source}: edge[${i}] has invalid on_disposition '${edge.on_disposition}' (valid: ${[...VALID_DISPOSITIONS].join(' | ')})`)
    }
    // Source must be a dispatch node — terminals are sinks, can't transition.
    const srcNode = def.nodes[edge.from]
    if (srcNode.type === 'terminal') {
      throw new Error(`${source}: edge[${i}] originates from terminal node '${edge.from}' — terminals are sinks`)
    }
  }
  // Sanity: at least one reachable terminal. Walk forward from entry,
  // collect reachable nodes, ensure ≥1 terminal among them. Without
  // this a pipeline could only error out on every disposition.
  // For parallel nodes, branches are reachable via the parallel itself
  // (not through edges) — include them in the reachable set so a
  // parallel-only flow doesn't trip the "no terminal reachable" check.
  const reachable = new Set([def.entry])
  let frontier = [def.entry]
  while (frontier.length) {
    const next = []
    for (const id of frontier) {
      const node = def.nodes[id]
      // Edge-based successors
      for (const e of def.edges) {
        if (e.from !== id) continue
        if (!reachable.has(e.to)) {
          reachable.add(e.to)
          next.push(e.to)
        }
      }
      // Parallel branches are reachable through the parallel node
      if (node.type === 'parallel' && Array.isArray(node.branches)) {
        for (const branchId of node.branches) {
          if (!reachable.has(branchId)) {
            reachable.add(branchId)
            next.push(branchId)
          }
        }
      }
      // Condition routes to .then / .else without going through edges
      if (node.type === 'condition') {
        for (const target of [node.then, node.else]) {
          if (target && !reachable.has(target)) {
            reachable.add(target)
            next.push(target)
          }
        }
      }
    }
    frontier = next
  }
  const reachableTerminals = [...reachable].filter(
    (id) => def.nodes[id].type === 'terminal',
  )
  if (!reachableTerminals.length) {
    throw new Error(`${source}: no terminal node is reachable from entry '${def.entry}'`)
  }
  return def
}

// V3.2.b — read a dotted path out of a nested object. Supports
// `pipeline_id`, `attrs.target`, `attrs.flags.skip_tests`, etc.
// Returns undefined when any segment is missing.
const readPath = (obj, path) => {
  if (!obj) return undefined
  const segments = path.split('.')
  let cur = obj
  for (const seg of segments) {
    if (cur == null || typeof cur !== 'object') return undefined
    cur = cur[seg]
  }
  return cur
}

// V3.2.b — evaluate a condition node's `.if` predicate against the
// run's task_attrs. The validator already guarantees exactly one of
// `equals` / `in` / `exists` is set.
export const evaluatePredicate = (predicate, attrs) => {
  if (!predicate || typeof predicate !== 'object') return false
  const value = readPath(attrs, predicate.attr)
  if ('equals' in predicate) return value === predicate.equals
  if ('in' in predicate) return Array.isArray(predicate.in) && predicate.in.includes(value)
  if ('exists' in predicate) {
    const present = value !== undefined
    return predicate.exists ? present : !present
  }
  return false
}

// Aggregate disposition for a parallel join.
// V3.2.a (all-complete): worst-of-children rule —
//   any error → 'error'
//   else any timeout → 'timeout'
//   else any parked → 'parked'
//   else (all success) → 'success'
//   else first non-success / non-cancelled (driver-specific oddities)
// `cancelled` (V3.3.c) is excluded — cancellation isn't an outcome
// the join cares about; it just means the branch was stopped early
// because quorum was already met.
// Wildcard `*` edges from the parallel node still match the result.
const SEVERITY = ['error', 'timeout', 'parked']

export const aggregateDisposition = (dispositions) => {
  const meaningful = dispositions.filter((d) => d !== 'cancelled')
  if (!meaningful.length) return 'success'
  for (const sev of SEVERITY) {
    if (meaningful.includes(sev)) return sev
  }
  if (meaningful.every((d) => d === 'success')) return 'success'
  return meaningful.find((d) => d !== 'success') || 'success'
}

// V3.3.c — quorum-aware aggregate. Used by the pipeline walker after
// it observes branch results. Returns 'success' when ≥ k branches
// succeeded (regardless of how the rest landed); otherwise falls back
// to the worst-of-children rule on the non-cancelled subset.
export const aggregateForJoin = (dispositions, join, k = null) => {
  if (join === 'all-complete') return aggregateDisposition(dispositions)
  const required = join === 'any-complete' ? 1 : join === 'k-of-n' ? (k || 0) : 0
  const successes = dispositions.filter((d) => d === 'success').length
  if (successes >= required) return 'success'
  return aggregateDisposition(dispositions)
}

// Quorum size for a parallel node — caller already validated shape.
export const quorumOf = (parallelNode) => {
  const join = parallelNode.join || 'all-complete'
  if (join === 'any-complete') return 1
  if (join === 'k-of-n') return parallelNode.k
  return parallelNode.branches.length // all-complete
}

export const loadPipelineFile = (path) => {
  if (!existsSync(path)) throw new Error(`pipeline file not found: ${path}`)
  let body
  try { body = readFileSync(path, 'utf8') } catch (err) {
    throw new Error(`failed to read ${path}: ${err.message}`)
  }
  let parsed
  try { parsed = JSON.parse(body) } catch (err) {
    throw new Error(`failed to parse ${path} as JSON: ${err.message}`)
  }
  return validatePipeline(parsed, path)
}

// Resolve the next node id given current node + disposition. Looks for
// an exact-match edge first, falls back to the wildcard `*`. Returns
// the resolved node id, or null if no transition matches.
export const resolveNext = (def, fromNodeId, disposition) => {
  const exact = def.edges.find(
    (e) => e.from === fromNodeId && e.on_disposition === disposition,
  )
  if (exact) return exact.to
  const wildcard = def.edges.find(
    (e) => e.from === fromNodeId && e.on_disposition === '*',
  )
  return wildcard ? wildcard.to : null
}

// List all `<id>.json` files under `.artel/pipelines/`. Returns an
// array of { id, path } sorted by id. Tolerates a missing directory.
export const listPipelineFiles = (projectDir) => {
  const dir = pipelinesDir(projectDir)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({ id: f.replace(/\.json$/, ''), path: join(dir, f) }))
    .sort((a, b) => a.id.localeCompare(b.id))
}

// V3.4.a — pipeline run observability. Reads events.jsonl, joins
// `pipeline_run.started` with `pipeline_run.ended` by `pipeline_run_id`
// to materialise past runs. (`readFileSync` is already imported above.)

const eventsPathFor = (projectDir) => join(projectDir, '.artel', 'events.jsonl')

const replayEvents = (projectDir) => {
  const path = eventsPathFor(projectDir)
  if (!existsSync(path)) return []
  const out = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line) continue
    try { out.push(JSON.parse(line)) } catch {}
  }
  return out
}

// Returns past pipeline runs newest-first. Each entry:
//   { run_id, pipeline_id, pipeline_version, started_at, ended_at?,
//     final_state?, last_node?, last_disposition?, duration_ms?,
//     abort_reason? }
//
// In-flight runs (started but not yet ended) appear without an
// `ended_at`; final_state stays null. Pipeline definitions that exist
// only as `pipeline.registered` events without ever running don't show
// up — this lists *runs*, not registrations.
export const listPipelineRuns = (projectDir, { limit = null, pipelineId = null } = {}) => {
  const events = replayEvents(projectDir)
  const byRun = new Map()
  for (const e of events) {
    if (e.kind !== 'workload' || typeof e.type !== 'string') continue
    if (!e.type.startsWith('pipeline_run.')) continue
    if (!e.pipeline_run_id) continue
    if (pipelineId && e.pipeline_id !== pipelineId) continue
    let cur = byRun.get(e.pipeline_run_id)
    if (!cur) {
      cur = { run_id: e.pipeline_run_id }
      byRun.set(e.pipeline_run_id, cur)
    }
    if (e.type === 'pipeline_run.started') {
      cur.pipeline_id = e.pipeline_id
      cur.pipeline_version = e.pipeline_version
      cur.entry_node = e.entry_node
      cur.started_at = e.at
    } else if (e.type === 'pipeline_run.ended') {
      cur.ended_at = e.at
      cur.final_state = e.final_state
      cur.last_node = e.last_node
      cur.last_disposition = e.last_disposition
      if (e.abort_reason) cur.abort_reason = e.abort_reason
      if (cur.started_at && cur.ended_at) {
        const ms = Date.parse(cur.ended_at) - Date.parse(cur.started_at)
        if (Number.isFinite(ms) && ms >= 0) cur.duration_ms = ms
      }
    }
  }
  const runs = [...byRun.values()]
    .filter((r) => r.started_at) // skip orphan ended-without-started
    .sort((a, b) => (b.started_at || '').localeCompare(a.started_at || ''))
  // Negative or null/undefined limit → return everything. Positive
  // limit → cap. Zero → empty list.
  if (limit == null || limit < 0) return runs
  return runs.slice(0, limit)
}

// Detail view for one run: the run summary + per-node timeline
// reconstructed from the dispatches tagged with this `pipeline_run_id`
// in their `task_attrs`. Each step:
//   { node_id, dispatch_id?, task?, role?, engine?, started_at?,
//     completed_at?, disposition?, parallel_of? }
export const pipelineRunDetail = (projectDir, runId) => {
  const events = replayEvents(projectDir)
  const summary = {}
  // Per-dispatch_id, accumulate start/end pair for steps tagged with
  // this pipeline_run_id. Match via `task_attrs.pipeline_run_id` —
  // that field flows through dispatch_lifecycle into both events and
  // .meta sidecars.
  const stepsByDispatch = new Map()
  for (const e of events) {
    if (e.kind !== 'workload' || typeof e.type !== 'string') continue
    // pipeline_run lifecycle for the summary panel
    if (e.type === 'pipeline_run.started' && e.pipeline_run_id === runId) {
      Object.assign(summary, {
        run_id: runId,
        pipeline_id: e.pipeline_id,
        pipeline_version: e.pipeline_version,
        entry_node: e.entry_node,
        started_at: e.at,
      })
      continue
    }
    if (e.type === 'pipeline_run.ended' && e.pipeline_run_id === runId) {
      summary.ended_at = e.at
      summary.final_state = e.final_state
      summary.last_node = e.last_node
      summary.last_disposition = e.last_disposition
      if (e.abort_reason) summary.abort_reason = e.abort_reason
      if (summary.started_at && summary.ended_at) {
        const ms = Date.parse(summary.ended_at) - Date.parse(summary.started_at)
        if (Number.isFinite(ms) && ms >= 0) summary.duration_ms = ms
      }
      continue
    }
    // dispatch.start / dispatch.end events tagged with this run
    if (e.type !== 'dispatch.start' && e.type !== 'dispatch.end') continue
    const attrs = e.task_attrs || {}
    if (attrs.pipeline_run_id !== runId) continue
    const did = e.dispatch_id
    if (!did) continue
    let step = stepsByDispatch.get(did)
    if (!step) {
      step = { dispatch_id: did }
      stepsByDispatch.set(did, step)
    }
    if (e.type === 'dispatch.start') {
      step.task = e.task
      step.role = e.owner_role
      step.engine = e.engine
      step.started_at = e.at
      step.node_id = attrs.pipeline_node_id || null
      if (attrs.pipeline_parallel_of) step.parallel_of = attrs.pipeline_parallel_of
    } else {
      step.completed_at = e.at
      step.disposition = e.disposition
    }
  }
  const steps = [...stepsByDispatch.values()].sort(
    (a, b) => (a.started_at || '').localeCompare(b.started_at || ''),
  )
  return Object.keys(summary).length ? { ...summary, steps } : null
}
