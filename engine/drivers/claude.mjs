// Engine driver: Claude Code CLI (`claude -p`).
//
// Universal-term mapping (DESIGN.md §5):
//   model           → --model
//   tools           → --allowedTools
//   permission-mode → --permission-mode (claude-native)
//   sandbox         → derived --permission-mode (read-only=plan,
//                     workspace-write=acceptEdits, full-access=
//                     bypassPermissions). Best-effort: claude has no true
//                     sandbox primitive. Explicit `permission-mode` wins
//                     over derived.
//   effort          → silent ignore (claude has no analog).
//
// parseUsage returns null in MVP — `claude -p` emits plain text by default
// and `--output-format json` would change .out semantics. v2 work.

import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readJsonl } from '../util/fs.mjs'

export const id = 'claude'
export const command = 'claude'
export const api_version = 1

const SANDBOX_TO_PERMISSION_MODE = {
  'read-only': 'plan',
  'workspace-write': 'acceptEdits',
  'full-access': 'bypassPermissions',
}

const projectsDir = () =>
  process.env.ARTEL_CLAUDE_PROJECTS_DIR || join(homedir(), '.claude/projects')

// claude encodes `/Users/me/proj` → `-Users-me-proj`.
const encodeProjectDir = (dir) => '-' + dir.replace(/^\//, '').replace(/\//g, '-')

export function args (meta, promptParts, session = {}) {
  const out = ['-p']
  if (session.resumeId) out.push('--resume', session.resumeId)
  else if (session.sessionId) out.push('--session-id', session.sessionId)
  if (meta.body && meta.body.trim()) out.push('--append-system-prompt', meta.body.trim())
  if (meta.tools) out.push('--allowedTools', meta.tools)

  const permissionMode = meta['permission-mode']
    ?? (meta.sandbox ? SANDBOX_TO_PERMISSION_MODE[meta.sandbox] : null)
  if (permissionMode) out.push('--permission-mode', permissionMode)

  if (meta.model) out.push('--model', meta.model)
  if (promptParts.length) out.push(promptParts.join(' '))
  return out
}

export function parseUsage () {
  // TODO v2: parse `--output-format json` envelope when wired through.
  return null
}

// sessionTokens: walk this project's claude session jsonl files (one
// per conversation), aggregate `assistant.message.usage` for events
// newer than `sinceMs`.
export function sessionTokens ({ projectDir, sinceMs = 0 } = {}) {
  const totals = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }
  const perDay = {}
  if (!projectDir) return { totals, perDay }

  const dir = join(projectsDir(), encodeProjectDir(projectDir))
  if (!existsSync(dir)) return { totals, perDay }

  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.jsonl')) continue
    for (const e of readJsonl(join(dir, f))) {
      if (e.type !== 'assistant') continue
      const ts = Date.parse(e.timestamp)
      if (!ts || ts < sinceMs) continue
      const u = e.message?.usage
      if (!u) continue
      totals.input += u.input_tokens || 0
      totals.output += u.output_tokens || 0
      totals.cacheRead += u.cache_read_input_tokens || 0
      totals.cacheCreation += u.cache_creation_input_tokens || 0
      const day = new Date(ts).toISOString().slice(0, 10)
      perDay[day] = (perDay[day] || 0) + (u.output_tokens || 0)
    }
  }
  return { totals, perDay }
}
