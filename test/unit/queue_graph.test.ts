// Unit tests for engine/core/queue_graph.mjs — event replay (V2.1).

import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as graphModule from '../../engine/core/queue_graph.mjs'
import { cleanupTempRoots, createTempRepo } from '../_helpers.js'

type Node = {
  slug: string
  status: string
  lane?: string
  description?: string
  since_at?: string
  created_at: string
  updated_at: string
}
type Edge = {
  relation: string
  from: string
  to: string
  added_at: string
  added_event_id: string
}
type Graph = { nodes: Map<string, Node>; edges: Map<string, Edge> }

const {
  buildGraph,
  readyForDispatch,
  nodesByStatus,
  incomingEdges,
  outgoingEdges,
  hasUnresolvedUpstream,
  effectiveStatus,
  findGatingCycle,
  EDGE_RELATIONS,
} = graphModule as {
  buildGraph: (projectDir: string) => Graph
  readyForDispatch: (graph: Graph) => Node[]
  nodesByStatus: (graph: Graph, status: string) => Node[]
  incomingEdges: (graph: Graph, slug: string, relation?: string | null) => Edge[]
  outgoingEdges: (graph: Graph, slug: string, relation?: string | null) => Edge[]
  hasUnresolvedUpstream: (graph: Graph, slug: string) => boolean
  effectiveStatus: (graph: Graph, slug: string) => string | null
  findGatingCycle: (graph: Graph, from: string, to: string, relation: string) => string[] | null
  EDGE_RELATIONS: Set<string>
}

afterEach(cleanupTempRoots)

const writeEvents = (root: string, events: object[]) => {
  mkdirSync(join(root, '.artel'), { recursive: true })
  writeFileSync(
    join(root, '.artel', 'events.jsonl'),
    events.map((e) => JSON.stringify(e)).join('\n') + '\n',
  )
}

const baseEnv = (overrides: object) => ({
  schema: 'v1',
  kind: 'workload',
  id: '01934f00-aaaa-7bbb-8ccc-' + Math.random().toString(16).slice(2, 14).padStart(12, '0'),
  cluster_id: '01934f00-aaaa-7bbb-8ccc-cccccccccccc',
  instance_id: '01934f00-aaaa-7bbb-8ccc-iiiiiiiiiiii',
  fence_token: 0,
  ...overrides,
})

