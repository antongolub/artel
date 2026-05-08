// Unit tests for engine/util/pipelines.mjs — parser/validator/resolver (V3.1).

import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as pipelinesModule from '../../engine/util/pipelines.mjs'
import { cleanupTempRoots, createTempRepo } from '../_helpers.js'

const { validatePipeline, loadPipelineFile, resolveNext, listPipelineFiles, pipelinePath, pipelinesDir } = pipelinesModule as {
  validatePipeline: (def: unknown, source?: string) => unknown
  loadPipelineFile: (path: string) => unknown
  resolveNext: (def: { edges: { from: string; to: string; on_disposition: string }[] }, fromNodeId: string, disposition: string) => string | null
  listPipelineFiles: (projectDir: string) => { id: string; path: string }[]
  pipelinePath: (projectDir: string, id: string) => string
  pipelinesDir: (projectDir: string) => string
}

afterEach(cleanupTempRoots)

const minimalPipeline = () => ({
  id: 'demo',
  version: 1,
  description: 'demo flow',
  entry: 'first',
  nodes: {
    first: { type: 'dispatch', role: 'implementer', prompt: 'do thing' },
    done: { type: 'terminal', final_state: 'completed' },
    fail: { type: 'terminal', final_state: 'failed' },
  },
  edges: [
    { from: 'first', on_disposition: 'success', to: 'done' },
    { from: 'first', on_disposition: '*', to: 'fail' },
  ],
})

describe('validatePipeline', () => {
  it('accepts a well-formed minimal pipeline', () => {
    expect(() => validatePipeline(minimalPipeline())).not.toThrow()
  })

  it('rejects non-object inputs', () => {
    expect(() => validatePipeline(null)).toThrow(/must be a JSON object/)
    expect(() => validatePipeline('a string')).toThrow(/must be a JSON object/)
  })

  it('rejects bad id slug', () => {
    const def = { ...minimalPipeline(), id: '_bad slug' }
    expect(() => validatePipeline(def)).toThrow(/id must be a slug/)
  })

  it('rejects bad version (non-integer or < 1)', () => {
    expect(() => validatePipeline({ ...minimalPipeline(), version: 0 })).toThrow(/version must be a positive integer/)
    expect(() => validatePipeline({ ...minimalPipeline(), version: 1.5 })).toThrow(/version must be a positive integer/)
    expect(() => validatePipeline({ ...minimalPipeline(), version: '1' })).toThrow(/version must be a positive integer/)
  })

  it('rejects entry referencing an unknown node', () => {
    const def = { ...minimalPipeline(), entry: 'ghost' }
    expect(() => validatePipeline(def)).toThrow(/entry 'ghost' is not a registered node/)
  })

  it('rejects unknown node types', () => {
    const def = minimalPipeline()
    def.nodes.first = { type: 'subpipeline' as 'dispatch', role: 'r', prompt: 'p' }
    expect(() => validatePipeline(def)).toThrow(/invalid type 'subpipeline'/)
  })

  it('rejects dispatch nodes missing role / prompt', () => {
    const noRole = minimalPipeline()
    delete (noRole.nodes.first as { role?: string }).role
    expect(() => validatePipeline(noRole)).toThrow(/requires a role/)

    const noPrompt = minimalPipeline()
    delete (noPrompt.nodes.first as { prompt?: string }).prompt
    expect(() => validatePipeline(noPrompt)).toThrow(/requires a prompt/)
  })

  it('rejects terminal nodes with bad final_state', () => {
    const def = minimalPipeline()
    def.nodes.done = { type: 'terminal', final_state: 'mystery' as 'completed' }
    expect(() => validatePipeline(def)).toThrow(/invalid final_state/)
  })

  it('rejects edges referencing unknown nodes', () => {
    const def = minimalPipeline()
    def.edges.push({ from: 'first', on_disposition: 'parked', to: 'ghost' })
    expect(() => validatePipeline(def)).toThrow(/'ghost' is not a registered node/)
  })

  it('rejects edges with unknown disposition', () => {
    const def = minimalPipeline()
    def.edges[0].on_disposition = 'frobs'
    expect(() => validatePipeline(def)).toThrow(/invalid on_disposition/)
  })

  it('rejects edges originating from terminal nodes', () => {
    const def = minimalPipeline()
    def.edges.push({ from: 'done', on_disposition: '*', to: 'fail' })
    expect(() => validatePipeline(def)).toThrow(/originates from terminal node 'done'/)
  })

  it('rejects pipelines with no reachable terminal', () => {
    const def = {
      id: 'stuck',
      version: 1,
      entry: 'a',
      nodes: {
        a: { type: 'dispatch', role: 'r', prompt: 'p' },
        b: { type: 'dispatch', role: 'r', prompt: 'p' },
      },
      edges: [
        { from: 'a', on_disposition: 'success', to: 'b' },
        { from: 'b', on_disposition: 'success', to: 'a' },
      ],
    }
    expect(() => validatePipeline(def)).toThrow(/no terminal node is reachable/)
  })

  it('tolerates extra fields (forward-compat)', () => {
    const def = minimalPipeline() as Record<string, unknown>
    def.future_field = { whatever: 1 }
    ;(def.nodes as Record<string, Record<string, unknown>>).first.attrs = { foo: 'bar' }
    expect(() => validatePipeline(def)).not.toThrow()
  })
})

