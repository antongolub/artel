// Cluster identity — bootstrap and read .artel/cluster.json.
// See DESIGN.md §12.1.
//
// `cluster_id` is stable across processes (committed to disk, optionally
// gitignored — consumer's call). `instance_id` is per-process, regenerated
// every invocation; lets observers distinguish process restarts of the same
// cluster.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { uuidv7 } from './schema.mjs'

const CLUSTER_FILE_NAME = 'cluster.json'

// Process-scoped cache. Cluster id is stable across calls in one process.
let cachedClusterId = null
let cachedInstanceId = null

const clusterFilePath = (projectArtelDir) => join(projectArtelDir, CLUSTER_FILE_NAME)

export function readClusterIdentity (projectArtelDir) {
  const path = clusterFilePath(projectArtelDir)
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

export function ensureClusterIdentity (projectArtelDir, { name = null } = {}) {
  const existing = readClusterIdentity(projectArtelDir)
  if (existing && existing.cluster_id) {
    cachedClusterId = existing.cluster_id
    return existing
  }
  mkdirSync(projectArtelDir, { recursive: true })
  const cluster = {
    cluster_id: uuidv7(),
    name: name || basename(projectArtelDir.replace(/\/?\.artel\/?$/, '')) || 'unnamed-cluster',
    created_at: new Date().toISOString(),
    schema: 'cluster-v1',
  }
  writeFileSync(clusterFilePath(projectArtelDir), JSON.stringify(cluster, null, 2) + '\n')
  cachedClusterId = cluster.cluster_id
  return cluster
}

export function clusterIdOf (projectArtelDir) {
  if (cachedClusterId) return cachedClusterId
  const existing = readClusterIdentity(projectArtelDir)
  if (existing && existing.cluster_id) {
    cachedClusterId = existing.cluster_id
    return cachedClusterId
  }
  return null
}

export function instanceId () {
  if (!cachedInstanceId) cachedInstanceId = uuidv7()
  return cachedInstanceId
}

// Test seam: reset module-scoped caches. Production callers never need this.
export function _resetCachesForTests () {
  cachedClusterId = null
  cachedInstanceId = null
}