describe('buildGraph', () => {
  it('returns empty graph when events.jsonl absent', () => {
    const root = createTempRepo()
    // createTempRepo doesn't create events.jsonl
    const graph = buildGraph(root)
    expect(graph.nodes.size).toBe(0)
  })

  it('replays queue_node.created events', () => {
    const root = createTempRepo()
    writeEvents(root, [
      baseEnv({ type: 'queue_node.created', at: '2026-05-04T10:00:00.000Z',
               node_id: 'task-a', status: 'Pending', lane: 'impl', description: 'do thing' }),
    ])
    const graph = buildGraph(root)
    expect(graph.nodes.size).toBe(1)
    const node = graph.nodes.get('task-a')!
    expect(node).toMatchObject({
      slug: 'task-a',
      status: 'Pending',
      lane: 'impl',
      description: 'do thing',
      created_at: '2026-05-04T10:00:00.000Z',
      updated_at: '2026-05-04T10:00:00.000Z',
    })
  })

  it('applies queue_node.updated patches; null clears fields', () => {
    const root = createTempRepo()
    writeEvents(root, [
      baseEnv({ type: 'queue_node.created', at: '2026-05-04T10:00:00.000Z',
               node_id: 'task-a', status: 'Pending', lane: 'impl' }),
      baseEnv({ type: 'queue_node.updated', at: '2026-05-04T10:01:00.000Z',
               node_id: 'task-a',
               fields: { status: 'In progress', since_at: '2026-05-04T10:01:00.000Z' } }),
      baseEnv({ type: 'queue_node.updated', at: '2026-05-04T10:02:00.000Z',
               node_id: 'task-a',
               fields: { status: 'Recently done', since_at: null } }),
    ])
    const node = buildGraph(root).nodes.get('task-a')!
    expect(node.status).toBe('Recently done')
    expect(node.since_at).toBeUndefined() // null cleared the field
    expect(node.lane).toBe('impl')        // untouched
    expect(node.updated_at).toBe('2026-05-04T10:02:00.000Z')
    expect(node.created_at).toBe('2026-05-04T10:00:00.000Z')
  })

  it('queue_node.deleted removes the slug from the map', () => {
    const root = createTempRepo()
    writeEvents(root, [
      baseEnv({ type: 'queue_node.created', at: '2026-05-04T10:00:00.000Z',
               node_id: 'task-a', status: 'Pending' }),
      baseEnv({ type: 'queue_node.deleted', at: '2026-05-04T10:01:00.000Z',
               node_id: 'task-a' }),
    ])
    const graph = buildGraph(root)
    expect(graph.nodes.size).toBe(0)
  })

  it('ignores unrelated events (workload but non-queue, infra, etc.)', () => {
    const root = createTempRepo()
    writeEvents(root, [
      baseEnv({ type: 'queue_node.created', at: '2026-05-04T10:00:00.000Z',
               node_id: 'task-a', status: 'Pending' }),
      baseEnv({ type: 'dispatch.start', at: '2026-05-04T10:01:00.000Z',
               task: 'task-a', owner_role: 'implementer' }),
      baseEnv({ kind: 'infra', type: 'cluster.heartbeat', at: '2026-05-04T10:02:00.000Z' }),
    ])
    const graph = buildGraph(root)
    expect(graph.nodes.size).toBe(1)
  })

  it('tolerates malformed JSON lines', () => {
    const root = createTempRepo()
    mkdirSync(join(root, '.artel'), { recursive: true })
    writeFileSync(join(root, '.artel', 'events.jsonl'), [
      '{"this is not json',
      JSON.stringify(baseEnv({ type: 'queue_node.created', at: '2026-05-04T10:00:00.000Z',
                               node_id: 'task-a', status: 'Pending' })),
      'garbage line',
      '',
    ].join('\n'))
    const graph = buildGraph(root)
    expect(graph.nodes.size).toBe(1)
    expect(graph.nodes.get('task-a')!.status).toBe('Pending')
  })

  it('queue_node.updated for unknown slug initialises a fresh node', () => {
    const root = createTempRepo()
    writeEvents(root, [
      baseEnv({ type: 'queue_node.updated', at: '2026-05-04T10:00:00.000Z',
               node_id: 'orphan', fields: { status: 'Pending', lane: 'spec' } }),
    ])
    const node = buildGraph(root).nodes.get('orphan')!
    expect(node).toMatchObject({ slug: 'orphan', status: 'Pending', lane: 'spec' })
  })
})

describe('readyForDispatch', () => {
  it('returns Pending nodes sorted by created_at ascending', () => {
    const root = createTempRepo()
    writeEvents(root, [
      baseEnv({ type: 'queue_node.created', at: '2026-05-04T10:00:00.000Z',
               node_id: 'a', status: 'Pending' }),
      baseEnv({ type: 'queue_node.created', at: '2026-05-04T09:00:00.000Z',
               node_id: 'b', status: 'Pending' }),
      baseEnv({ type: 'queue_node.created', at: '2026-05-04T11:00:00.000Z',
               node_id: 'c', status: 'In progress' }),
    ])
    const graph = buildGraph(root)
    const ready = readyForDispatch(graph)
    expect(ready.map((n) => n.slug)).toEqual(['b', 'a']) // b is earlier
    expect(ready).not.toContainEqual(expect.objectContaining({ slug: 'c' }))
  })
})

describe('nodesByStatus', () => {
  it('filters by exact status match', () => {
    const root = createTempRepo()
    writeEvents(root, [
      baseEnv({ type: 'queue_node.created', at: '2026-05-04T10:00:00.000Z',
               node_id: 'a', status: 'Pending' }),
      baseEnv({ type: 'queue_node.created', at: '2026-05-04T10:01:00.000Z',
               node_id: 'b', status: 'Blocked' }),
    ])
    const graph = buildGraph(root)
    expect(nodesByStatus(graph, 'Pending').map((n) => n.slug)).toEqual(['a'])
    expect(nodesByStatus(graph, 'Blocked').map((n) => n.slug)).toEqual(['b'])
    expect(nodesByStatus(graph, 'Recently done')).toEqual([])
  })
})