describe('resolveNext', () => {
  const def = minimalPipeline()

  it('matches exact disposition first', () => {
    expect(resolveNext(def, 'first', 'success')).toBe('done')
  })

  it('falls back to wildcard `*` when no exact match', () => {
    expect(resolveNext(def, 'first', 'parked')).toBe('fail')
    expect(resolveNext(def, 'first', 'timeout')).toBe('fail')
  })

  it('returns null when no edge matches', () => {
    const noWildcard = {
      ...minimalPipeline(),
      edges: [{ from: 'first', on_disposition: 'success', to: 'done' }],
    }
    expect(resolveNext(noWildcard, 'first', 'parked')).toBeNull()
  })

  it('returns null for unknown source', () => {
    expect(resolveNext(def, 'ghost', 'success')).toBeNull()
  })
})

describe('parallel node validation (V3.2.a)', () => {
  const withParallel = (overrides = {}) => ({
    id: 'fanout',
    version: 1,
    entry: 'fan',
    nodes: {
      fan: { type: 'parallel', branches: ['a', 'b'], join: 'all-complete' },
      a: { type: 'dispatch', role: 'cold-reader', prompt: 'review' },
      b: { type: 'dispatch', role: 'adversary', prompt: 'attack' },
      done: { type: 'terminal', final_state: 'completed' },
      fail: { type: 'terminal', final_state: 'failed' },
    },
    edges: [
      { from: 'fan', on_disposition: 'success', to: 'done' },
      { from: 'fan', on_disposition: '*', to: 'fail' },
    ],
    ...overrides,
  })

  it('accepts a well-formed parallel pipeline', () => {
    expect(() => validatePipeline(withParallel())).not.toThrow()
  })

  it('rejects parallel without branches', () => {
    const def = withParallel()
    def.nodes.fan = { type: 'parallel', branches: [], join: 'all-complete' }
    expect(() => validatePipeline(def)).toThrow(/non-empty branches array/)
  })

  it('rejects branch referencing unknown node', () => {
    const def = withParallel()
    def.nodes.fan = { type: 'parallel', branches: ['a', 'ghost'], join: 'all-complete' }
    expect(() => validatePipeline(def)).toThrow(/references unknown branch 'ghost'/)
  })

  it('rejects duplicate branches', () => {
    const def = withParallel()
    def.nodes.fan = { type: 'parallel', branches: ['a', 'a'], join: 'all-complete' }
    expect(() => validatePipeline(def)).toThrow(/duplicate branch 'a'/)
  })

  it('rejects parallel listing itself as a branch', () => {
    const def = withParallel()
    def.nodes.fan = { type: 'parallel', branches: ['fan'], join: 'all-complete' }
    expect(() => validatePipeline(def)).toThrow(/cannot list itself as a branch/)
  })

  it('rejects unknown join policy', () => {
    const def = withParallel()
    def.nodes.fan = { type: 'parallel', branches: ['a', 'b'], join: 'frob-of-n' }
    expect(() => validatePipeline(def)).toThrow(/invalid join 'frob-of-n'/)
  })

  it('rejects non-dispatch branches (V3.2.a restriction)', () => {
    const def = withParallel() as Record<string, unknown> & { nodes: Record<string, unknown> }
    def.nodes.nested = { type: 'parallel', branches: ['a'], join: 'all-complete' }
    def.nodes.fan = { type: 'parallel', branches: ['a', 'nested'], join: 'all-complete' }
    expect(() => validatePipeline(def)).toThrow(/branch 'nested' must be a dispatch node/)
  })

  it('parallel-only flow: branches reachable through parallel', () => {
    // a, b only listed as parallel branches, not as edge targets.
    // Reachability check should still find the terminals.
    expect(() => validatePipeline(withParallel())).not.toThrow()
  })

  it('default join is all-complete (omitted accepted)', () => {
    const def = withParallel() as Record<string, unknown> & { nodes: Record<string, unknown> }
    def.nodes.fan = { type: 'parallel', branches: ['a', 'b'] } // no join
    expect(() => validatePipeline(def)).not.toThrow()
  })
})

