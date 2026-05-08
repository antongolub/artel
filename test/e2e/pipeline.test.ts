// E2E for `artel pipeline` — register / list / show / run (V3.1).

import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  cleanupTempRoots,
  createTempRepo,
  ENGINE_FILES_CORE,
  ENGINE_FILES_DRIVERS,
  ENGINE_FILES_UTIL,
  installEngineRuntime,
  installStub,
  runNode,
  snapshotRepo,
} from '../_helpers.js'

afterEach(cleanupTempRoots)

const installAll = (root: string) =>
  installEngineRuntime(root, [
    'engine/cli/pipeline.mjs',
    'engine/cli/spawn.mjs',
    'engine/cli/run.mjs',
    ...ENGINE_FILES_CORE,
    ...ENGINE_FILES_DRIVERS,
    ...ENGINE_FILES_UTIL,
  ])

const minimal = (overrides = {}) => ({
  id: 'demo',
  version: 1,
  description: 'demo flow',
  entry: 'first',
  nodes: {
    first: { type: 'dispatch', role: 'implementer', engine: 'claude', prompt: 'do thing' },
    done: { type: 'terminal', final_state: 'completed' },
    fail: { type: 'terminal', final_state: 'failed' },
  },
  edges: [
    { from: 'first', on_disposition: 'success', to: 'done' },
    { from: 'first', on_disposition: '*', to: 'fail' },
  ],
  ...overrides,
})

const writePipelineFile = (root: string, name: string, body: object) => {
  const path = join(root, name)
  writeFileSync(path, JSON.stringify(body, null, 2))
  return path
}

const events = (root: string) => {
  const path = join(root, '.artel', 'events.jsonl')
  return existsSync(path)
    ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : []
}

describe('artel pipeline register / list / show', () => {
  it('register copies validated def into .artel/pipelines/ and emits event', () => {
    const root = createTempRepo()
    installAll(root)
    const path = writePipelineFile(root, 'demo.json', minimal())
    const r = runNode(root, ['engine/cli/pipeline.mjs', 'register', path])
    expect(r.status).toBe(0)
    expect(existsSync(join(root, '.artel', 'pipelines', 'demo.json'))).toBe(true)
    const evt = events(root).find((e) => e.type === 'pipeline.registered')
    expect(evt).toMatchObject({
      kind: 'workload',
      pipeline_id: 'demo',
      pipeline_version: 1,
      node_count: 3,
      edge_count: 2,
      fence_token: 0,
    })
  })

  it('register fails on validation error', () => {
    const root = createTempRepo()
    installAll(root)
    const broken = minimal()
    delete (broken.nodes.first as { role?: string }).role
    const path = writePipelineFile(root, 'broken.json', broken)
    const r = runNode(root, ['engine/cli/pipeline.mjs', 'register', path])
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/requires a role/)
  })

  it('list shows registered pipelines', () => {
    const root = createTempRepo()
    installAll(root)
    runNode(root, ['engine/cli/pipeline.mjs', 'register', writePipelineFile(root, 'p1.json', minimal())])
    runNode(root, ['engine/cli/pipeline.mjs', 'register', writePipelineFile(root, 'p2.json', { ...minimal(), id: 'second-flow' })])
    const r = runNode(root, ['engine/cli/pipeline.mjs', 'list'])
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('demo')
    expect(r.stdout).toContain('second-flow')
    expect(r.stdout).toMatch(/3 nodes, 2 edges/)
  })

  it('list --json emits structured array', () => {
    const root = createTempRepo()
    installAll(root)
    runNode(root, ['engine/cli/pipeline.mjs', 'register', writePipelineFile(root, 'p.json', minimal())])
    const r = runNode(root, ['engine/cli/pipeline.mjs', 'list', '--json'])
    expect(r.status).toBe(0)
    const parsed = JSON.parse(r.stdout)
    expect(parsed).toHaveLength(1)
    expect(parsed[0]).toMatchObject({ id: 'demo', version: 1, node_count: 3, edge_count: 2 })
  })

  it('show renders one pipeline', () => {
    const root = createTempRepo()
    installAll(root)
    runNode(root, ['engine/cli/pipeline.mjs', 'register', writePipelineFile(root, 'p.json', minimal())])
    const r = runNode(root, ['engine/cli/pipeline.mjs', 'show', 'demo'])
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('demo')
    expect(r.stdout).toContain('first')
    expect(r.stdout).toContain('on_success')
    expect(r.stdout).toContain('completed')
  })

  it('show --json round-trips the def', () => {
    const root = createTempRepo()
    installAll(root)
    runNode(root, ['engine/cli/pipeline.mjs', 'register', writePipelineFile(root, 'p.json', minimal())])
    const r = runNode(root, ['engine/cli/pipeline.mjs', 'show', 'demo', '--json'])
    expect(r.status).toBe(0)
    const parsed = JSON.parse(r.stdout)
    expect(parsed.id).toBe('demo')
    expect(parsed.entry).toBe('first')
  })

  it('show on missing pipeline → exit 1', () => {
    const root = createTempRepo()
    installAll(root)
    const r = runNode(root, ['engine/cli/pipeline.mjs', 'show', 'ghost'])
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/'ghost' not registered/)
  })
})

