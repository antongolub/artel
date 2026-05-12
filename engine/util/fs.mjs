// Filesystem helpers shared across drivers and runners.

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

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

// Most-recent JSONL object matching `predicate`. Used by dispatch
// lifecycle to find the prior dispatch.start / dispatch.end for a given
// dispatch_id without materialising the full stream. Returns null when
// the file is missing or no line matches.
export function findLastJsonl (path, predicate) {
  let content
  try { content = readFileSync(path, 'utf8') } catch { return null }
  const lines = content.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i]) continue
    let obj
    try { obj = JSON.parse(lines[i]) } catch { continue }
    if (predicate(obj)) return obj
  }
  return null
}

// `mtimeMs` of a path, or `null` on error. Used to short-circuit walks
// over old files.
export function mtimeMs (path) {
  try { return statSync(path).mtimeMs } catch { return null }
}

// Try-read JSON from `path`; return `null` if the file is absent,
// unreadable, or contains malformed JSON. The dispatch / cluster / status
// readers all share this shape — never throw on a missing sidecar.
export function readJson (path) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}

// Pretty-print JSON to `path` (2-space indent, trailing newline) and
// create the parent directory if needed. Non-atomic — for atomic writes
// of secrets see trust/trust.mjs:atomicWriteJson.
export function writeJson (path, body) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(body, null, 2) + '\n')
}

// List files in `dir` ending with `ext`, returning bare basenames
// (extension stripped). Missing dir → empty array. Used by run /
// state_gen for role discovery (`.md` files under agents/) and engine
// discovery (`.mjs` files under drivers/).
export function listDirBy (dir, ext) {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith(ext))
    .map((f) => f.slice(0, -ext.length))
}