describe('condition node validation (V3.2.b)', () => {
  const withCondition = (overrides = {}) => ({
    id: 'gated',
    version: 1,
    entry: 'gate',
    nodes: {
      gate: { type: 'condition', if: { attr: 'attrs.skip_tests', equals: true }, then: 'done', else: 'test' },
      test: { type: 'dispatch', role: 'implementer', prompt: 'run tests' },
      done: { type: 'terminal', final_state: 'completed' },
    },
    edges: [
      { from: 'test', on_disposition: 'success', to: 'done' },
      { from: 'test', on_disposition: '*', to: 'done' },
    ],
    ...overrides,
  })

  it('accepts a well-formed condition pipeline', () => {
    expect(() => validatePipeline(withCondition())).not.toThrow()
  })

  it('rejects condition without then / else', () => {
    const def = withCondition()
    delete (def.nodes.gate as { then?: string }).then
    expect(() => validatePipeline(def)).toThrow(/\.then '.*' is not a registered node/)
  })

  it('rejects condition referencing unknown then/else', () => {
    const def = withCondition()
    def.nodes.gate.then = 'ghost'
    expect(() => validatePipeline(def)).toThrow(/\.then 'ghost' is not a registered node/)
  })

  it('rejects condition without .if', () => {
    const def = withCondition()
    delete (def.nodes.gate as { if?: object }).if
    expect(() => validatePipeline(def)).toThrow(/requires an \.if predicate/)
  })

  it('rejects condition with bad attr', () => {
    const def = withCondition()
    def.nodes.gate.if = { equals: true } as never
    expect(() => validatePipeline(def)).toThrow(/\.if\.attr must be a non-empty string/)
  })

  it('rejects condition with multiple ops', () => {
    const def = withCondition()
    def.nodes.gate.if = { attr: 'x', equals: 1, in: [1, 2] } as never
    expect(() => validatePipeline(def)).toThrow(/must specify exactly one of/)
  })

  it('rejects condition with no op', () => {
    const def = withCondition()
    def.nodes.gate.if = { attr: 'x' } as never
    expect(() => validatePipeline(def)).toThrow(/must specify exactly one of/)
  })

  it('rejects in op with non-array value', () => {
    const def = withCondition()
    def.nodes.gate.if = { attr: 'x', in: 'not-an-array' } as never
    expect(() => validatePipeline(def)).toThrow(/\.if\.in must be an array/)
  })

  it('rejects exists op with non-boolean', () => {
    const def = withCondition()
    def.nodes.gate.if = { attr: 'x', exists: 'maybe' } as never
    expect(() => validatePipeline(def)).toThrow(/\.if\.exists must be a boolean/)
  })

  it('reachability follows .then and .else', () => {
    // condition is the only path to `done` and `test`; without
    // following condition's then/else, reachability would fail.
    expect(() => validatePipeline(withCondition())).not.toThrow()
  })
})