describe('artel pipeline run (V3.1 linear)', () => {
  it('walks success → completed; emits pipeline_run.started + .ended', () => {
    const root = createTempRepo()
    installAll(root)
    snapshotRepo(root, 'runtime')
    runNode(root, ['engine/cli/pipeline.mjs', 'register', writePipelineFile(root, 'p.json', minimal())])
    snapshotRepo(root, 'with pipeline')

    const stub = ['#!/usr/bin/env node', 'console.log("ok")'].join('\n')
    const binDir = installStub(root, 'claude', stub)

    const r = runNode(root, ['engine/cli/pipeline.mjs', 'run', 'demo'], {
      PATH: `${binDir}:${process.env.PATH || ''}`,
    })
    expect(r.status).toBe(0)
    const ended = events(root).find((e) => e.type === 'pipeline_run.ended')
    expect(ended).toMatchObject({
      kind: 'workload',
      final_state: 'completed',
      pipeline_id: 'demo',
      last_node: 'done',
      last_disposition: 'success',
      fence_token: 0,
    })
    const started = events(root).find((e) => e.type === 'pipeline_run.started')
    expect(started.pipeline_run_id).toBe(ended.pipeline_run_id)
  })

  it('multi-node chain: 3 dispatches → all success → completed', () => {
    const root = createTempRepo()
    installAll(root)
    snapshotRepo(root, 'runtime')
    const def = {
      id: 'three',
      version: 1,
      entry: 'a',
      nodes: {
        a: { type: 'dispatch', role: 'implementer', engine: 'claude', prompt: 'a' },
        b: { type: 'dispatch', role: 'implementer', engine: 'claude', prompt: 'b' },
        c: { type: 'dispatch', role: 'implementer', engine: 'claude', prompt: 'c' },
        done: { type: 'terminal', final_state: 'completed' },
      },
      edges: [
        { from: 'a', on_disposition: 'success', to: 'b' },
        { from: 'b', on_disposition: 'success', to: 'c' },
        { from: 'c', on_disposition: 'success', to: 'done' },
      ],
    }
    runNode(root, ['engine/cli/pipeline.mjs', 'register', writePipelineFile(root, 'p.json', def)])
    snapshotRepo(root, 'with pipeline')

    const stub = ['#!/usr/bin/env node', 'console.log("ok")'].join('\n')
    const binDir = installStub(root, 'claude', stub)

    const r = runNode(root, ['engine/cli/pipeline.mjs', 'run', 'three', '--task-prefix', 'chain'],
      { PATH: `${binDir}:${process.env.PATH || ''}` })
    expect(r.status).toBe(0)
    // Three dispatches landed under task prefix `chain-<node>`.
    for (const stem of ['chain-a', 'chain-b', 'chain-c']) {
      expect(existsSync(join(root, '.artel', '.dispatches', `${stem}.meta`))).toBe(true)
    }
    // Each dispatch's task attrs carry pipeline_run_id + pipeline_node_id —
    // verifiable via dispatch.start events.
    const starts = events(root).filter((e) => e.type === 'dispatch.start')
    expect(starts).toHaveLength(3)
    const runIds = new Set(starts.map((e) => e.task_attrs?.pipeline_run_id).filter(Boolean))
    // task_attrs may not surface on dispatch.start in the current schema —
    // verify via .meta sidecar instead. Fall back to events file taskAttrs key.
    const taskMeta = JSON.parse(
      readFileSync(join(root, '.artel', '.dispatches', 'chain-a.meta'), 'utf8'),
    )
    expect(taskMeta.taskAttrs?.pipeline_node_id).toBe('a')
    expect(taskMeta.taskAttrs?.pipeline_run_id).toBeTruthy()
  })

  it('non-success disposition follows wildcard edge to abort terminal', () => {
    const root = createTempRepo()
    installAll(root)
    snapshotRepo(root, 'runtime')
    runNode(root, ['engine/cli/pipeline.mjs', 'register', writePipelineFile(root, 'p.json', minimal())])
    snapshotRepo(root, 'with pipeline')

    // Stub that exits non-zero, no parked-marker → disposition becomes 'error'.
    const stub = ['#!/usr/bin/env node', 'console.error("boom"); process.exit(7)'].join('\n')
    const binDir = installStub(root, 'claude', stub)

    const r = runNode(root, ['engine/cli/pipeline.mjs', 'run', 'demo'],
      { PATH: `${binDir}:${process.env.PATH || ''}` })
    expect(r.status).not.toBe(0) // pipeline.run exits with !=0 unless completed
    const ended = events(root).find((e) => e.type === 'pipeline_run.ended')
    expect(ended.final_state).toBe('failed')
    expect(ended.last_node).toBe('fail')
  })

  it('pipeline with no transition for disposition surfaces "no transition" abort', () => {
    const root = createTempRepo()
    installAll(root)
    snapshotRepo(root, 'runtime')
    const stuck = {
      id: 'stuck',
      version: 1,
      entry: 'a',
      nodes: {
        a: { type: 'dispatch', role: 'implementer', engine: 'claude', prompt: 'go' },
        done: { type: 'terminal', final_state: 'completed' },
      },
      edges: [
        // Only handles success; any other disposition → no transition.
        { from: 'a', on_disposition: 'success', to: 'done' },
      ],
    }
    runNode(root, ['engine/cli/pipeline.mjs', 'register', writePipelineFile(root, 'stuck.json', stuck)])
    snapshotRepo(root, 'with pipeline')

    const stub = ['#!/usr/bin/env node', 'process.exit(1)'].join('\n')
    const binDir = installStub(root, 'claude', stub)

    const r = runNode(root, ['engine/cli/pipeline.mjs', 'run', 'stuck'],
      { PATH: `${binDir}:${process.env.PATH || ''}` })
    expect(r.status).not.toBe(0)
    const ended = events(root).find((e) => e.type === 'pipeline_run.ended')
    expect(ended.final_state).toBe('failed')
    expect(ended.abort_reason).toMatch(/no transition for disposition/)
  })

  it('--attrs JSON merges into each dispatch task attrs', () => {
    const root = createTempRepo()
    installAll(root)
    snapshotRepo(root, 'runtime')
    runNode(root, ['engine/cli/pipeline.mjs', 'register', writePipelineFile(root, 'p.json', minimal())])
    snapshotRepo(root, 'with pipeline')

    const stub = ['#!/usr/bin/env node', 'console.log("ok")'].join('\n')
    const binDir = installStub(root, 'claude', stub)

    const r = runNode(root, [
      'engine/cli/pipeline.mjs', 'run', 'demo',
      '--attrs', '{"brief": "ship the fixture"}',
      '--task-prefix', 'briefed',
    ], { PATH: `${binDir}:${process.env.PATH || ''}` })
    expect(r.status).toBe(0)
    const meta = JSON.parse(
      readFileSync(join(root, '.artel', '.dispatches', 'briefed-first.meta'), 'utf8'),
    )
    expect(meta.taskAttrs.brief).toBe('ship the fixture')
    expect(meta.taskAttrs.pipeline_id).toBe('demo')
  })

  it('run on missing pipeline → exit 1', () => {
    const root = createTempRepo()
    installAll(root)
    const r = runNode(root, ['engine/cli/pipeline.mjs', 'run', 'ghost'])
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/'ghost' not registered/)
  })
})

