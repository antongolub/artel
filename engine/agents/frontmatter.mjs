// Markdown frontmatter parser + normaliser.
//
// Format: `---\n<lines>\n---\n<body>`. Each line is `key: value`.
// Unknown shapes return empty meta + the original text as body.

const FENCE_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/
const KV_RE = /^([a-zA-Z0-9_-]+):\s*(.*)$/

export const parseFrontmatter = (text) => {
  const match = text.match(FENCE_RE)
  if (!match) return { meta: {}, body: text }
  const meta = {}
  for (const line of match[1].split('\n')) {
    const m = line.match(KV_RE)
    if (m) meta[m[1]] = m[2].trim()
  }
  return { meta, body: match[2] }
}

// Map of legacy-key → canonical-key. When a deprecated key appears, log a
// warning and rewrite it (canonical wins if both present). Drivers also read
// both for resilience when invoked outside run.mjs.
export const DEPRECATED_FRONTMATTER_KEYS = {
  'codex-model': 'model',
  'codex-effort': 'effort',
  'copilot-model': 'model',
  'copilot-tools': 'tools',
}

export const normaliseFrontmatter = (meta, source = '<unknown>') => {
  for (const [legacy, canonical] of Object.entries(DEPRECATED_FRONTMATTER_KEYS)) {
    if (meta[legacy] === undefined) continue
    console.error(`warning: frontmatter "${legacy}" is deprecated; use "${canonical}" (in ${source})`)
    if (meta[canonical] === undefined) meta[canonical] = meta[legacy]
    delete meta[legacy]
  }
  return meta
}