describe('evaluatePredicate (V3.2.b)', () => {
  const { evaluatePredicate } = pipelinesModule as { evaluatePredicate: (p: object | null, attrs: object) => boolean }

  it('equals matches exact value', () => {
    expect(evaluatePredicate({ attr: 'x', equals: 1 }, { x: 1 })).toBe(true)
    expect(evaluatePredicate({ attr: 'x', equals: 1 }, { x: 2 })).toBe(false)
    expect(evaluatePredicate({ attr: 'x', equals: 'foo' }, { x: 'foo' })).toBe(true)
    expect(evaluatePredicate({ attr: 'x', equals: true }, { x: true })).toBe(true)
  })

  it('reads dotted paths', () => {
    expect(evaluatePredicate({ attr: 'a.b.c', equals: 7 }, { a: { b: { c: 7 } } })).toBe(true)
    expect(evaluatePredicate({ attr: 'a.b.c', equals: 7 }, { a: { b: {} } })).toBe(false)
    expect(evaluatePredicate({ attr: 'a.b', equals: undefined }, { a: {} })).toBe(true)
  })

  it('in matches array membership', () => {
    expect(evaluatePredicate({ attr: 'env', in: ['staging', 'prod'] }, { env: 'staging' })).toBe(true)
    expect(evaluatePredicate({ attr: 'env', in: ['staging', 'prod'] }, { env: 'dev' })).toBe(false)
  })

  it('exists checks presence', () => {
    expect(evaluatePredicate({ attr: 'x', exists: true }, { x: 0 })).toBe(true)
    expect(evaluatePredicate({ attr: 'x', exists: true }, { x: '' })).toBe(true)
    expect(evaluatePredicate({ attr: 'x', exists: true }, {})).toBe(false)
    expect(evaluatePredicate({ attr: 'x', exists: false }, {})).toBe(true)
    expect(evaluatePredicate({ attr: 'x', exists: false }, { x: 1 })).toBe(false)
  })

  it('returns false on null / non-object predicate', () => {
    expect(evaluatePredicate(null, { x: 1 })).toBe(false)
  })
})

describe('parallel join (V3.3.c) — any-complete / k-of-n', () => {
  const withJoin = (join: string, extra: object = {}) => ({
    id: 'race',
    version: 1,
    entry: 'fan',
    nodes: {
      fan: { type: 'parallel', branches: ['a', 'b', 'c'], join, ...extra },
      a: { type: 'dispatch', role: 'cold-reader', prompt: 'a' },
      b: { type: 'dispatch', role: 'adversary', prompt: 'b' },
      c: { type: 'dispatch', role: 'maintainer', prompt: 'c' },
      done: { type: 'terminal', final_state: 'completed' },
      fail: { type: 'terminal', final_state: 'failed' },
    },
    edges: [
      { from: 'fan', on_disposition: 'success', to: 'done' },
      { from: 'fan', on_disposition: '*', to: 'fail' },
    ],
  })

  it('accepts any-complete', () => {
    expect(() => validatePipeline(withJoin('any-complete'))).not.toThrow()
  })

  it('accepts k-of-n with valid k', () => {
    expect(() => validatePipeline(withJoin('k-of-n', { k: 2 }))).not.toThrow()
  })

  it('rejects k-of-n without k', () => {
    expect(() => validatePipeline(withJoin('k-of-n')))
      .toThrow(/k-of-n requires \.k integer in \[1, 3\]/)
  })

  it('rejects k-of-n with k outside [1, branches.length]', () => {
    expect(() => validatePipeline(withJoin('k-of-n', { k: 0 })))
      .toThrow(/integer in \[1, 3\]/)
    expect(() => validatePipeline(withJoin('k-of-n', { k: 4 })))
      .toThrow(/integer in \[1, 3\]/)
    expect(() => validatePipeline(withJoin('k-of-n', { k: 1.5 })))
      .toThrow(/integer in \[1, 3\]/)
  })
})

