// E2E for V11 — agent identity injection through dispatch + `artel trust list`.
//
// We use a stub `claude` binary that prints `process.env.GIT_AUTHOR_NAME` etc.
// to its .out so we can assert the lifecycle injected the right env.

import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
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

describe('artel spawn — credential injection (V11.2)', () => {
  const writeCredentials = (root: string, body: Record<string, string>) => {
    mkdirSync(join(root, '.artel', 'trust'), { recursive: true })
    writeFileSync(join(root, '.artel', 'trust', 'credentials.json'), JSON.stringify(body, null, 2))
  }

  // Echo only the env vars relevant to credential tests.
  const credEchoStub = ['#!/usr/bin/env node',
    `for (const k of ['GITHUB_TOKEN','NPM_TOKEN','OPENAI_API_KEY']) {`,
    `  if (process.env[k] !== undefined) console.log(\`\${k}=\${process.env[k]}\`)`,
    `}`,
    ''].join('\n')

  it('frontmatter `requires:` injects env vars from credentials.json', () => {
    const root = createTempRepo()
    installAll(root)
    writeFileSync(join(root, 'agents', 'implementer.md'),
      ['---', 'name: implementer', 'description: test',
       'schema: role-v1', 'version: 1', 'updated_at: 2026-05-04T00:00:00.000Z',
       'engine: claude', 'requires: GITHUB_TOKEN, NPM_TOKEN', '---', 'implementer'].join('\n'))
    writeCredentials(root, {
      GITHUB_TOKEN: 'ghp_secret123',
      NPM_TOKEN: 'npm_secret456',
      OPENAI_API_KEY: 'sk-not-required',
    })
    snapshotRepo(root, 'with creds')
    const binDir = installStub(root, 'claude', credEchoStub)

    const r = runNode(
      root,
      ['engine/cli/spawn.mjs', 'implementer', 'cred-inject', '-p', 'hi'],
      { PATH: `${binDir}:${process.env.PATH || ''}` },
    )
    expect(r.status).toBe(0)
    const out = readFileSync(join(root, '.artel', '.dispatches', 'cred-inject.out'), 'utf8')
    expect(out).toContain('GITHUB_TOKEN=ghp_secret123')
    expect(out).toContain('NPM_TOKEN=npm_secret456')
    // OPENAI_API_KEY exists in the registry but isn't required → not injected.
    expect(out).not.toContain('OPENAI_API_KEY=')
  })

  it('missing required credential fails dispatch with helpful error', () => {
    const root = createTempRepo()
    installAll(root)
    writeFileSync(join(root, 'agents', 'implementer.md'),
      ['---', 'name: implementer', 'description: test',
       'schema: role-v1', 'version: 1', 'updated_at: 2026-05-04T00:00:00.000Z',
       'engine: claude', 'requires: GITHUB_TOKEN, NPM_TOKEN', '---', 'implementer'].join('\n'))
    writeCredentials(root, { GITHUB_TOKEN: 'ghp_x' }) // NPM_TOKEN missing
    snapshotRepo(root, 'partial creds')
    const binDir = installStub(root, 'claude', credEchoStub)

    const r = runNode(
      root,
      ['engine/cli/spawn.mjs', 'implementer', 'cred-missing', '-p', 'hi'],
      { PATH: `${binDir}:${process.env.PATH || ''}` },
    )
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/requires: NPM_TOKEN but.*credentials\.json is missing/)
  })

  it('no requires + no credentials.json → no injection (no crash)', () => {
    const root = createTempRepo()
    installAll(root)
    snapshotRepo(root, 'baseline')
    const binDir = installStub(root, 'claude', credEchoStub)
    const r = runNode(
      root,
      ['engine/cli/spawn.mjs', 'implementer', 'cred-none', '-p', 'hi'],
      {
        PATH: `${binDir}:${process.env.PATH || ''}`,
        GITHUB_TOKEN: '', NPM_TOKEN: '', OPENAI_API_KEY: '',
      },
    )
    expect(r.status).toBe(0)
    const out = readFileSync(join(root, '.artel', '.dispatches', 'cred-none.out'), 'utf8')
    expect(out).not.toContain('GITHUB_TOKEN=ghp')
  })

  it('V11.4 — encrypted credentials still flow into dispatch env', () => {
    const root = createTempRepo()
    installAll(root)
    writeFileSync(join(root, 'agents', 'implementer.md'),
      ['---', 'name: implementer', 'description: test',
       'schema: role-v1', 'version: 1', 'updated_at: 2026-05-04T00:00:00.000Z',
       'engine: claude', 'requires: GITHUB_TOKEN', '---', 'implementer'].join('\n'))
    const env = { ARTEL_MASTER_KEY: Buffer.alloc(32, 11).toString('base64') }
    runNode(root, ['engine/cli/trust.mjs', 'set-credential', 'GITHUB_TOKEN', '--from-env', 'V'],
      { ...env, V: 'ghp_encrypted' })
    runNode(root, ['engine/cli/trust.mjs', 'encrypt'], env)
    snapshotRepo(root, 'encrypted creds')
    const binDir = installStub(root, 'claude', credEchoStub)
    const r = runNode(
      root,
      ['engine/cli/spawn.mjs', 'implementer', 'enc-cred-flow', '-p', 'hi'],
      { PATH: `${binDir}:${process.env.PATH || ''}`, ...env },
    )
    expect(r.status).toBe(0)
    const out = readFileSync(join(root, '.artel', '.dispatches', 'enc-cred-flow.out'), 'utf8')
    expect(out).toContain('GITHUB_TOKEN=ghp_encrypted')
  })

  it('credentials override operator env when name collides', () => {
    const root = createTempRepo()
    installAll(root)
    writeFileSync(join(root, 'agents', 'implementer.md'),
      ['---', 'name: implementer', 'description: test',
       'schema: role-v1', 'version: 1', 'updated_at: 2026-05-04T00:00:00.000Z',
       'engine: claude', 'requires: GITHUB_TOKEN', '---', 'implementer'].join('\n'))
    writeCredentials(root, { GITHUB_TOKEN: 'from-truststore' })
    snapshotRepo(root, 'override')
    const binDir = installStub(root, 'claude', credEchoStub)
    const r = runNode(
      root,
      ['engine/cli/spawn.mjs', 'implementer', 'cred-override', '-p', 'hi'],
      {
        PATH: `${binDir}:${process.env.PATH || ''}`,
        GITHUB_TOKEN: 'from-operator-env', // should be overridden by truststore
      },
    )
    expect(r.status).toBe(0)
    const out = readFileSync(join(root, '.artel', '.dispatches', 'cred-override.out'), 'utf8')
    expect(out).toContain('GITHUB_TOKEN=from-truststore')
    expect(out).not.toContain('from-operator-env')
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
    expect(r.stdout).toContain('Identities')
    expect(r.stdout).toContain('bot')
    expect(r.stdout).toContain('artel-bot <artel-bot@cluster.local>')
    expect(r.stdout).toContain('owner')
    expect(r.stdout).toContain('Anton <anton@example.com>')
    expect(r.stdout).toContain('/keys/bot')
    expect(r.stdout).toContain('Credentials')
  })

  it('lists credential names without values', () => {
    const root = createTempRepo()
    installAll(root)
    writeIdentities(root, { bot: { name: 'b', email: 'b@x' } })
    mkdirSync(join(root, '.artel', 'trust'), { recursive: true })
    writeFileSync(join(root, '.artel', 'trust', 'credentials.json'),
      JSON.stringify({ GITHUB_TOKEN: 'ghp_secret', NPM_TOKEN: 'npm_secret' }))
    const r = runNode(root, ['engine/cli/trust.mjs', 'list'])
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('GITHUB_TOKEN')
    expect(r.stdout).toContain('NPM_TOKEN')
    // values must NEVER appear
    expect(r.stdout).not.toContain('ghp_secret')
    expect(r.stdout).not.toContain('npm_secret')
  })

  it('--json emits { identities, credentials, credentials_mode } shape', () => {
    const root = createTempRepo()
    installAll(root)
    writeIdentities(root, { bot: { name: 'artel-bot', email: 'b@x' } })
    const r = runNode(root, ['engine/cli/trust.mjs', 'list', '--json'])
    expect(r.status).toBe(0)
    const parsed = JSON.parse(r.stdout)
    expect(parsed).toEqual({
      identities: { bot: { name: 'artel-bot', email: 'b@x' } },
      credentials: [],
      credentials_mode: 'empty',
    })
  })

  it('shows a friendly hint when the registry is missing', () => {
    const root = createTempRepo()
    installAll(root)
    const r = runNode(root, ['engine/cli/trust.mjs', 'list'])
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/no identities — try:/)
    expect(r.stdout).toMatch(/none — try:/)
  })
})

