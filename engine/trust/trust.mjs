// Project-side truststore — `.artel/trust/` (V11).
//
// Two registries:
//   1. identities.json — git authorship (name / email / ssh_key path).
//      Safe to commit — no secrets, just author info + key paths.
//   2. credentials.json — opaque token/secret values keyed by env-var
//      name. NEVER commit — gitignore it.
//
//   .artel/trust/identities.json
//   {
//     "bot": { "name": "artel-bot", "email": "bot@cluster.local",
//              "ssh_key": "/Users/anton/.ssh/artel-bot" },
//     "owner": { "name": "Anton Golub", "email": "anton@example.com" }
//   }
//
//   .artel/trust/credentials.json   ← gitignore!
//   {
//     "GITHUB_TOKEN": "ghp_…",
//     "NPM_TOKEN": "npm_…",
//     "OPENAI_API_KEY": "sk-…"
//   }
//
// Roles declare what they need:
//   identity: bot                # git author for commits
//   requires: GITHUB_TOKEN, NPM_TOKEN   # env vars to inject from creds
//
// Lifecycle injects GIT_AUTHOR_*/GIT_COMMITTER_*/GIT_SSH_COMMAND from
// identity, plus literal env vars from credentials. CLI `--identity`
// overrides per-dispatch; credentials are project-wide.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathsFor } from '../config/env.mjs'
import { decryptJson, encryptJson, loadMasterKey } from './crypto.mjs'

const trustDir = (projectDir) => pathsFor(projectDir).trustDir

const identitiesPath      = (projectDir) => join(trustDir(projectDir), 'identities.json')
const credentialsPath     = (projectDir) => join(trustDir(projectDir), 'credentials.json')
const credentialsEncPath  = (projectDir) => join(trustDir(projectDir), 'credentials.json.enc')

// V11.4 — encryption mode is detected by the on-disk file shape:
//   credentials.json.enc present  → encrypted (master key required)
//   credentials.json present      → plaintext
//   neither                       → empty registry
// `artel trust encrypt` flips a project from plaintext → encrypted;
// `artel trust decrypt` reverses. Mutators (set / delete) follow the
// existing file's mode.
export const credentialsMode = (projectDir) => {
  if (existsSync(credentialsEncPath(projectDir))) return 'encrypted'
  if (existsSync(credentialsPath(projectDir))) return 'plaintext'
  return 'empty'
}

// Read all registered identities. Returns `{}` when the file is absent
// (no truststore configured) — caller decides whether absence is an
// error (user explicitly asked for an identity) or fine (default flow).
export const readIdentities = (projectDir) => {
  const path = identitiesPath(projectDir)
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    throw new Error(`failed to parse ${path}: ${err.message}`)
  }
}

// Resolve a single identity by name. Throws when the user explicitly
// asked for one and it isn't registered (helpful list of known names).
// Returns `null` for an empty/falsy name (= no identity declared).
export const resolveIdentity = (projectDir, name) => {
  if (!name) return null
  const all = readIdentities(projectDir)
  if (!all[name]) {
    const known = Object.keys(all).join(', ') || '(none)'
    throw new Error(
      `unknown identity '${name}' under ${identitiesPath(projectDir)}. Known: ${known}`,
    )
  }
  return all[name]
}

// Translate an identity record into the env-var slice that lifecycle
// merges into the spawn env. Empty when identity is null. Bare strings
// (no shell-meaningful chars) are quoted in GIT_SSH_COMMAND so paths
// with spaces still work.
export const identityEnv = (identity) => {
  if (!identity) return {}
  const out = {}
  if (identity.name) {
    out.GIT_AUTHOR_NAME = identity.name
    out.GIT_COMMITTER_NAME = identity.name
  }
  if (identity.email) {
    out.GIT_AUTHOR_EMAIL = identity.email
    out.GIT_COMMITTER_EMAIL = identity.email
  }
  if (identity.ssh_key) {
    out.GIT_SSH_COMMAND = `ssh -i ${JSON.stringify(identity.ssh_key)} -o IdentitiesOnly=yes`
  }
  return out
}

// Read all registered credentials. `{}` when no file is present.
// Auto-decrypts when in encrypted mode — master key is loaded lazily so
// non-encrypted projects don't need one configured.
export const readCredentials = (projectDir) => {
  const mode = credentialsMode(projectDir)
  if (mode === 'empty') return {}
  if (mode === 'encrypted') {
    const path = credentialsEncPath(projectDir)
    let envelope
    try {
      envelope = JSON.parse(readFileSync(path, 'utf8'))
    } catch (err) {
      throw new Error(`failed to parse ${path}: ${err.message}`)
    }
    return decryptJson(envelope, loadMasterKey())
  }
  const path = credentialsPath(projectDir)
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    throw new Error(`failed to parse ${path}: ${err.message}`)
  }
}

// Parse a `requires: A, B, C` frontmatter value to a name list. Whitespace
// tolerated; empty entries dropped; duplicates collapsed.
export const parseRequires = (requires) => {
  if (!requires) return []
  const seen = new Set()
  const out = []
  for (const part of String(requires).split(',')) {
    const name = part.trim()
    if (!name || seen.has(name)) continue
    seen.add(name)
    out.push(name)
  }
  return out
}

