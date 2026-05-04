// E2E for `artel replay` — re-runs a past dispatch with same role + prompt.

import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
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
    'engine/cli/replay.mjs',
    'engine/cli/spawn.mjs',
    'engine/cli/run.mjs',
    ...ENGINE_FILES_CORE,
    ...ENGINE_FILES_DRIVERS,
    ...ENGINE_FILES_UTIL,
  ])

const writeOriginalDispatch = (root: string, slug: string, dispatchId: string, overrides: Record<string, unknown> = {}) => {
  const dir = join(root, '.artel', '.dispatches')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${slug}.meta`), JSON.stringify({
    task: slug,
    role: 'implementer',
    engine: 'claude',
    model: 'opus',
    dispatchId,
    traceId: dispatchId,
    status: 'failed',
    disposition: 'error',
    completedAt: '2026-05-04T10:00:00.000Z',
    ...overrides,
  }) + '\n')
  writeFileSync(join(dir, `${slug}.out`), 'original output\n')
  writeFileSync(join(dir, `${slug}.prompt`), 'do the original thing\n')
}

describe('artel replay', () => {
  it('re-runs original dispatch on a different engine, with --retry-of wired', () => {
    const root = createTempRepo()
    installAll(root)
    snapshotRepo(root, 'runtime')
    const dispatchId = '01934f00-aaaa-7bbb-8ccc-000000000001'
    writeOriginalDispatch(root, 'broken-task', dispatchId)
    snapshotRepo(root, 'add original')

    // Stubs for both claude (orig engine) and codex (replay target)
    const claudeStub = ['#!/usr/bin/env node', 'console.log("claude ran")'].join('\n')
    const codexStub = ['#!/usr/bin/env node', 'console.log(process.argv.slice(2).join(" "))'].join('\n')
    const binDir = installStub(root, 'claude', claudeStub)
    installStub(root, 'codex', codexStub)

    const r = runNode(root, ['engine/cli/replay.mjs', 'broken-task', '--engine', 'codex'], {
      PATH: `${binDir}:${process.env.PATH || ''}`,
    })
    expect(r.status).toBe(0)

    // A new .meta exists with auto-generated slug
    const dispatchesDir = join(root, '.artel', '.dispatches')
    const replayMetaPath = readMetaForReplay(dispatchesDir)
    expect(replayMetaPath).not.toBeNull()
    const replayMeta = JSON.parse(readFileSync(replayMetaPath!, 'utf8'))
    expect(replayMeta.role).toBe('implementer')
    expect(replayMeta.engine).toBe('codex')                  // engine override
    expect(replayMeta.task).toMatch(/^broken-task-replay-/)  // auto slug
    expect(replayMeta.retryOf).toBe(dispatchId)              // chain wired
  })

  it('re-runs on original engine when --engine omitted', () => {
    const root = createTempRepo()
    installAll(root)
    snapshotRepo(root, 'runtime')
    const dispatchId = '01934f00-aaaa-7bbb-8ccc-000000000002'
    writeOriginalDispatch(root, 'flaky-task', dispatchId)
    snapshotRepo(root, 'add original')
    const claudeStub = ['#!/usr/bin/env node', 'console.log("ok")'].join('\n')
    const binDir = installStub(root, 'claude', claudeStub)
    installStub(root, 'codex', '#!/usr/bin/env node\nconsole.log("noop")')

    const r = runNode(root, ['engine/cli/replay.mjs', 'flaky-task'], {
      PATH: `${binDir}:${process.env.PATH || ''}`,
    })
    expect(r.status).toBe(0)
    const replayMeta = JSON.parse(readFileSync(readMetaForReplay(join(root, '.artel', '.dispatches'))!, 'utf8'))
    expect(replayMeta.engine).toBe('claude') // same as original
    expect(replayMeta.retryOf).toBe(dispatchId)
  })

  it('resolves target by dispatch_id (UUID v7)', () => {
    const root = createTempRepo()
    installAll(root)
    snapshotRepo(root, 'runtime')
    const dispatchId = '01934f00-aaaa-7bbb-8ccc-000000000003'
    writeOriginalDispatch(root, 'by-id-task', dispatchId)
    snapshotRepo(root, 'add original')
    const claudeStub = ['#!/usr/bin/env node', 'console.log("ok")'].join('\n')
    const binDir = installStub(root, 'claude', claudeStub)

    const r = runNode(root, ['engine/cli/replay.mjs', dispatchId], {
      PATH: `${binDir}:${process.env.PATH || ''}`,
    })
    expect(r.status).toBe(0)
    const replayMeta = JSON.parse(readFileSync(readMetaForReplay(join(root, '.artel', '.dispatches'))!, 'utf8'))
    expect(replayMeta.retryOf).toBe(dispatchId)
  })

  it('fails with helpful message when target not found', () => {
    const root = createTempRepo()
    installAll(root)
    const r = runNode(root, ['engine/cli/replay.mjs', 'no-such-task'])
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/No dispatch found for task slug 'no-such-task'/)
  })

  it('fails when prompt sidecar is missing (legacy dispatch)', () => {
    const root = createTempRepo()
    installAll(root)
    const dir = join(root, '.artel', '.dispatches')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'no-prompt.meta'), JSON.stringify({
      task: 'no-prompt', role: 'implementer', engine: 'claude',
      dispatchId: '01934f00-aaaa-7bbb-8ccc-000000000004',
    }) + '\n')
    writeFileSync(join(dir, 'no-prompt.out'), 'output\n')
    const r = runNode(root, ['engine/cli/replay.mjs', 'no-prompt'])
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/Original prompt sidecar not found/)
  })

  it('--task overrides the auto-generated replay slug', () => {
    const root = createTempRepo()
    installAll(root)
    snapshotRepo(root, 'runtime')
    const dispatchId = '01934f00-aaaa-7bbb-8ccc-000000000005'
    writeOriginalDispatch(root, 'orig-task', dispatchId)
    snapshotRepo(root, 'add original')
    const claudeStub = ['#!/usr/bin/env node', 'console.log("ok")'].join('\n')
    const binDir = installStub(root, 'claude', claudeStub)

    const r = runNode(
      root,
      ['engine/cli/replay.mjs', 'orig-task', '--task', 'custom-slug'],
      { PATH: `${binDir}:${process.env.PATH || ''}` },
    )
    expect(r.status).toBe(0)
    expect(readFileSync(join(root, '.artel', '.dispatches', 'custom-slug.meta'), 'utf8')).toContain('custom-slug')
  })
})

// Pick the most-recently written .meta whose stem includes 'replay' —
// auto-generated replay slugs match `<orig>-replay-<short>`.
function readMetaForReplay (dir: string): string | null {
  const candidates = readdirSync(dir)
    .filter((f) => f.endsWith('.meta') && f.includes('replay'))
  if (!candidates.length) return null
  candidates.sort((a, b) => statSync(join(dir, b)).mtimeMs - statSync(join(dir, a)).mtimeMs)
  return join(dir, candidates[0])
}
