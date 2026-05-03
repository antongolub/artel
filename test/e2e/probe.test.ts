// E2E for `artel probe` — engine readiness checks.
// Tests use the installStub pattern: fake `claude` / `codex` / `gh` binaries
// in a per-test bin dir, PATH override, and per-engine env to point at the
// test's auth fixtures (CODEX_HOME, ARTEL_CLAUDE_PROJECTS_DIR).

import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import {
  cleanupTempRoots,
  createTempRepo,
  ENGINE_FILES_CORE,
  ENGINE_FILES_DRIVERS,
  ENGINE_FILES_UTIL,
  installEngineRuntime,
  installStub,
  runNode,
} from '../_helpers.js'

afterEach(cleanupTempRoots)

const installProbe = (root: string) =>
  installEngineRuntime(root, [
    'engine/cli/probe.mjs',
    ...ENGINE_FILES_CORE,
    ...ENGINE_FILES_DRIVERS,
    ...ENGINE_FILES_UTIL,
  ])

// Stub that fails any invocation — simulates "binary not on PATH" by
// shadowing the real binary with a script that always exits non-zero.
const stubFail = ['#!/usr/bin/env node', 'process.exit(127)', ''].join('\n')

const stubVersion = (vline: string) =>
  ['#!/usr/bin/env node',
   `const a = process.argv.slice(2).join(' ');`,
   `if (a.includes('copilot -- --version')) { console.log('copilot 1.0.42'); }`,
   `else if (a.includes('auth status')) { process.exit(0); }`,
   `else if (a.includes('--version')) { console.log(${JSON.stringify(vline)}); }`,
   `else { process.exit(0); }`,
   ''].join('\n')

// Install fail-stubs for all three engines, shadowing whatever's on the
// host PATH. Returns the bin dir to prepend.
const shadowAllAsMissing = (root: string) => {
  const a = installStub(root, 'claude', stubFail)
  installStub(root, 'codex', stubFail)
  installStub(root, 'gh', stubFail)
  return a
}

describe('artel probe', () => {
  it('reports all three engines missing when binaries fail to run', () => {
    const root = createTempRepo()
    installProbe(root)
    const binDir = shadowAllAsMissing(root)
    const r = runNode(root, ['engine/cli/probe.mjs'], {
      PATH: `${binDir}:${process.env.PATH || ''}`,
    })
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('claude')
    expect(r.stdout).toContain('codex')
    expect(r.stdout).toContain('copilot')
    expect(r.stdout).toContain('not installed')
    expect(r.stdout).toMatch(/0\/3 engines ready/)
  })

  it('reports codex as no-auth when auth.json absent', () => {
    const root = createTempRepo()
    installProbe(root)
    const binDir = installStub(root, 'codex', stubVersion('codex 0.125.0'))
    // Shadow the others as missing so we isolate codex behaviour.
    installStub(root, 'claude', stubFail)
    installStub(root, 'gh', stubFail)
    const codexHome = join(root, 'fake-codex')
    mkdirSync(codexHome, { recursive: true })
    const r = runNode(root, ['engine/cli/probe.mjs'], {
      PATH: `${binDir}:${process.env.PATH || ''}`,
      CODEX_HOME: codexHome,
    })
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('0.125.0')
    expect(r.stdout).toContain('no auth')
    expect(r.stdout).toContain('auth.json not found')
  })

  it('reports all three engines ready with stub binaries + auth fixtures', () => {
    const root = createTempRepo()
    installProbe(root)
    const binDir = installStub(root, 'codex', stubVersion('codex 0.125.0'))
    installStub(root, 'claude', stubVersion('claude 2.1.0'))
    installStub(root, 'gh', stubVersion('gh 2.50.0'))
    const codexHome = join(root, 'fake-codex')
    mkdirSync(codexHome, { recursive: true })
    writeFileSync(join(codexHome, 'auth.json'), '{"token":"fake"}')
    // claude needs recent session activity for 'ok' state.
    const claudeProjects = join(root, 'fake-claude-projects', '-some-project')
    mkdirSync(claudeProjects, { recursive: true })
    const sessionFile = join(claudeProjects, 'session.jsonl')
    writeFileSync(sessionFile, '{"type":"user"}\n')
    utimesSync(sessionFile, new Date(), new Date())
    const r = runNode(root, ['engine/cli/probe.mjs'], {
      PATH: `${binDir}:${process.env.PATH || ''}`,
      CODEX_HOME: codexHome,
      ARTEL_CLAUDE_PROJECTS_DIR: join(root, 'fake-claude-projects'),
    })
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/3\/3 engines ready/)
  })

  it('emits JSON when --json passed', () => {
    const root = createTempRepo()
    installProbe(root)
    const binDir = shadowAllAsMissing(root)
    const r = runNode(root, ['engine/cli/probe.mjs', '--json'], {
      PATH: `${binDir}:${process.env.PATH || ''}`,
    })
    expect(r.status).toBe(1)
    const parsed = JSON.parse(r.stdout)
    expect(parsed).toHaveLength(3)
    expect(parsed.map((x: { engine: string }) => x.engine)).toEqual(['claude', 'codex', 'copilot'])
    for (const x of parsed) {
      expect(x.installed).toBe(false)
      expect(x.authState).toBe('missing')
      expect(x.hint).toMatch(/not on PATH/)
    }
  })

  it("routes via 'artel probe' through the dispatcher", () => {
    const root = createTempRepo()
    installEngineRuntime(root, [
      'engine/cli/artel.mjs',
      'engine/cli/probe.mjs',
      ...ENGINE_FILES_CORE,
      ...ENGINE_FILES_DRIVERS,
      ...ENGINE_FILES_UTIL,
    ])
    const binDir = shadowAllAsMissing(root)
    const r = runNode(root, ['engine/cli/artel.mjs', 'probe', '--json'], {
      PATH: `${binDir}:${process.env.PATH || ''}`,
    })
    expect(r.status).toBe(1)
    expect(() => JSON.parse(r.stdout)).not.toThrow()
  })
})
