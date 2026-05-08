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
