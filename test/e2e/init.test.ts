import { afterEach, describe, expect, it } from 'vitest'
import { cleanupTempRoots, createTempRepo, ENGINE_FILES_CORE, ENGINE_FILES_UTIL, installEngineRuntime, runNode } from '../_helpers.js'

afterEach(cleanupTempRoots)

describe('artel init', () => {
  it('bootstraps .artel/cluster.json idempotently', () => {
    const root = createTempRepo()
    installEngineRuntime(root, ['engine/cli/init.mjs', ...ENGINE_FILES_CORE, ...ENGINE_FILES_UTIL])

    const first = runNode(root, ['engine/cli/init.mjs', '--name', 'test-cluster'])
    expect(first.status).toBe(0)
    const a = JSON.parse(first.stdout)
    expect(a.name).toBe('test-cluster')
    expect(a.cluster_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/)

    const second = runNode(root, ['engine/cli/init.mjs'])
    expect(second.status).toBe(0)
    const b = JSON.parse(second.stdout)
    expect(b.cluster_id).toBe(a.cluster_id)
    expect(b.name).toBe('test-cluster')
  })
})
