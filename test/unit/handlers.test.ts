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

  it('returns cancelled when ctx.abortSignal fires (V3.7.e)', async () => {
    const ac = new AbortController()
    // Long-running cmd that handles SIGTERM cleanly to surface the
    // cancel path. Abort fires before the cmd's own exit timer.
    setTimeout(() => ac.abort(), 50)
    const r = await runHandler(
      {
        handler: 'builtin.exec',
        cmd: 'sleep 10',
      },
      { projectDir: mktmp(), abortSignal: ac.signal },
    )
    expect(r.disposition).toBe('cancelled')
  })

  it('returns cancelled when signal already aborted at entry', async () => {
    const ac = new AbortController()
    ac.abort()
    const r = await runHandler(
      { handler: 'builtin.exec', cmd: 'sleep 5' },
      { projectDir: mktmp(), abortSignal: ac.signal },
    )
    expect(r.disposition).toBe('cancelled')
  })

  it('cancel takes precedence over timeout when both fire close together', async () => {
    // timeout_ms set, but abort fires first — disposition should be
    // `cancelled`, not `timeout`. Race tolerance: we abort 20ms in,
    // timeout would fire at 5000ms.
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 20)
    const r = await runHandler(
      { handler: 'builtin.exec', cmd: 'sleep 10', timeout_ms: 5000 },
      { projectDir: mktmp(), abortSignal: ac.signal },
    )
    expect(r.disposition).toBe('cancelled')
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

  // V3.7.d.b — dotted-path keys + unset.
  it('builds nested attrs from dotted-path keys (V3.7.d.b)', async () => {
    const r = await runHandler(
      {
        handler: 'builtin.set_attr',
        set: { 'flags.deployed': true, 'flags.staged': false, top: 'x' },
      },
      { attrs: {} },
    )
    expect(r.disposition).toBe('success')
    expect(r.attrs).toEqual({
      flags: { deployed: true, staged: false },
      top: 'x',
    })
    // set_resolved keeps the flat post-template view for events
    expect(r.set_resolved).toEqual({
      'flags.deployed': true, 'flags.staged': false, top: 'x',
    })
  })

  it('returns unsets when node.unset is set (V3.7.d.b)', async () => {
    const r = await runHandler(
      {
        handler: 'builtin.set_attr',
        set: { phase: 'next' },
        unset: ['flags.staged', 'tmp'],
      },
      { attrs: { phase: 'prev', flags: { staged: true } } },
    )
    expect(r.disposition).toBe('success')
    expect(r.attrs).toEqual({ phase: 'next' })
    expect(r.unsets).toEqual(['flags.staged', 'tmp'])
  })

  it('handles set-only / unset-only / both shapes (V3.7.d.b)', async () => {
    // unset only
    const r1 = await runHandler(
      { handler: 'builtin.set_attr', unset: ['phase'] },
      { attrs: { phase: 'x' } },
    )
    expect(r1.disposition).toBe('success')
    expect(r1.attrs).toEqual({})
    expect(r1.unsets).toEqual(['phase'])

    // set only
    const r2 = await runHandler(
      { handler: 'builtin.set_attr', set: { phase: 'x' } },
      { attrs: {} },
    )
    expect(r2.unsets).toEqual([])
  })

  it('renders templates in unset paths (V3.7.d.c)', async () => {
    const r = await runHandler(
      {
        handler: 'builtin.set_attr',
        unset: ['{{ scope }}.tmp', 'phase'],
      },
      { attrs: { scope: 'flags' } },
    )
    expect(r.disposition).toBe('success')
    expect(r.unsets).toEqual(['flags.tmp', 'phase'])
  })

  it('atomic error when unset template render fails (V3.7.d.c)', async () => {
    const r = await runHandler(
      {
        handler: 'builtin.set_attr',
        set: { phase: 'next' },        // would succeed alone
        unset: ['{{ ghost }}.tmp'],    // template fails
      },
      { attrs: {} },
    )
    expect(r.disposition).toBe('error')
    expect(r.error).toMatch(/render of \.unset entry '\{\{ ghost \}\}\.tmp' failed:.*ghost/)
    // No attrs returned — atomic, walker leaves userAttrs alone.
    expect(r.attrs).toBeUndefined()
  })

  it('renders templates in dotted-key values (V3.7.d.b)', async () => {
    const r = await runHandler(
      {
        handler: 'builtin.set_attr',
        set: { 'config.run_id': 'r-{{ pipeline_run_id }}' },
      },
      { attrs: { pipeline_run_id: 'abc' } },
    )
    expect(r.attrs).toEqual({ config: { run_id: 'r-abc' } })
  })
})

