// E2E for V11 — agent identity injection through dispatch + `artel trust list`.
//
// We use a stub `claude` binary that prints `process.env.GIT_AUTHOR_NAME` etc.
// to its .out so we can assert the lifecycle injected the right env.

import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
  snapshotRepo,
} from '../_helpers.js'

afterEach(cleanupTempRoots)

const installAll = (root: string) =>
  installEngineRuntime(root, [
    'engine/cli/spawn.mjs',
    'engine/cli/run.mjs',
    'engine/cli/trust.mjs',
    ...ENGINE_FILES_CORE,
    ...ENGINE_FILES_DRIVERS,
    ...ENGINE_FILES_UTIL,
  ])

const writeIdentities = (root: string, body: object) => {
  mkdirSync(join(root, '.artel', 'trust'), { recursive: true })
  writeFileSync(join(root, '.artel', 'trust', 'identities.json'), JSON.stringify(body, null, 2))
}

// stub claude that dumps relevant env vars to stdout
const envEchoStub = ['#!/usr/bin/env node',
  `for (const k of ['GIT_AUTHOR_NAME','GIT_AUTHOR_EMAIL','GIT_COMMITTER_NAME','GIT_COMMITTER_EMAIL','GIT_SSH_COMMAND','ARTEL_IDENTITY']) {`,
  `  if (process.env[k] !== undefined) console.log(\`\${k}=\${process.env[k]}\`)`,
  `}`,
  ''].join('\n')

