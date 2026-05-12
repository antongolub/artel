// Parse `QUEUE.md` — the human-edited markdown queue (AGENTS.md §Queue).
//
// Layout: optional header lines, then `## <Section>` blocks each
// containing `- <text>` bullets with optional `  <continuation>` lines.
// `(none)` placeholders are normalised away. Sections outside the
// canonical allowlist are ignored, missing sections are backfilled empty
// so writers can round-trip without losing structure.
//
// Three CLIs (status / state_gen / queue) had copy-pasted variants of
// this scanner; this is the single source of truth. Consumers fold the
// `{text, details}` item shape into a flat string when that's all they
// need (queue.mjs round-trips them flat; status.mjs renders flat).

import { existsSync, readFileSync } from 'node:fs'

export const QUEUE_SECTIONS = ['For Owner', 'In progress', 'Pending', 'Blocked', 'Recently done']

const emptySections = () =>
  Object.fromEntries(QUEUE_SECTIONS.map((s) => [s, []]))

// Parse markdown text. Returns:
//   { header: string[], sections: Record<sectionName, Array<{text, details}>> }
// Sections always include all QUEUE_SECTIONS keys (empty arrays if
// absent in the source). Header is everything before the first `##`,
// regardless of whether that first section is canonical.
export const parseQueueMd = (text) => {
  const sections = emptySections()
  const header = []
  let seenSection = false
  let cur = null
  let item = null
  const flush = () => {
    if (item && cur) sections[cur].push(item)
    item = null
  }
  for (const line of text.split('\n')) {
    const sec = line.match(/^## (.+)$/)
    if (sec) {
      flush()
      seenSection = true
      cur = QUEUE_SECTIONS.includes(sec[1]) ? sec[1] : null
      continue
    }
    if (!seenSection) { header.push(line); continue }
    if (!cur) continue              // inside an unknown section — drop content
    const bullet = line.match(/^- (.+)$/)
    if (bullet) {
      flush()
      item = { text: bullet[1], details: [] }
      continue
    }
    const cont = line.match(/^  (.+)$/)
    if (cont && item) item.details.push(cont[1])
  }
  flush()
  // Drop `(none)` placeholders so callers don't have to special-case.
  for (const k of QUEUE_SECTIONS) sections[k] = sections[k].filter((it) => !it.text.startsWith('(none)'))
  return { header, sections }
}

// Read + parse, returning empty sections if the file is missing. Most
// CLI readers want this; the `missing` flag distinguishes "no queue
// yet" from "queue exists but empty".
export const readQueueMd = (queuePath) => {
  if (!existsSync(queuePath)) {
    return { header: [], sections: emptySections(), missing: true }
  }
  return { ...parseQueueMd(readFileSync(queuePath, 'utf8')), missing: false }
}

// Fold {text, details} → "text d1 d2 d3" for callers that don't care
// about the continuation split.
export const flattenItem = (item) =>
  item.details.length ? `${item.text} ${item.details.join(' ')}` : item.text
