import { describe, expect, it } from 'vitest'
import { claudeDriver } from '../../_helpers.js'

const { args, api_version, parseUsage } = claudeDriver

describe('claude.args', () => {
  it('translates universal model / tools / permission-mode', () => {
    const out = args(
      { body: 'role brief', model: 'opus', tools: 'Read,Edit', 'permission-mode': 'acceptEdits' },
      ['hello'],
    )
    expect(out).toContain('--model')
    expect(out).toContain('opus')
    expect(out).toContain('--allowedTools')
    expect(out).toContain('Read,Edit')
    expect(out).toContain('--permission-mode')
    expect(out).toContain('acceptEdits')
    expect(out).toContain('--append-system-prompt')
  })

  it('derives permission-mode from sandbox when explicit not set', () => {
    const out = args({ sandbox: 'workspace-write' }, [])
    const i = out.indexOf('--permission-mode')
    expect(i).toBeGreaterThanOrEqual(0)
    expect(out[i + 1]).toBe('acceptEdits')
  })

  it('explicit permission-mode wins over sandbox-derived', () => {
    const out = args({ sandbox: 'full-access', 'permission-mode': 'plan' }, [])
    const i = out.indexOf('--permission-mode')
    expect(out[i + 1]).toBe('plan')
  })

  it('silently ignores effort (no analog)', () => {
    expect(args({ effort: 'xhigh' }, []).join(' ')).not.toContain('xhigh')
  })

  it.each(['gpt-5', 'gpt-5.4', 'o3', 'chatgpt-4o', 'codex-mini'])(
    "drops codex-namespace model '%s'",
    (model) => {
      const out = args({ model }, [])
      expect(out).not.toContain('--model')
      expect(out).not.toContain(model)
    },
  )

  it.each(['opus', 'sonnet', 'haiku', 'claude-3-5-sonnet'])(
    "passes claude-namespace model '%s' through verbatim",
    (model) => {
      const out = args({ model }, [])
      expect(out).toContain('--model')
      expect(out).toContain(model)
    },
  )
})

describe('claude api_version', () => {
  it('is 1', () => expect(api_version).toBe(1))
})

describe('claude.parseUsage', () => {
  it('returns null in MVP', () => {
    expect(parseUsage('/tmp/whatever', 'session-id')).toBeNull()
  })
})
