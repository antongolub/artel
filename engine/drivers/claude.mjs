// Engine driver: Claude Code CLI (`claude -p`).
//
// Universal-term mapping (DESIGN.md §5):
//   model           → --model  (only when claude-namespace; foreign values
//                     dropped per MIGRATION.md §1 "silently ignore" — see
//                     below)
//   tools           → --allowedTools
//   permission-mode → --permission-mode (claude-native)
//   sandbox         → derived --permission-mode (read-only=plan,
//                     workspace-write=acceptEdits, full-access=
//                     bypassPermissions). Best-effort: claude has no true
//                     sandbox primitive. Explicit `permission-mode` wins
//                     over derived.
//   effort          → silent ignore (claude has no analog).
//
// Cross-namespace model values:
//   Symmetric to the codex driver: a role declaring `model: gpt-5` (or any
//   OpenAI / codex-namespace value) is meaningless to claude. Drop it and
//   let claude pick the account default. Mapping foreign → claude is
//   intentionally NOT implemented — gpt-5 and opus are not equivalents.
//
// parseUsage returns null in MVP — `claude -p` emits plain text by default
// and `--output-format json` would change .out semantics. v2 work.

import { existsSync, readdirSync, statSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join } from 'node:path'
import { readJsonl } from '../util/fs.mjs'
import { runWithTimeout } from '../util/proc.mjs'

export const id = 'claude'
export const command = 'claude'
export const api_version = 1

const SANDBOX_TO_PERMISSION_MODE = {
  'read-only': 'plan',
  'workspace-write': 'acceptEdits',
  'full-access': 'bypassPermissions',
}

// Detect codex-namespace model values that don't belong on a claude CLI.
// Conservative: matches only well-known OpenAI families.
const isCodexNamespaceModel = (m) => /^(gpt-|o\d|chatgpt-|codex-)/i.test(m || '')

import { createConfig } from '../config/env.mjs'

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

  if (meta.model && !isCodexNamespaceModel(meta.model)) {
    out.push('--model', meta.model)
  }
  if (promptParts.length) out.push(promptParts.join(' '))
  return out
}

export function parseUsage () {
  // TODO v2: parse `--output-format json` envelope when wired through.
  return null
}

// Readiness probe used by `artel probe`. Returns:
//   { engine, binary, installed, version, authState, hint? }
// authState: 'ok' (binary + recent session activity)
//          | 'unknown' (binary present, no recent activity — auth state can't
//             be determined without an actual dispatch)
//          | 'missing' (binary not on PATH)
// Heuristic: claude has no stable on-disk credential file across versions;
// the strongest signal we can get without an LLM call is whether
// `~/.claude/projects/` shows recent jsonl activity.
export function probe () {
  let version = null
  try {
    const out = execSync(`${command} --version`, {
      encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'],
    })
    const m = out.match(/\d+\.\d+\.\d+/)
    version = m ? m[0] : (out.split('\n')[0] || '').trim().slice(0, 16) || null
  } catch {
    return {
      engine: id,
      binary: command,
      installed: false,
      version: null,
      authState: 'missing',
      hint: `${command} CLI not on PATH — see https://docs.anthropic.com/en/docs/claude-code`,
    }
  }
  const dir = createConfig().claudeProjectsDir
  let lastSessionMs = 0
  let sessions = 0
  if (existsSync(dir)) {
    try {
      for (const sub of readdirSync(dir)) {
        const subPath = join(dir, sub)
        try {
          if (!statSync(subPath).isDirectory()) continue
          for (const f of readdirSync(subPath)) {
            if (!f.endsWith('.jsonl')) continue
            sessions++
            const m = statSync(join(subPath, f)).mtimeMs
            if (m > lastSessionMs) lastSessionMs = m
          }
        } catch {}
      }
    } catch {}
  }
  const recent = lastSessionMs > Date.now() - 30 * 86400000
  return {
    engine: id,
    binary: command,
    installed: true,
    version,
    authState: recent ? 'ok' : 'unknown',
    hint: recent
      ? null
      : `no session activity in ${dir} (last 30d) — run \`${command}\` interactively to authenticate`,
    sessions,
  }
}

// Live ping-pong against the model — used by `artel probe --json`. Minimal
// prompt; just verify the engine round-trips a recognisable token. Cost
// is a few tokens; latency dominates by network. 30s hard timeout.
export async function roundtrip ({ timeoutMs = 30000 } = {}) {
  const r = await runWithTimeout(
    command,
    ['-p', 'Reply with exactly the single word: pong'],
    { timeoutMs },
  )
  if (r.timedOut) {
    return { status: 'down', detail: `timeout after ${timeoutMs}ms`, durationMs: r.durationMs }
  }
  if (r.code !== 0) {
    const err = (r.stderr || r.stdout || `exit ${r.code}`).trim().split('\n')[0].slice(0, 200)
    return { status: 'down', detail: `${command} exit ${r.code}: ${err}`, durationMs: r.durationMs }
  }
  const out = (r.stdout || '').trim()
  const match = /\bpong\b/i.test(out)
  return {
    status: match ? 'ok' : 'unexpected',
    detail: match
      ? `pong received in ${r.durationMs}ms`
      : `response missing "pong": ${out.slice(0, 80)}`,
    durationMs: r.durationMs,
    response: out.slice(0, 200),
  }
}

// sessionTokens: walk this project's claude session jsonl files (one
// per conversation), aggregate `assistant.message.usage` for events
// newer than `sinceMs`.
export function sessionTokens ({ projectDir, sinceMs = 0 } = {}) {
  const totals = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }
  const perDay = {}
  if (!projectDir) return { totals, perDay }

  const dir = join(createConfig().claudeProjectsDir, encodeProjectDir(projectDir))
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
