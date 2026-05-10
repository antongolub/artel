// Unit tests for engine/trust/trust.mjs — identity registry + env builder.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as trustModule from '../../engine/trust/trust.mjs'
import { cleanupTempRoots, createTempRepo } from '../_helpers.js'

type Identity = { name?: string; email?: string; ssh_key?: string }
const {
  readIdentities,
  resolveIdentity,
  identityEnv,
  identitiesPath,
  readCredentials,
  parseRequires,
  resolveRequires,
  credentialsPath,
  setIdentity,
  deleteIdentity,
  setCredential,
  deleteCredential,
  sshKeyPath,
} = trustModule as {
  readIdentities: (projectDir: string) => Record<string, Identity>
  resolveIdentity: (projectDir: string, name: string | null) => Identity | null
  identityEnv: (identity: Identity | null) => Record<string, string>
  identitiesPath: (projectDir: string) => string
  readCredentials: (projectDir: string) => Record<string, string>
  parseRequires: (requires: string | null | undefined) => string[]
  resolveRequires: (projectDir: string, requires: string | null | undefined) => Record<string, string>
  credentialsPath: (projectDir: string) => string
  setIdentity: (projectDir: string, name: string, record: Partial<Identity> & Record<string, unknown>) => Identity
  deleteIdentity: (projectDir: string, name: string) => boolean
  setCredential: (projectDir: string, name: string, value: string) => void
  deleteCredential: (projectDir: string, name: string) => boolean
  sshKeyPath: (projectDir: string, name: string) => string
}

afterEach(cleanupTempRoots)

const writeIdentities = (root: string, body: Record<string, Identity>) => {
  mkdirSync(join(root, '.artel', 'trust'), { recursive: true })
  writeFileSync(join(root, '.artel', 'trust', 'identities.json'), JSON.stringify(body, null, 2))
}

describe('readIdentities', () => {
  it('returns {} when the file is absent', () => {
    const root = createTempRepo()
    expect(readIdentities(root)).toEqual({})
  })

  it('parses a populated identities.json', () => {
    const root = createTempRepo()
    writeIdentities(root, {
      bot: { name: 'artel-bot', email: 'artel-bot@cluster.local', ssh_key: '/keys/bot' },
      owner: { name: 'Anton', email: 'anton@example.com' },
    })
    const ids = readIdentities(root)
    expect(Object.keys(ids).sort()).toEqual(['bot', 'owner'])
    expect(ids.bot.email).toBe('artel-bot@cluster.local')
  })

  it('throws on malformed JSON with the file path in the message', () => {
    const root = createTempRepo()
    mkdirSync(join(root, '.artel', 'trust'), { recursive: true })
    writeFileSync(join(root, '.artel', 'trust', 'identities.json'), '{ not: json')
    expect(() => readIdentities(root)).toThrow(/identities\.json/)
  })
})

describe('resolveIdentity', () => {
  it('returns null for a null/empty name', () => {
    const root = createTempRepo()
    expect(resolveIdentity(root, null)).toBeNull()
    expect(resolveIdentity(root, '')).toBeNull()
  })

  it('returns the matching record', () => {
    const root = createTempRepo()
    writeIdentities(root, { bot: { name: 'artel-bot', email: 'artel-bot@cluster.local' } })
    const id = resolveIdentity(root, 'bot')
    expect(id).toMatchObject({ name: 'artel-bot', email: 'artel-bot@cluster.local' })
  })

  it('throws with helpful "Known: ..." list on unknown name', () => {
    const root = createTempRepo()
    writeIdentities(root, { bot: { name: 'b' }, owner: { name: 'o' } })
    expect(() => resolveIdentity(root, 'ghost')).toThrow(/unknown identity 'ghost'.*Known: bot, owner/)
  })

  it("'Known: (none)' when registry empty", () => {
    const root = createTempRepo()
    expect(() => resolveIdentity(root, 'ghost')).toThrow(/Known: \(none\)/)
  })
})

