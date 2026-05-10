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

// V3.8 — operator-cancel sentinel directory. `artel pipeline cancel
// <run-id>` writes an empty file at `.artel/.pipeline-cancels/<run-id>`;
// the running walker polls for it and aborts on detection. Dot-prefix
// matches the rest of the runtime-state convention (`.dispatches/`,
// `.sessions/`, `.worktrees/`). One file per cancelled run; presence
// is the signal — no payload. Stale sentinels (run never picked up)
// can be pruned via `artel sweep` (deferred).
const PIPELINE_CANCELS_DIR_REL = ['.artel', '.pipeline-cancels']

export const pipelineCancelsDir = (projectDir) =>
  join(projectDir, ...PIPELINE_CANCELS_DIR_REL)

export const pipelineCancelPath = (projectDir, runId) =>
  join(pipelineCancelsDir(projectDir), runId)

const SLUG_RE = /^[a-z0-9][a-z0-9._-]*$/i

export const VALID_NODE_TYPES = new Set([
  'dispatch', 'terminal', 'parallel', 'condition', 'handler',
])

// V3.7.a — handler node builtins. The walker dispatches handler
// nodes through `runHandler` in `engine/util/handlers.mjs`; each
// builtin is a small platform action (no LLM, no role). Adding a
// handler = registering a new builtin name here AND extending the
// runHandler dispatch map. Handlers cannot appear inside `parallel`
// branches in V3.7.a (the parallel validator already restricts
// branches to dispatch nodes; lifting that requires per-branch
// cancellation work).
//
// V3.7.c adds `builtin.assert` — predicate-based guard. Evaluates
// `node.if` (same V3.6 predicate vocabulary as `condition`) against
// run attrs; success on true, error on false. Optional template-
// rendered `node.message` lands in the `pipeline_handler.end`
// event's `error` field for forensics.
//
// V3.7.d adds `builtin.set_attr` — mutates run attrs in place.
// `node.set` is a flat object of `{ key: scalar }` pairs; string
// values are V3.5 template-rendered against the current attrs scope
// before merge. Walker shallow-merges the returned attrs back into
// `userAttrs` so subsequent steps see the mutation. Pipeline-injected
// ids (`pipeline_run_id`, `pipeline_id`, `pipeline_node_id`,
// `pipeline_parallel_of`) are respread per step, so user `set`
// overriding them is benign — but rejecting at validator level keeps
// intent clear.
export const VALID_HANDLERS = new Set([
  'builtin.exec', 'builtin.assert', 'builtin.set_attr',
])

const RESERVED_ATTR_KEYS = new Set([
  'pipeline_run_id', 'pipeline_id', 'pipeline_node_id', 'pipeline_parallel_of',
])

// V3.3.c — three join policies. all-complete waits for every branch;
// any-complete returns as soon as one succeeds (cancels the rest);
// k-of-n returns as soon as `node.k` succeed (cancels the rest).
// Cancellation rides on AbortSignal plumbed through dispatchLifecycle
// (V3.3.c) — branches each run in their own worktree, so cancelling
// is just SIGTERM + worktree remove, no shared-state cleanup.
export const VALID_JOIN_POLICIES = new Set(['all-complete', 'any-complete', 'k-of-n'])

// Condition predicates. Two shapes:
//
// Atomic (V3.2.b + V3.6 comparisons):
//   { "attr": "key.path", "equals": <any> }
//   { "attr": "key.path", "ne":     <any> }
//   { "attr": "key.path", "in":     [<any>, ...] }
//   { "attr": "key.path", "exists": true|false }
//   { "attr": "key.path", "gt"|"gte"|"lt"|"lte": <number> }
//
// Compound (V3.6 — recursive, no `attr`):
//   { "not": <predicate> }
//   { "and": [<predicate>, ...] }   # non-empty array
//   { "or":  [<predicate>, ...] }   # non-empty array
//
// Compounds nest atomics or other compounds without bound; the
// validator recurses. Vocabulary still intentionally narrow — no
// regex / `where` / `function`-style predicates.
export const VALID_ATOMIC_OPS = new Set([
  'equals', 'ne', 'in', 'exists', 'gt', 'gte', 'lt', 'lte',
])
export const VALID_COMPOUND_OPS = new Set(['not', 'and', 'or'])
// Kept for back-compat with any callers that imported the V3.2.b name.
// The combined set gates "this key is a recognised predicate operator"
// when the validator distinguishes atomic vs. compound shape.
export const VALID_PREDICATE_OPS = new Set([
  ...VALID_ATOMIC_OPS, ...VALID_COMPOUND_OPS,
])

