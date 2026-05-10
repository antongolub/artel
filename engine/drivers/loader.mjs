// Driver plugin overlay loader (V6).
//
// Resolves engine drivers across three layered locations, in precedence
// order:
//   1. Project overlay  — <project>/.artel/drivers/<engine>.mjs
//   2. User overlay     — ~/.artel/drivers/<engine>.mjs
//   3. Platform default — <platform>/engine/drivers/<engine>.mjs
//
// Project beats user beats platform — same as skills (DESIGN.md §8.3).
// `ARTEL_USER_DRIVERS_DIR` and `ARTEL_PROJECT_DIR` env vars override the
// default locations for tests / sandboxes.

import { existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createConfig } from '../config/env.mjs'

// loader.mjs lives next to its peer drivers — the platform default dir
// is the directory containing this module.
const PLATFORM_DRIVERS_DIR = dirname(fileURLToPath(import.meta.url))

// Resolve config per call so test overrides of ARTEL_PROJECT_DIR /
// ARTEL_USER_DRIVERS_DIR between calls take effect.
const layers = () => {
  const cfg = createConfig()
  return [
    { source: 'project',  dir: cfg.driversDir },
    { source: 'user',     dir: cfg.userDriversDir },
    { source: 'platform', dir: PLATFORM_DRIVERS_DIR },
  ]
}

// Resolve `<engineId>.mjs` to its effective on-disk path + which layer
// provided it. Returns null when no layer has the driver.
export const resolveDriverPath = (engineId) => {
  for (const { source, dir } of layers()) {
    const path = join(dir, `${engineId}.mjs`)
    if (existsSync(path)) return { path, source }
  }
  return null
}

// Validate that a freshly-imported module exposes the bare minimum the
// dispatcher needs. Optional methods (parseUsage / sessionTokens / probe)
// are checked at call sites with `?.()` and missing → graceful no-op.
const REQUIRED = ['args']

const assertContract = (engineId, mod, source) => {
  for (const k of REQUIRED) {
    if (typeof mod[k] !== 'function') {
      throw new Error(
        `Driver '${engineId}' (${source}) is missing required export \`${k}()\``,
      )
    }
  }
}

// Load a single driver by id. Throws if the id is unknown across all
// overlay layers, or if the resolved module fails the contract.
export const loadDriver = async (engineId) => {
  const hit = resolveDriverPath(engineId)
  if (!hit) {
    const visible = listDrivers().join(', ') || '(none)'
    throw new Error(
      `Unknown engine: ${engineId}. Visible drivers: ${visible}`,
    )
  }
  const mod = await import(pathToFileURL(hit.path).href)
  assertContract(engineId, mod, hit.source)
  return { id: engineId, source: hit.source, path: hit.path, module: mod }
}

// Skip the loader itself + any underscore-prefixed sibling lib so the
// platform-default dir can host both the resolver and its drivers.
const SKIP = new Set(['loader.mjs'])

const dirEngines = (dir) =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith('.mjs') && !f.startsWith('_') && !SKIP.has(f))
        .map((f) => f.slice(0, -'.mjs'.length))
    : []

// Sorted unique engine ids visible across all layers. The effective
// driver for each id is the one `resolveDriverPath` would pick.
export const listDrivers = () => {
  const ids = new Set()
  for (const { dir } of layers()) for (const id of dirEngines(dir)) ids.add(id)
  return [...ids].sort()
}

// Discover + load every visible driver. Used by `artel probe` and
// other dashboards that iterate all engines. A driver that fails the
// contract throws — caller decides whether to bubble or swallow.
export const discoverDrivers = async () => {
  const out = []
  for (const id of listDrivers()) out.push(await loadDriver(id))
  return out
}