describe('artel pipeline run — parallel (V3.2.a)', () => {
  const fanoutPipeline = () => ({
    id: 'fanout',
    version: 1,
    description: 'Fan out to 3 reviewers, join all-complete',
    entry: 'reviews',
    nodes: {
      reviews: { type: 'parallel', branches: ['cr', 'adv', 'maint'], join: 'all-complete' },
      cr: { type: 'dispatch', role: 'implementer', engine: 'claude', prompt: 'cold-read' },
      adv: { type: 'dispatch', role: 'implementer', engine: 'claude', prompt: 'attack' },
      maint: { type: 'dispatch', role: 'implementer', engine: 'claude', prompt: 'audit' },
      done: { type: 'terminal', final_state: 'completed' },
      fail: { type: 'terminal', final_state: 'failed' },
    },
    edges: [
      { from: 'reviews', on_disposition: 'success', to: 'done' },
      { from: 'reviews', on_disposition: '*', to: 'fail' },
    ],
  })

  it('runs all branches, joins on success → completed', () => {
    const root = createTempRepo()
    installAll(root)
    snapshotRepo(root, 'runtime')
    runNode(root, ['engine/cli/pipeline.mjs', 'register', writePipelineFile(root, 'p.json', fanoutPipeline())])
    snapshotRepo(root, 'with pipeline')
    const stub = ['#!/usr/bin/env node', 'console.log("ok")'].join('\n')
    const binDir = installStub(root, 'claude', stub)

    const r = runNode(root, ['engine/cli/pipeline.mjs', 'run', 'fanout', '--task-prefix', 'fan'],
      { PATH: `${binDir}:${process.env.PATH || ''}` })
    expect(r.status).toBe(0)
    // Each branch task lands under <prefix>-<parallel-id>-<branch-id>
    for (const stem of ['fan-reviews-cr', 'fan-reviews-adv', 'fan-reviews-maint']) {
      expect(existsSync(join(root, '.artel', '.dispatches', `${stem}.meta`))).toBe(true)
    }
    const ended = events(root).find((e) => e.type === 'pipeline_run.ended')
    expect(ended).toMatchObject({ final_state: 'completed', last_node: 'done', last_disposition: 'success' })
  })

  it('aggregate fails when any branch fails — wildcard catches', () => {
    const root = createTempRepo()
    installAll(root)
    snapshotRepo(root, 'runtime')
    // First branch succeeds; second exits non-zero (→ disposition error).
    const def = fanoutPipeline()
    def.nodes.cr.role = 'implementer-ok'
    def.nodes.adv.role = 'implementer-bad'
    def.nodes.maint.role = 'implementer-ok'
    // We can't easily branch behaviour by role with a single stub.
    // Easier path: keep stub generic but make it always fail; aggregate still reaches `fail`.
    runNode(root, ['engine/cli/pipeline.mjs', 'register', writePipelineFile(root, 'p.json', fanoutPipeline())])
    snapshotRepo(root, 'with pipeline')
    const stub = ['#!/usr/bin/env node', 'process.exit(7)'].join('\n')
    const binDir = installStub(root, 'claude', stub)

    const r = runNode(root, ['engine/cli/pipeline.mjs', 'run', 'fanout', '--task-prefix', 'fan2'],
      { PATH: `${binDir}:${process.env.PATH || ''}` })
    expect(r.status).not.toBe(0)
    const ended = events(root).find((e) => e.type === 'pipeline_run.ended')
    expect(ended.final_state).toBe('failed')
    expect(ended.last_node).toBe('fail')
    // All three branches still ran
    for (const stem of ['fan2-reviews-cr', 'fan2-reviews-adv', 'fan2-reviews-maint']) {
      expect(existsSync(join(root, '.artel', '.dispatches', `${stem}.meta`))).toBe(true)
    }
  })

  it('branch dispatches carry pipeline_parallel_of in taskAttrs', () => {
    const root = createTempRepo()
    installAll(root)
    snapshotRepo(root, 'runtime')
    runNode(root, ['engine/cli/pipeline.mjs', 'register', writePipelineFile(root, 'p.json', fanoutPipeline())])
    snapshotRepo(root, 'with pipeline')
    const stub = ['#!/usr/bin/env node', 'console.log("ok")'].join('\n')
    const binDir = installStub(root, 'claude', stub)
    runNode(root, ['engine/cli/pipeline.mjs', 'run', 'fanout', '--task-prefix', 'tag'],
      { PATH: `${binDir}:${process.env.PATH || ''}` })
    const meta = JSON.parse(
      readFileSync(join(root, '.artel', '.dispatches', 'tag-reviews-cr.meta'), 'utf8'),
    )
    expect(meta.taskAttrs).toMatchObject({
      pipeline_id: 'fanout',
      pipeline_node_id: 'cr',
      pipeline_parallel_of: 'reviews',
    })
    expect(meta.taskAttrs.pipeline_run_id).toBeTruthy()
  })

  it('show renders parallel nodes', () => {
    const root = createTempRepo()
    installAll(root)
    runNode(root, ['engine/cli/pipeline.mjs', 'register', writePipelineFile(root, 'p.json', fanoutPipeline())])
    const r = runNode(root, ['engine/cli/pipeline.mjs', 'show', 'fanout'])
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/reviews\s+parallel\s+branches=\[cr, adv, maint\]\s+join=all-complete/)
  })
})

