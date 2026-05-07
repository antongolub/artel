// Queue graph — event-sourced read side (V2.1 nodes + V2.2 edges).
//
// `QUEUE.md` is the human-friendly projection; `events.jsonl` is the
// canonical source. This module replays `queue_node.*` and
// `queue_edge.*` events into a snapshot graph and exposes pure
// query helpers.
//
// Status vocabulary mirrors QUEUE.md sections 1:1:
//   For Owner | In progress | Pending | Blocked | Recently done
//
// V2.2: edges introduce *effective* status. `effectiveStatus(node, g)`
// returns 'Blocked' when the node has an unresolved inbound `blocks`
// or `depends_on` edge whose source isn't `Recently done` —
// regardless of the node's declared status. `readyForDispatch` uses
// the same logic to filter Pending nodes that have outstanding
// upstream work.
//
// Edge identity is the tuple (relation, from, to). Re-emitting the
// same `queue_edge.added` for an existing tuple is a no-op (last
// `attrs` patch wins). `queue_edge.removed` removes by tuple.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export const VALID_STATUSES = new Set([
  'For Owner', 'In progress', 'Pending', 'Blocked', 'Recently done',
])

// Edge relations. Identity is (relation, from, to). Schema reserves
// `queue_edge.*` as workload — the relation lives in the event
// payload as `relation` (avoids clashing with event-level `kind`).
//
// `gating` relations participate in dispatch readiness: a Pending
// node with an unresolved gating inbound edge is effectively Blocked.
// Other relations are informational (lineage, structure).
export const EDGE_RELATIONS = new Set([
  'blocks',         // gating: src must complete before dst
  'depends_on',     // gating: dst needs src's output
  'supersedes',     // src replaced dst
  'parent_of',      // src decomposed into dst
  'triggers',       // src completion creates dst
  'derived_from',   // dst derives from src processing
  'same_pipeline_run', // both belong to same run
])

const GATING_RELATIONS = new Set(['blocks', 'depends_on'])

const edgeKey = (relation, from, to) => `${relation}:${from}->${to}`

const eventsPath = (projectDir) =>
  join(projectDir, '.artel', 'events.jsonl')

// Replay queue_node.* events from .artel/events.jsonl into a map.
// Each NodeState: {
//   slug, status, lane?, description?,
//   since_at?,                         // set when status=In progress
//   role_hint?,                        // free-text hint, future use
//   created_at, updated_at,            // ISO timestamps
//   created_event_id, updated_event_id // UUIDs (debug + audit)
// }
//
// Tolerates missing events.jsonl (returns empty graph). Tolerates
// queue_node.updated for an unknown slug — treats it as a resync from
// reality (some other process emitted the create elsewhere) and
// applies the patch lazily.
export const buildGraph = (projectDir) => {
  const nodes = new Map()
  const edges = new Map()
  const path = eventsPath(projectDir)
  if (!existsSync(path)) return { nodes, edges }
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line) continue
    let e
    try { e = JSON.parse(line) } catch { continue }
    if (e.kind !== 'workload' || typeof e.type !== 'string') continue
    if (e.type.startsWith('queue_node.')) applyNodeEvent(nodes, e)
    else if (e.type.startsWith('queue_edge.')) applyEdgeEvent(edges, e)
  }
  return { nodes, edges }
}

const applyNodeEvent = (nodes, e) => {
  const slug = e.node_id
  if (!slug) return
  if (e.type === 'queue_node.created') {
    nodes.set(slug, {
      slug,
      status: e.status || 'Pending',
      ...(e.lane ? { lane: e.lane } : {}),
      ...(e.description ? { description: e.description } : {}),
      ...(e.role_hint ? { role_hint: e.role_hint } : {}),
      ...(e.since_at ? { since_at: e.since_at } : {}),
      created_at: e.at,
      updated_at: e.at,
      created_event_id: e.id,
      updated_event_id: e.id,
    })
    return
  }
  if (e.type === 'queue_node.updated') {
    const cur = nodes.get(slug) || {
      slug,
      status: 'Pending',
      created_at: e.at,
      created_event_id: e.id,
    }
    const fields = e.fields || {}
    // Patch semantics: explicit `null` clears; `undefined` preserves;
    // any other value overwrites.
    for (const [k, v] of Object.entries(fields)) {
      if (v === null) delete cur[k]
      else if (v !== undefined) cur[k] = v
    }
    cur.updated_at = e.at
    cur.updated_event_id = e.id
    nodes.set(slug, cur)
    return
  }
  if (e.type === 'queue_node.deleted') {
    nodes.delete(slug)
    return
  }
}

