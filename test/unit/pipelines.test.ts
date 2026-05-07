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
    def.nodes.first = { type: 'parallel' as 'dispatch', role: 'r', prompt: 'p' }
    expect(() => validatePipeline(def)).toThrow(/invalid type 'parallel'/)
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
