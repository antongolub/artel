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

// V3.2.a: only all-complete join. any-complete + k-of-n deferred —
// they need cancellation semantics that depend on V3.3 worktrees.
export const VALID_JOIN_POLICIES = new Set(['all-complete'])

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
        throw new Error(`${source}: parallel node '${nid}' has invalid join '${join}' (V3.2.a: ${[...VALID_JOIN_POLICIES].join(' | ')})`)
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

// Aggregate disposition for a parallel join. V3.2.a only supports
// `all-complete`. Worst-of-the-children rule:
//   any error → 'error'
//   else any timeout → 'timeout'
//   else any parked → 'parked'
//   else any unknown → that string (last seen)
//   else (all success) → 'success'
// Wildcard `*` edges from the parallel node still match any of these.
const SEVERITY = ['error', 'timeout', 'parked']

export const aggregateDisposition = (dispositions) => {
  if (!dispositions.length) return 'success'
  for (const sev of SEVERITY) {
    if (dispositions.includes(sev)) return sev
  }
  // All success, or all unknowns. Return success when all match,
  // otherwise the first non-success (covers driver-specific oddities).
  if (dispositions.every((d) => d === 'success')) return 'success'
  return dispositions.find((d) => d !== 'success') || 'success'
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