// --- V2.2: edges ---

describe('edge replay (V2.2)', () => {
  it('replays queue_edge.added into the edges map', () => {
    const root = createTempRepo()
    writeEvents(root, [
      baseEnv({ type: 'queue_node.created', at: 't1', node_id: 'a', status: 'Recently done' }),
      baseEnv({ type: 'queue_node.created', at: 't2', node_id: 'b', status: 'Pending' }),
      baseEnv({ type: 'queue_edge.added', at: 't3', relation: 'blocks', from: 'a', to: 'b' }),
    ])
    const graph = buildGraph(root)
    expect(graph.edges.size).toBe(1)
    const edge = [...graph.edges.values()][0]
    expect(edge).toMatchObject({ relation: 'blocks', from: 'a', to: 'b', added_at: 't3' })
  })

  it('queue_edge.removed removes by (relation, from, to) tuple', () => {
    const root = createTempRepo()
    writeEvents(root, [
      baseEnv({ type: 'queue_node.created', at: 't1', node_id: 'a', status: 'Pending' }),
      baseEnv({ type: 'queue_node.created', at: 't2', node_id: 'b', status: 'Pending' }),
      baseEnv({ type: 'queue_edge.added', at: 't3', relation: 'blocks', from: 'a', to: 'b' }),
      baseEnv({ type: 'queue_edge.removed', at: 't4', relation: 'blocks', from: 'a', to: 'b' }),
    ])
    expect(buildGraph(root).edges.size).toBe(0)
  })

  it('re-adding the same tuple is a no-op (key-deduped)', () => {
    const root = createTempRepo()
    writeEvents(root, [
      baseEnv({ type: 'queue_node.created', at: 't1', node_id: 'a', status: 'Pending' }),
      baseEnv({ type: 'queue_node.created', at: 't2', node_id: 'b', status: 'Pending' }),
      baseEnv({ type: 'queue_edge.added', at: 't3', relation: 'blocks', from: 'a', to: 'b' }),
      baseEnv({ type: 'queue_edge.added', at: 't4', relation: 'blocks', from: 'a', to: 'b' }),
    ])
    expect(buildGraph(root).edges.size).toBe(1)
  })

  it('different relation between same nodes = different edge', () => {
    const root = createTempRepo()
    writeEvents(root, [
      baseEnv({ type: 'queue_node.created', at: 't1', node_id: 'a', status: 'Pending' }),
      baseEnv({ type: 'queue_node.created', at: 't2', node_id: 'b', status: 'Pending' }),
      baseEnv({ type: 'queue_edge.added', at: 't3', relation: 'blocks', from: 'a', to: 'b' }),
      baseEnv({ type: 'queue_edge.added', at: 't4', relation: 'depends_on', from: 'a', to: 'b' }),
    ])
    expect(buildGraph(root).edges.size).toBe(2)
  })

  it('ignores malformed edge events (missing fields)', () => {
    const root = createTempRepo()
    writeEvents(root, [
      baseEnv({ type: 'queue_node.created', at: 't1', node_id: 'a', status: 'Pending' }),
      baseEnv({ type: 'queue_edge.added', at: 't2', from: 'a' }), // no relation, no to
      baseEnv({ type: 'queue_edge.added', at: 't3', relation: 'blocks' }), // no from/to
    ])
    expect(buildGraph(root).edges.size).toBe(0)
  })

  it('incomingEdges / outgoingEdges filter by slug + optional relation', () => {
    const root = createTempRepo()
    writeEvents(root, [
      baseEnv({ type: 'queue_node.created', at: 't1', node_id: 'a', status: 'Pending' }),
      baseEnv({ type: 'queue_node.created', at: 't2', node_id: 'b', status: 'Pending' }),
      baseEnv({ type: 'queue_node.created', at: 't3', node_id: 'c', status: 'Pending' }),
      baseEnv({ type: 'queue_edge.added', at: 't4', relation: 'blocks', from: 'a', to: 'b' }),
      baseEnv({ type: 'queue_edge.added', at: 't5', relation: 'depends_on', from: 'c', to: 'b' }),
    ])
    const graph = buildGraph(root)
    expect(incomingEdges(graph, 'b').map((e) => e.from).sort()).toEqual(['a', 'c'])
    expect(incomingEdges(graph, 'b', 'blocks').map((e) => e.from)).toEqual(['a'])
    expect(outgoingEdges(graph, 'a').map((e) => e.to)).toEqual(['b'])
    expect(outgoingEdges(graph, 'b')).toEqual([])
  })
})