describe('artel spawn — identity injection (V11)', () => {
  it('frontmatter `identity:` flows GIT_* env into the child', () => {
    const root = createTempRepo()
    installAll(root)
    // Override the platform implementer.md (createTempRepo's stub) with one
    // that declares `identity: bot` in frontmatter.
    writeFileSync(join(root, 'agents', 'implementer.md'),
      ['---', 'name: implementer', 'description: test',
       'schema: role-v1', 'version: 1', 'updated_at: 2026-05-04T00:00:00.000Z',
       'engine: claude', 'identity: bot', '---', 'implementer'].join('\n'))
    writeIdentities(root, {
      bot: { name: 'artel-bot', email: 'artel-bot@cluster.local', ssh_key: '/keys/bot' },
    })
    snapshotRepo(root, 'with bot identity')

    const binDir = installStub(root, 'claude', envEchoStub)
    installStub(root, 'codex', '#!/usr/bin/env node\nconsole.log("noop")')

    const r = runNode(
      root,
      ['engine/cli/spawn.mjs', 'implementer', 'identity-fm', '-p', 'hello'],
      { PATH: `${binDir}:${process.env.PATH || ''}` },
    )
    expect(r.status).toBe(0)
    const out = readFileSync(join(root, '.artel', '.dispatches', 'identity-fm.out'), 'utf8')
    expect(out).toContain('GIT_AUTHOR_NAME=artel-bot')
    expect(out).toContain('GIT_AUTHOR_EMAIL=artel-bot@cluster.local')
    expect(out).toContain('GIT_COMMITTER_NAME=artel-bot')
    expect(out).toContain('GIT_COMMITTER_EMAIL=artel-bot@cluster.local')
    expect(out).toContain('GIT_SSH_COMMAND=ssh -i "/keys/bot" -o IdentitiesOnly=yes')
    expect(out).toContain('ARTEL_IDENTITY=bot')
  })

  it('--identity CLI override beats frontmatter', () => {
    const root = createTempRepo()
    installAll(root)
    writeFileSync(join(root, 'agents', 'implementer.md'),
      ['---', 'name: implementer', 'description: test',
       'schema: role-v1', 'version: 1', 'updated_at: 2026-05-04T00:00:00.000Z',
       'engine: claude', 'identity: bot', '---', 'implementer'].join('\n'))
    writeIdentities(root, {
      bot: { name: 'artel-bot', email: 'artel-bot@x' },
      hotfix: { name: 'hotfix-runner', email: 'hotfix@x' },
    })
    snapshotRepo(root, 'two identities')

    const binDir = installStub(root, 'claude', envEchoStub)

    const r = runNode(
      root,
      ['engine/cli/spawn.mjs', 'implementer', 'identity-cli', '-p', 'hi', '--identity', 'hotfix'],
      { PATH: `${binDir}:${process.env.PATH || ''}` },
    )
    expect(r.status).toBe(0)
    const out = readFileSync(join(root, '.artel', '.dispatches', 'identity-cli.out'), 'utf8')
    expect(out).toContain('GIT_AUTHOR_NAME=hotfix-runner')
    expect(out).toContain('GIT_COMMITTER_EMAIL=hotfix@x')
    expect(out).not.toContain('artel-bot')
    expect(out).toContain('ARTEL_IDENTITY=hotfix')
  })

  it('no identity declared → child inherits operator env (no GIT_AUTHOR override)', () => {
    const root = createTempRepo()
    installAll(root)
    snapshotRepo(root, 'no identity')

    const binDir = installStub(root, 'claude', envEchoStub)
    const r = runNode(
      root,
      ['engine/cli/spawn.mjs', 'implementer', 'identity-none', '-p', 'hi'],
      {
        PATH: `${binDir}:${process.env.PATH || ''}`,
        // Explicitly clear so the assertion is meaningful even when the
        // host env happens to have a GIT_AUTHOR_NAME set.
        GIT_AUTHOR_NAME: '',
        GIT_AUTHOR_EMAIL: '',
      },
    )
    expect(r.status).toBe(0)
    const out = readFileSync(join(root, '.artel', '.dispatches', 'identity-none.out'), 'utf8')
    // Lifecycle should not inject when no identity is declared. ARTEL_IDENTITY
    // also stays unset.
    expect(out).not.toContain('ARTEL_IDENTITY=')
  })

  it('unknown identity name fails the dispatch with a helpful error', () => {
    const root = createTempRepo()
    installAll(root)
    writeIdentities(root, { bot: { name: 'bot', email: 'bot@x' } })
    snapshotRepo(root, 'one identity')

    const binDir = installStub(root, 'claude', envEchoStub)
    const r = runNode(
      root,
      ['engine/cli/spawn.mjs', 'implementer', 'identity-bad', '-p', 'hi', '--identity', 'ghost'],
      { PATH: `${binDir}:${process.env.PATH || ''}` },
    )
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/unknown identity 'ghost'.*Known: bot/)
  })
})

describe('artel trust list', () => {
  it('renders registered identities', () => {
    const root = createTempRepo()
    installAll(root)
    writeIdentities(root, {
      bot: { name: 'artel-bot', email: 'artel-bot@cluster.local', ssh_key: '/keys/bot' },
      owner: { name: 'Anton', email: 'anton@example.com' },
    })
    const r = runNode(root, ['engine/cli/trust.mjs', 'list'])
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('bot')
    expect(r.stdout).toContain('artel-bot <artel-bot@cluster.local>')
    expect(r.stdout).toContain('owner')
    expect(r.stdout).toContain('Anton <anton@example.com>')
    expect(r.stdout).toContain('/keys/bot')
  })

  it('--json passes through the registry verbatim', () => {
    const root = createTempRepo()
    installAll(root)
    writeIdentities(root, { bot: { name: 'artel-bot', email: 'b@x' } })
    const r = runNode(root, ['engine/cli/trust.mjs', 'list', '--json'])
    expect(r.status).toBe(0)
    const parsed = JSON.parse(r.stdout)
    expect(parsed).toEqual({ bot: { name: 'artel-bot', email: 'b@x' } })
  })

  it('shows a friendly hint when the registry is missing', () => {
    const root = createTempRepo()
    installAll(root)
    const r = runNode(root, ['engine/cli/trust.mjs', 'list'])
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/no identities registered/)
  })
})
