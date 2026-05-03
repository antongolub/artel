import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanupTempRoots, codexDriver, createTempRepo } from '../../_helpers.js'

const { args, api_version, parseUsage, sessionTokens } = codexDriver

afterEach(cleanupTempRoots)

describe('codex.args', () => {
  it('translates universal model / effort / sandbox', () => {
    const out = args({ model: 'gpt-5', effort: 'high', sandbox: 'read-only' }, ['hello'])
    expect(out).toContain('-m')
    expect(out).toContain('gpt-5')
    expect(out.join(' ')).toContain('model_reasoning_effort=high')
    expect(out.join(' ')).toContain('disk-full-read-access')
  })

  it('back-compat: reads codex-effort when canonical effort missing', () => {
    expect(args({ 'codex-effort': 'medium' }, []).join(' ')).toContain('model_reasoning_effort=medium')
  })

  it('canonical effort wins over legacy codex-effort', () => {
    const out = args({ effort: 'high', 'codex-effort': 'low' }, [])
    expect(out.join(' ')).toContain('model_reasoning_effort=high')
    expect(out.join(' ')).not.toContain('model_reasoning_effort=low')
  })

  it('canonical model wins over legacy codex-model', () => {
    const out = args({ model: 'gpt-5', 'codex-model': 'o3' }, [])
    expect(out).toContain('gpt-5')
    expect(out).not.toContain('o3')
  })

  it('silently ignores tools (no allowlist in CLI)', () => {
    expect(args({ tools: 'Read,Edit' }, []).join(' ')).not.toContain('Read,Edit')
  })

  it('silently ignores permission-mode', () => {
    expect(args({ 'permission-mode': 'acceptEdits' }, []).join(' ')).not.toContain('acceptEdits')
  })
})

describe('codex api_version', () => {
  it('is 1', () => expect(api_version).toBe(1))
})

describe('codex.parseUsage', () => {
  it('returns null when no matching session file', () => {
    const root = createTempRepo()
    const sessionsDir = join(root, 'fake-codex-sessions')
    mkdirSync(sessionsDir, { recursive: true })
    const saved = process.env.ARTEL_CODEX_SESSIONS_DIR
    process.env.ARTEL_CODEX_SESSIONS_DIR = sessionsDir
    try {
      expect(parseUsage('/tmp/whatever', 'no-such-session')).toBeNull()
    } finally {
      if (saved) process.env.ARTEL_CODEX_SESSIONS_DIR = saved
      else delete process.env.ARTEL_CODEX_SESSIONS_DIR
    }
  })

  it('extracts last token_count totals from a session file', () => {
    const root = createTempRepo()
    const sessionsDir = join(root, 'fake-codex-sessions', '2026', '05', '02')
    mkdirSync(sessionsDir, { recursive: true })
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const path = join(sessionsDir, `rollout-${sessionId}.jsonl`)
    const lines = [
      { type: 'session_meta', payload: { id: sessionId, model: 'gpt-5', cwd: '/some/dir' } },
      { type: 'event_msg', timestamp: '2026-05-02T10:00:00.000Z', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1000, output_tokens: 500, cached_input_tokens: 100 } } } },
      { type: 'event_msg', timestamp: '2026-05-02T10:01:00.000Z', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 2000, output_tokens: 1500, cached_input_tokens: 300 } } } },
    ]
    writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')

    const saved = process.env.ARTEL_CODEX_SESSIONS_DIR
    process.env.ARTEL_CODEX_SESSIONS_DIR = join(root, 'fake-codex-sessions')
    try {
      const usage = parseUsage('/tmp/unused', sessionId)
      expect(usage).not.toBeNull()
      expect(usage!.tokens_in).toBe(1700) // 2000 - 300 cached
      expect(usage!.tokens_out).toBe(1500)
      expect(usage!.cache_read).toBe(300)
      expect(usage!.model).toBe('gpt-5')
      expect(usage!.cost_usd).toBeNull()
    } finally {
      if (saved) process.env.ARTEL_CODEX_SESSIONS_DIR = saved
      else delete process.env.ARTEL_CODEX_SESSIONS_DIR
    }
  })
})

describe('codex.sessionTokens', () => {
  it('returns empty totals when no projectName provided', () => {
    expect(sessionTokens({}).totals).toEqual({ input: 0, output: 0, cached: 0 })
  })
})
