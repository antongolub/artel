import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanupTempRoots, cluster, createTempRepo } from '../_helpers.js'

const { ensureClusterIdentity, instanceId } = cluster

afterEach(cleanupTempRoots)

describe('ensureClusterIdentity', () => {
  it('creates cluster.json on first call', () => {
    const root = createTempRepo()
    const c = ensureClusterIdentity(join(root, '.artel'))
    expect(c.cluster_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/)
    expect(c.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(c.schema).toBe('cluster-v1')
    const onDisk = JSON.parse(readFileSync(join(root, '.artel', 'cluster.json'), 'utf8'))
    expect(onDisk.cluster_id).toBe(c.cluster_id)
  })

  it('is idempotent — same id on second call', () => {
    const root = createTempRepo()
    const a = ensureClusterIdentity(join(root, '.artel'))
    const b = ensureClusterIdentity(join(root, '.artel'))
    expect(b.cluster_id).toBe(a.cluster_id)
    expect(b.created_at).toBe(a.created_at)
  })

  it('uses --name override on first bootstrap', () => {
    const root = createTempRepo()
    const c = ensureClusterIdentity(join(root, '.artel'), { name: 'my-cluster' })
    expect(c.name).toBe('my-cluster')
  })
})

describe('instanceId', () => {
  it('is stable within a process', () => {
    expect(instanceId()).toBe(instanceId())
  })
})