describe('identityEnv', () => {
  it('returns {} when identity is null', () => {
    expect(identityEnv(null)).toEqual({})
  })

  it('emits GIT_AUTHOR/COMMITTER pairs from name + email', () => {
    expect(identityEnv({ name: 'bot', email: 'bot@x.io' })).toEqual({
      GIT_AUTHOR_NAME: 'bot',
      GIT_AUTHOR_EMAIL: 'bot@x.io',
      GIT_COMMITTER_NAME: 'bot',
      GIT_COMMITTER_EMAIL: 'bot@x.io',
    })
  })

  it('builds GIT_SSH_COMMAND with quoted path + IdentitiesOnly', () => {
    const env = identityEnv({ name: 'bot', email: 'b@x', ssh_key: '/home/u/.ssh/bot key' })
    expect(env.GIT_SSH_COMMAND).toBe('ssh -i "/home/u/.ssh/bot key" -o IdentitiesOnly=yes')
  })

  it('omits author/committer when only ssh_key is set', () => {
    const env = identityEnv({ ssh_key: '/keys/bot' })
    expect(env).toEqual({
      GIT_SSH_COMMAND: 'ssh -i "/keys/bot" -o IdentitiesOnly=yes',
    })
  })
})

describe('identitiesPath', () => {
  it('points at <project>/.artel/trust/identities.json', () => {
    const root = createTempRepo()
    expect(identitiesPath(root)).toBe(join(root, '.artel', 'trust', 'identities.json'))
  })
})

const writeCredentials = (root: string, body: Record<string, string>) => {
  mkdirSync(join(root, '.artel', 'trust'), { recursive: true })
  writeFileSync(join(root, '.artel', 'trust', 'credentials.json'), JSON.stringify(body, null, 2))
}

describe('readCredentials', () => {
  it('returns {} when the file is absent', () => {
    const root = createTempRepo()
    expect(readCredentials(root)).toEqual({})
  })

  it('parses populated credentials.json', () => {
    const root = createTempRepo()
    writeCredentials(root, { GITHUB_TOKEN: 'ghp_xxx', NPM_TOKEN: 'npm_yyy' })
    const creds = readCredentials(root)
    expect(creds.GITHUB_TOKEN).toBe('ghp_xxx')
    expect(creds.NPM_TOKEN).toBe('npm_yyy')
  })

  it('throws on malformed JSON with the file path in the message', () => {
    const root = createTempRepo()
    mkdirSync(join(root, '.artel', 'trust'), { recursive: true })
    writeFileSync(join(root, '.artel', 'trust', 'credentials.json'), '{ broken')
    expect(() => readCredentials(root)).toThrow(/credentials\.json/)
  })
})

describe('parseRequires', () => {
  it.each([
    [null, []],
    [undefined, []],
    ['', []],
    ['   ', []],
    ['GITHUB_TOKEN', ['GITHUB_TOKEN']],
    ['GITHUB_TOKEN, NPM_TOKEN', ['GITHUB_TOKEN', 'NPM_TOKEN']],
    ['  A , B,, ,C  ', ['A', 'B', 'C']],
  ])('parseRequires(%j) → %j', (input, expected) => {
    expect(parseRequires(input)).toEqual(expected)
  })

  it('collapses duplicates preserving first-seen order', () => {
    expect(parseRequires('A, B, A, C, B')).toEqual(['A', 'B', 'C'])
  })
})

describe('resolveRequires', () => {
  it('returns {} when requires is empty/null', () => {
    const root = createTempRepo()
    expect(resolveRequires(root, null)).toEqual({})
    expect(resolveRequires(root, '')).toEqual({})
  })

  it('builds env-var slice from registered credentials', () => {
    const root = createTempRepo()
    writeCredentials(root, { GITHUB_TOKEN: 'ghp_xxx', NPM_TOKEN: 'npm_yyy', UNUSED: 'z' })
    const env = resolveRequires(root, 'GITHUB_TOKEN, NPM_TOKEN')
    expect(env).toEqual({ GITHUB_TOKEN: 'ghp_xxx', NPM_TOKEN: 'npm_yyy' })
  })

  it('throws with the missing names in the message', () => {
    const root = createTempRepo()
    writeCredentials(root, { GITHUB_TOKEN: 'ghp_xxx' })
    expect(() => resolveRequires(root, 'GITHUB_TOKEN, NPM_TOKEN, OPENAI_API_KEY'))
      .toThrow(/requires: NPM_TOKEN, OPENAI_API_KEY but/)
  })

  it('coerces non-string credential values to strings', () => {
    const root = createTempRepo()
    writeCredentials(root, { COUNT: 42 as unknown as string })
    const env = resolveRequires(root, 'COUNT')
    expect(env.COUNT).toBe('42')
  })
})

