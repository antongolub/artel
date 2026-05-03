// E2E for driver plugin overlay (V6) — drop a custom driver into the
// project's `.artel/drivers/` and verify the dispatch pipeline picks it
// up end-to-end (run.mjs → loadDriver → custom args() → spawn).

import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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

const customDriver = `\
// Custom overlay driver — emits a sentinel arg so we can confirm it ran.
export const id = 'custom-llama'
export const command = 'echo'
export const api_version = 1
export function args (meta, promptParts) {
  return ['CUSTOM-LLAMA-OK', ...promptParts]
}
export function probe () {
  return { engine: 'custom-llama', binary: 'echo', installed: true, version: '0.0.1', authState: 'ok', hint: null }
}
`

describe('driver overlay (V6)', () => {
  it('dispatch resolves a custom driver from <project>/.artel/drivers/', () => {
    const root = createTempRepo()
    installEngineRuntime(root, [
      'engine/cli/spawn.mjs',
      'engine/cli/run.mjs',
      ...ENGINE_FILES_CORE,
      ...ENGINE_FILES_UTIL,
      ...ENGINE_FILES_DRIVERS,
    ])
    snapshotRepo(root, 'runtime')

    // Drop the overlay driver into the project's .artel/drivers/, then
    // commit so the dispatch's clean-tree precondition is satisfied.
    const overlayDir = join(root, '.artel', 'drivers')
    mkdirSync(overlayDir, { recursive: true })
    writeFileSync(join(overlayDir, 'custom-llama.mjs'), customDriver)
    snapshotRepo(root, 'add custom-llama overlay')

    // The custom driver's `command` is `echo` — universally available.
    // No stub install needed; just dispatch.
    const r = runNode(
      root,
      ['engine/cli/spawn.mjs', 'implementer', 'custom-llama-smoke', '--engine', 'custom-llama', '-p', 'hi'],
      {},
    )
    expect(r.status).toBe(0)
    const out = readFileSync(join(root, '.artel', '.dispatches', 'custom-llama-smoke.out'), 'utf8')
    expect(out).toContain('CUSTOM-LLAMA-OK')
    const meta = JSON.parse(readFileSync(join(root, '.artel', '.dispatches', 'custom-llama-smoke.meta'), 'utf8'))
    expect(meta).toMatchObject({
      engine: 'custom-llama',
      status: 'completed',
      disposition: 'success',
    })
  })

  it("'artel run --list' surfaces overlay engines", () => {
    const root = createTempRepo()
    installEngineRuntime(root, [
      'engine/cli/run.mjs',
      ...ENGINE_FILES_CORE,
      ...ENGINE_FILES_UTIL,
      ...ENGINE_FILES_DRIVERS,
    ])

    // overlay engine doesn't need to be functional for --list.
    const overlayDir = join(root, '.artel', 'drivers')
    mkdirSync(overlayDir, { recursive: true })
    writeFileSync(join(overlayDir, 'fake-engine.mjs'), 'export function args () { return [] }\n')

    // Trigger the usage help (no positional arg) to see the engines list.
    const r = runNode(root, ['engine/cli/run.mjs'], {})
    // run.mjs exits non-zero for missing args, but stderr contains the
    // 'Engines:' line we care about.
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/Engines:.*fake-engine/)
  })

  it('rejects an overlay driver missing required `args` export', () => {
    const root = createTempRepo()
    installEngineRuntime(root, [
      'engine/cli/run.mjs',
      ...ENGINE_FILES_CORE,
      ...ENGINE_FILES_UTIL,
      ...ENGINE_FILES_DRIVERS,
    ])
    const overlayDir = join(root, '.artel', 'drivers')
    mkdirSync(overlayDir, { recursive: true })
    writeFileSync(join(overlayDir, 'broken.mjs'), `export const id = 'broken'\n`)
    const stubBin = installStub(root, 'broken', '#!/usr/bin/env node\nconsole.log("noop")')
    const r = runNode(
      root,
      ['engine/cli/run.mjs', '--engine', 'broken', 'implementer', 'hi'],
      { PATH: `${stubBin}:${process.env.PATH || ''}` },
    )
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/missing required export `args/)
  })
})
