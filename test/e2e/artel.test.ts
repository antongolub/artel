// E2E for the unified `artel <cmd>` dispatcher: verifies argv routing
// to underlying CLI modules. Underlying module behaviour is covered by
// the per-subcommand tests (init.test.ts / run via spawn.test.ts / etc).

import { afterEach, describe, expect, it } from 'vitest'
import {
  cleanupTempRoots,
  createTempRepo,
  ENGINE_FILES_CORE,
  ENGINE_FILES_UTIL,
  installEngineRuntime,
  runNode,
} from '../_helpers.js'

afterEach(cleanupTempRoots)

const installArtel = (root: string, extra: string[] = []) =>
  installEngineRuntime(root, [
    'engine/cli/artel.mjs',
    ...extra,
    ...ENGINE_FILES_CORE,
    ...ENGINE_FILES_UTIL,
  ])

describe('artel dispatcher', () => {
  it('shows usage and exits non-zero with no subcommand', () => {
    const root = createTempRepo()
    installArtel(root)
    const r = runNode(root, ['engine/cli/artel.mjs'])
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/Usage: artel/)
  })

  it('exits 0 on --help', () => {
    const root = createTempRepo()
    installArtel(root)
    const r = runNode(root, ['engine/cli/artel.mjs', '--help'])
    expect(r.status).toBe(0)
    expect(r.stderr).toMatch(/init\s+\|\s+run\s+\|\s+spawn/)
  })

  it('rejects unknown subcommand', () => {
    const root = createTempRepo()
    installArtel(root)
    const r = runNode(root, ['engine/cli/artel.mjs', 'frobnicate'])
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/unknown command 'frobnicate'/)
  })

  it("routes 'init --name X' through to init.mjs", () => {
    const root = createTempRepo()
    installArtel(root, ['engine/cli/init.mjs'])
    const r = runNode(root, ['engine/cli/artel.mjs', 'init', '--name', 'via-dispatcher'])
    expect(r.status).toBe(0)
    const cluster = JSON.parse(r.stdout)
    expect(cluster.name).toBe('via-dispatcher')
    expect(cluster.cluster_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/)
  })

  it("propagates exit code from subcommand (checkpoint without env → non-zero)", () => {
    const root = createTempRepo()
    installArtel(root, ['engine/cli/checkpoint.mjs'])
    const r = runNode(root, ['engine/cli/artel.mjs', 'checkpoint', '--completed', 'a', '--next', 'b'])
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/ARTEL_DISPATCH_ID/)
  })
})