describe('credentialsPath', () => {
  it('points at <project>/.artel/trust/credentials.json', () => {
    const root = createTempRepo()
    expect(credentialsPath(root)).toBe(join(root, '.artel', 'trust', 'credentials.json'))
  })
})

describe('setIdentity / deleteIdentity (V11.3)', () => {
  it('creates a new identity and persists it atomically', () => {
    const root = createTempRepo()
    setIdentity(root, 'bot', { name: 'artel-bot', email: 'bot@x' })
    const all = readIdentities(root)
    expect(all.bot).toEqual({ name: 'artel-bot', email: 'bot@x' })
  })

  it('merges into an existing identity (preserves untouched fields)', () => {
    const root = createTempRepo()
    setIdentity(root, 'bot', { name: 'artel-bot', email: 'bot@x', ssh_key: '/keys/bot' })
    setIdentity(root, 'bot', { email: 'bot@new.x' })
    expect(readIdentities(root).bot).toEqual({ name: 'artel-bot', email: 'bot@new.x', ssh_key: '/keys/bot' })
  })

  it('clears a field when patch value is null', () => {
    const root = createTempRepo()
    setIdentity(root, 'bot', { name: 'artel-bot', email: 'bot@x', ssh_key: '/keys/bot' })
    setIdentity(root, 'bot', { ssh_key: null as unknown as string })
    expect(readIdentities(root).bot).toEqual({ name: 'artel-bot', email: 'bot@x' })
  })

  it('throws when name is empty', () => {
    const root = createTempRepo()
    expect(() => setIdentity(root, '', { name: 'x' })).toThrow(/name required/)
  })

  it('deleteIdentity removes existing, returns true; missing returns false', () => {
    const root = createTempRepo()
    setIdentity(root, 'bot', { name: 'artel-bot', email: 'bot@x' })
    expect(deleteIdentity(root, 'bot')).toBe(true)
    expect(readIdentities(root)).toEqual({})
    expect(deleteIdentity(root, 'ghost')).toBe(false)
  })
})

describe('setCredential / deleteCredential (V11.3)', () => {
  it('stores credentials with mode 0600 on the file', () => {
    const root = createTempRepo()
    setCredential(root, 'GITHUB_TOKEN', 'ghp_secret')
    expect(readCredentials(root)).toEqual({ GITHUB_TOKEN: 'ghp_secret' })
    if (process.platform !== 'win32') {
      const stat = statSync(credentialsPath(root))
      expect((stat.mode & 0o777).toString(8)).toBe('600')
    }
  })

  it('rejects invalid env-var names', () => {
    const root = createTempRepo()
    expect(() => setCredential(root, '1BAD', 'v')).toThrow(/invalid env-var name/)
    expect(() => setCredential(root, 'has-dash', 'v')).toThrow(/invalid env-var name/)
    expect(() => setCredential(root, '', 'v')).toThrow(/required/)
  })

  it('rejects non-string value', () => {
    const root = createTempRepo()
    expect(() => setCredential(root, 'X', 42 as unknown as string)).toThrow(/value must be a string/)
  })

  it('deleteCredential removes existing, returns true; missing returns false', () => {
    const root = createTempRepo()
    setCredential(root, 'X', 'v')
    expect(deleteCredential(root, 'X')).toBe(true)
    expect(readCredentials(root)).toEqual({})
    expect(deleteCredential(root, 'GHOST')).toBe(false)
  })
})

describe('sshKeyPath (V11.3)', () => {
  it('points at <project>/.artel/trust/keys/<name>', () => {
    const root = createTempRepo()
    expect(sshKeyPath(root, 'bot')).toBe(join(root, '.artel', 'trust', 'keys', 'bot'))
  })
})