// V3.6 — recursive predicate validator. `path` is the dotted-from-root
// label used in error messages (e.g. `.if.and[0].not`).
const validatePredicateShape = (pred, source, nid, path) => {
  if (!pred || typeof pred !== 'object' || Array.isArray(pred)) {
    throw new Error(`${source}: condition node '${nid}' ${path} must be a predicate object`)
  }
  const compound = [...VALID_COMPOUND_OPS].filter((op) => op in pred)
  const atomic = [...VALID_ATOMIC_OPS].filter((op) => op in pred)

  if (compound.length > 0) {
    if (compound.length > 1) {
      throw new Error(`${source}: condition node '${nid}' ${path} compound predicate must have exactly one of ${[...VALID_COMPOUND_OPS].join(' | ')} (got: ${compound.join(', ')})`)
    }
    if (atomic.length > 0 || 'attr' in pred) {
      const mixed = [...atomic, ...('attr' in pred ? ['attr'] : [])]
      throw new Error(`${source}: condition node '${nid}' ${path} compound predicate must not mix with atomic ops or 'attr' (got: ${mixed.join(', ')})`)
    }
    const op = compound[0]
    if (op === 'not') {
      validatePredicateShape(pred.not, source, nid, `${path}.not`)
    } else {
      // and / or
      if (!Array.isArray(pred[op]) || pred[op].length === 0) {
        throw new Error(`${source}: condition node '${nid}' ${path}.${op} must be a non-empty array of predicates`)
      }
      pred[op].forEach((sub, i) =>
        validatePredicateShape(sub, source, nid, `${path}.${op}[${i}]`),
      )
    }
    return
  }

  // Atomic
  if (typeof pred.attr !== 'string' || !pred.attr) {
    throw new Error(`${source}: condition node '${nid}' ${path}.attr must be a non-empty string`)
  }
  if (atomic.length !== 1) {
    throw new Error(`${source}: condition node '${nid}' ${path} must specify exactly one of ${[...VALID_ATOMIC_OPS].join(' | ')} | ${[...VALID_COMPOUND_OPS].join(' | ')} (got: ${atomic.join(', ') || '(none)'})`)
  }
  const op = atomic[0]
  if (op === 'in' && !Array.isArray(pred.in)) {
    throw new Error(`${source}: condition node '${nid}' ${path}.in must be an array`)
  }
  if (op === 'exists' && typeof pred.exists !== 'boolean') {
    throw new Error(`${source}: condition node '${nid}' ${path}.exists must be a boolean`)
  }
  if (['gt', 'gte', 'lt', 'lte'].includes(op) && typeof pred[op] !== 'number') {
    throw new Error(`${source}: condition node '${nid}' ${path}.${op} must be a number`)
  }
}

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
      // V3.9 — optional per-node timeout, plumbed to dispatchLifecycle
      // as `timeoutMs`. Same shape as handler.exec.timeout_ms for
      // consistency. Falls back to ARTEL_DISPATCH_TIMEOUT_MS env /
      // built-in default when absent. Useful for parallel branches
      // that need different per-branch budgets, and for gating long
      // dispatches at the pipeline level rather than relying on the
      // global default.
      if (node.timeout_ms != null) {
        if (typeof node.timeout_ms !== 'number' || node.timeout_ms <= 0 || !Number.isFinite(node.timeout_ms)) {
          throw new Error(`${source}: dispatch node '${nid}' .timeout_ms must be a positive finite number (got: ${node.timeout_ms})`)
        }
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
      // V3.6 — recursive predicate shape check. Atomic + compound
      // predicates handled uniformly; compounds (not/and/or) recurse.
      validatePredicateShape(node.if, source, nid, '.if')
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
        // V3.2.a → V3.7.e: branches must be a dispatch or handler
        // node. Nested parallel / condition / subpipeline still
        // deferred (walker isn't recursive on aggregate
        // dispositions). For handlers in branches, set_attr is
        // explicitly rejected — its mutation lands in shared
        // userAttrs, and concurrent siblings would race on writes
        // (validator wins is fine in linear flows; parallel needs
        // either a merge contract or no mutation). assert + exec are
        // fine: assert is read-only, exec mutates only the
        // filesystem (which the operator's pipeline shape governs).
        const branchNode = def.nodes[branchId]
        if (branchNode.type === 'dispatch') {
          // ok
        } else if (branchNode.type === 'handler') {
          if (branchNode.handler === 'builtin.set_attr') {
            throw new Error(`${source}: parallel node '${nid}' branch '${branchId}' is a builtin.set_attr handler — disallowed in parallel branches (concurrent set_attr writes would race on userAttrs; use a sequential set_attr after the parallel join)`)
          }
        } else {
          throw new Error(`${source}: parallel node '${nid}' branch '${branchId}' must be a dispatch or handler node (got: ${branchNode.type})`)
        }
      }
    } else if (node.type === 'handler') {
      // V3.7.a — built-in platform action. Kind=workload but no LLM,
      // no role, no engine. Disposition flows through outgoing edges
      // exactly like dispatch.
      if (typeof node.handler !== 'string' || !node.handler) {
        throw new Error(`${source}: handler node '${nid}' .handler must be a non-empty string`)
      }
      if (!VALID_HANDLERS.has(node.handler)) {
        throw new Error(`${source}: handler node '${nid}' .handler '${node.handler}' is not a known builtin (valid: ${[...VALID_HANDLERS].join(' | ')})`)
      }
      // Per-builtin shape checks. Centralised here so a malformed
      // handler is caught at register time, not when the run touches
      // it. Add a new builtin = add a case here AND in handlers.mjs.
      if (node.handler === 'builtin.exec') {
        if (typeof node.cmd !== 'string' || !node.cmd.trim()) {
          throw new Error(`${source}: handler node '${nid}' (builtin.exec) requires .cmd as a non-empty string`)
        }
        if (node.timeout_ms != null) {
          if (typeof node.timeout_ms !== 'number' || node.timeout_ms <= 0 || !Number.isFinite(node.timeout_ms)) {
            throw new Error(`${source}: handler node '${nid}' .timeout_ms must be a positive finite number (got: ${node.timeout_ms})`)
          }
        }
      }
      // V3.7.c — builtin.assert: requires .if predicate (same shape
      // as condition.if — atomic or compound, recursive). Optional
      // .message string (template-rendered at run time, surfaced in
      // the end event's `error` field on failure).
      if (node.handler === 'builtin.assert') {
        if (!node.if || typeof node.if !== 'object') {
          throw new Error(`${source}: handler node '${nid}' (builtin.assert) requires an .if predicate object`)
        }
        validatePredicateShape(node.if, source, nid, '.if')
        if (node.message != null && typeof node.message !== 'string') {
          throw new Error(`${source}: handler node '${nid}' .message must be a string (got: ${typeof node.message})`)
        }
      }
      // V3.7.d — builtin.set_attr: requires .set (non-empty object).
      // Top-level keys only (no dotted paths in V3.7.d — walker has
      // no writePath helper). Values must be scalar (string | number
      // | boolean) or null; objects / arrays rejected (no obvious
      // merge semantics, and templates only apply to strings).
      // Reserved pipeline-injected keys rejected for clarity (they
      // can't actually be overridden — walker respreads them per
      // step — but accepting them invites confusion).
      if (node.handler === 'builtin.set_attr') {
        if (!node.set || typeof node.set !== 'object' || Array.isArray(node.set)) {
          throw new Error(`${source}: handler node '${nid}' (builtin.set_attr) requires .set as an object`)
        }
        const keys = Object.keys(node.set)
        if (keys.length === 0) {
          throw new Error(`${source}: handler node '${nid}' .set must be non-empty`)
        }
        for (const key of keys) {
          if (RESERVED_ATTR_KEYS.has(key)) {
            throw new Error(`${source}: handler node '${nid}' .set cannot override pipeline-injected key '${key}' (reserved: ${[...RESERVED_ATTR_KEYS].join(', ')})`)
          }
          if (key.includes('.')) {
            throw new Error(`${source}: handler node '${nid}' .set key '${key}' must be top-level (dotted-path keys deferred to V3.7.d+)`)
          }
          const v = node.set[key]
          const t = typeof v
          if (v === null || t === 'string' || t === 'number' || t === 'boolean') continue
          throw new Error(`${source}: handler node '${nid}' .set['${key}'] must be a scalar (string | number | boolean) or null (got: ${Array.isArray(v) ? 'array' : t})`)
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

// V3.2.b + V3.6 — evaluate a condition node's `.if` predicate against
// the run's task_attrs. Validator guarantees the shape is atomic
// (with exactly one op) or compound (`not`/`and`/`or` recursive).
//
// Comparison ops (`gt`/`gte`/`lt`/`lte`) require a numeric attr value;
// non-numeric / missing → false. This matches the principle of
// fail-closed routing — a missing or wrong-typed attr does not
// silently take a comparison branch.
export const evaluatePredicate = (predicate, attrs) => {
  if (!predicate || typeof predicate !== 'object') return false

  // Compound first — they don't read `attr`.
  if ('not' in predicate) return !evaluatePredicate(predicate.not, attrs)
  if ('and' in predicate) {
    return Array.isArray(predicate.and) && predicate.and.every((p) => evaluatePredicate(p, attrs))
  }
  if ('or' in predicate) {
    return Array.isArray(predicate.or) && predicate.or.some((p) => evaluatePredicate(p, attrs))
  }

  // Atomic
  const value = readPath(attrs, predicate.attr)
  if ('equals' in predicate) return value === predicate.equals
  if ('ne' in predicate) return value !== predicate.ne
  if ('in' in predicate) return Array.isArray(predicate.in) && predicate.in.includes(value)
  if ('exists' in predicate) {
    const present = value !== undefined
    return predicate.exists ? present : !present
  }
  if ('gt' in predicate) return typeof value === 'number' && value > predicate.gt
  if ('gte' in predicate) return typeof value === 'number' && value >= predicate.gte
  if ('lt' in predicate) return typeof value === 'number' && value < predicate.lt
  if ('lte' in predicate) return typeof value === 'number' && value <= predicate.lte
  return false
}

// V3.5 — `{{ dotted.path }}` substitution for dispatch prompts.
// Whitespace-tolerant; missing or null/undefined attrs throw with a
// helpful error (fail-fast beats silent "" replacement; an
// unparametrized prompt is almost always an operator bug). Object /
// array values throw — only scalars (string|number|boolean) have an
// obvious string form.
//
// Vocabulary is intentionally just substitution. No conditionals,
// loops, filters, or escapes — keep the surface minimal until a
// concrete need arises. A literal `{{` in the source is therefore
// reserved; if a real prompt needs that bigraph, encode it in the
// scope (`--attrs '{"open":"{{"}'` + `prompt: "{{open}}foo"`).
//
// Scope shape: same blob the walker passes through as `task_attrs`
// (user `--attrs` merged on top of pipeline-injected ids — same
// scope `evaluatePredicate` reads against).
export const renderTemplate = (template, scope) => {
  if (template == null) return template
  if (typeof template !== 'string') return template
  return template.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_match, path) => {
    const v = readPath(scope, path)
    if (v === undefined || v === null) {
      throw new Error(`template: missing attribute '${path}'`)
    }
    if (typeof v === 'object') {
      throw new Error(
        `template: cannot substitute object/array at '${path}' — only scalars (string|number|boolean) supported`,
      )
    }
    return String(v)
  })
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
// reconstructed from the dispatches AND handlers tagged with this
// `pipeline_run_id`. Each step has a `kind` ('dispatch' | 'handler')
// so renderers can adjust columns. Common fields:
//   { kind, node_id, started_at?, completed_at?, disposition? }
// Dispatch-only: dispatch_id, task, role, engine, parallel_of.
// Handler-only:  handler_id, handler (builtin name), exit_code,
//                signal, duration_ms, cmd?, error?.
export const pipelineRunDetail = (projectDir, runId) => {
  const events = replayEvents(projectDir)
  const summary = {}
  // Match via `task_attrs.pipeline_run_id` for dispatches (that field
  // flows through dispatch_lifecycle into events + .meta sidecars)
  // and via top-level `pipeline_run_id` for handler events
  // (V3.7.b emits them direct, no .meta sidecar).
  const stepsByKey = new Map()
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
    // Dispatch start/end — keyed by dispatch_id
    if (e.type === 'dispatch.start' || e.type === 'dispatch.end') {
      const attrs = e.task_attrs || {}
      if (attrs.pipeline_run_id !== runId) continue
      const did = e.dispatch_id
      if (!did) continue
      const key = `dispatch:${did}`
      let step = stepsByKey.get(key)
      if (!step) {
        step = { kind: 'dispatch', dispatch_id: did }
        stepsByKey.set(key, step)
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
      continue
    }
    // V3.7.b — handler start/end. Keyed by handler_id, top-level
    // pipeline_run_id (no task_attrs indirection — handlers don't go
    // through dispatch_api).
    if (e.type === 'pipeline_handler.start' || e.type === 'pipeline_handler.end') {
      if (e.pipeline_run_id !== runId) continue
      const hid = e.handler_id
      if (!hid) continue
      const key = `handler:${hid}`
      let step = stepsByKey.get(key)
      if (!step) {
        step = { kind: 'handler', handler_id: hid }
        stepsByKey.set(key, step)
      }
      if (e.type === 'pipeline_handler.start') {
        step.handler = e.handler
        step.node_id = e.pipeline_node_id || null
        step.started_at = e.at
        if (e.cmd != null) step.cmd = e.cmd
        if (e.timeout_ms != null) step.timeout_ms = e.timeout_ms
      } else {
        step.completed_at = e.at
        step.disposition = e.disposition
        if (e.exit_code != null) step.exit_code = e.exit_code
        if (e.signal != null) step.signal = e.signal
        if (e.duration_ms != null) step.duration_ms = e.duration_ms
        if (e.error != null) step.error = e.error
      }
    }
  }
  const steps = [...stepsByKey.values()].sort(
    (a, b) => (a.started_at || '').localeCompare(b.started_at || ''),
  )
  return Object.keys(summary).length ? { ...summary, steps } : null
}