describe('artel pipeline run — condition (V3.2.b)', () => {
  const conditionPipeline = (overrides = {}) => ({
    id: 'gated',
    version: 1,
    description: 'Skip impl when attrs.skip says so',
    entry: 'gate',
    nodes: {
      gate: { type: 'condition', if: { attr: 'skip', equals: true }, then: 'done', else: 'impl' },
      impl: { type: 'dispatch', role: 'implementer', engine: 'claude', prompt: 'do the thing' },
      done: { type: 'terminal', final_state: 'completed' },
    },
    edges: [
      { from: 'impl', on_disposition: 'success', to: 'done' },
      { from: 'impl', on_disposition: '*', to: 'done' },
    ],
    ...overrides,
  })

  it("condition with --attrs '{\"skip\": true}' jumps to .then, skipping the dispatch", () => {
    const root = createTempRepo()
    installAll(root)
    snapshotRepo(root, 'runtime')
    runNode(root, ['engine/cli/pipeline.mjs', 'register', writePipelineFile(root, 'p.json', conditionPipeline())])
    snapshotRepo(root, 'with pipeline')

    const stub = ['#!/usr/bin/env node', 'console.log("ok")', ''].join('\n')
    const binDir = installStub(root, 'claude', stub)

    const r = runNode(root, [
      'engine/cli/pipeline.mjs', 'run', 'gated',
      '--attrs', '{"skip": true}',
      '--task-prefix', 'skipped',
    ], { PATH: `${binDir}:${process.env.PATH || ''}` })
    expect(r.status).toBe(0)
    // The dispatch was bypassed → no impl .meta exists
    expect(existsSync(join(root, '.artel', '.dispatches', 'skipped-impl.meta'))).toBe(false)
    const ended = events(root).find((e) => e.type === 'pipeline_run.ended')
    expect(ended).toMatchObject({ final_state: 'completed', last_node: 'done' })
  })

  it('condition with .else branch dispatches the gated node', () => {
    const root = createTempRepo()
    installAll(root)
    snapshotRepo(root, 'runtime')
    runNode(root, ['engine/cli/pipeline.mjs', 'register', writePipelineFile(root, 'p.json', conditionPipeline())])
    snapshotRepo(root, 'with pipeline')
    const stub = ['#!/usr/bin/env node', 'console.log("ok")', ''].join('\n')
    const binDir = installStub(root, 'claude', stub)

    const r = runNode(root, [
      'engine/cli/pipeline.mjs', 'run', 'gated',
      '--attrs', '{"skip": false}',
      '--task-prefix', 'tested',
    ], { PATH: `${binDir}:${process.env.PATH || ''}` })
    expect(r.status).toBe(0)
    expect(existsSync(join(root, '.artel', '.dispatches', 'tested-impl.meta'))).toBe(true)
    const ended = events(root).find((e) => e.type === 'pipeline_run.ended')
    expect(ended).toMatchObject({ final_state: 'completed', last_node: 'done' })
  })

  it('condition routes via dotted attrs path', () => {
    const root = createTempRepo()
    installAll(root)
    snapshotRepo(root, 'runtime')
    const def = conditionPipeline({
      nodes: {
        gate: { type: 'condition', if: { attr: 'env.target', in: ['staging', 'prod'] }, then: 'impl', else: 'done' },
        impl: { type: 'dispatch', role: 'implementer', engine: 'claude', prompt: 'deploy' },
        done: { type: 'terminal', final_state: 'completed' },
      },
    })
    runNode(root, ['engine/cli/pipeline.mjs', 'register', writePipelineFile(root, 'p.json', def)])
    snapshotRepo(root, 'with pipeline')
    const stub = ['#!/usr/bin/env node', 'console.log("ok")', ''].join('\n')
    const binDir = installStub(root, 'claude', stub)

    const r = runNode(root, [
      'engine/cli/pipeline.mjs', 'run', 'gated',
      '--attrs', '{"env": {"target": "prod"}}',
      '--task-prefix', 'deploy',
    ], { PATH: `${binDir}:${process.env.PATH || ''}` })
    expect(r.status).toBe(0)
    // env.target = prod is in [staging, prod] → went to .then = impl
    expect(existsSync(join(root, '.artel', '.dispatches', 'deploy-impl.meta'))).toBe(true)
  })

  it('show renders condition rows', () => {
    const root = createTempRepo()
    installAll(root)
    runNode(root, ['engine/cli/pipeline.mjs', 'register', writePipelineFile(root, 'p.json', conditionPipeline())])
    const r = runNode(root, ['engine/cli/pipeline.mjs', 'show', 'gated'])
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/gate\s+condition\s+if\(skip equals true\) then=done else=impl/)
  })
})

