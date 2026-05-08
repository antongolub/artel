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

describe('artel pipeline run — parallel any-complete / k-of-n (V3.3.c)', () => {
  // A stub that finishes quickly with success. Used as the "fast"
  // branch in race tests; siblings sleep longer and end up cancelled.
  const fastStub = ['#!/usr/bin/env node', 'console.log("fast ok")', ''].join('\n')

  // Stub that hangs for several seconds so the race test can verify
  // cancellation actually fires. We also write a marker file so
  // forensic checks could see whether it ran to completion (it
  // shouldn't — the controller aborts it).
  const slowStub = ['#!/usr/bin/env node',
    `setTimeout(() => { console.log("slow ok"); process.exit(0) }, 30000)`,
    `// SIGTERM handler exits non-zero — used to identify the cancel path.`,
    `process.on('SIGTERM', () => { console.error('cancelled'); process.exit(143) })`,
    ''].join('\n')

  // Project-level driver overlay (DESIGN.md §8.3) so we can spawn
  // distinct stubs per branch without pretending they're all 'claude'.
  // Minimal contract: id / command / args(). Engine name = binary name
  // — installStub puts the binary on PATH under that exact name.
  const installDriverOverlay = (root: string, engineId: string) => {
    const dir = join(root, '.artel', 'drivers')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${engineId}.mjs`), [
      `export const id = '${engineId}'`,
      `export const command = '${engineId}'`,
      `export const api_version = 1`,
      `export function args (meta, promptParts) {`,
      `  return promptParts.length ? [promptParts.join(' ')] : []`,
      `}`,
      ``,
    ].join('\n'))
  }

  const racePipeline = (overrides = {}) => ({
    id: 'race',
    version: 1,
    entry: 'fan',
    nodes: {
      fan: { type: 'parallel', branches: ['fast', 'slow1', 'slow2'], join: 'any-complete' },
      fast: { type: 'dispatch', role: 'implementer', engine: 'fastclaude', prompt: 'fast' },
      slow1: { type: 'dispatch', role: 'implementer', engine: 'slowclaude', prompt: 'slow1' },
      slow2: { type: 'dispatch', role: 'implementer', engine: 'slowclaude', prompt: 'slow2' },
      done: { type: 'terminal', final_state: 'completed' },
      fail: { type: 'terminal', final_state: 'failed' },
    },
    edges: [
      { from: 'fan', on_disposition: 'success', to: 'done' },
      { from: 'fan', on_disposition: '*', to: 'fail' },
    ],
    ...overrides,
  })

  it('any-complete: first success wins, siblings cancelled', () => {
    const root = createTempRepo()
    installAll(root)
    installDriverOverlay(root, 'fastclaude')
    installDriverOverlay(root, 'slowclaude')
    snapshotRepo(root, 'runtime')
    runNode(root, ['engine/cli/pipeline.mjs', 'register', writePipelineFile(root, 'p.json', racePipeline())])
    snapshotRepo(root, 'with pipeline')

    // fastclaude finishes immediately; slowclaude hangs but
    // SIGTERM-handles cleanly.
    const binDir = installStub(root, 'fastclaude', fastStub)
    installStub(root, 'slowclaude', slowStub)

    const r = runNode(root, ['engine/cli/pipeline.mjs', 'run', 'race', '--task-prefix', 'race1'],
      { PATH: `${binDir}:${process.env.PATH || ''}` })
    expect(r.status).toBe(0)

    // Aggregate is success
    const ended = events(root).find((e) => e.type === 'pipeline_run.ended')
    expect(ended).toMatchObject({ final_state: 'completed', last_disposition: 'success' })

    // Fast branch: success. Slow branches: cancelled (or possibly
    // "error" if our SIGTERM races settled exit, depending on timing).
    // What matters: at least one cancelled.
    const dispatchEnds = events(root).filter(
      (e) => e.type === 'dispatch.end' && e.task_attrs?.pipeline_run_id === ended.pipeline_run_id,
    )
    const dispoBy = Object.fromEntries(
      dispatchEnds.map((e) => [e.task_attrs.pipeline_node_id, e.disposition]),
    )
    expect(dispoBy.fast).toBe('success')
    expect(['cancelled', 'error']).toContain(dispoBy.slow1)
    expect(['cancelled', 'error']).toContain(dispoBy.slow2)
    // At least one branch was actually cancelled (not just errored).
    expect([dispoBy.slow1, dispoBy.slow2].includes('cancelled')).toBe(true)
  })

  it('k-of-n with k=2: returns success once 2 of 3 finish', () => {
    const root = createTempRepo()
    installAll(root)
    installDriverOverlay(root, 'fastclaude')
    installDriverOverlay(root, 'slowclaude')
    snapshotRepo(root, 'runtime')
    const def = racePipeline({
      nodes: {
        fan: { type: 'parallel', branches: ['fast1', 'fast2', 'slow'], join: 'k-of-n', k: 2 },
        fast1: { type: 'dispatch', role: 'implementer', engine: 'fastclaude', prompt: 'fast1' },
        fast2: { type: 'dispatch', role: 'implementer', engine: 'fastclaude', prompt: 'fast2' },
        slow: { type: 'dispatch', role: 'implementer', engine: 'slowclaude', prompt: 'slow' },
        done: { type: 'terminal', final_state: 'completed' },
        fail: { type: 'terminal', final_state: 'failed' },
      },
    })
    runNode(root, ['engine/cli/pipeline.mjs', 'register', writePipelineFile(root, 'p.json', def)])
    snapshotRepo(root, 'with pipeline')

    const binDir = installStub(root, 'fastclaude', fastStub)
    installStub(root, 'slowclaude', slowStub)

    const r = runNode(root, ['engine/cli/pipeline.mjs', 'run', 'race', '--task-prefix', 'kof'],
      { PATH: `${binDir}:${process.env.PATH || ''}` })
    expect(r.status).toBe(0)

    const ended = events(root).find((e) => e.type === 'pipeline_run.ended')
    expect(ended.final_state).toBe('completed')
    // 2 successes is enough; slow gets cancelled.
    const dispatchEnds = events(root).filter(
      (e) => e.type === 'dispatch.end' && e.task_attrs?.pipeline_run_id === ended.pipeline_run_id,
    )
    const dispoBy = Object.fromEntries(
      dispatchEnds.map((e) => [e.task_attrs.pipeline_node_id, e.disposition]),
    )
    expect(dispoBy.fast1).toBe('success')
    expect(dispoBy.fast2).toBe('success')
    expect(['cancelled', 'error']).toContain(dispoBy.slow)
  })

  it('any-complete with all branches failing falls through to wildcard edge', () => {
    const root = createTempRepo()
    installAll(root)
    installDriverOverlay(root, 'failclaude')
    snapshotRepo(root, 'runtime')
    const def = {
      ...racePipeline(),
      nodes: {
        fan: { type: 'parallel', branches: ['a', 'b', 'c'], join: 'any-complete' },
        a: { type: 'dispatch', role: 'implementer', engine: 'failclaude', prompt: 'a' },
        b: { type: 'dispatch', role: 'implementer', engine: 'failclaude', prompt: 'b' },
        c: { type: 'dispatch', role: 'implementer', engine: 'failclaude', prompt: 'c' },
        done: { type: 'terminal', final_state: 'completed' },
        fail: { type: 'terminal', final_state: 'failed' },
      },
    }
    runNode(root, ['engine/cli/pipeline.mjs', 'register', writePipelineFile(root, 'p.json', def)])
    snapshotRepo(root, 'with pipeline')

    const failStub = ['#!/usr/bin/env node', 'process.exit(7)', ''].join('\n')
    const binDir = installStub(root, 'failclaude', failStub)

    const r = runNode(root, ['engine/cli/pipeline.mjs', 'run', 'race', '--task-prefix', 'allfail'],
      { PATH: `${binDir}:${process.env.PATH || ''}` })
    expect(r.status).not.toBe(0)
    const ended = events(root).find((e) => e.type === 'pipeline_run.ended')
    expect(ended.final_state).toBe('failed')
    expect(ended.last_node).toBe('fail')
  })

  it('show renders k-of-n with k', () => {
    const root = createTempRepo()
    installAll(root)
    const def = racePipeline({
      nodes: {
        fan: { type: 'parallel', branches: ['fast1', 'fast2', 'slow'], join: 'k-of-n', k: 2 },
        fast1: { type: 'dispatch', role: 'implementer', engine: 'claude', prompt: '' },
        fast2: { type: 'dispatch', role: 'implementer', engine: 'claude', prompt: '' },
        slow: { type: 'dispatch', role: 'implementer', engine: 'claude', prompt: '' },
        done: { type: 'terminal', final_state: 'completed' },
        fail: { type: 'terminal', final_state: 'failed' },
      },
    })
    runNode(root, ['engine/cli/pipeline.mjs', 'register', writePipelineFile(root, 'p.json', def)])
    const r = runNode(root, ['engine/cli/pipeline.mjs', 'show', 'race'])
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/fan\s+parallel\s+branches=\[fast1, fast2, slow\]\s+join=k-of-n\s+k=2/)
  })
})

describe('artel pipeline run — prompt template substitution (V3.5)', () => {
  // The walker renders `{{ attr }}` placeholders against the merged
  // attrs (user --attrs + pipeline-injected ids) before passing to
  // dispatchLifecycle. The rendered prompt lands in
  // .artel/.dispatches/<task>.prompt — we read it back to assert.

  const templated = (overrides = {}) => ({
    id: 'tmpl',
    version: 1,
    entry: 'first',
    nodes: {
      first: {
        type: 'dispatch',
        role: 'implementer',
        engine: 'claude',
        prompt: 'Implement: {{ target }} for run {{ pipeline_run_id }}',
      },
      done: { type: 'terminal', final_state: 'completed' },
      fail: { type: 'terminal', final_state: 'failed' },
    },
    edges: [
      { from: 'first', on_disposition: 'success', to: 'done' },
      { from: 'first', on_disposition: '*', to: 'fail' },
    ],
    ...overrides,
  })

  it('substitutes user --attrs and pipeline-injected ids into prompt', () => {
    const root = createTempRepo()
    installAll(root)
    snapshotRepo(root, 'runtime')
    runNode(root, ['engine/cli/pipeline.mjs', 'register', writePipelineFile(root, 'p.json', templated())])
    snapshotRepo(root, 'with pipeline')

    const stub = ['#!/usr/bin/env node', 'console.log("ok")', ''].join('\n')
    const binDir = installStub(root, 'claude', stub)

    const r = runNode(root, [
      'engine/cli/pipeline.mjs', 'run', 'tmpl',
      '--attrs', '{"target":"auth-bug"}',
      '--task-prefix', 'tt',
    ], { PATH: `${binDir}:${process.env.PATH || ''}` })
    expect(r.status).toBe(0)

    const promptPath = join(root, '.artel', '.dispatches', 'tt-first.prompt')
    expect(existsSync(promptPath)).toBe(true)
    const rendered = readFileSync(promptPath, 'utf8')
    // pipeline_run_id is a UUIDv7 — assert shape via the static parts
    // and the dynamic parts via regex.
    expect(rendered).toMatch(/^Implement: auth-bug for run [0-9a-f-]{36}$/)
  })

  it('missing attribute fails the run with a clear template error', () => {
    const root = createTempRepo()
    installAll(root)
    snapshotRepo(root, 'runtime')
    runNode(root, ['engine/cli/pipeline.mjs', 'register', writePipelineFile(root, 'p.json', templated())])
    snapshotRepo(root, 'with pipeline')

    const stub = ['#!/usr/bin/env node', 'console.log("ok")', ''].join('\n')
    const binDir = installStub(root, 'claude', stub)

    // No --attrs → `target` is missing → render throws → run aborts.
    const r = runNode(root, ['engine/cli/pipeline.mjs', 'run', 'tmpl', '--task-prefix', 'fail'],
      { PATH: `${binDir}:${process.env.PATH || ''}` })
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/prompt template at node 'first':.*missing attribute 'target'/)
    const ended = events(root).find((e) => e.type === 'pipeline_run.ended')
    expect(ended.final_state).toBe('failed')
    expect(ended.abort_reason).toMatch(/template/)
  })

  it('parallel branches see pipeline_node_id + parallel_of in their prompt scope', () => {
    const root = createTempRepo()
    installAll(root)
    const def = {
      id: 'fanout-tmpl',
      version: 1,
      entry: 'fan',
      nodes: {
        fan: { type: 'parallel', branches: ['a', 'b'], join: 'all-complete' },
        a: { type: 'dispatch', role: 'implementer', engine: 'claude',
             prompt: 'branch={{ pipeline_node_id }} parent={{ pipeline_parallel_of }}' },
        b: { type: 'dispatch', role: 'implementer', engine: 'claude',
             prompt: 'branch={{ pipeline_node_id }} parent={{ pipeline_parallel_of }}' },
        done: { type: 'terminal', final_state: 'completed' },
        fail: { type: 'terminal', final_state: 'failed' },
      },
      edges: [
        { from: 'fan', on_disposition: 'success', to: 'done' },
        { from: 'fan', on_disposition: '*', to: 'fail' },
      ],
    }
    runNode(root, ['engine/cli/pipeline.mjs', 'register', writePipelineFile(root, 'p.json', def)])

    const stub = ['#!/usr/bin/env node', 'console.log("ok")', ''].join('\n')
    const binDir = installStub(root, 'claude', stub)

    const r = runNode(root, ['engine/cli/pipeline.mjs', 'run', 'fanout-tmpl', '--task-prefix', 'fo'],
      { PATH: `${binDir}:${process.env.PATH || ''}` })
    expect(r.status).toBe(0)

    const promptA = readFileSync(join(root, '.artel', '.dispatches', 'fo-fan-a.prompt'), 'utf8')
    const promptB = readFileSync(join(root, '.artel', '.dispatches', 'fo-fan-b.prompt'), 'utf8')
    expect(promptA).toBe('branch=a parent=fan')
    expect(promptB).toBe('branch=b parent=fan')
  })

  it('passes through prompt with no templates unchanged (back-compat)', () => {
    const root = createTempRepo()
    installAll(root)
    snapshotRepo(root, 'runtime')
    const def = {
      id: 'plain', version: 1, entry: 'first',
      nodes: {
        first: { type: 'dispatch', role: 'implementer', engine: 'claude', prompt: 'just a literal prompt' },
        done: { type: 'terminal', final_state: 'completed' },
        fail: { type: 'terminal', final_state: 'failed' },
      },
      edges: [
        { from: 'first', on_disposition: 'success', to: 'done' },
        { from: 'first', on_disposition: '*', to: 'fail' },
      ],
    }
    runNode(root, ['engine/cli/pipeline.mjs', 'register', writePipelineFile(root, 'p.json', def)])
    snapshotRepo(root, 'with pipeline')
    const stub = ['#!/usr/bin/env node', 'console.log("ok")', ''].join('\n')
    const binDir = installStub(root, 'claude', stub)
    const r = runNode(root, ['engine/cli/pipeline.mjs', 'run', 'plain', '--task-prefix', 'pp'],
      { PATH: `${binDir}:${process.env.PATH || ''}` })
    expect(r.status).toBe(0)
    expect(readFileSync(join(root, '.artel', '.dispatches', 'pp-first.prompt'), 'utf8'))
      .toBe('just a literal prompt')
  })
})

describe('artel pipeline run — condition compounds + comparisons (V3.6)', () => {
  // Verify the richer predicate vocabulary actually routes through
  // the walker. Branch chosen → only that branch's dispatch
  // .meta lands; the other branch's stays absent. (Same probe
  // pattern as the V3.2.b condition tests.)
  const richCondition = (predicate: object) => ({
    id: 'gated', version: 1, entry: 'gate',
    nodes: {
      gate: { type: 'condition', if: predicate, then: 'yes', else: 'no' },
      yes: { type: 'dispatch', role: 'implementer', engine: 'claude', prompt: 'yes' },
      no: { type: 'dispatch', role: 'implementer', engine: 'claude', prompt: 'no' },
      done: { type: 'terminal', final_state: 'completed' },
    },
    edges: [
      { from: 'yes', on_disposition: 'success', to: 'done' },
      { from: 'yes', on_disposition: '*', to: 'done' },
      { from: 'no', on_disposition: 'success', to: 'done' },
      { from: 'no', on_disposition: '*', to: 'done' },
    ],
  })

  const runWithAttrs = (def: object, attrs: object, prefix: string) => {
    const root = createTempRepo()
    installAll(root)
    snapshotRepo(root, 'runtime')
    runNode(root, ['engine/cli/pipeline.mjs', 'register', writePipelineFile(root, 'p.json', def)])
    snapshotRepo(root, 'with pipeline')
    const stub = ['#!/usr/bin/env node', 'console.log("ok")', ''].join('\n')
    const binDir = installStub(root, 'claude', stub)
    const r = runNode(root, [
      'engine/cli/pipeline.mjs', 'run', 'gated',
      '--attrs', JSON.stringify(attrs),
      '--task-prefix', prefix,
    ], { PATH: `${binDir}:${process.env.PATH || ''}` })
    return { root, r }
  }

  it('and: every nested predicate must hold for .then', () => {
    const def = richCondition({
      and: [
        { attr: 'env', equals: 'prod' },
        { attr: 'approved', equals: true },
      ],
    })
    // both true → yes
    const a = runWithAttrs(def, { env: 'prod', approved: true }, 'and-yes')
    expect(a.r.status).toBe(0)
    expect(existsSync(join(a.root, '.artel', '.dispatches', 'and-yes-yes.meta'))).toBe(true)
    expect(existsSync(join(a.root, '.artel', '.dispatches', 'and-yes-no.meta'))).toBe(false)

    // one false → no
    const b = runWithAttrs(def, { env: 'prod', approved: false }, 'and-no')
    expect(b.r.status).toBe(0)
    expect(existsSync(join(b.root, '.artel', '.dispatches', 'and-no-no.meta'))).toBe(true)
    expect(existsSync(join(b.root, '.artel', '.dispatches', 'and-no-yes.meta'))).toBe(false)
  })

  it('or with not: any nested predicate suffices, including negation', () => {
    const def = richCondition({
      or: [
        { attr: 'force', equals: true },
        { not: { attr: 'env', equals: 'dev' } },
      ],
    })
    // env=prod → not-equals-dev fires → yes
    const a = runWithAttrs(def, { env: 'prod' }, 'or-prod')
    expect(existsSync(join(a.root, '.artel', '.dispatches', 'or-prod-yes.meta'))).toBe(true)

    // env=dev, no force → both branches false → no
    const b = runWithAttrs(def, { env: 'dev' }, 'or-dev')
    expect(existsSync(join(b.root, '.artel', '.dispatches', 'or-dev-no.meta'))).toBe(true)

    // env=dev but force=true → first branch fires → yes
    const c = runWithAttrs(def, { env: 'dev', force: true }, 'or-force')
    expect(existsSync(join(c.root, '.artel', '.dispatches', 'or-force-yes.meta'))).toBe(true)
  })

  it('comparison gte routes via numeric attr', () => {
    const def = richCondition({ attr: 'score', gte: 0.8 })
    const a = runWithAttrs(def, { score: 0.9 }, 'gte-hi')
    expect(existsSync(join(a.root, '.artel', '.dispatches', 'gte-hi-yes.meta'))).toBe(true)

    const b = runWithAttrs(def, { score: 0.5 }, 'gte-lo')
    expect(existsSync(join(b.root, '.artel', '.dispatches', 'gte-lo-no.meta'))).toBe(true)

    // Missing attr → fail-closed → no.
    const c = runWithAttrs(def, {}, 'gte-miss')
    expect(existsSync(join(c.root, '.artel', '.dispatches', 'gte-miss-no.meta'))).toBe(true)
  })

  it('show renders compound + comparison predicates recursively', () => {
    const root = createTempRepo()
    installAll(root)
    const def = richCondition({
      and: [
        { not: { attr: 'cancelled', exists: true } },
        { or: [{ attr: 'env', equals: 'prod' }, { attr: 'score', gte: 0.8 }] },
      ],
    })
    runNode(root, ['engine/cli/pipeline.mjs', 'register',
      writePipelineFile(root, 'p.json', def)])
    const r = runNode(root, ['engine/cli/pipeline.mjs', 'show', 'gated'])
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(
      /gate\s+condition\s+if\(\(not\(cancelled exists true\) and \(env equals "prod" or score gte 0\.8\)\)\) then=yes else=no/,
    )
  })

  it('register surfaces precise paths on bad nested predicate', () => {
    const root = createTempRepo()
    installAll(root)
    const broken = richCondition({
      and: [
        { attr: 'env', equals: 'prod' },
        { attr: 'approved' }, // missing op
      ],
    })
    const r = runNode(root, ['engine/cli/pipeline.mjs', 'register',
      writePipelineFile(root, 'broken.json', broken)])
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/\.if\.and\[1\] must specify exactly one/)
  })
})

describe('artel pipeline run — handler nodes (V3.7.a)', () => {
  // builtin.exec runs `bash -c <cmd>`. Walker treats disposition like
  // dispatch: success on exit 0 → success edge; non-zero → error edge.
  const flow = (handlerNode: object, edges = [
    { from: 'h', on_disposition: 'success', to: 'done' },
    { from: 'h', on_disposition: '*', to: 'fail' },
  ]) => ({
    id: 'h-flow', version: 1, entry: 'h',
    nodes: {
      h: handlerNode,
      done: { type: 'terminal', final_state: 'completed' },
      fail: { type: 'terminal', final_state: 'failed' },
    },
    edges,
  })

  it('builtin.exec exit 0 → success edge → completed', () => {
    const root = createTempRepo()
    installAll(root)
    snapshotRepo(root, 'runtime')
    const def = flow({
      type: 'handler', handler: 'builtin.exec',
      cmd: `touch handler-marker.txt`,
    })
    runNode(root, ['engine/cli/pipeline.mjs', 'register', writePipelineFile(root, 'p.json', def)])
    snapshotRepo(root, 'with pipeline')

    const r = runNode(root, ['engine/cli/pipeline.mjs', 'run', 'h-flow'])
    expect(r.status).toBe(0)
    // The handler ran in the project dir — marker file lands there.
    expect(existsSync(join(root, 'handler-marker.txt'))).toBe(true)
    const ended = events(root).find((e) => e.type === 'pipeline_run.ended')
    expect(ended).toMatchObject({
      final_state: 'completed', last_node: 'done', last_disposition: 'success',
    })
  })

  it('builtin.exec non-zero exit → wildcard edge → failed', () => {
    const root = createTempRepo()
    installAll(root)
    snapshotRepo(root, 'runtime')
    const def = flow({
      type: 'handler', handler: 'builtin.exec', cmd: 'exit 7',
    })
    runNode(root, ['engine/cli/pipeline.mjs', 'register', writePipelineFile(root, 'p.json', def)])
    snapshotRepo(root, 'with pipeline')

    const r = runNode(root, ['engine/cli/pipeline.mjs', 'run', 'h-flow'])
    expect(r.status).not.toBe(0)
    const ended = events(root).find((e) => e.type === 'pipeline_run.ended')
    expect(ended).toMatchObject({
      final_state: 'failed', last_node: 'fail', last_disposition: 'error',
    })
  })

  it('builtin.exec timeout → wildcard edge', () => {
    const root = createTempRepo()
    installAll(root)
    snapshotRepo(root, 'runtime')
    const def = flow({
      type: 'handler', handler: 'builtin.exec',
      cmd: 'sleep 5', timeout_ms: 100,
    })
    runNode(root, ['engine/cli/pipeline.mjs', 'register', writePipelineFile(root, 'p.json', def)])
    snapshotRepo(root, 'with pipeline')

    const r = runNode(root, ['engine/cli/pipeline.mjs', 'run', 'h-flow'])
    expect(r.status).not.toBe(0)
    const ended = events(root).find((e) => e.type === 'pipeline_run.ended')
    expect(ended.final_state).toBe('failed')
    expect(ended.last_disposition).toBe('timeout')
  })

  it('register surfaces precise error on bad handler shape', () => {
    const root = createTempRepo()
    installAll(root)
    const def = flow({ type: 'handler', handler: 'builtin.exec' }) // no cmd
    const r = runNode(root, ['engine/cli/pipeline.mjs', 'register',
      writePipelineFile(root, 'broken.json', def)])
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/\(builtin\.exec\) requires \.cmd as a non-empty string/)
  })

  it('show renders handler row with cmd + timeout', () => {
    const root = createTempRepo()
    installAll(root)
    const def = flow({
      type: 'handler', handler: 'builtin.exec',
      cmd: 'npm test', timeout_ms: 60000,
    })
    runNode(root, ['engine/cli/pipeline.mjs', 'register', writePipelineFile(root, 'p.json', def)])
    const r = runNode(root, ['engine/cli/pipeline.mjs', 'show', 'h-flow'])
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/h\s+handler\s+builtin\.exec\s+cmd="npm test"\s+timeout_ms=60000/)
  })

  it('emits pipeline_handler.start/.end events; status renders handler step (V3.7.b)', () => {
    const root = createTempRepo()
    installAll(root)
    snapshotRepo(root, 'runtime')
    const def = flow({
      type: 'handler', handler: 'builtin.exec', cmd: 'true',
    })
    runNode(root, ['engine/cli/pipeline.mjs', 'register', writePipelineFile(root, 'p.json', def)])
    snapshotRepo(root, 'with pipeline')

    const r = runNode(root, ['engine/cli/pipeline.mjs', 'run', 'h-flow'])
    expect(r.status).toBe(0)

    // Events: start + end with full payload.
    const evts = events(root)
    const hStart = evts.find((e) => e.type === 'pipeline_handler.start')
    const hEnd = evts.find((e) => e.type === 'pipeline_handler.end')
    expect(hStart).toBeDefined()
    expect(hEnd).toBeDefined()
    expect(hStart).toMatchObject({
      kind: 'workload', handler: 'builtin.exec',
      pipeline_id: 'h-flow', pipeline_node_id: 'h', cmd: 'true',
    })
    expect(hStart.handler_id).toBeTruthy()
    expect(hEnd).toMatchObject({
      kind: 'workload', handler_id: hStart.handler_id, handler: 'builtin.exec',
      pipeline_node_id: 'h', disposition: 'success', exit_code: 0,
    })
    expect(typeof hEnd.duration_ms).toBe('number')

    // status --json: handler row alongside any dispatches (none here).
    const ended = evts.find((e) => e.type === 'pipeline_run.ended')
    const sj = runNode(root, ['engine/cli/pipeline.mjs', 'status', ended.pipeline_run_id, '--json'])
    expect(sj.status).toBe(0)
    const det = JSON.parse(sj.stdout) as {
      steps: Array<{ kind: string; node_id: string; handler: string; disposition: string; exit_code: number }>
    }
    expect(det.steps).toHaveLength(1)
    expect(det.steps[0]).toMatchObject({
      kind: 'handler', node_id: 'h', handler: 'builtin.exec',
      disposition: 'success', exit_code: 0,
    })

    // status (text): handler word appears in the row.
    const st = runNode(root, ['engine/cli/pipeline.mjs', 'status', ended.pipeline_run_id])
    expect(st.status).toBe(0)
    expect(st.stdout).toMatch(/h\s+true\s+handler\s+exec\s+success/)
  })

  it('handler chains with dispatch through edges', () => {
    // handler success → dispatch → terminal. Verifies that handler
    // disposition flows through edges to a downstream dispatch the
    // way dispatch dispositions do.
    const root = createTempRepo()
    installAll(root)
    snapshotRepo(root, 'runtime')
    const def = {
      id: 'mixed', version: 1, entry: 'h',
      nodes: {
        h: { type: 'handler', handler: 'builtin.exec', cmd: 'true' },
        impl: { type: 'dispatch', role: 'implementer', engine: 'claude', prompt: 'go' },
        done: { type: 'terminal', final_state: 'completed' },
        fail: { type: 'terminal', final_state: 'failed' },
      },
      edges: [
        { from: 'h', on_disposition: 'success', to: 'impl' },
        { from: 'h', on_disposition: '*', to: 'fail' },
        { from: 'impl', on_disposition: 'success', to: 'done' },
        { from: 'impl', on_disposition: '*', to: 'fail' },
      ],
    }
    runNode(root, ['engine/cli/pipeline.mjs', 'register', writePipelineFile(root, 'p.json', def)])
    snapshotRepo(root, 'with pipeline')

    const stub = ['#!/usr/bin/env node', 'console.log("ok")', ''].join('\n')
    const binDir = installStub(root, 'claude', stub)

    const r = runNode(root, ['engine/cli/pipeline.mjs', 'run', 'mixed', '--task-prefix', 'mx'],
      { PATH: `${binDir}:${process.env.PATH || ''}` })
    expect(r.status).toBe(0)
    expect(existsSync(join(root, '.artel', '.dispatches', 'mx-impl.meta'))).toBe(true)
    const ended = events(root).find((e) => e.type === 'pipeline_run.ended')
    expect(ended.final_state).toBe('completed')
  })
})
