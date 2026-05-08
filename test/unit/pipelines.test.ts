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
    def.nodes.fan = { type: 'parallel', branches: ['a', 'b'], join: 'k-of-n' }
    expect(() => validatePipeline(def)).toThrow(/invalid join 'k-of-n'/)
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
