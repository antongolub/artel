// Symmetric encryption for trust credentials (V11.4).
//
// AES-256-GCM via pure node:crypto — no deps. Key is 32 random bytes
// stored base64 in `~/.config/artel/master.key` by default; override via
// `ARTEL_MASTER_KEY_FILE` (path) or `ARTEL_MASTER_KEY` (inline base64,
// for CI where filesystem is ephemeral). The key lives **outside** the
// project tree so the repo stays committable.
//
// Wire format (one JSON object per encrypted file):
//   {
//     "schema": "secret-aes-256-gcm-v1",
//     "iv":     "<base64, 12 bytes>",
//     "tag":    "<base64, 16 bytes>",
//     "ciphertext": "<base64, payload bytes>"
//   }
//
// Each write generates a fresh IV. Read verifies the auth tag — tampered
// or wrong-key payloads throw rather than silently returning garbage.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const ALGO = 'aes-256-gcm'
const KEY_BYTES = 32
const IV_BYTES = 12
const TAG_BYTES = 16
const SCHEMA = 'secret-aes-256-gcm-v1'

// Default master-key path. Honours XDG_CONFIG_HOME if set; falls back to
// `~/.config/artel/master.key`. Env override `ARTEL_MASTER_KEY_FILE` wins
// over both.
export const masterKeyPath = () => {
  if (process.env.ARTEL_MASTER_KEY_FILE) return process.env.ARTEL_MASTER_KEY_FILE
  const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  return join(xdg, 'artel', 'master.key')
}

// Resolve the 32-byte key from env-inline > file > error. Returns a Buffer.
export const loadMasterKey = () => {
  if (process.env.ARTEL_MASTER_KEY) {
    const buf = Buffer.from(process.env.ARTEL_MASTER_KEY, 'base64')
    if (buf.length !== KEY_BYTES) {
      throw new Error(
        `ARTEL_MASTER_KEY must decode to ${KEY_BYTES} bytes (got ${buf.length}). ` +
        `Generate one with: artel trust gen-key --print`,
      )
    }
    return buf
  }
  const path = masterKeyPath()
  if (!existsSync(path)) {
    throw new Error(
      `master key not found at ${path}. Generate one with: artel trust gen-key`,
    )
  }
  const text = readFileSync(path, 'utf8').trim()
  const buf = Buffer.from(text, 'base64')
  if (buf.length !== KEY_BYTES) {
    throw new Error(
      `${path} must decode to ${KEY_BYTES} bytes (got ${buf.length}). ` +
      `File may be corrupted; regenerate with: artel trust gen-key --force`,
    )
  }
  return buf
}

// Generate a new 32-byte master key, write base64 to `path` with 0600
// perms. Atomic (tmp + rename). Refuses to overwrite an existing file
// unless `force: true`.
export const generateMasterKey = (path, { force = false } = {}) => {
  if (existsSync(path) && !force) {
    throw new Error(`${path} already exists — pass --force to overwrite`)
  }
  const key = randomBytes(KEY_BYTES)
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`
  writeFileSync(tmp, key.toString('base64') + '\n')
  try { chmodSync(tmp, 0o600) } catch {}
  renameSync(tmp, path)
  return key
}

// Encrypt an arbitrary JSON-serialisable body. Returns a JSON-shaped
// object ready to be written to disk. IV is generated fresh per call.
export const encryptJson = (body, key) => {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGO, key, iv)
  const plaintext = Buffer.from(JSON.stringify(body), 'utf8')
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()
  return {
    schema: SCHEMA,
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  }
}

// Decrypt a wire-format object back into the original body. Throws on
// schema mismatch, wrong key, or tampered ciphertext (auth tag failure).
export const decryptJson = (envelope, key) => {
  if (!envelope || envelope.schema !== SCHEMA) {
    throw new Error(`expected schema '${SCHEMA}', got '${envelope?.schema || '(missing)'}'`)
  }
  const iv = Buffer.from(envelope.iv, 'base64')
  const tag = Buffer.from(envelope.tag, 'base64')
  const ciphertext = Buffer.from(envelope.ciphertext, 'base64')
  if (iv.length !== IV_BYTES) throw new Error(`bad iv length: ${iv.length}`)
  if (tag.length !== TAG_BYTES) throw new Error(`bad tag length: ${tag.length}`)
  const decipher = createDecipheriv(ALGO, key, iv)
  decipher.setAuthTag(tag)
  try {
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
    return JSON.parse(plaintext.toString('utf8'))
  } catch (err) {
    throw new Error(`decryption failed (wrong key or tampered file): ${err.message}`)
  }
}

export { SCHEMA as ENCRYPTED_SCHEMA, KEY_BYTES }