describe('artel trust set-identity / delete-identity (V11.3)', () => {
  it('upserts identity from --author "Name <email>"', () => {
    const root = createTempRepo()
    installAll(root)
    const r = runNode(root, [
      'engine/cli/trust.mjs', 'set-identity', 'bot',
      '--author', 'artel-bot <bot@cluster.local>',
      '--ssh-key', '/keys/bot',
    ])
    expect(r.status).toBe(0)
    const file = JSON.parse(readFileSync(join(root, '.artel', 'trust', 'identities.json'), 'utf8'))
    expect(file.bot).toEqual({ name: 'artel-bot', email: 'bot@cluster.local', ssh_key: '/keys/bot' })
  })

  it('rejects malformed --author', () => {
    const root = createTempRepo()
    installAll(root)
    const r = runNode(root, [
      'engine/cli/trust.mjs', 'set-identity', 'bot', '--author', 'no email here',
    ])
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/--author must be 'Name <email>'/)
  })

  it('delete-identity removes; missing → exit 1', () => {
    const root = createTempRepo()
    installAll(root)
    runNode(root, ['engine/cli/trust.mjs', 'set-identity', 'bot', '--author', 'B <b@x>'])
    const ok = runNode(root, ['engine/cli/trust.mjs', 'delete-identity', 'bot'])
    expect(ok.status).toBe(0)
    const missing = runNode(root, ['engine/cli/trust.mjs', 'delete-identity', 'bot'])
    expect(missing.status).toBe(1)
    expect(missing.stderr).toMatch(/'bot' not found/)
  })
})