describe('effectiveStatus + readyForDispatch (V2.2)', () => {
  const buildScenario = (root: string) => {
    // upstream: Pending. downstream: Pending. edge: blocks(upstream → downstream).
    writeEvents(root, [
      baseEnv({ type: 'queue_node.created', at: 't1', node_id: 'upstream', status: 'Pending' }),
      baseEnv({ type: 'queue_node.created', at: 't2', node_id: 'downstream', status: 'Pending' }),
      baseEnv({ type: 'queue_edge.added', at: 't3', relation: 'blocks', from: 'upstream', to: 'downstream' }),
    ])
  }

  it('Pending + unresolved gating inbound → effective Blocked', () => {
    const root = createTempRepo()
    buildScenario(root)
    const graph = buildGraph(root)
    expect(effectiveStatus(graph, 'upstream')).toBe('Pending')   // no gating in
    expect(effectiveStatus(graph, 'downstream')).toBe('Blocked') // upstream not done
    expect(hasUnresolvedUpstream(graph, 'downstream')).toBe(true)
  })

  it('upstream Recently done → downstream effectively Pending again', () => {
    const root = createTempRepo()
    buildScenario(root)
    writeEvents(root, [
      // append: mark upstream done
      baseEnv({ type: 'queue_node.created', at: 't1', node_id: 'upstream', status: 'Pending' }),
      baseEnv({ type: 'queue_node.created', at: 't2', node_id: 'downstream', status: 'Pending' }),
      baseEnv({ type: 'queue_edge.added', at: 't3', relation: 'blocks', from: 'upstream', to: 'downstream' }),
      baseEnv({ type: 'queue_node.updated', at: 't4', node_id: 'upstream',
               fields: { status: 'Recently done' } }),
    ])
    const graph = buildGraph(root)
    expect(effectiveStatus(graph, 'downstream')).toBe('Pending')
    expect(hasUnresolvedUpstream(graph, 'downstream')).toBe(false)
  })

  it('In progress is sticky — gating doesn\'t override (owner forced through)', () => {
    const root = createTempRepo()
    writeEvents(root, [
      baseEnv({ type: 'queue_node.created', at: 't1', node_id: 'a', status: 'Pending' }),
      baseEnv({ type: 'queue_node.created', at: 't2', node_id: 'b', status: 'In progress' }),
      baseEnv({ type: 'queue_edge.added', at: 't3', relation: 'blocks', from: 'a', to: 'b' }),
    ])
    const graph = buildGraph(root)
    expect(effectiveStatus(graph, 'b')).toBe('In progress')
  })

  it('non-gating relations (parent_of, derived_from, ...) do not block', () => {
    const root = createTempRepo()
    writeEvents(root, [
      baseEnv({ type: 'queue_node.created', at: 't1', node_id: 'a', status: 'Pending' }),
      baseEnv({ type: 'queue_node.created', at: 't2', node_id: 'b', status: 'Pending' }),
      baseEnv({ type: 'queue_edge.added', at: 't3', relation: 'parent_of', from: 'a', to: 'b' }),
    ])
    const graph = buildGraph(root)
    expect(effectiveStatus(graph, 'b')).toBe('Pending')
    expect(readyForDispatch(graph).map((n) => n.slug).sort()).toEqual(['a', 'b'])
  })

  it('readyForDispatch filters out blocked Pending nodes', () => {
    const root = createTempRepo()
    buildScenario(root)
    const graph = buildGraph(root)
    expect(readyForDispatch(graph).map((n) => n.slug)).toEqual(['upstream'])
  })
})

