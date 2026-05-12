// Unit tests for engine/trust/crypto.mjs — AES-256-GCM helpers (V11.4).

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import * as cryptoModule from '../../engine/trust/crypto.mjs'
import { cleanupTempRoots, createTempRepo } from '../_helpers.js'

const {
  encryptJson,
  decryptJson,
  generateMasterKey,
  loadMasterKey,
  masterKeyPath,
  ENCRYPTED_SCHEMA,
} = cryptoModule as {
  encryptJson: (body: unknown, key: Buffer) => { schema: string; iv: string; tag: string; ciphertext: string }
  decryptJson: (envelope: unknown, key: Buffer) => unknown
  generateMasterKey: (path: string, opts?: { force?: boolean }) => Buffer
  loadMasterKey: () => Buffer
  masterKeyPath: () => string
  ENCRYPTED_SCHEMA: string
}

let savedKeyFileEnv: string | undefined
let savedKeyEnv: string | undefined
let savedXdg: string | undefined

beforeEach(() => {
  savedKeyFileEnv = process.env.ARTEL_MASTER_KEY_FILE
  savedKeyEnv = process.env.ARTEL_MASTER_KEY
  savedXdg = process.env.XDG_CONFIG_HOME
})

afterEach(() => {
  if (savedKeyFileEnv) process.env.ARTEL_MASTER_KEY_FILE = savedKeyFileEnv
  else delete process.env.ARTEL_MASTER_KEY_FILE
  if (savedKeyEnv) process.env.ARTEL_MASTER_KEY = savedKeyEnv
  else delete process.env.ARTEL_MASTER_KEY
  if (savedXdg) process.env.XDG_CONFIG_HOME = savedXdg
  else delete process.env.XDG_CONFIG_HOME
  cleanupTempRoots()
})

describe('encryptJson / decryptJson roundtrip', () => {
  it('encrypts and decrypts an arbitrary JSON body', () => {
    const key = randomBytes(32)
    const body = { GITHUB_TOKEN: 'ghp_xxx', NPM_TOKEN: 'npm_yyy', nested: { a: 1 } }
    const env = encryptJson(body, key)
    expect(env.schema).toBe(ENCRYPTED_SCHEMA)
    expect(env.iv).toMatch(/^[A-Za-z0-9+/]+=*$/)
    expect(env.tag).toMatch(/^[A-Za-z0-9+/]+=*$/)
    expect(env.ciphertext).toMatch(/^[A-Za-z0-9+/]+=*$/)
    expect(decryptJson(env, key)).toEqual(body)
  })

  it('uses a fresh IV per call (so re-encrypting same body gives different ciphertext)', () => {
    const key = randomBytes(32)
    const body = { GITHUB_TOKEN: 'ghp_xxx' }
    const a = encryptJson(body, key)
    const b = encryptJson(body, key)
    expect(a.iv).not.toBe(b.iv)
    expect(a.ciphertext).not.toBe(b.ciphertext)
    // But both decrypt to the same body
    expect(decryptJson(a, key)).toEqual(body)
    expect(decryptJson(b, key)).toEqual(body)
  })

  it('decrypt rejects wrong key (auth tag fails)', () => {
    const key1 = randomBytes(32)
    const key2 = randomBytes(32)
    const env = encryptJson({ GITHUB_TOKEN: 'ghp_xxx' }, key1)
    expect(() => decryptJson(env, key2)).toThrow(/decryption failed/)
  })

  it('decrypt rejects tampered ciphertext', () => {
    const key = randomBytes(32)
    const env = encryptJson({ GITHUB_TOKEN: 'ghp_xxx' }, key)
    const tampered = { ...env, ciphertext: Buffer.from('garbage').toString('base64') }
    expect(() => decryptJson(tampered, key)).toThrow(/decryption failed/)
  })

  it('decrypt rejects tampered auth tag', () => {
    const key = randomBytes(32)
    const env = encryptJson({ GITHUB_TOKEN: 'ghp_xxx' }, key)
    const tampered = { ...env, tag: Buffer.alloc(16).toString('base64') }
    expect(() => decryptJson(tampered, key)).toThrow(/decryption failed/)
  })

  it('decrypt rejects unknown schema', () => {
    const key = randomBytes(32)
    expect(() => decryptJson({ schema: 'wat-v0', iv: '', tag: '', ciphertext: '' }, key))
      .toThrow(/expected schema/)
    expect(() => decryptJson(null, key)).toThrow(/expected schema/)
  })

  it('decrypt rejects malformed iv / tag length', () => {
    const key = randomBytes(32)
    const env = encryptJson({ X: 'y' }, key)
    expect(() => decryptJson({ ...env, iv: Buffer.alloc(8).toString('base64') }, key))
      .toThrow(/bad iv length/)
    expect(() => decryptJson({ ...env, tag: Buffer.alloc(8).toString('base64') }, key))
      .toThrow(/bad tag length/)
  })
})