describe('artel trust set-credential / delete-credential (V11.3)', () => {
  it('--from-env reads value from process env', () => {
    const root = createTempRepo()
    installAll(root)
    const r = runNode(root, [
      'engine/cli/trust.mjs', 'set-credential', 'GITHUB_TOKEN', '--from-env', 'TEST_TOKEN_VAR',
    ], { TEST_TOKEN_VAR: 'ghp_xxxxxx' })
    expect(r.status).toBe(0)
    const creds = JSON.parse(readFileSync(join(root, '.artel', 'trust', 'credentials.json'), 'utf8'))
    expect(creds.GITHUB_TOKEN).toBe('ghp_xxxxxx')
  })

  it('reads from stdin when --from-env absent', () => {
    const root = createTempRepo()
    installAll(root)
    const r = spawnSync(
      process.execPath,
      ['engine/cli/trust.mjs', 'set-credential', 'NPM_TOKEN'],
      { cwd: root, encoding: 'utf8', input: 'npm_xxxxxx\n' },
    )
    expect(r.status).toBe(0)
    const creds = JSON.parse(readFileSync(join(root, '.artel', 'trust', 'credentials.json'), 'utf8'))
    expect(creds.NPM_TOKEN).toBe('npm_xxxxxx')
  })

  it('rejects invalid env-var names', () => {
    const root = createTempRepo()
    installAll(root)
    const r = runNode(root, [
      'engine/cli/trust.mjs', 'set-credential', '1BAD', '--from-env', 'X',
    ], { X: 'v' })
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/invalid env-var name/)
  })

  it('delete-credential removes; missing → exit 1', () => {
    const root = createTempRepo()
    installAll(root)
    runNode(root, ['engine/cli/trust.mjs', 'set-credential', 'X', '--from-env', 'V'], { V: 'y' })
    const ok = runNode(root, ['engine/cli/trust.mjs', 'delete-credential', 'X'])
    expect(ok.status).toBe(0)
    const missing = runNode(root, ['engine/cli/trust.mjs', 'delete-credential', 'X'])
    expect(missing.status).toBe(1)
  })
})

const commandAvailable = (bin: string) => {
  const r = spawnSync(bin, ['-V'], { stdio: 'ignore' })
  return r.status !== null
}