describe('quorumOf (V3.3.c)', () => {
  const { quorumOf } = pipelinesModule as { quorumOf: (n: { branches: string[]; join?: string; k?: number }) => number }

  it('all-complete → branches.length', () => {
    expect(quorumOf({ branches: ['a', 'b', 'c'] })).toBe(3)
    expect(quorumOf({ branches: ['a', 'b'], join: 'all-complete' })).toBe(2)
  })

  it('any-complete → 1', () => {
    expect(quorumOf({ branches: ['a', 'b', 'c'], join: 'any-complete' })).toBe(1)
  })

  it('k-of-n → node.k', () => {
    expect(quorumOf({ branches: ['a', 'b', 'c'], join: 'k-of-n', k: 2 })).toBe(2)
  })
})

describe('aggregateForJoin (V3.3.c)', () => {
  const { aggregateForJoin } = pipelinesModule as {
    aggregateForJoin: (xs: string[], join: string, k?: number | null) => string
  }

  it('all-complete delegates to worst-of-children', () => {
    expect(aggregateForJoin(['success', 'success', 'success'], 'all-complete')).toBe('success')
    expect(aggregateForJoin(['success', 'error', 'success'], 'all-complete')).toBe('error')
  })

  it('any-complete returns success when ≥1 branch succeeded', () => {
    expect(aggregateForJoin(['success', 'cancelled', 'cancelled'], 'any-complete')).toBe('success')
    expect(aggregateForJoin(['error', 'success', 'cancelled'], 'any-complete')).toBe('success')
  })

  it('any-complete falls back to worst when no success', () => {
    expect(aggregateForJoin(['error', 'parked', 'timeout'], 'any-complete')).toBe('error')
    expect(aggregateForJoin(['parked', 'parked', 'parked'], 'any-complete')).toBe('parked')
  })

  it('k-of-n returns success when ≥k branches succeeded', () => {
    expect(aggregateForJoin(['success', 'success', 'cancelled'], 'k-of-n', 2)).toBe('success')
    expect(aggregateForJoin(['success', 'error', 'success'], 'k-of-n', 2)).toBe('success')
  })

  it('k-of-n falls back to worst when fewer than k succeeded', () => {
    expect(aggregateForJoin(['success', 'error', 'error'], 'k-of-n', 2)).toBe('error')
  })
})

describe('aggregateDisposition (V3.2.a)', () => {
  const { aggregateDisposition } = pipelinesModule as { aggregateDisposition: (xs: string[]) => string }

  it('all success → success', () => {
    expect(aggregateDisposition(['success', 'success', 'success'])).toBe('success')
  })

  it('any error → error (severity wins)', () => {
    expect(aggregateDisposition(['success', 'error', 'success'])).toBe('error')
  })

  it('error beats timeout beats parked', () => {
    expect(aggregateDisposition(['parked', 'timeout', 'error'])).toBe('error')
    expect(aggregateDisposition(['parked', 'timeout'])).toBe('timeout')
    expect(aggregateDisposition(['success', 'parked'])).toBe('parked')
  })

  it('empty list → success (vacuous truth)', () => {
    expect(aggregateDisposition([])).toBe('success')
  })

  it('unknown disposition: returns first non-success', () => {
    expect(aggregateDisposition(['success', 'weirdo', 'success'])).toBe('weirdo')
  })

  it('V3.3.c — cancelled is excluded (not a real outcome)', () => {
    expect(aggregateDisposition(['success', 'cancelled', 'cancelled'])).toBe('success')
    expect(aggregateDisposition(['cancelled', 'cancelled'])).toBe('success')
    expect(aggregateDisposition(['error', 'cancelled'])).toBe('error')
  })
})

