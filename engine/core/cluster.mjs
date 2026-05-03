// Cluster identity (DESIGN.md §12.1).
//
// `cluster_id` is stable across processes (committed to disk under
// `.artel/cluster.json`, typically gitignored — each developer / install
// gets its own). `instance_id` is per-process: regenerated every
// invocation so observers can distinguish process restarts of the same
// cluster.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { uuidv7 } from '../util/ids.mjs'

const CLUSTER_FILE = 'cluster.json'

const clusterPath = (artelDir) => join(artelDir, CLUSTER_FILE)

export function readClusterIdentity (artelDir) {
  const path = clusterPath(artelDir)
  if (!existsSync(path)) return null
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}

export function ensureClusterIdentity (artelDir, { name = null } = {}) {
  const existing = readClusterIdentity(artelDir)
  if (existing?.cluster_id) return existing

  mkdirSync(artelDir, { recursive: true })
  const cluster = {
    cluster_id: uuidv7(),
    name: name || basename(artelDir.replace(/\/?\.artel\/?$/, '')) || 'unnamed-cluster',
    created_at: new Date().toISOString(),
    schema: 'cluster-v1',
  }
  writeFileSync(clusterPath(artelDir), JSON.stringify(cluster, null, 2) + '\n')
  return cluster
}

let cachedInstanceId = null
export function instanceId () {
  if (!cachedInstanceId) cachedInstanceId = uuidv7()
  return cachedInstanceId
}

// Test seam: reset module-scoped cache. Production callers never need this.
export function _resetCachesForTests () {
  cachedInstanceId = null
}