describe('artel trust gen-key / encrypt / decrypt (V11.4)', () => {
  it('gen-key writes 32-byte key, refuses overwrite without --force', () => {
    const root = createTempRepo()
    installAll(root)
    const keyPath = join(root, 'master.key')
    const r = runNode(root, ['engine/cli/trust.mjs', 'gen-key'], {
      ARTEL_MASTER_KEY_FILE: keyPath,
    })
    expect(r.status).toBe(0)
    expect(readFileSync(keyPath, 'utf8').trim()).toMatch(/^[A-Za-z0-9+/]+=*$/)
    expect(Buffer.from(readFileSync(keyPath, 'utf8').trim(), 'base64').length).toBe(32)

    const second = runNode(root, ['engine/cli/trust.mjs', 'gen-key'], {
      ARTEL_MASTER_KEY_FILE: keyPath,
    })
    expect(second.status).not.toBe(0)
    expect(second.stderr).toMatch(/--force/)
  })

  it('gen-key --print emits the base64 key on stdout (pipeable)', () => {
    const root = createTempRepo()
    installAll(root)
    const keyPath = join(root, 'master.key')
    const r = runNode(root, ['engine/cli/trust.mjs', 'gen-key', '--print'], {
      ARTEL_MASTER_KEY_FILE: keyPath,
    })
    expect(r.status).toBe(0)
    const printed = r.stdout.trim()
    expect(Buffer.from(printed, 'base64').length).toBe(32)
    // Matches what was written to disk
    expect(printed).toBe(readFileSync(keyPath, 'utf8').trim())
  })

  it('encrypt seals existing creds; decrypt round-trips back', () => {
    const root = createTempRepo()
    installAll(root)
    const env = { ARTEL_MASTER_KEY: Buffer.alloc(32, 5).toString('base64') }
    runNode(root, [
      'engine/cli/trust.mjs', 'set-credential', 'GITHUB_TOKEN', '--from-env', 'V',
    ], { ...env, V: 'ghp_xxx' })

    // Plaintext exists, .enc doesn't
    expect(existsSync(join(root, '.artel', 'trust', 'credentials.json'))).toBe(true)
    expect(existsSync(join(root, '.artel', 'trust', 'credentials.json.enc'))).toBe(false)

    const enc = runNode(root, ['engine/cli/trust.mjs', 'encrypt'], env)
    expect(enc.status).toBe(0)
    expect(existsSync(join(root, '.artel', 'trust', 'credentials.json'))).toBe(false)
    expect(existsSync(join(root, '.artel', 'trust', 'credentials.json.enc'))).toBe(true)

    // list shows encrypted mode
    const list = runNode(root, ['engine/cli/trust.mjs', 'list'], env)
    expect(list.status).toBe(0)
    expect(list.stdout).toMatch(/mode:.*encrypted/)
    // Names still appear (CLI decrypts to render); values still don't.
    expect(list.stdout).toContain('GITHUB_TOKEN')
    expect(list.stdout).not.toContain('ghp_xxx')

    const dec = runNode(root, ['engine/cli/trust.mjs', 'decrypt'], env)
    expect(dec.status).toBe(0)
    expect(existsSync(join(root, '.artel', 'trust', 'credentials.json'))).toBe(true)
    expect(existsSync(join(root, '.artel', 'trust', 'credentials.json.enc'))).toBe(false)
    const restored = JSON.parse(readFileSync(join(root, '.artel', 'trust', 'credentials.json'), 'utf8'))
    expect(restored).toEqual({ GITHUB_TOKEN: 'ghp_xxx' })
  })

  it('mutators in encrypted mode reseal — read by dispatch lifecycle still works', () => {
    const root = createTempRepo()
    installAll(root)
    const env = { ARTEL_MASTER_KEY: Buffer.alloc(32, 9).toString('base64') }

    runNode(root, ['engine/cli/trust.mjs', 'encrypt'], env) // start encrypted (empty)
    runNode(root, ['engine/cli/trust.mjs', 'set-credential', 'NPM_TOKEN', '--from-env', 'V'],
      { ...env, V: 'npm_yyy' })

    // No plaintext file ever existed
    expect(existsSync(join(root, '.artel', 'trust', 'credentials.json'))).toBe(false)
    // .enc decrypts back to expected value
    const list = runNode(root, ['engine/cli/trust.mjs', 'list'], env)
    expect(list.stdout).toContain('NPM_TOKEN')
    expect(list.stdout).not.toContain('npm_yyy')
  })

  it('encrypt without master key fails fast', () => {
    const root = createTempRepo()
    installAll(root)
    const r = runNode(root, ['engine/cli/trust.mjs', 'encrypt'], {
      ARTEL_MASTER_KEY: '',
      ARTEL_MASTER_KEY_FILE: '/no/such/key',
    })
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/master key not found/)
  })

  it('list shows mode badge in plaintext / empty / encrypted', () => {
    const root = createTempRepo()
    installAll(root)
    const env = { ARTEL_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') }

    // empty
    let r = runNode(root, ['engine/cli/trust.mjs', 'list'], env)
    expect(r.stdout).toMatch(/mode:.*empty/)

    // plaintext
    runNode(root, ['engine/cli/trust.mjs', 'set-credential', 'X', '--from-env', 'V'], { ...env, V: 'y' })
    r = runNode(root, ['engine/cli/trust.mjs', 'list'], env)
    expect(r.stdout).toMatch(/mode:.*plaintext/)

    // encrypted
    runNode(root, ['engine/cli/trust.mjs', 'encrypt'], env)
    r = runNode(root, ['engine/cli/trust.mjs', 'list'], env)
    expect(r.stdout).toMatch(/mode:.*encrypted/)
  })
})

