import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanupTempRoots, createTempRepo, ENGINE_FILES_CORE, ENGINE_FILES_UTIL, installEngineRuntime, installStub, runNode, snapshotRepo } from '../_helpers.js'

afterEach(cleanupTempRoots)

describe('artel spawn smoke', () => {
  it('keeps smoke-v3 + smoke-effort-flag + smoke-effort-canonical alive', () => {
    const root = createTempRepo()
    installEngineRuntime(root, [
      'engine/cli/spawn.mjs',
      'engine/cli/run.mjs',
      ...ENGINE_FILES_CORE,
      ...ENGINE_FILES_UTIL,
      'engine/drivers/claude.mjs',
      'engine/drivers/codex.mjs',
    ])
    snapshotRepo(root, 'runtime')

    const binDir = installStub(root, 'claude', ['#!/usr/bin/env node', 'console.log("smoke-v3-ok")'].join('\n'))
    installStub(root, 'codex', ['#!/usr/bin/env node', 'console.log(process.argv.slice(2).join(" "))'].join('\n'))

    const env = { PATH: `${binDir}:${process.env.PATH || ''}` }
    const smokeV3 = runNode(root, ['engine/cli/spawn.mjs', 'implementer', 'smoke-v3', '--engine', 'claude', '-p', 'hello'], env)
    expect(smokeV3.status).toBe(0)

    const smokeEffort = runNode(
      root,
      ['engine/cli/spawn.mjs', 'implementer', 'smoke-effort-flag', '--engine', 'codex', '--codex-effort', 'xhigh', '-p', 'hello'],
      env,
    )
    expect(smokeEffort.status).toBe(0)

    const v3Meta = JSON.parse(readFileSync(join(root, '.artel', '.dispatches', 'smoke-v3.meta'), 'utf8'))
    expect(v3Meta).toMatchObject({
      task: 'smoke-v3', role: 'implementer', engine: 'claude',
      status: 'completed', disposition: 'success',
    })

    const effortOut = readFileSync(join(root, '.artel', '.dispatches', 'smoke-effort-flag.out'), 'utf8')
    expect(effortOut).toContain('model_reasoning_effort=xhigh')

    // Canonical --effort flag should produce the same effect, no warning required.
    const smokeCanonical = runNode(
      root,
      ['engine/cli/spawn.mjs', 'implementer', 'smoke-effort-canonical', '--engine', 'codex', '--effort', 'high', '-p', 'hello'],
      env,
    )
    expect(smokeCanonical.status).toBe(0)
    const canonicalOut = readFileSync(join(root, '.artel', '.dispatches', 'smoke-effort-canonical.out'), 'utf8')
    expect(canonicalOut).toContain('model_reasoning_effort=high')
  })
})
