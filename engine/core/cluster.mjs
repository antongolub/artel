// Cluster identity (DESIGN.md §12.1).
//
// `cluster_id` is stable across processes (committed to disk under
// `.artel/cluster.json`, typically gitignored — each developer / install
// gets its own). `instance_id` is per-process: regenerated every
// invocation so observers can distinguish process restarts of the same
// cluster.

import { basename, join } from 'node:path'
import { uuidv7 } from '../util/ids.mjs'
import { readJson, writeJson } from '../util/fs.mjs'

const CLUSTER_FILE = 'cluster.json'

const clusterPath = (artelDir) => join(artelDir, CLUSTER_FILE)

export function readClusterIdentity (artelDir) {
  return readJson(clusterPath(artelDir))
}

export function ensureClusterIdentity (artelDir, { name = null } = {}) {
  const existing = readClusterIdentity(artelDir)
  if (existing?.cluster_id) return existing

  const cluster = {
    cluster_id: uuidv7(),
    name: name || basename(artelDir.replace(/\/?\.artel\/?$/, '')) || 'unnamed-cluster',
    created_at: new Date().toISOString(),
    schema: 'cluster-v1',
  }
  writeJson(clusterPath(artelDir), cluster)
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
