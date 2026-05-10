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

describe('dispatch node timeout_ms validation (V3.9 + V3.9.b)', () => {
  const withTimeout = (timeoutMs: unknown) => {
    const def = minimalPipeline() as Record<string, unknown> & { nodes: Record<string, Record<string, unknown>> }
    def.nodes.first.timeout_ms = timeoutMs
    return def
  }

  it('accepts a positive finite number', () => {
    expect(() => validatePipeline(withTimeout(60000))).not.toThrow()
    expect(() => validatePipeline(withTimeout(1))).not.toThrow()
  })

  it('accepts string with suffix ms / s / m / h / d (V3.9.b)', () => {
    for (const v of ['500ms', '60s', '5m', '2h', '1d', '60', '60000']) {
      expect(() => validatePipeline(withTimeout(v))).not.toThrow()
    }
    // Whitespace tolerance.
    expect(() => validatePipeline(withTimeout(' 60s '))).not.toThrow()
  })

  it('accepts dispatch node without timeout_ms (back-compat)', () => {
    expect(() => validatePipeline(minimalPipeline())).not.toThrow()
  })

  it('rejects zero / negative timeout_ms', () => {
    expect(() => validatePipeline(withTimeout(0))).toThrow(
      /\.timeout_ms must be a positive integer ms or string with suffix/,
    )
    expect(() => validatePipeline(withTimeout(-1000))).toThrow(
      /\.timeout_ms must be a positive integer ms or string with suffix/,
    )
  })

  it('rejects malformed strings + Infinity + NaN', () => {
    for (const v of ['invalid', '60x', '60 sec', '5 m', '-60s', '0s']) {
      expect(() => validatePipeline(withTimeout(v))).toThrow(
        /\.timeout_ms must be a positive integer ms or string with suffix/,
      )
    }
    expect(() => validatePipeline(withTimeout(Infinity))).toThrow(
      /\.timeout_ms must be a positive integer ms or string with suffix/,
    )
    expect(() => validatePipeline(withTimeout(NaN))).toThrow(
      /\.timeout_ms must be a positive integer ms or string with suffix/,
    )
  })

  it('null / undefined treated as absent (no validation error)', () => {
    expect(() => validatePipeline(withTimeout(null))).not.toThrow()
    expect(() => validatePipeline(withTimeout(undefined))).not.toThrow()
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

  it('rejects nested parallel as branch (V3.2.a → V3.7.e: only dispatch / handler allowed)', () => {
    const def = withParallel() as Record<string, unknown> & { nodes: Record<string, unknown> }
    def.nodes.nested = { type: 'parallel', branches: ['a'], join: 'all-complete' }
    def.nodes.fan = { type: 'parallel', branches: ['a', 'nested'], join: 'all-complete' }
    expect(() => validatePipeline(def)).toThrow(/branch 'nested' must be a dispatch or handler node \(got: parallel\)/)
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

describe('condition predicate vocabulary (V3.6) — compounds + comparisons', () => {
  const { evaluatePredicate } = pipelinesModule as { evaluatePredicate: (p: object | null, attrs: object) => boolean }

  // Validator coverage — registered through validatePipeline so we
  // catch shape errors with full context messages.
  const wrap = (predicate: object) => ({
    id: 'gated', version: 1, entry: 'gate',
    nodes: {
      gate: { type: 'condition', if: predicate, then: 'done', else: 'done' },
      done: { type: 'terminal', final_state: 'completed' },
    },
    edges: [],
  })

  describe('validator (compounds)', () => {
    it('accepts not / and / or shapes', () => {
      expect(() => validatePipeline(wrap({ not: { attr: 'x', equals: 1 } }))).not.toThrow()
      expect(() => validatePipeline(wrap({
        and: [{ attr: 'x', equals: 1 }, { attr: 'y', equals: 2 }],
      }))).not.toThrow()
      expect(() => validatePipeline(wrap({
        or: [{ attr: 'x', equals: 1 }, { attr: 'y', exists: true }],
      }))).not.toThrow()
    })

    it('rejects empty and/or arrays', () => {
      expect(() => validatePipeline(wrap({ and: [] }))).toThrow(/\.if\.and must be a non-empty array/)
      expect(() => validatePipeline(wrap({ or: [] }))).toThrow(/\.if\.or must be a non-empty array/)
    })

    it('rejects compound mixed with atomic op or attr', () => {
      expect(() => validatePipeline(wrap({ and: [{ attr: 'x', equals: 1 }], attr: 'y' })))
        .toThrow(/compound predicate must not mix/)
      expect(() => validatePipeline(wrap({ not: { attr: 'x', equals: 1 }, equals: 2 })))
        .toThrow(/compound predicate must not mix/)
    })

    it('rejects multiple compound ops in one predicate', () => {
      expect(() => validatePipeline(wrap({
        and: [{ attr: 'x', equals: 1 }],
        or: [{ attr: 'y', equals: 2 }],
      }))).toThrow(/exactly one of not | and | or/)
    })

    it('rejects non-array body for and/or', () => {
      expect(() => validatePipeline(wrap({ and: { attr: 'x', equals: 1 } as never })))
        .toThrow(/must be a non-empty array/)
    })

    it('recurses into nested compounds', () => {
      // Deeply nested but well-formed.
      expect(() => validatePipeline(wrap({
        and: [
          { not: { attr: 'a', equals: 1 } },
          { or: [{ attr: 'b', exists: true }, { attr: 'c', gt: 5 }] },
        ],
      }))).not.toThrow()

      // Bad nested predicate (missing op) — error should pinpoint
      // the path so the operator can find it.
      expect(() => validatePipeline(wrap({
        and: [{ attr: 'a', equals: 1 }, { attr: 'b' }],
      }))).toThrow(/\.if\.and\[1\] must specify exactly one/)
    })

    it('rejects non-object predicate (string, number, array)', () => {
      expect(() => validatePipeline(wrap('xx' as never))).toThrow(/predicate object/)
      expect(() => validatePipeline(wrap([{ attr: 'x', equals: 1 }] as never))).toThrow(/predicate object/)
    })
  })

  describe('validator (comparisons)', () => {
    it('accepts gt / gte / lt / lte with numeric values', () => {
      for (const op of ['gt', 'gte', 'lt', 'lte']) {
        expect(() => validatePipeline(wrap({ attr: 'x', [op]: 7 }))).not.toThrow()
      }
    })

    it('rejects gt / gte / lt / lte with non-numeric values', () => {
      for (const op of ['gt', 'gte', 'lt', 'lte']) {
        expect(() => validatePipeline(wrap({ attr: 'x', [op]: 'seven' })))
          .toThrow(new RegExp(`\\.if\\.${op} must be a number`))
      }
    })

    it('accepts ne with any value', () => {
      expect(() => validatePipeline(wrap({ attr: 'x', ne: 'staging' }))).not.toThrow()
      expect(() => validatePipeline(wrap({ attr: 'x', ne: false }))).not.toThrow()
      expect(() => validatePipeline(wrap({ attr: 'x', ne: null }))).not.toThrow()
    })
  })

  describe('evaluator (compounds)', () => {
    it('not negates the inner predicate', () => {
      expect(evaluatePredicate({ not: { attr: 'x', equals: 1 } }, { x: 1 })).toBe(false)
      expect(evaluatePredicate({ not: { attr: 'x', equals: 1 } }, { x: 2 })).toBe(true)
    })

    it('and is true iff every branch is true (short-circuit)', () => {
      const p = { and: [{ attr: 'x', equals: 1 }, { attr: 'y', exists: true }] }
      expect(evaluatePredicate(p, { x: 1, y: 'something' })).toBe(true)
      expect(evaluatePredicate(p, { x: 1 })).toBe(false)
      expect(evaluatePredicate(p, { x: 2, y: 'something' })).toBe(false)
    })

    it('or is true iff any branch is true (short-circuit)', () => {
      const p = { or: [{ attr: 'x', equals: 1 }, { attr: 'y', exists: true }] }
      expect(evaluatePredicate(p, { x: 1 })).toBe(true)
      expect(evaluatePredicate(p, { y: 'something' })).toBe(true)
      expect(evaluatePredicate(p, {})).toBe(false)
    })

    it('compounds nest', () => {
      const p = {
        and: [
          { not: { attr: 'cancelled', exists: true } },
          { or: [{ attr: 'env', equals: 'prod' }, { attr: 'force', equals: true }] },
        ],
      }
      expect(evaluatePredicate(p, { env: 'prod' })).toBe(true)
      expect(evaluatePredicate(p, { force: true })).toBe(true)
      expect(evaluatePredicate(p, { env: 'dev' })).toBe(false)
      expect(evaluatePredicate(p, { env: 'prod', cancelled: true })).toBe(false)
    })
  })

  describe('evaluator (comparisons + ne)', () => {
    it('gt/gte/lt/lte compare numbers', () => {
      expect(evaluatePredicate({ attr: 'n', gt: 5 }, { n: 6 })).toBe(true)
      expect(evaluatePredicate({ attr: 'n', gt: 5 }, { n: 5 })).toBe(false)
      expect(evaluatePredicate({ attr: 'n', gte: 5 }, { n: 5 })).toBe(true)
      expect(evaluatePredicate({ attr: 'n', lt: 10 }, { n: 9 })).toBe(true)
      expect(evaluatePredicate({ attr: 'n', lte: 10 }, { n: 10 })).toBe(true)
    })

    it('comparisons fail-closed on non-numeric / missing attr', () => {
      // missing
      expect(evaluatePredicate({ attr: 'n', gt: 5 }, {})).toBe(false)
      // string in numeric slot
      expect(evaluatePredicate({ attr: 'n', gt: 5 }, { n: '6' })).toBe(false)
      // null
      expect(evaluatePredicate({ attr: 'n', lt: 10 }, { n: null })).toBe(false)
    })

    it('ne is strict !==', () => {
      expect(evaluatePredicate({ attr: 'env', ne: 'prod' }, { env: 'staging' })).toBe(true)
      expect(evaluatePredicate({ attr: 'env', ne: 'prod' }, { env: 'prod' })).toBe(false)
      // missing → undefined !== 'prod' → true
      expect(evaluatePredicate({ attr: 'env', ne: 'prod' }, {})).toBe(true)
      // type-strict — number 1 !== string '1'
      expect(evaluatePredicate({ attr: 'x', ne: 1 }, { x: '1' })).toBe(true)
    })
  })
})

describe('handler node validation (V3.7.a)', () => {
  const withHandler = (handlerNode: object) => ({
    id: 'flow', version: 1, entry: 'h',
    nodes: {
      h: handlerNode,
      done: { type: 'terminal', final_state: 'completed' },
    },
    edges: [
      { from: 'h', on_disposition: 'success', to: 'done' },
      { from: 'h', on_disposition: '*', to: 'done' },
    ],
  })

  it('accepts a well-formed builtin.exec handler', () => {
    expect(() => validatePipeline(withHandler({
      type: 'handler', handler: 'builtin.exec', cmd: 'true',
    }))).not.toThrow()
  })

  it('accepts builtin.exec with timeout_ms', () => {
    expect(() => validatePipeline(withHandler({
      type: 'handler', handler: 'builtin.exec', cmd: 'sleep 1', timeout_ms: 5000,
    }))).not.toThrow()
  })

  it('rejects handler node with no .handler field', () => {
    expect(() => validatePipeline(withHandler({ type: 'handler' })))
      .toThrow(/\.handler must be a non-empty string/)
  })

  it('rejects unknown handler builtin', () => {
    expect(() => validatePipeline(withHandler({
      type: 'handler', handler: 'builtin.ghost', cmd: 'true',
    }))).toThrow(/'builtin\.ghost' is not a known builtin/)
  })

  it('rejects builtin.exec without cmd', () => {
    expect(() => validatePipeline(withHandler({
      type: 'handler', handler: 'builtin.exec',
    }))).toThrow(/requires \.cmd as a non-empty string/)
  })

  it('rejects builtin.exec with empty / whitespace cmd', () => {
    expect(() => validatePipeline(withHandler({
      type: 'handler', handler: 'builtin.exec', cmd: '   ',
    }))).toThrow(/requires \.cmd as a non-empty string/)
  })

  it('rejects builtin.exec with non-positive timeout_ms', () => {
    expect(() => validatePipeline(withHandler({
      type: 'handler', handler: 'builtin.exec', cmd: 'true', timeout_ms: 0,
    }))).toThrow(/\.timeout_ms must be a positive integer ms or string with suffix/)
    expect(() => validatePipeline(withHandler({
      type: 'handler', handler: 'builtin.exec', cmd: 'true', timeout_ms: -100,
    }))).toThrow(/\.timeout_ms must be a positive integer ms or string with suffix/)
    expect(() => validatePipeline(withHandler({
      type: 'handler', handler: 'builtin.exec', cmd: 'true', timeout_ms: 'soon' as never,
    }))).toThrow(/\.timeout_ms must be a positive integer ms or string with suffix/)
  })

  it('handler nodes participate in reachability', () => {
    // Pipeline: entry h (handler) → done (terminal). Without handler
    // being recognised by the type validator, the validator would
    // reject; without edge-following, no terminal would be reachable.
    expect(() => validatePipeline(withHandler({
      type: 'handler', handler: 'builtin.exec', cmd: 'true',
    }))).not.toThrow()
  })

  it('accepts a well-formed builtin.assert handler', () => {
    expect(() => validatePipeline(withHandler({
      type: 'handler', handler: 'builtin.assert',
      if: { attr: 'env', equals: 'prod' },
    }))).not.toThrow()
  })

  it('accepts builtin.assert with compound predicate + message', () => {
    expect(() => validatePipeline(withHandler({
      type: 'handler', handler: 'builtin.assert',
      if: { and: [{ attr: 'env', equals: 'prod' }, { attr: 'approved', equals: true }] },
      message: 'deploy {{ target }} requires approval',
    }))).not.toThrow()
  })

  it('rejects builtin.assert without .if', () => {
    expect(() => validatePipeline(withHandler({
      type: 'handler', handler: 'builtin.assert',
    }))).toThrow(/requires an \.if predicate object/)
  })

  it('rejects builtin.assert with malformed nested predicate (path-aware)', () => {
    expect(() => validatePipeline(withHandler({
      type: 'handler', handler: 'builtin.assert',
      if: { and: [{ attr: 'x', equals: 1 }, { attr: 'y' /* no op */ }] },
    }))).toThrow(/\.if\.and\[1\] must specify exactly one/)
  })

  it('rejects builtin.assert with non-string message', () => {
    expect(() => validatePipeline(withHandler({
      type: 'handler', handler: 'builtin.assert',
      if: { attr: 'x', equals: 1 },
      message: 42,
    }))).toThrow(/\.message must be a string/)
  })

  it('accepts a well-formed builtin.set_attr handler', () => {
    expect(() => validatePipeline(withHandler({
      type: 'handler', handler: 'builtin.set_attr',
      set: { phase: 'reviewed', count: 7, paused: false, last_error: null },
    }))).not.toThrow()
  })

  it('rejects builtin.set_attr without .set and .unset', () => {
    expect(() => validatePipeline(withHandler({
      type: 'handler', handler: 'builtin.set_attr',
    }))).toThrow(/requires \.set and\/or \.unset/)
  })

  it('rejects builtin.set_attr with empty .set and no .unset', () => {
    expect(() => validatePipeline(withHandler({
      type: 'handler', handler: 'builtin.set_attr', set: {},
    }))).toThrow(/\.set must be non-empty.*or supply \.unset/)
  })

  it('rejects builtin.set_attr with array .set', () => {
    expect(() => validatePipeline(withHandler({
      type: 'handler', handler: 'builtin.set_attr',
      set: [{ k: 'v' }],
    }))).toThrow(/requires \.set as an object/)
  })

  it('rejects builtin.set_attr with object value', () => {
    expect(() => validatePipeline(withHandler({
      type: 'handler', handler: 'builtin.set_attr',
      set: { nested: { foo: 'bar' } },
    }))).toThrow(/\.set\['nested'\] must be a scalar.*got: object/)
  })

  it('rejects builtin.set_attr with array value', () => {
    expect(() => validatePipeline(withHandler({
      type: 'handler', handler: 'builtin.set_attr',
      set: { tags: ['a', 'b'] },
    }))).toThrow(/\.set\['tags'\] must be a scalar.*got: array/)
  })

  it('rejects builtin.set_attr overriding pipeline-injected keys', () => {
    expect(() => validatePipeline(withHandler({
      type: 'handler', handler: 'builtin.set_attr',
      set: { pipeline_run_id: 'spoof' },
    }))).toThrow(/cannot override pipeline-injected key 'pipeline_run_id'/)
  })

  it('accepts dotted-path keys in .set (V3.7.d.b)', () => {
    expect(() => validatePipeline(withHandler({
      type: 'handler', handler: 'builtin.set_attr',
      set: { 'flags.deployed': true, 'config.timeout.ms': 30000 },
    }))).not.toThrow()
  })

  it('accepts .unset (V3.7.d.b) without .set', () => {
    expect(() => validatePipeline(withHandler({
      type: 'handler', handler: 'builtin.set_attr',
      unset: ['phase', 'flags.staged'],
    }))).not.toThrow()
  })

  it('accepts both .set and .unset together (V3.7.d.b)', () => {
    expect(() => validatePipeline(withHandler({
      type: 'handler', handler: 'builtin.set_attr',
      set: { phase: 'deployed' },
      unset: ['flags.staged'],
    }))).not.toThrow()
  })

  it('rejects empty .unset array (V3.7.d.b)', () => {
    expect(() => validatePipeline(withHandler({
      type: 'handler', handler: 'builtin.set_attr',
      unset: [],
    }))).toThrow(/\.unset must be a non-empty array/)
  })

  it('rejects non-string entries in .unset (V3.7.d.b)', () => {
    expect(() => validatePipeline(withHandler({
      type: 'handler', handler: 'builtin.set_attr',
      unset: ['phase', 42 as never],
    }))).toThrow(/\.unset entries must be non-empty strings/)
  })

  it('rejects .unset removing pipeline-injected key (V3.7.d.b)', () => {
    expect(() => validatePipeline(withHandler({
      type: 'handler', handler: 'builtin.set_attr',
      unset: ['pipeline_run_id'],
    }))).toThrow(/\.unset cannot remove pipeline-injected key 'pipeline_run_id'/)
  })

  it('accepts a well-formed builtin.git_tag (annotated, V3.7.f)', () => {
    expect(() => validatePipeline(withHandler({
      type: 'handler', handler: 'builtin.git_tag',
      name: 'v1.0', message: 'release 1.0',
    }))).not.toThrow()
  })

  it('accepts builtin.git_tag with lightweight: true and no message', () => {
    expect(() => validatePipeline(withHandler({
      type: 'handler', handler: 'builtin.git_tag',
      name: 'v1.0', lightweight: true,
    }))).not.toThrow()
  })

  it('accepts builtin.git_tag with optional target', () => {
    expect(() => validatePipeline(withHandler({
      type: 'handler', handler: 'builtin.git_tag',
      name: 'v1.0', message: 'r', target: 'main',
    }))).not.toThrow()
  })

  it('rejects builtin.git_tag without name', () => {
    expect(() => validatePipeline(withHandler({
      type: 'handler', handler: 'builtin.git_tag', message: 'r',
    }))).toThrow(/requires \.name as a non-empty string/)
  })

  it('rejects builtin.git_tag without message and without lightweight', () => {
    expect(() => validatePipeline(withHandler({
      type: 'handler', handler: 'builtin.git_tag', name: 'v1.0',
    }))).toThrow(/requires \.message as a non-empty string \(or set \.lightweight: true\)/)
  })

  it('rejects builtin.git_tag with non-boolean lightweight', () => {
    expect(() => validatePipeline(withHandler({
      type: 'handler', handler: 'builtin.git_tag',
      name: 'v', message: 'r', lightweight: 'yes' as never,
    }))).toThrow(/\.lightweight must be a boolean/)
  })

  it('rejects builtin.git_tag with empty target', () => {
    expect(() => validatePipeline(withHandler({
      type: 'handler', handler: 'builtin.git_tag',
      name: 'v', message: 'r', target: '',
    }))).toThrow(/\.target must be a non-empty string when set/)
  })

  it('rejects dotted .set whose top segment is reserved (V3.7.d.b)', () => {
    expect(() => validatePipeline(withHandler({
      type: 'handler', handler: 'builtin.set_attr',
      set: { 'pipeline_run_id.fake': 'x' },
    }))).toThrow(/cannot override pipeline-injected key 'pipeline_run_id'/)
  })

  it('handler.exec + handler.assert allowed as parallel branches (V3.7.e)', () => {
    const def = {
      id: 'mix', version: 1, entry: 'fan',
      nodes: {
        fan: { type: 'parallel', branches: ['h_exec', 'h_assert', 'd'], join: 'all-complete' },
        h_exec: { type: 'handler', handler: 'builtin.exec', cmd: 'true' },
        h_assert: { type: 'handler', handler: 'builtin.assert', if: { attr: 'env', equals: 'prod' } },
        d: { type: 'dispatch', role: 'implementer', prompt: 'go' },
        done: { type: 'terminal', final_state: 'completed' },
      },
      edges: [
        { from: 'fan', on_disposition: 'success', to: 'done' },
        { from: 'fan', on_disposition: '*', to: 'done' },
      ],
    }
    expect(() => validatePipeline(def)).not.toThrow()
  })

  it('builtin.set_attr still rejected as a parallel branch (V3.7.e — race on shared userAttrs)', () => {
    const def = {
      id: 'racy', version: 1, entry: 'fan',
      nodes: {
        fan: { type: 'parallel', branches: ['h_set'], join: 'all-complete' },
        h_set: { type: 'handler', handler: 'builtin.set_attr', set: { phase: 'reviewed' } },
        done: { type: 'terminal', final_state: 'completed' },
      },
      edges: [
        { from: 'fan', on_disposition: 'success', to: 'done' },
        { from: 'fan', on_disposition: '*', to: 'done' },
      ],
    }
    expect(() => validatePipeline(def)).toThrow(/builtin\.set_attr handler — disallowed in parallel branches/)
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

  // V3.7.b — pipelineRunDetail joins handler events alongside
  // dispatches, tagging each step with `kind`. Handler steps carry
  // handler_id / handler / cmd / exit_code instead of dispatch_id /
  // task / role / engine.
  it('pipelineRunDetail joins handler start/end into steps with kind=handler', () => {
    const root = createTempRepo()
    writeEvents(root, [
      baseEvent({ type: 'pipeline_run.started', at: '2026-05-08T10:00:00.000Z',
        pipeline_run_id: 'rh', pipeline_id: 'h-flow', pipeline_version: 1, entry_node: 'h' }),
      baseEvent({ type: 'pipeline_handler.start', at: '2026-05-08T10:00:01.000Z',
        handler_id: 'h1', handler: 'builtin.exec',
        pipeline_run_id: 'rh', pipeline_id: 'h-flow', pipeline_node_id: 'h',
        cmd: 'npm test', timeout_ms: 60000 }),
      baseEvent({ type: 'pipeline_handler.end', at: '2026-05-08T10:00:05.000Z',
        handler_id: 'h1', handler: 'builtin.exec',
        pipeline_run_id: 'rh', pipeline_id: 'h-flow', pipeline_node_id: 'h',
        disposition: 'success', exit_code: 0, signal: null, duration_ms: 4000 }),
      baseEvent({ type: 'pipeline_run.ended', at: '2026-05-08T10:00:06.000Z',
        pipeline_run_id: 'rh', pipeline_id: 'h-flow', final_state: 'completed',
        last_node: 'done', last_disposition: 'success' }),
    ])
    const detail = pipelineRunDetail(root, 'rh') as {
      steps: Array<{ kind: string; node_id: string; handler: string; cmd: string;
        disposition: string; exit_code: number; duration_ms: number }>
    }
    expect(detail.steps).toHaveLength(1)
    expect(detail.steps[0]).toMatchObject({
      kind: 'handler',
      node_id: 'h',
      handler: 'builtin.exec',
      cmd: 'npm test',
      disposition: 'success',
      exit_code: 0,
      duration_ms: 4000,
    })
  })

  it('pipelineRunDetail interleaves handler + dispatch steps by start time', () => {
    const root = createTempRepo()
    writeEvents(root, [
      baseEvent({ type: 'pipeline_run.started', at: '2026-05-08T10:00:00.000Z',
        pipeline_run_id: 'mix', pipeline_id: 'mix-flow' }),
      // handler runs first
      baseEvent({ type: 'pipeline_handler.start', at: '2026-05-08T10:00:01.000Z',
        handler_id: 'h1', handler: 'builtin.exec',
        pipeline_run_id: 'mix', pipeline_node_id: 'pre', cmd: 'true' }),
      baseEvent({ type: 'pipeline_handler.end', at: '2026-05-08T10:00:02.000Z',
        handler_id: 'h1', handler: 'builtin.exec',
        pipeline_run_id: 'mix', pipeline_node_id: 'pre',
        disposition: 'success', exit_code: 0 }),
      // dispatch runs second
      baseEvent({ type: 'dispatch.start', at: '2026-05-08T10:00:03.000Z',
        task: 'mix-impl', dispatch_id: 'd1', owner_role: 'implementer', engine: 'claude',
        task_attrs: { pipeline_run_id: 'mix', pipeline_node_id: 'impl' } }),
      baseEvent({ type: 'dispatch.end', at: '2026-05-08T10:00:30.000Z',
        dispatch_id: 'd1', disposition: 'success',
        task_attrs: { pipeline_run_id: 'mix', pipeline_node_id: 'impl' } }),
    ])
    const detail = pipelineRunDetail(root, 'mix') as {
      steps: Array<{ kind: string; node_id: string }>
    }
    expect(detail.steps).toHaveLength(2)
    expect(detail.steps.map((s) => [s.kind, s.node_id])).toEqual([
      ['handler', 'pre'],
      ['dispatch', 'impl'],
    ])
  })

  it('pipelineRunDetail handler step propagates exit_code / signal / error / timeout_ms', () => {
    const root = createTempRepo()
    writeEvents(root, [
      baseEvent({ type: 'pipeline_run.started', at: '2026-05-08T10:00:00.000Z',
        pipeline_run_id: 'tmo', pipeline_id: 'tmo-flow' }),
      baseEvent({ type: 'pipeline_handler.start', at: '2026-05-08T10:00:01.000Z',
        handler_id: 'h1', handler: 'builtin.exec',
        pipeline_run_id: 'tmo', pipeline_node_id: 'long',
        cmd: 'sleep 30', timeout_ms: 100 }),
      baseEvent({ type: 'pipeline_handler.end', at: '2026-05-08T10:00:02.000Z',
        handler_id: 'h1', handler: 'builtin.exec',
        pipeline_run_id: 'tmo', pipeline_node_id: 'long',
        disposition: 'timeout', exit_code: null, signal: 'SIGTERM',
        duration_ms: 100 }),
    ])
    const detail = pipelineRunDetail(root, 'tmo') as {
      steps: Array<{ disposition: string; signal: string; timeout_ms: number; exit_code: null }>
    }
    expect(detail.steps[0].disposition).toBe('timeout')
    expect(detail.steps[0].signal).toBe('SIGTERM')
    expect(detail.steps[0].timeout_ms).toBe(100)
  })
})

describe('writePath / deletePath / deepMergeAttrs (V3.7.d.b)', () => {
  const { writePath, deletePath, deepMergeAttrs } = pipelinesModule as {
    writePath: (obj: Record<string, unknown>, path: string, value: unknown) => void
    deletePath: (obj: Record<string, unknown>, path: string) => void
    deepMergeAttrs: (target: Record<string, unknown>, source: Record<string, unknown>) => Record<string, unknown>
  }

  describe('writePath', () => {
    it('writes top-level keys', () => {
      const obj = {} as Record<string, unknown>
      writePath(obj, 'phase', 'reviewed')
      expect(obj).toEqual({ phase: 'reviewed' })
    })

    it('creates intermediate objects for nested paths', () => {
      const obj = {} as Record<string, unknown>
      writePath(obj, 'flags.deployed', true)
      expect(obj).toEqual({ flags: { deployed: true } })

      writePath(obj, 'config.timeout.ms', 30000)
      expect(obj).toEqual({
        flags: { deployed: true },
        config: { timeout: { ms: 30000 } },
      })
    })

    it('preserves siblings under shared top key', () => {
      const obj = { flags: { staged: true } } as Record<string, unknown>
      writePath(obj, 'flags.deployed', true)
      expect(obj).toEqual({ flags: { staged: true, deployed: true } })
    })

    it('overwrites scalar/array intermediate with fresh object', () => {
      const obj = { flags: 'broken' } as Record<string, unknown>
      writePath(obj, 'flags.deployed', true)
      expect(obj).toEqual({ flags: { deployed: true } })

      const arr = { tags: ['a', 'b'] } as Record<string, unknown>
      writePath(arr, 'tags.first', 'x')
      expect(arr).toEqual({ tags: { first: 'x' } })
    })

    it('overwrites a leaf value', () => {
      const obj = { phase: 'reviewing' } as Record<string, unknown>
      writePath(obj, 'phase', 'reviewed')
      expect(obj.phase).toBe('reviewed')
    })
  })

  describe('deletePath', () => {
    it('removes a top-level key', () => {
      const obj = { phase: 'reviewed', count: 7 } as Record<string, unknown>
      deletePath(obj, 'phase')
      expect(obj).toEqual({ count: 7 })
    })

    it('removes a nested key without disturbing siblings', () => {
      const obj = { flags: { staged: true, deployed: true } } as Record<string, unknown>
      deletePath(obj, 'flags.staged')
      expect(obj).toEqual({ flags: { deployed: true } })
    })

    it('no-ops when an intermediate is missing', () => {
      const obj = { phase: 'x' } as Record<string, unknown>
      expect(() => deletePath(obj, 'flags.deployed')).not.toThrow()
      expect(obj).toEqual({ phase: 'x' })
    })

    it('no-ops on missing leaf', () => {
      const obj = { flags: { staged: true } } as Record<string, unknown>
      deletePath(obj, 'flags.missing')
      expect(obj).toEqual({ flags: { staged: true } })
    })
  })

  describe('deepMergeAttrs', () => {
    it('shallow merges flat objects (back-compat with V3.7.d)', () => {
      const t = { phase: 'old' } as Record<string, unknown>
      deepMergeAttrs(t, { phase: 'new', count: 5 })
      expect(t).toEqual({ phase: 'new', count: 5 })
    })

    it('preserves siblings under shared nested key', () => {
      const t = { flags: { staged: true } } as Record<string, unknown>
      deepMergeAttrs(t, { flags: { deployed: true } })
      expect(t).toEqual({ flags: { staged: true, deployed: true } })
    })

    it('overwrites arrays (no concat)', () => {
      const t = { tags: ['a', 'b'] } as Record<string, unknown>
      deepMergeAttrs(t, { tags: ['c'] })
      expect(t).toEqual({ tags: ['c'] })
    })

    it('overwrites scalars with objects when source nests', () => {
      const t = { flags: false } as Record<string, unknown>
      deepMergeAttrs(t, { flags: { deployed: true } })
      expect(t).toEqual({ flags: { deployed: true } })
    })

    it('returns the target for chaining', () => {
      const t = {} as Record<string, unknown>
      const r = deepMergeAttrs(t, { x: 1 })
      expect(r).toBe(t)
    })
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
