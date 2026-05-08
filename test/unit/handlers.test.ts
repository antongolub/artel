// Unit tests for engine/util/handlers.mjs — runHandler + builtins
// (V3.7.a). These actually spawn shell commands so they're slower
// than pure-unit tests; the suite stays bounded by using `true` /
// `false` / minimal `node -e` snippets.

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runHandler, knownHandlers } from '../../engine/util/handlers.mjs'

const tempDirs: string[] = []
const mktmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'artel-handlers-test-'))
  tempDirs.push(d)
  return d
}
afterEach(() => {
  for (const d of tempDirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }) } catch {}
  }
})

describe('runHandler dispatch table', () => {
  it('knownHandlers lists builtin.exec', () => {
    expect(knownHandlers()).toContain('builtin.exec')
  })

  it('throws on unknown handler name', async () => {
    await expect(runHandler({ handler: 'builtin.ghost' }, { projectDir: '/tmp' }))
      .rejects.toThrow(/Unknown handler/)
  })
})

describe('builtin.exec', () => {
  it('returns success on exit 0', async () => {
    const r = await runHandler(
      { handler: 'builtin.exec', cmd: 'true' },
      { projectDir: mktmp() },
    )
    expect(r.disposition).toBe('success')
    expect(r.exitCode).toBe(0)
    expect(typeof r.durationMs).toBe('number')
  })

  it('returns error on non-zero exit', async () => {
    const r = await runHandler(
      { handler: 'builtin.exec', cmd: 'exit 7' },
      { projectDir: mktmp() },
    )
    expect(r.disposition).toBe('error')
    expect(r.exitCode).toBe(7)
  })

  it('runs in projectDir cwd', async () => {
    const dir = mktmp()
    // pwd in the dir should match — bash resolves symlinks via -P
    // for stable comparison with realpath.
    const r = await runHandler(
      { handler: 'builtin.exec', cmd: `[ "$(pwd -P)" = "$(cd "${dir}" && pwd -P)" ]` },
      { projectDir: dir },
    )
    expect(r.disposition).toBe('success')
  })

  it('honours pipes / && / shell features', async () => {
    const r = await runHandler(
      { handler: 'builtin.exec', cmd: 'echo hi | grep -q hi && true' },
      { projectDir: mktmp() },
    )
    expect(r.disposition).toBe('success')
  })

  it('returns timeout when cmd exceeds timeout_ms', async () => {
    const r = await runHandler(
      { handler: 'builtin.exec', cmd: 'sleep 5', timeout_ms: 100 },
      { projectDir: mktmp() },
    )
    expect(r.disposition).toBe('timeout')
    // SIGTERM kills the bash; node sees signal: 'SIGTERM' and exitCode
    // null. We only assert the disposition — node may surface either
    // exitCode=143 or signal='SIGTERM' depending on timing.
  })

  it('returns error when bash hits a syntax error', async () => {
    // Unbalanced `do` triggers a parse error → bash exits non-zero.
    const r = await runHandler(
      { handler: 'builtin.exec', cmd: 'do' },
      { projectDir: mktmp() },
    )
    expect(r.disposition).toBe('error')
    expect(r.exitCode).not.toBe(0)
  })
})

