// Filesystem helpers shared across drivers and runners.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

// Recursively yield all .jsonl files under `root`. Tolerates broken
// permissions and missing files silently — caller decides what to do
// with an empty result.
export function * walkJsonl (root) {
  if (!existsSync(root)) return
  const stack = [root]
  while (stack.length) {
    const dir = stack.pop()
    let entries
    try { entries = readdirSync(dir) } catch { continue }
    for (const name of entries) {
      const path = join(dir, name)
      let st
      try { st = statSync(path) } catch { continue }
      if (st.isDirectory()) stack.push(path)
      else if (name.endsWith('.jsonl')) yield path
    }
  }
}

// Stream JSON objects from a JSONL file. Skips blank lines and parse
// errors; never throws. Returns an array (callers tend to want random
// access for delta-tracking) — switch to a generator if memory matters.
export function readJsonl (path) {
  let content
  try { content = readFileSync(path, 'utf8') } catch { return [] }
  const out = []
  for (const line of content.split('\n')) {
    if (!line) continue
    try { out.push(JSON.parse(line)) } catch { /* skip */ }
  }
  return out
}

// `mtimeMs` of a path, or `null` on error. Used to short-circuit walks
// over old files.
export function mtimeMs (path) {
  try { return statSync(path).mtimeMs } catch { return null }
}