describe('listPipelineRuns / pipelineRunDetail (V3.4.a)', () => {
  const { listPipelineRuns, pipelineRunDetail } = pipelinesModule as {
    listPipelineRuns: (projectDir: string, opts?: { limit?: number; pipelineId?: string }) => unknown[]
    pipelineRunDetail: (projectDir: string, runId: string) => unknown | null
  }

  const writeEvents = (root: string, events: object[]) => {
    mkdirSync(join(root, '.artel'), { recursive: true })
    writeFileSync(
      join(root, '.artel', 'events.jsonl'),
      events.map((e) => JSON.stringify(e)).join('\n') + '\n',
    )
  }

  const baseEvent = (overrides: object) => ({
    schema: 'v1',
    kind: 'workload',
    id: '01934f00-aaaa-7bbb-8ccc-' + Math.random().toString(16).slice(2, 14).padStart(12, '0'),
    cluster_id: '01934f00-aaaa-7bbb-8ccc-cccccccccccc',
    instance_id: '01934f00-aaaa-7bbb-8ccc-iiiiiiiiiiii',
    fence_token: 0,
    ...overrides,
  })

  it('returns [] when no events.jsonl', () => {
    const root = createTempRepo()
    expect(listPipelineRuns(root)).toEqual([])
  })

  it('joins pipeline_run.started + .ended into one entry per run_id', () => {
    const root = createTempRepo()
    writeEvents(root, [
      baseEvent({ type: 'pipeline_run.started', at: '2026-05-04T10:00:00.000Z',
        pipeline_run_id: 'r1', pipeline_id: 'flow', pipeline_version: 1, entry_node: 'a' }),
      baseEvent({ type: 'pipeline_run.ended', at: '2026-05-04T10:01:30.000Z',
        pipeline_run_id: 'r1', pipeline_id: 'flow', final_state: 'completed',
        last_node: 'done', last_disposition: 'success' }),
    ])
    const runs = listPipelineRuns(root) as Array<{ run_id: string; final_state: string; duration_ms: number }>
    expect(runs).toHaveLength(1)
    expect(runs[0].run_id).toBe('r1')
    expect(runs[0].final_state).toBe('completed')
    expect(runs[0].duration_ms).toBe(90000)
  })

  it('in-flight runs (started, not ended) appear without final_state', () => {
    const root = createTempRepo()
    writeEvents(root, [
      baseEvent({ type: 'pipeline_run.started', at: '2026-05-04T10:00:00.000Z',
        pipeline_run_id: 'r-flying', pipeline_id: 'flow', pipeline_version: 1 }),
    ])
    const runs = listPipelineRuns(root) as Array<{ run_id: string; final_state?: string }>
    expect(runs).toHaveLength(1)
    expect(runs[0].final_state).toBeUndefined()
  })

  it('sorts newest-first', () => {
    const root = createTempRepo()
    writeEvents(root, [
      baseEvent({ type: 'pipeline_run.started', at: '2026-05-04T09:00:00.000Z',
        pipeline_run_id: 'old', pipeline_id: 'flow' }),
      baseEvent({ type: 'pipeline_run.started', at: '2026-05-04T11:00:00.000Z',
        pipeline_run_id: 'new', pipeline_id: 'flow' }),
      baseEvent({ type: 'pipeline_run.started', at: '2026-05-04T10:00:00.000Z',
        pipeline_run_id: 'mid', pipeline_id: 'flow' }),
    ])
    const runs = listPipelineRuns(root) as Array<{ run_id: string }>
    expect(runs.map((r) => r.run_id)).toEqual(['new', 'mid', 'old'])
  })

  it('filters by --pipeline id', () => {
    const root = createTempRepo()
    writeEvents(root, [
      baseEvent({ type: 'pipeline_run.started', at: '2026-05-04T10:00:00.000Z',
        pipeline_run_id: 'r-a', pipeline_id: 'flow-a' }),
      baseEvent({ type: 'pipeline_run.started', at: '2026-05-04T11:00:00.000Z',
        pipeline_run_id: 'r-b', pipeline_id: 'flow-b' }),
    ])
    const runs = listPipelineRuns(root, { pipelineId: 'flow-a' }) as Array<{ run_id: string }>
    expect(runs).toHaveLength(1)
    expect(runs[0].run_id).toBe('r-a')
  })

  it('respects --limit', () => {
    const root = createTempRepo()
    writeEvents(root, [
      baseEvent({ type: 'pipeline_run.started', at: '2026-05-04T10:00:00.000Z', pipeline_run_id: '1', pipeline_id: 'flow' }),
      baseEvent({ type: 'pipeline_run.started', at: '2026-05-04T10:01:00.000Z', pipeline_run_id: '2', pipeline_id: 'flow' }),
      baseEvent({ type: 'pipeline_run.started', at: '2026-05-04T10:02:00.000Z', pipeline_run_id: '3', pipeline_id: 'flow' }),
    ])
    const runs = listPipelineRuns(root, { limit: 2 }) as unknown[]
    expect(runs).toHaveLength(2)
  })

  it('pipelineRunDetail joins dispatch.start/.end via task_attrs.pipeline_run_id', () => {
    const root = createTempRepo()
    writeEvents(root, [
      baseEvent({ type: 'pipeline_run.started', at: '2026-05-04T10:00:00.000Z',
        pipeline_run_id: 'r1', pipeline_id: 'flow', pipeline_version: 1, entry_node: 'a' }),
      baseEvent({ type: 'dispatch.start', at: '2026-05-04T10:00:01.000Z',
        task: 'r1-a', dispatch_id: 'd1', owner_role: 'implementer', engine: 'codex',
        task_attrs: { pipeline_run_id: 'r1', pipeline_id: 'flow', pipeline_node_id: 'a' } }),
      baseEvent({ type: 'dispatch.end', at: '2026-05-04T10:00:30.000Z',
        dispatch_id: 'd1', disposition: 'success',
        task_attrs: { pipeline_run_id: 'r1', pipeline_id: 'flow', pipeline_node_id: 'a' } }),
      baseEvent({ type: 'pipeline_run.ended', at: '2026-05-04T10:01:00.000Z',
        pipeline_run_id: 'r1', pipeline_id: 'flow', final_state: 'completed',
        last_node: 'done', last_disposition: 'success' }),
    ])
    const detail = pipelineRunDetail(root, 'r1') as {
      run_id: string
      final_state: string
      steps: Array<{ node_id: string; disposition: string; role: string }>
    }
    expect(detail.run_id).toBe('r1')
    expect(detail.final_state).toBe('completed')
    expect(detail.steps).toHaveLength(1)
    expect(detail.steps[0]).toMatchObject({
      node_id: 'a', disposition: 'success', role: 'implementer',
    })
  })

  it('pipelineRunDetail surfaces parallel_of for branch dispatches', () => {
    const root = createTempRepo()
    writeEvents(root, [
      baseEvent({ type: 'pipeline_run.started', at: '2026-05-04T10:00:00.000Z',
        pipeline_run_id: 'r1', pipeline_id: 'flow' }),
      baseEvent({ type: 'dispatch.start', at: '2026-05-04T10:00:01.000Z',
        task: 'r1-rev-cr', dispatch_id: 'd1', owner_role: 'cold-reader',
        task_attrs: { pipeline_run_id: 'r1', pipeline_node_id: 'cr', pipeline_parallel_of: 'reviews' } }),
      baseEvent({ type: 'dispatch.end', at: '2026-05-04T10:00:30.000Z',
        dispatch_id: 'd1', disposition: 'success',
        task_attrs: { pipeline_run_id: 'r1', pipeline_node_id: 'cr', pipeline_parallel_of: 'reviews' } }),
    ])
    const detail = pipelineRunDetail(root, 'r1') as {
      steps: Array<{ parallel_of?: string }>
    }
    expect(detail.steps[0].parallel_of).toBe('reviews')
  })

  it('pipelineRunDetail returns null for unknown run id', () => {
    const root = createTempRepo()
    expect(pipelineRunDetail(root, 'nope')).toBeNull()
  })
})