describe('findGatingCycle', () => {
  it('detects direct A → B → A cycle', () => {
    const root = createTempRepo()
    writeEvents(root, [
      baseEnv({ type: 'queue_node.created', at: 't1', node_id: 'a', status: 'Pending' }),
      baseEnv({ type: 'queue_node.created', at: 't2', node_id: 'b', status: 'Pending' }),
      baseEnv({ type: 'queue_edge.added', at: 't3', relation: 'blocks', from: 'a', to: 'b' }),
    ])
    const graph = buildGraph(root)
    // Adding b → a would close A → B → A
    expect(findGatingCycle(graph, 'b', 'a', 'blocks')).toEqual(['b', 'a', 'b'])
  })

  it('detects indirect cycle through chain A → B → C → A', () => {
    const root = createTempRepo()
    writeEvents(root, [
      baseEnv({ type: 'queue_node.created', at: 't1', node_id: 'a', status: 'Pending' }),
      baseEnv({ type: 'queue_node.created', at: 't2', node_id: 'b', status: 'Pending' }),
      baseEnv({ type: 'queue_node.created', at: 't3', node_id: 'c', status: 'Pending' }),
      baseEnv({ type: 'queue_edge.added', at: 't4', relation: 'blocks', from: 'a', to: 'b' }),
      baseEnv({ type: 'queue_edge.added', at: 't5', relation: 'blocks', from: 'b', to: 'c' }),
    ])
    const graph = buildGraph(root)
    expect(findGatingCycle(graph, 'c', 'a', 'blocks')).toEqual(['c', 'a', 'b', 'c'])
  })

  it('mixes gating relations — depends_on and blocks both close cycles', () => {
    const root = createTempRepo()
    writeEvents(root, [
      baseEnv({ type: 'queue_node.created', at: 't1', node_id: 'a', status: 'Pending' }),
      baseEnv({ type: 'queue_node.created', at: 't2', node_id: 'b', status: 'Pending' }),
      baseEnv({ type: 'queue_edge.added', at: 't3', relation: 'blocks', from: 'a', to: 'b' }),
    ])
    const graph = buildGraph(root)
    // b -- depends_on -> a would close because a -> b blocks already.
    expect(findGatingCycle(graph, 'b', 'a', 'depends_on')).toEqual(['b', 'a', 'b'])
  })

  it('non-gating relations never trigger cycle check', () => {
    const root = createTempRepo()
    writeEvents(root, [
      baseEnv({ type: 'queue_node.created', at: 't1', node_id: 'a', status: 'Pending' }),
      baseEnv({ type: 'queue_node.created', at: 't2', node_id: 'b', status: 'Pending' }),
      baseEnv({ type: 'queue_edge.added', at: 't3', relation: 'blocks', from: 'a', to: 'b' }),
    ])
    const graph = buildGraph(root)
    expect(findGatingCycle(graph, 'b', 'a', 'parent_of')).toBeNull()
  })

  it('returns null when no cycle would form', () => {
    const root = createTempRepo()
    writeEvents(root, [
      baseEnv({ type: 'queue_node.created', at: 't1', node_id: 'a', status: 'Pending' }),
      baseEnv({ type: 'queue_node.created', at: 't2', node_id: 'b', status: 'Pending' }),
    ])
    const graph = buildGraph(root)
    expect(findGatingCycle(graph, 'a', 'b', 'blocks')).toBeNull()
  })

  it('rejects self-edges immediately', () => {
    const root = createTempRepo()
    writeEvents(root, [
      baseEnv({ type: 'queue_node.created', at: 't1', node_id: 'a', status: 'Pending' }),
    ])
    expect(findGatingCycle(buildGraph(root), 'a', 'a', 'blocks')).toEqual(['a', 'a'])
  })
})

describe('EDGE_RELATIONS', () => {
  it('includes the seven canonical relations', () => {
    const expected = ['blocks', 'depends_on', 'supersedes', 'parent_of',
      'triggers', 'derived_from', 'same_pipeline_run']
    for (const r of expected) expect(EDGE_RELATIONS.has(r)).toBe(true)
  })
})