describe('generateMasterKey', () => {
  it('writes 32-byte base64 key with mode 0600 atomically', () => {
    const root = createTempRepo()
    const path = join(root, 'master.key')
    const key = generateMasterKey(path)
    expect(key.length).toBe(32)
    expect(existsSync(path)).toBe(true)
    const text = readFileSync(path, 'utf8').trim()
    expect(Buffer.from(text, 'base64').length).toBe(32)
    if (process.platform !== 'win32') {
      expect((statSync(path).mode & 0o777).toString(8)).toBe('600')
    }
  })

  it('refuses to overwrite without --force', () => {
    const root = createTempRepo()
    const path = join(root, 'master.key')
    generateMasterKey(path)
    expect(() => generateMasterKey(path)).toThrow(/already exists/)
    // --force succeeds and produces a different key
    const before = readFileSync(path, 'utf8')
    generateMasterKey(path, { force: true })
    const after = readFileSync(path, 'utf8')
    expect(after).not.toBe(before)
  })
})

describe('loadMasterKey precedence', () => {
  it('reads from ARTEL_MASTER_KEY env when set', () => {
    const inline = randomBytes(32)
    process.env.ARTEL_MASTER_KEY = inline.toString('base64')
    expect(loadMasterKey().equals(inline)).toBe(true)
  })

  it('rejects ARTEL_MASTER_KEY of wrong length', () => {
    process.env.ARTEL_MASTER_KEY = Buffer.alloc(16).toString('base64')
    expect(() => loadMasterKey()).toThrow(/must decode to 32 bytes/)
  })

  it('reads from file when env not set', () => {
    const root = createTempRepo()
    const path = join(root, 'master.key')
    delete process.env.ARTEL_MASTER_KEY
    process.env.ARTEL_MASTER_KEY_FILE = path
    const key = generateMasterKey(path)
    expect(loadMasterKey().equals(key)).toBe(true)
  })

  it('throws helpful error when neither env nor file is available', () => {
    delete process.env.ARTEL_MASTER_KEY
    process.env.ARTEL_MASTER_KEY_FILE = '/nonexistent/master.key'
    expect(() => loadMasterKey()).toThrow(/master key not found.*artel trust gen-key/)
  })

  it('rejects file with wrong byte length', () => {
    const root = createTempRepo()
    const path = join(root, 'master.key')
    delete process.env.ARTEL_MASTER_KEY
    process.env.ARTEL_MASTER_KEY_FILE = path
    writeFileSync(path, Buffer.alloc(8).toString('base64'))
    expect(() => loadMasterKey()).toThrow(/must decode to 32 bytes/)
  })
})

describe('masterKeyPath', () => {
  it('honours ARTEL_MASTER_KEY_FILE override', () => {
    process.env.ARTEL_MASTER_KEY_FILE = '/custom/path/master.key'
    expect(masterKeyPath()).toBe('/custom/path/master.key')
  })

  it('honours XDG_CONFIG_HOME when set', () => {
    delete process.env.ARTEL_MASTER_KEY_FILE
    process.env.XDG_CONFIG_HOME = '/xdg/config'
    expect(masterKeyPath()).toBe('/xdg/config/artel/master.key')
  })

  it('falls back to ~/.config when no env', () => {
    delete process.env.ARTEL_MASTER_KEY_FILE
    delete process.env.XDG_CONFIG_HOME
    expect(masterKeyPath()).toMatch(/\.config\/artel\/master\.key$/)
  })
})