describe('artel trust gen-ssh (V11.3)', () => {
  it('generates ed25519 keypair, updates identity ssh_key, prints pubkey', () => {
    if (!commandAvailable('ssh-keygen')) return
    const root = createTempRepo()
    installAll(root)
    runNode(root, ['engine/cli/trust.mjs', 'set-identity', 'bot', '--author', 'B <b@x>'])

    const r = runNode(root, ['engine/cli/trust.mjs', 'gen-ssh', 'bot'])
    expect(r.status).toBe(0)
    const keyPath = join(root, '.artel', 'trust', 'keys', 'bot')
    expect(readFileSync(keyPath, 'utf8')).toMatch(/-----BEGIN OPENSSH PRIVATE KEY-----/)
    const pub = readFileSync(`${keyPath}.pub`, 'utf8')
    expect(pub).toMatch(/^ssh-ed25519 /)
    const ids = JSON.parse(readFileSync(join(root, '.artel', 'trust', 'identities.json'), 'utf8'))
    // Path may be macOS-realpath-resolved (`/private/var/...`) — compare by suffix.
    expect(ids.bot.ssh_key).toMatch(/\.artel\/trust\/keys\/bot$/)
    expect(r.stdout).toMatch(/^ssh-ed25519 /)
  })

  it('refuses to overwrite without --force', () => {
    if (!commandAvailable('ssh-keygen')) return
    const root = createTempRepo()
    installAll(root)
    runNode(root, ['engine/cli/trust.mjs', 'set-identity', 'bot', '--author', 'B <b@x>'])
    runNode(root, ['engine/cli/trust.mjs', 'gen-ssh', 'bot'])
    const second = runNode(root, ['engine/cli/trust.mjs', 'gen-ssh', 'bot'])
    expect(second.status).not.toBe(0)
    expect(second.stderr).toMatch(/--force/)
  })

  it('--force overwrites existing key', () => {
    if (!commandAvailable('ssh-keygen')) return
    const root = createTempRepo()
    installAll(root)
    runNode(root, ['engine/cli/trust.mjs', 'set-identity', 'bot', '--author', 'B <b@x>'])
    runNode(root, ['engine/cli/trust.mjs', 'gen-ssh', 'bot'])
    const keyPath = join(root, '.artel', 'trust', 'keys', 'bot')
    const before = readFileSync(`${keyPath}.pub`, 'utf8')
    const second = runNode(root, ['engine/cli/trust.mjs', 'gen-ssh', 'bot', '--force'])
    expect(second.status).toBe(0)
    const after = readFileSync(`${keyPath}.pub`, 'utf8')
    expect(after).not.toBe(before)
  })

  it('refuses when identity not registered', () => {
    const root = createTempRepo()
    installAll(root)
    const r = runNode(root, ['engine/cli/trust.mjs', 'gen-ssh', 'unknown-bot'])
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/not registered/)
  })
})