const applyEdgeEvent = (edges, e) => {
  const { relation, from, to } = e
  if (!relation || !from || !to) return
  const key = edgeKey(relation, from, to)
  if (e.type === 'queue_edge.added') {
    edges.set(key, {
      relation,
      from,
      to,
      ...(e.attrs || {}),
      added_at: e.at,
      added_event_id: e.id,
    })
    return
  }
  if (e.type === 'queue_edge.removed') {
    edges.delete(key)
    return
  }
}

// Predicate-driven queries on top of the replay. Pure — operate on the
// snapshot returned by buildGraph(). Callers can chain or compose.
export const nodesByStatus = (graph, status) =>
  [...graph.nodes.values()].filter((n) => n.status === status)

// All edges where `to === slug`. Optional `relation` filter narrows
// to one edge kind (e.g. only `blocks`). Used by status-derivation
// and dispatch-readiness queries.
export const incomingEdges = (graph, slug, relation = null) =>
  [...graph.edges.values()].filter((e) =>
    e.to === slug && (!relation || e.relation === relation))

export const outgoingEdges = (graph, slug, relation = null) =>
  [...graph.edges.values()].filter((e) =>
    e.from === slug && (!relation || e.relation === relation))

// `Recently done` is the resolution criterion for gating edges. Once
// the upstream node hits that state, the edge stops blocking dst.
const isResolved = (graph, slug) => {
  const node = graph.nodes.get(slug)
  if (!node) return true            // unknown upstream → don't block
  return node.status === 'Recently done'
}

// True if any inbound gating edge (blocks / depends_on) is unresolved
// — i.e. the upstream node is not yet `Recently done`. V2.2 derives
// `Blocked` from this.
export const hasUnresolvedUpstream = (graph, slug) => {
  for (const e of incomingEdges(graph, slug)) {
    if (!GATING_RELATIONS.has(e.relation)) continue
    if (!isResolved(graph, e.from)) return true
  }
  return false
}

// V2.2: effective status overlays edge-derived `Blocked` on top of
// the declared status. A node declared Pending with unresolved
// gating inbound is effectively Blocked. A node declared In progress
// stays In progress regardless of edges (that's intentional — the
// owner forced it through). A Recently done node stays Recently done.
export const effectiveStatus = (graph, slug) => {
  const node = graph.nodes.get(slug)
  if (!node) return null
  if (node.status === 'In progress' || node.status === 'Recently done') {
    return node.status
  }
  if (node.status === 'Pending' && hasUnresolvedUpstream(graph, slug)) {
    return 'Blocked'
  }
  return node.status
}

// V2.2: Pending nodes with no unresolved gating upstream, sorted by
// created_at. Dispatchers / orchestrators consume this to pick what
// to launch next.
export const readyForDispatch = (graph) =>
  nodesByStatus(graph, 'Pending')
    .filter((n) => !hasUnresolvedUpstream(graph, n.slug))
    .sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''))

// Cycle pre-check for a hypothetical edge `from → to` of the given
// relation. Walks outgoing gating edges from `to` and reports a path
// back to `from` if reachable. Used at link time so we never persist
// a cycle. Returns the cycle slug list (`[from, …, to, from]`) or
// `null` if no cycle.
export const findGatingCycle = (graph, from, to, relation) => {
  if (!GATING_RELATIONS.has(relation)) return null
  if (from === to) return [from, from]
  // DFS from `to` following outgoing gating edges. If we hit `from`
  // we'd close a cycle when adding `from → to`.
  const visited = new Set()
  const stack = [{ slug: to, path: [from, to] }]
  while (stack.length) {
    const { slug, path } = stack.pop()
    if (visited.has(slug)) continue
    visited.add(slug)
    for (const e of outgoingEdges(graph, slug)) {
      if (!GATING_RELATIONS.has(e.relation)) continue
      const nextPath = [...path, e.to]
      if (e.to === from) return nextPath
      stack.push({ slug: e.to, path: nextPath })
    }
  }
  return null
}