describe('renderTemplate (V3.5)', () => {
  const { renderTemplate } = pipelinesModule as { renderTemplate: (t: unknown, scope: object) => unknown }

  it('passes through strings without templates unchanged', () => {
    expect(renderTemplate('hello world', {})).toBe('hello world')
    expect(renderTemplate('', {})).toBe('')
    expect(renderTemplate('a {b} c', {})).toBe('a {b} c') // single braces left alone
  })

  it('passes through non-strings unchanged', () => {
    expect(renderTemplate(null, {})).toBe(null)
    expect(renderTemplate(undefined, {})).toBe(undefined)
    expect(renderTemplate(42 as unknown as string, {})).toBe(42)
  })

  it('substitutes a single {{ name }} from top-level scope', () => {
    expect(renderTemplate('hi {{ user }}', { user: 'anton' })).toBe('hi anton')
  })

  it('substitutes multiple placeholders in one string', () => {
    expect(renderTemplate('{{ a }} + {{ b }} = {{ c }}', { a: 1, b: 2, c: 3 }))
      .toBe('1 + 2 = 3')
  })

  it('reads dotted paths', () => {
    expect(renderTemplate('target={{ attrs.target }}', { attrs: { target: 'foo' } }))
      .toBe('target=foo')
    expect(renderTemplate('flag={{ a.b.c }}', { a: { b: { c: true } } }))
      .toBe('flag=true')
  })

  it('is whitespace-tolerant', () => {
    expect(renderTemplate('{{user}}', { user: 'x' })).toBe('x')
    expect(renderTemplate('{{ user }}', { user: 'x' })).toBe('x')
    expect(renderTemplate('{{   user   }}', { user: 'x' })).toBe('x')
  })

  it('coerces scalar types to string', () => {
    expect(renderTemplate('{{ n }}', { n: 7 })).toBe('7')
    expect(renderTemplate('{{ b }}', { b: false })).toBe('false')
    expect(renderTemplate('{{ s }}', { s: '' })).toBe('')
  })

  it('throws on missing attribute', () => {
    expect(() => renderTemplate('{{ ghost }}', {}))
      .toThrow(/missing attribute 'ghost'/)
    expect(() => renderTemplate('{{ a.b }}', { a: {} }))
      .toThrow(/missing attribute 'a.b'/)
  })

  it('throws on null/undefined value (fail-fast — no silent "")', () => {
    expect(() => renderTemplate('{{ x }}', { x: null }))
      .toThrow(/missing attribute 'x'/)
    expect(() => renderTemplate('{{ x }}', { x: undefined }))
      .toThrow(/missing attribute 'x'/)
  })

  it('throws on object/array values', () => {
    expect(() => renderTemplate('{{ x }}', { x: { y: 1 } }))
      .toThrow(/cannot substitute object\/array/)
    expect(() => renderTemplate('{{ x }}', { x: [1, 2] }))
      .toThrow(/cannot substitute object\/array/)
  })

  it('mixes pipeline-injected ids and user attrs in the same template', () => {
    const scope = {
      pipeline_id: 'review-flow',
      pipeline_run_id: 'abc123',
      target: 'auth-bug',
    }
    expect(renderTemplate('[{{pipeline_id}} run={{pipeline_run_id}}] impl {{target}}', scope))
      .toBe('[review-flow run=abc123] impl auth-bug')
  })

  it('does not recursively expand substituted values', () => {
    // If `name` resolves to "{{ inner }}" we leave it as a literal —
    // re-rendering would invite infinite-loop bugs.
    expect(renderTemplate('hi {{ name }}', { name: '{{ inner }}', inner: 'x' }))
      .toBe('hi {{ inner }}')
  })
})