describe('builtin.assert (V3.7.c)', () => {
  it('returns success when predicate evaluates true', async () => {
    const r = await runHandler(
      { handler: 'builtin.assert', if: { attr: 'env', equals: 'prod' } },
      { attrs: { env: 'prod' } },
    )
    expect(r.disposition).toBe('success')
    expect(r.error).toBeUndefined()
    expect(typeof r.durationMs).toBe('number')
  })

  it('returns error when predicate evaluates false', async () => {
    const r = await runHandler(
      { handler: 'builtin.assert', if: { attr: 'env', equals: 'prod' } },
      { attrs: { env: 'dev' } },
    )
    expect(r.disposition).toBe('error')
    // Default message when none supplied.
    expect(r.error).toBe('assertion failed')
  })

  it('renders custom message via V3.5 template substitution', async () => {
    const r = await runHandler(
      {
        handler: 'builtin.assert',
        if: { attr: 'approved', equals: true },
        message: 'deploy of {{ target }} blocked: approval flag missing',
      },
      { attrs: { approved: false, target: 'prod' } },
    )
    expect(r.disposition).toBe('error')
    expect(r.error).toBe('deploy of prod blocked: approval flag missing')
  })

  it('handles compound predicates (V3.6 and/or/not)', async () => {
    const node = {
      handler: 'builtin.assert',
      if: {
        and: [
          { attr: 'env', equals: 'prod' },
          { not: { attr: 'paused', equals: true } },
        ],
      },
    }
    const r1 = await runHandler(node, { attrs: { env: 'prod', paused: false } })
    expect(r1.disposition).toBe('success')

    const r2 = await runHandler(node, { attrs: { env: 'prod', paused: true } })
    expect(r2.disposition).toBe('error')

    const r3 = await runHandler(node, { attrs: { env: 'dev' } })
    expect(r3.disposition).toBe('error')
  })

  it('treats missing attrs object as empty (every check fail-closed)', async () => {
    // No ctx.attrs → builtin reads from {} → exists=true is false →
    // routes through error.
    const r = await runHandler(
      { handler: 'builtin.assert', if: { attr: 'flag', exists: true } },
      { /* no attrs */ },
    )
    expect(r.disposition).toBe('error')
  })

  it('reports template error in message field rather than crashing', async () => {
    const r = await runHandler(
      {
        handler: 'builtin.assert',
        if: { attr: 'x', equals: 1 },
        message: 'x={{ x }} y={{ ghost }}',  // ghost is missing
      },
      { attrs: { x: 0 } },
    )
    expect(r.disposition).toBe('error')
    expect(r.error).toMatch(/\[message render failed:.*ghost/)
  })

  it('reads dotted-path attrs', async () => {
    const r = await runHandler(
      { handler: 'builtin.assert', if: { attr: 'env.target', in: ['staging', 'prod'] } },
      { attrs: { env: { target: 'staging' } } },
    )
    expect(r.disposition).toBe('success')
  })

  it('comparison ops fail-closed on missing attr (V3.6 semantics)', async () => {
    const r = await runHandler(
      { handler: 'builtin.assert', if: { attr: 'score', gte: 0.8 } },
      { attrs: {} },
    )
    expect(r.disposition).toBe('error')
  })
})

describe('builtin.set_attr (V3.7.d)', () => {
  it('returns success with attrs payload for the walker to merge', async () => {
    const r = await runHandler(
      { handler: 'builtin.set_attr', set: { phase: 'reviewed', count: 7 } },
      { attrs: {} },
    )
    expect(r.disposition).toBe('success')
    expect(r.attrs).toEqual({ phase: 'reviewed', count: 7 })
    expect(r.set_resolved).toEqual({ phase: 'reviewed', count: 7 })
  })

  it('passes through scalar values (number / boolean / null)', async () => {
    const r = await runHandler(
      {
        handler: 'builtin.set_attr',
        set: { count: 42, ready: true, blocked: false, last_error: null },
      },
      { attrs: {} },
    )
    expect(r.attrs).toEqual({ count: 42, ready: true, blocked: false, last_error: null })
  })

  it('renders string values via V3.5 templates against ctx.attrs', async () => {
    const r = await runHandler(
      {
        handler: 'builtin.set_attr',
        set: {
          tag: 'reviewed-{{ pipeline_run_id }}',
          target: '{{ env }}-deploy',
        },
      },
      { attrs: { pipeline_run_id: 'abc123', env: 'prod' } },
    )
    expect(r.attrs).toEqual({ tag: 'reviewed-abc123', target: 'prod-deploy' })
  })

  it('errors atomically when any string template fails (no partial mutation)', async () => {
    const r = await runHandler(
      {
        handler: 'builtin.set_attr',
        set: {
          good: 'computed-{{ env }}',
          bad: 'needs-{{ ghost }}',     // ghost missing → throw
          also_good: 42,
        },
      },
      { attrs: { env: 'prod' } },
    )
    expect(r.disposition).toBe('error')
    expect(r.error).toMatch(/set_attr: render of \.set\['bad'\] failed:.*missing attribute 'ghost'/)
    // No attrs returned — atomic, walker leaves userAttrs untouched.
    expect(r.attrs).toBeUndefined()
  })

  it('does not recursively re-render the resolved value', async () => {
    // The resolved value contains template syntax literally; that's
    // by design (V3.5 contract). A subsequent set_attr or template
    // render would catch it, but the immediate result is verbatim.
    const r = await runHandler(
      { handler: 'builtin.set_attr', set: { x: '{{ y }}' } },
      { attrs: { y: '{{ z }}', z: 'hello' } },
    )
    expect(r.attrs.x).toBe('{{ z }}')
  })
})