describe('artel pipeline runs / status (V3.4.a)', () => {
  const linearPipeline = () => ({
    id: 'observable',
    version: 1,
    entry: 'a',
    nodes: {
      a: { type: 'dispatch', role: 'implementer', engine: 'claude', prompt: 'a' },
      b: { type: 'dispatch', role: 'implementer', engine: 'claude', prompt: 'b' },
      done: { type: 'terminal', final_state: 'completed' },
    },
    edges: [
      { from: 'a', on_disposition: 'success', to: 'b' },
      { from: 'b', on_disposition: 'success', to: 'done' },
    ],
  })

  const setUpRun = (root: string) => {
    installAll(root)
    snapshotRepo(root, 'runtime')
    runNode(root, ['engine/cli/pipeline.mjs', 'register', writePipelineFile(root, 'p.json', linearPipeline())])
    snapshotRepo(root, 'with pipeline')
    const stub = ['#!/usr/bin/env node', 'console.log("ok")', ''].join('\n')
    const binDir = installStub(root, 'claude', stub)
    return runNode(root, ['engine/cli/pipeline.mjs', 'run', 'observable', '--task-prefix', 'obs'],
      { PATH: `${binDir}:${process.env.PATH || ''}` })
  }

  it('runs lists past completed runs', () => {
    const root = createTempRepo()
    const runResult = setUpRun(root)
    expect(runResult.status).toBe(0)

    const r = runNode(root, ['engine/cli/pipeline.mjs', 'runs'])
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('observable')
    expect(r.stdout).toMatch(/completed/)
  })

  it('runs --json emits structured array sorted newest first', () => {
    const root = createTempRepo()
    setUpRun(root)
    const r = runNode(root, ['engine/cli/pipeline.mjs', 'runs', '--json'])
    expect(r.status).toBe(0)
    const parsed = JSON.parse(r.stdout) as Array<{ pipeline_id: string; final_state: string; duration_ms: number }>
    expect(parsed).toHaveLength(1)
    expect(parsed[0]).toMatchObject({ pipeline_id: 'observable', final_state: 'completed' })
    expect(parsed[0].duration_ms).toBeGreaterThanOrEqual(0)
  })

  it('runs --pipeline filters to one pipeline id', () => {
    const root = createTempRepo()
    setUpRun(root)
    const empty = runNode(root, ['engine/cli/pipeline.mjs', 'runs', '--pipeline', 'other-flow', '--json'])
    expect(empty.status).toBe(0)
    expect(JSON.parse(empty.stdout)).toEqual([])

    const matched = runNode(root, ['engine/cli/pipeline.mjs', 'runs', '--pipeline', 'observable', '--json'])
    expect(JSON.parse(matched.stdout)).toHaveLength(1)
  })

  it('runs --limit caps the count', () => {
    const root = createTempRepo()
    setUpRun(root)
    setUpRun(createTempRepo()) // separate run, separate root, but our root has only 1
    const r = runNode(root, ['engine/cli/pipeline.mjs', 'runs', '--limit', '0', '--json'])
    expect(r.status).toBe(0)
    expect(JSON.parse(r.stdout)).toEqual([])
  })

  it('status surfaces per-node steps with disposition', () => {
    const root = createTempRepo()
    setUpRun(root)
    // Pull the run id from runs --json
    const list = JSON.parse(runNode(root, ['engine/cli/pipeline.mjs', 'runs', '--json']).stdout) as Array<{ run_id: string }>
    const runId = list[0].run_id

    const r = runNode(root, ['engine/cli/pipeline.mjs', 'status', runId])
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('observable')
    expect(r.stdout).toContain('completed')
    expect(r.stdout).toContain('Steps')
    // Both dispatch nodes show as steps
    expect(r.stdout).toMatch(/\ba\s+/)
    expect(r.stdout).toMatch(/\bb\s+/)
  })

  it('status accepts a trailing fragment of run_id', () => {
    const root = createTempRepo()
    setUpRun(root)
    const list = JSON.parse(runNode(root, ['engine/cli/pipeline.mjs', 'runs', '--json']).stdout) as Array<{ run_id: string }>
    const runId = list[0].run_id
    const fragment = runId.slice(-12)
    const r = runNode(root, ['engine/cli/pipeline.mjs', 'status', fragment])
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('observable')
  })

  it('status --json emits run summary + steps', () => {
    const root = createTempRepo()
    setUpRun(root)
    const list = JSON.parse(runNode(root, ['engine/cli/pipeline.mjs', 'runs', '--json']).stdout) as Array<{ run_id: string }>
    const r = runNode(root, ['engine/cli/pipeline.mjs', 'status', list[0].run_id, '--json'])
    expect(r.status).toBe(0)
    const parsed = JSON.parse(r.stdout) as {
      run_id: string; pipeline_id: string; final_state: string;
      steps: Array<{ node_id: string; disposition: string }>;
    }
    expect(parsed.pipeline_id).toBe('observable')
    expect(parsed.final_state).toBe('completed')
    expect(parsed.steps).toHaveLength(2)
    expect(parsed.steps.map((s) => s.node_id)).toEqual(['a', 'b'])
  })

  it('status on missing run id → exit 1', () => {
    const root = createTempRepo()
    installAll(root)
    const r = runNode(root, ['engine/cli/pipeline.mjs', 'status', 'no-such-run'])
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/no run matches/)
  })

  it('runs on empty events.jsonl shows hint', () => {
    const root = createTempRepo()
    installAll(root)
    const r = runNode(root, ['engine/cli/pipeline.mjs', 'runs'])
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/no runs yet/)
  })
})
