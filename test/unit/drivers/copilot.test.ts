import { describe, expect, it } from 'vitest'
import { copilotDriver } from '../../_helpers.js'

const { args, api_version, parseUsage, sessionTokens } = copilotDriver

describe('copilot.args', () => {
  it('translates universal model / tools / sandbox=full-access', () => {
    const out = args(
      { model: 'claude-sonnet-4', tools: 'Read,Edit', sandbox: 'full-access' },
      ['hello'],
    )
    expect(out).toContain('--model')
    expect(out).toContain('claude-sonnet-4')
    expect(out).toContain('--available-tools')
    expect(out).toContain('Read,Edit')
    expect(out).toContain('--allow-all-paths')
    expect(out).toContain('--allow-all-urls')
  })

  it('back-compat: reads copilot-tools / copilot-model when canonical missing', () => {
    const out = args({ 'copilot-tools': 'Read', 'copilot-model': 'gpt-4' }, [])
    expect(out).toContain('Read')
    expect(out).toContain('gpt-4')
  })

  it('canonical wins over legacy', () => {
    const out = args({ model: 'newer', 'copilot-model': 'older', tools: 'A', 'copilot-tools': 'B' }, [])
    expect(out).toContain('newer')
    expect(out).not.toContain('older')
    expect(out).toContain('A')
    expect(out).not.toContain('B')
  })

  it('silently ignores effort and permission-mode', () => {
    const out = args({ effort: 'xhigh', 'permission-mode': 'plan' }, [])
    expect(out.join(' ')).not.toContain('xhigh')
    expect(out.join(' ')).not.toContain('plan')
  })
})

describe('copilot api_version', () => {
  it('is 1', () => expect(api_version).toBe(1))
})

describe('copilot.parseUsage', () => {
  it('returns null', () => expect(parseUsage()).toBeNull())
})

describe('copilot.sessionTokens', () => {
  it('returns empty totals when no projectName provided', () => {
    expect(sessionTokens({}).totals).toEqual({ input: 0, output: 0, cached: 0, reasoning: 0 })
  })
})
