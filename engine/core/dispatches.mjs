// Read-side helpers for `.artel/.dispatches/` — the sidecar directory
// where each dispatch persists its `.meta` (JSON status), `.out`
// (transcript), `.prompt` (rendered input).
//
// Pair with `core/dispatch_api.mjs` (writer side) and `core/parked.mjs`
// (narrow parsed-tail helper). status / sweep / state_gen / replay all
// walked this dir with copy-pasted try/JSON.parse loops; this collapses
// that into one primitive.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// Parse every `.meta` under `dispatchesDir`. Yields
// `{ stem, path, meta }` per file — `stem` is the filename without
// extension (consumers derive sibling `.out` / `.prompt` paths from it).
// Bad/empty JSON files are silently skipped.
export const listDispatches = (dispatchesDir) => {
  if (!existsSync(dispatchesDir)) return []
  const out = []
  for (const f of readdirSync(dispatchesDir)) {
    if (!f.endsWith('.meta')) continue
    const path = join(dispatchesDir, f)
    try { out.push({ stem: f.slice(0, -'.meta'.length), path, meta: JSON.parse(readFileSync(path, 'utf8')) }) }
    catch {}
  }
  return out
}