// V11.4 — encryption mode integration. crypto.mjs is unit-tested
// separately; here we verify trust.mjs flips and reads transparently.
const trustModule2 = trustModule as unknown as {
  encryptCredentials: (projectDir: string) => { changed: boolean }
  decryptCredentials: (projectDir: string) => { changed: boolean }
  credentialsMode: (projectDir: string) => 'plaintext' | 'encrypted' | 'empty'
  credentialsEncPath: (projectDir: string) => string
}
const { encryptCredentials, decryptCredentials, credentialsMode, credentialsEncPath } = trustModule2

let savedKeyEnv: string | undefined

describe('credentialsMode + encrypt/decrypt (V11.4)', () => {
  beforeEach(() => {
    savedKeyEnv = process.env.ARTEL_MASTER_KEY
    // 32-byte key, base64. Same key reused across tests in this describe.
    process.env.ARTEL_MASTER_KEY = Buffer.alloc(32, 7).toString('base64')
  })
  afterEach(() => {
    if (savedKeyEnv) process.env.ARTEL_MASTER_KEY = savedKeyEnv
    else delete process.env.ARTEL_MASTER_KEY
  })

  it('credentialsMode reflects on-disk file shape', () => {
    const root = createTempRepo()
    expect(credentialsMode(root)).toBe('empty')
    setCredential(root, 'X', 'y')
    expect(credentialsMode(root)).toBe('plaintext')
    encryptCredentials(root)
    expect(credentialsMode(root)).toBe('encrypted')
  })

  it('encryptCredentials seals existing plaintext, removes the plaintext file', () => {
    const root = createTempRepo()
    setCredential(root, 'GITHUB_TOKEN', 'ghp_xxx')
    expect(existsSync(credentialsPath(root))).toBe(true)
    const result = encryptCredentials(root)
    expect(result.changed).toBe(true)
    expect(existsSync(credentialsPath(root))).toBe(false)
    expect(existsSync(credentialsEncPath(root))).toBe(true)
    // readCredentials transparently decrypts back to original
    expect(readCredentials(root)).toEqual({ GITHUB_TOKEN: 'ghp_xxx' })
  })

  it('encryptCredentials is idempotent in encrypted mode', () => {
    const root = createTempRepo()
    setCredential(root, 'X', 'y')
    encryptCredentials(root)
    const before = readFileSync(credentialsEncPath(root), 'utf8')
    const result = encryptCredentials(root)
    expect(result.changed).toBe(false)
    const after = readFileSync(credentialsEncPath(root), 'utf8')
    // Idempotent → file untouched.
    expect(after).toBe(before)
  })

  it('mutators in encrypted mode reseal with fresh IV every write', () => {
    const root = createTempRepo()
    setCredential(root, 'X', 'first')
    encryptCredentials(root)
    const path = credentialsEncPath(root)
    const a = JSON.parse(readFileSync(path, 'utf8'))
    setCredential(root, 'Y', 'second')
    const b = JSON.parse(readFileSync(path, 'utf8'))
    expect(a.iv).not.toBe(b.iv)
    expect(a.ciphertext).not.toBe(b.ciphertext)
    // Round-trip after each mutation
    expect(readCredentials(root)).toEqual({ X: 'first', Y: 'second' })
  })

  it('decryptCredentials reverses to plaintext, removes .enc', () => {
    const root = createTempRepo()
    setCredential(root, 'X', 'y')
    encryptCredentials(root)
    expect(credentialsMode(root)).toBe('encrypted')
    const result = decryptCredentials(root)
    expect(result.changed).toBe(true)
    expect(credentialsMode(root)).toBe('plaintext')
    expect(existsSync(credentialsEncPath(root))).toBe(false)
    expect(readCredentials(root)).toEqual({ X: 'y' })
  })

  it('readCredentials throws helpful error when key is wrong', () => {
    const root = createTempRepo()
    setCredential(root, 'X', 'y')
    encryptCredentials(root)
    process.env.ARTEL_MASTER_KEY = Buffer.alloc(32, 99).toString('base64')
    expect(() => readCredentials(root)).toThrow(/decryption failed/)
  })
})
