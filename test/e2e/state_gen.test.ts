import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanupTempRoots, createTempRepo, ENGINE_FILES_CORE, ENGINE_FILES_UTIL, installEngineRuntime, runNode } from '../_helpers.js'

afterEach(cleanupTempRoots)

describe('artel-state_gen', () => {
  it('frontmatter contains cluster id + name from .artel/cluster.json', () => {
    const root = createTempRepo()
    installEngineRuntime(root, ['engine/cli/state_gen.mjs', ...ENGINE_FILES_CORE, ...ENGINE_FILES_UTIL])
    writeFileSync(
      join(root, '.artel', 'cluster.json'),
      JSON.stringify({
        cluster_id: '01934f00-0000-7000-8000-aaaaaaaaaaaa',
        name: 'test-cluster',
        created_at: '2026-05-01T00:00:00.000Z',
        schema: 'cluster-v1',
      }, null, 2) + '\n',
    )

    const result = runNode(root, ['engine/cli/state_gen.mjs'])
    expect(result.status).toBe(0)
    const stateMd = readFileSync(join(root, '.artel', 'state.md'), 'utf8')
    expect(stateMd).toContain('id: "01934f00-0000-7000-8000-aaaaaaaaaaaa"')
    expect(stateMd).toContain('name: "test-cluster"')
  })
})