// Resolve a `requires:` frontmatter value into the env-var slice the
// lifecycle merges into the spawn env. Strict — missing keys throw with
// a helpful message that lists which names weren't found and where.
export const resolveRequires = (projectDir, requires) => {
  const names = parseRequires(requires)
  if (!names.length) return {}
  const creds = readCredentials(projectDir)
  const out = {}
  const missing = []
  for (const name of names) {
    if (creds[name] === undefined) missing.push(name)
    else out[name] = String(creds[name])
  }
  if (missing.length) {
    throw new Error(
      `role declares requires: ${missing.join(', ')} but ${credentialsPath(projectDir)} is missing these — ` +
      `add to credentials.json or remove from frontmatter`,
    )
  }
  return out
}

// --- write side (V11.3 mutators) ---

// Atomic JSON write with optional file mode. Renames a tmp file into
// place so a crash mid-write doesn't leave a half-baked file. The mode
// is applied after rename so the public path always exists with the
// final perms (0600 for secrets).
const atomicWriteJson = (path, body, { mode } = {}) => {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`
  writeFileSync(tmp, JSON.stringify(body, null, 2) + '\n')
  if (mode != null) {
    try { chmodSync(tmp, mode) } catch {}
  }
  renameSync(tmp, path)
}

const writeIdentities = (projectDir, body) => {
  atomicWriteJson(identitiesPath(projectDir), body)
}

// Plaintext writer — used directly only by the `decrypt` path. Mutators
// route through `writeCredentials` which respects the current mode.
const writeCredentialsPlaintext = (projectDir, body) => {
  atomicWriteJson(credentialsPath(projectDir), body, { mode: 0o600 })
}

// Mode-respecting writer. Encrypted projects get fresh-IV reseal on every
// write; plaintext projects stay plaintext. New projects (no file yet)
// default to plaintext — callers must `encrypt` explicitly to opt in.
const writeCredentials = (projectDir, body) => {
  if (credentialsMode(projectDir) === 'encrypted') {
    const envelope = encryptJson(body, loadMasterKey())
    atomicWriteJson(credentialsEncPath(projectDir), envelope, { mode: 0o600 })
    return
  }
  writeCredentialsPlaintext(projectDir, body)
}

// Flip plaintext → encrypted. Reads existing creds (if any), writes them
// as a sealed envelope, removes the plaintext. Idempotent — no-op when
// already encrypted. Throws if the master key isn't available.
export const encryptCredentials = (projectDir) => {
  const mode = credentialsMode(projectDir)
  if (mode === 'encrypted') return { changed: false }
  const body = mode === 'plaintext' ? readCredentials(projectDir) : {}
  const envelope = encryptJson(body, loadMasterKey())
  atomicWriteJson(credentialsEncPath(projectDir), envelope, { mode: 0o600 })
  if (mode === 'plaintext') {
    try { rmSync(credentialsPath(projectDir)) } catch {}
  }
  return { changed: true }
}

// Flip encrypted → plaintext. Decrypts in memory, writes plaintext, then
// removes the .enc. Idempotent — no-op when already plaintext or empty.
export const decryptCredentials = (projectDir) => {
  if (credentialsMode(projectDir) !== 'encrypted') return { changed: false }
  const body = readCredentials(projectDir)
  writeCredentialsPlaintext(projectDir, body)
  try { rmSync(credentialsEncPath(projectDir)) } catch {}
  return { changed: true }
}

// Upsert (or update) an identity. Pass `null` for a field to clear it.
// `record` is a partial — undefined fields preserve the existing value;
// explicit null deletes the field.
export const setIdentity = (projectDir, name, record) => {
  if (!name) throw new Error('setIdentity: name required')
  const all = readIdentities(projectDir)
  const merged = { ...(all[name] || {}) }
  for (const [k, v] of Object.entries(record || {})) {
    if (v === null) delete merged[k]
    else if (v !== undefined) merged[k] = v
  }
  all[name] = merged
  writeIdentities(projectDir, all)
  return merged
}

export const deleteIdentity = (projectDir, name) => {
  const all = readIdentities(projectDir)
  if (!(name in all)) return false
  delete all[name]
  writeIdentities(projectDir, all)
  return true
}

export const setCredential = (projectDir, name, value) => {
  if (!name) throw new Error('setCredential: name required')
  if (typeof value !== 'string') throw new Error('setCredential: value must be a string')
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`setCredential: invalid env-var name '${name}' (alphanumeric + underscore, no leading digit)`)
  }
  const all = readCredentials(projectDir)
  all[name] = value
  writeCredentials(projectDir, all)
}

export const deleteCredential = (projectDir, name) => {
  const all = readCredentials(projectDir)
  if (!(name in all)) return false
  delete all[name]
  writeCredentials(projectDir, all)
  return true
}

// Path where `gen-ssh` writes a generated keypair: `.artel/trust/keys/<name>`
// (private), `.pub` sibling for the public half. Caller is responsible
// for invoking `ssh-keygen` — util only resolves the path.
export const sshKeyPath = (projectDir, name) =>
  join(trustDir(projectDir), 'keys', name)

export { identitiesPath, credentialsPath, credentialsEncPath }