describe('loadPipelineFile / listPipelineFiles', () => {
  it('loadPipelineFile parses + validates from disk', () => {
    const root = createTempRepo()
    mkdirSync(join(root, '.artel', 'pipelines'), { recursive: true })
    const path = pipelinePath(root, 'demo')
    writeFileSync(path, JSON.stringify(minimalPipeline()))
    const def = loadPipelineFile(path) as { id: string }
    expect(def.id).toBe('demo')
  })

  it('loadPipelineFile errors clearly on missing / malformed', () => {
    expect(() => loadPipelineFile('/no/such/path.json')).toThrow(/not found/)

    const root = createTempRepo()
    mkdirSync(join(root, '.artel', 'pipelines'), { recursive: true })
    const bad = pipelinePath(root, 'broken')
    writeFileSync(bad, '{ broken json')
    expect(() => loadPipelineFile(bad)).toThrow(/failed to parse/)
  })

  it('listPipelineFiles returns sorted ids; tolerates missing dir', () => {
    const root = createTempRepo()
    expect(listPipelineFiles(root)).toEqual([])

    mkdirSync(pipelinesDir(root), { recursive: true })
    writeFileSync(pipelinePath(root, 'b'), JSON.stringify(minimalPipeline()))
    writeFileSync(pipelinePath(root, 'a'), JSON.stringify({ ...minimalPipeline(), id: 'a' }))
    const ids = listPipelineFiles(root).map((f) => f.id)
    expect(ids).toEqual(['a', 'b'])
  })
})