describe('builtin.git_tag (V3.7.f)', () => {
  // Spawns real git to verify the tag actually lands. Each test
  // gets a fresh ephemeral repo with one commit on `main`.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { spawnSync } = require('node:child_process') as typeof import('node:child_process')

  const initRepo = () => {
    const root = mktmp()
    spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: root })
    spawnSync('git', ['config', 'user.email', 't@t.t'], { cwd: root })
    spawnSync('git', ['config', 'user.name', 't'], { cwd: root })
    spawnSync('git', ['commit', '--allow-empty', '-m', 'initial', '-q'], { cwd: root })
    return root
  }

  const tags = (root: string) =>
    spawnSync('git', ['tag', '-l'], { cwd: root, encoding: 'utf8' })
      .stdout.trim().split('\n').filter(Boolean)

  it('creates an annotated tag at HEAD on success', async () => {
    const root = initRepo()
    const r = await runHandler(
      { handler: 'builtin.git_tag', name: 'v1.0', message: 'release one' },
      { projectDir: root, attrs: {} },
    )
    expect(r.disposition).toBe('success')
    expect(r.tag_name).toBe('v1.0')
    expect(r.annotated).toBe(true)
    expect(tags(root)).toEqual(['v1.0'])
  })

  it('creates a lightweight tag (no message)', async () => {
    const root = initRepo()
    const r = await runHandler(
      { handler: 'builtin.git_tag', name: 'lw', lightweight: true },
      { projectDir: root, attrs: {} },
    )
    expect(r.disposition).toBe('success')
    expect(r.annotated).toBe(false)
    expect(tags(root)).toEqual(['lw'])
  })

  it('renders templates in name + message + target', async () => {
    const root = initRepo()
    const r = await runHandler(
      {
        handler: 'builtin.git_tag',
        name: 'v{{ version }}',
        message: 'release {{ version }}',
      },
      { projectDir: root, attrs: { version: '2.5' } },
    )
    expect(r.disposition).toBe('success')
    expect(r.tag_name).toBe('v2.5')
    expect(tags(root)).toEqual(['v2.5'])
  })

  it('errors on duplicate tag (git rejects)', async () => {
    const root = initRepo()
    spawnSync('git', ['tag', 'v1.0'], { cwd: root })
    const r = await runHandler(
      { handler: 'builtin.git_tag', name: 'v1.0', message: 'r' },
      { projectDir: root, attrs: {} },
    )
    expect(r.disposition).toBe('error')
    expect(r.error).toMatch(/git_tag:.*already exists/)
    expect(r.tag_name).toBe('v1.0')
  })

  it('errors on missing target ref', async () => {
    const root = initRepo()
    const r = await runHandler(
      {
        handler: 'builtin.git_tag', name: 'v1.0', message: 'r',
        target: 'no-such-branch',
      },
      { projectDir: root, attrs: {} },
    )
    expect(r.disposition).toBe('error')
    expect(r.error).toMatch(/git_tag:/)
  })

  it('returns cancelled when ctx.abortSignal already aborted at entry (V3.7.f.b)', async () => {
    const root = initRepo()
    const ac = new AbortController()
    ac.abort()
    const r = await runHandler(
      { handler: 'builtin.git_tag', name: 'v1.0', message: 'r' },
      { projectDir: root, attrs: {}, abortSignal: ac.signal },
    )
    expect(r.disposition).toBe('cancelled')
    // Pre-aborted: git was killed before it could write the tag.
    expect(tags(root)).toEqual([])
  })

  it('errors when template render fails (no partial side-effect)', async () => {
    const root = initRepo()
    const r = await runHandler(
      {
        handler: 'builtin.git_tag',
        name: 'v{{ ghost }}', message: 'r',
      },
      { projectDir: root, attrs: {} },
    )
    expect(r.disposition).toBe('error')
    expect(r.error).toMatch(/template render failed:.*ghost/)
    // No tag was created
    expect(tags(root)).toEqual([])
  })
})
