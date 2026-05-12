#!/usr/bin/env node
// `artel trust <subcommand>` — inspect + edit the project truststore.
//
// Subcommands:
//   list                                  — render registered identities
//                                            and credential names
//   set-identity <name> --author "N <e>"  — upsert identity
//                                            [--ssh-key <path>]
//   delete-identity <name>                — remove identity
//   set-credential <name> [--from-env V]  — set credential value (stdin
//                                            by default; --from-env reads
//                                            process env safely)
//   delete-credential <name>              — remove credential
//   gen-ssh <identity> [--force]          — generate ed25519 keypair
//                                            under .artel/trust/keys/,
//                                            update identity's ssh_key
//
// Credentials are NEVER printed by this CLI — `list` shows names only,
// `set-credential` reads from stdin or env to avoid shell history.

import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { parseArgs } from 'node:util'
import {
  credentialsEncPath,
  credentialsMode,
  credentialsPath,
  decryptCredentials,
  deleteCredential,
  deleteIdentity,
  encryptCredentials,
  identitiesPath,
  readCredentials,
  readIdentities,
  setCredential,
  setIdentity,
  sshKeyPath,
} from '../trust/trust.mjs'
import { generateMasterKey, loadMasterKey, masterKeyPath } from '../trust/crypto.mjs'
import { appendInfraEvent } from '../core/audit.mjs'
import { chalk, die } from '../util/chalk.mjs'
import { config } from '../config/env.mjs'

const { projectDir: PROJECT_DIR } = config

const usage = (code = 2) => {
  console.error(`\
Usage: artel trust <subcommand> [options]

Subcommands:
  list                                  inspect identities + credential names
  set-identity <name>                   upsert an identity
       --author "Name <email>"            (required)
       --ssh-key <path>                   (optional)
  delete-identity <name>                remove an identity
  set-credential <name>                 store an opaque secret (env-var name)
       --from-env <VAR>                   read value from process.env[VAR]
                                          (default: read from stdin, no echo)
  delete-credential <name>              remove a credential
  gen-ssh <identity-name>               generate ed25519 keypair, update
       --force                            identity's ssh_key (refuses to
                                          overwrite without --force)
  gen-key [--print] [--force]           generate AES-256 master key for
                                          credentials encryption (writes
                                          to ~/.config/artel/master.key,
                                          override via ARTEL_MASTER_KEY_FILE)
  encrypt                               encrypt credentials.json in place
                                          (requires master key)
  decrypt                               reverse: encrypted → plaintext`)
  process.exit(code)
}

const subArgs = process.argv.slice(2)
if (!subArgs.length) usage(2)
const sub = subArgs[0]
const subRest = subArgs.slice(1)

if (sub === '-h' || sub === '--help') usage(0)

// --- list ---

if (sub === 'list') {
  let values
  try {
    ({ values } = parseArgs({
      args: subRest,
      options: { json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
    }))
  } catch (err) { die(err.message, 2) }
  if (values.help) usage(0)

  const identities = readIdentities(PROJECT_DIR)
  const idsPath = identitiesPath(PROJECT_DIR)
  const mode = credentialsMode(PROJECT_DIR)
  const credPath = mode === 'encrypted' ? credentialsEncPath(PROJECT_DIR) : credentialsPath(PROJECT_DIR)

  // Reading credentials in encrypted mode requires the master key. Render
  // a helpful state line instead of crashing when the key is missing —
  // the user can still see identities + the fact that creds are encrypted.
  let credentials = {}
  let credReadError = null
  if (mode !== 'empty') {
    try { credentials = readCredentials(PROJECT_DIR) }
    catch (err) { credReadError = err.message }
  }
  const credNames = Object.keys(credentials).sort()

  if (values.json) {
    console.log(JSON.stringify({
      identities,
      credentials: credNames,
      credentials_mode: mode,
      ...(credReadError ? { credentials_error: credReadError } : {}),
    }, null, 2))
    process.exit(0)
  }

  const names = Object.keys(identities)
  console.log(`\n${chalk.bold('artel trust list')} ${chalk.dim(`— ${idsPath}`)}\n`)
  console.log(`${chalk.bold('Identities')}`)
  if (!names.length) {
    console.log(`  ${chalk.dim('(no identities — try: artel trust set-identity bot --author "artel-bot <bot@cluster.local>")')}`)
  } else {
    for (const name of names.sort()) {
      const id = identities[name]
      const author = id.name && id.email ? `${id.name} <${id.email}>` : (id.name || id.email || chalk.dim('—'))
      const ssh = id.ssh_key ? `${chalk.dim('· ssh')} ${id.ssh_key}` : ''
      console.log(`  ${chalk.cyan(name.padEnd(12))} ${author} ${ssh}`)
    }
  }

  const modeBadge = mode === 'encrypted'
    ? `${chalk.green('encrypted')}`
    : mode === 'plaintext'
      ? `${chalk.yellow('plaintext')}`
      : chalk.dim('empty')
  console.log(`\n${chalk.bold('Credentials')} ${chalk.dim('· mode:')} ${modeBadge} ${chalk.dim(`— ${credPath}`)}`)
  if (credReadError) {
    console.log(`  ${chalk.dim('(read failed:')} ${credReadError}${chalk.dim(')')}`)
  } else if (!credNames.length && mode === 'empty') {
    console.log(`  ${chalk.dim('(none — try: artel trust set-credential GITHUB_TOKEN --from-env MY_VAR)')}`)
  } else if (!credNames.length) {
    console.log(`  ${chalk.dim('(none registered)')}`)
  } else {
    for (const name of credNames) console.log(`  ${chalk.cyan(name)}`)
  }
  console.log()
  process.exit(0)
}

// --- set-identity ---

if (sub === 'set-identity') {
  let values, positionals
  try {
    ({ values, positionals } = parseArgs({
      args: subRest,
      options: {
        author: { type: 'string' },
        'ssh-key': { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
      allowPositionals: true,
    }))
  } catch (err) { die(err.message, 2) }
  if (values.help) usage(0)
  const [name] = positionals
  if (!name) die('set-identity: <name> is required', 2)

  const patch = {}
  if (values.author) {
    // Parse "Name <email>" form, like git's user.name + user.email pair.
    const m = values.author.match(/^(.+?)\s*<([^>]+)>\s*$/)
    if (!m) die(`set-identity: --author must be 'Name <email>' (got: ${values.author})`, 2)
    patch.name = m[1].trim()
    patch.email = m[2].trim()
  }
  if (values['ssh-key']) patch.ssh_key = values['ssh-key']
  if (Object.keys(patch).length === 0) {
    die('set-identity: provide at least one of --author / --ssh-key', 2)
  }
  const merged = setIdentity(PROJECT_DIR, name, patch)
  appendInfraEvent(PROJECT_DIR, 'trust.identity.set', {
    name,
    fields: Object.keys(patch),
  })
  console.error(`identity '${name}' set: ${merged.name || ''} <${merged.email || ''}>${merged.ssh_key ? ` · ssh ${merged.ssh_key}` : ''}`)
  process.exit(0)
}

// --- delete-identity ---

if (sub === 'delete-identity') {
  const name = subRest[0]
  if (!name) die('delete-identity: <name> is required', 2)
  const removed = deleteIdentity(PROJECT_DIR, name)
  if (!removed) die(`delete-identity: '${name}' not found`, 1)
  appendInfraEvent(PROJECT_DIR, 'trust.identity.deleted', { name })
  console.error(`identity '${name}' deleted`)
  process.exit(0)
}

// --- set-credential ---

if (sub === 'set-credential') {
  let values, positionals
  try {
    ({ values, positionals } = parseArgs({
      args: subRest,
      options: {
        'from-env': { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
      allowPositionals: true,
    }))
  } catch (err) { die(err.message, 2) }
  if (values.help) usage(0)
  const [name] = positionals
  if (!name) die('set-credential: <name> is required', 2)

  let value
  if (values['from-env']) {
    value = process.env[values['from-env']]
    if (value === undefined) {
      die(`set-credential: $${values['from-env']} is not set in the parent env`, 1)
    }
  } else if (process.stdin.isTTY) {
    die(`set-credential: no input — pass --from-env <VAR> or pipe the value via stdin`, 2)
  } else {
    value = readFileSync(0, 'utf8').replace(/\n$/, '')
  }
  setCredential(PROJECT_DIR, name, value)
  // Audit by name + length only — never the value (defence against
  // accidental disclosure if events.jsonl leaks).
  appendInfraEvent(PROJECT_DIR, 'trust.credential.set', {
    name,
    value_length: value.length,
  })
  console.error(`credential '${name}' set (${value.length} chars)`)
  process.exit(0)
}

// --- delete-credential ---

if (sub === 'delete-credential') {
  const name = subRest[0]
  if (!name) die('delete-credential: <name> is required', 2)
  const removed = deleteCredential(PROJECT_DIR, name)
  if (!removed) die(`delete-credential: '${name}' not found`, 1)
  appendInfraEvent(PROJECT_DIR, 'trust.credential.deleted', { name })
  console.error(`credential '${name}' deleted`)
  process.exit(0)
}

// --- gen-ssh ---

if (sub === 'gen-ssh') {
  let values, positionals
  try {
    ({ values, positionals } = parseArgs({
      args: subRest,
      options: {
        force: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
      allowPositionals: true,
    }))
  } catch (err) { die(err.message, 2) }
  if (values.help) usage(0)
  const [identity] = positionals
  if (!identity) die('gen-ssh: <identity> is required', 2)

  const all = readIdentities(PROJECT_DIR)
  if (!all[identity]) die(`gen-ssh: identity '${identity}' not registered (run: artel trust set-identity ${identity} --author ...)`, 1)

  const keyPath = sshKeyPath(PROJECT_DIR, identity)
  if (existsSync(keyPath) && !values.force) {
    die(`gen-ssh: ${keyPath} already exists — pass --force to overwrite`, 1)
  }
  // ssh-keygen requires the parent dir to exist (it won't mkdir for us).
  const fs = await import('node:fs')
  fs.mkdirSync(dirname(keyPath), { recursive: true })
  // Remove existing files so ssh-keygen doesn't prompt.
  for (const p of [keyPath, `${keyPath}.pub`]) {
    if (existsSync(p)) fs.rmSync(p)
  }

  const r = spawnSync('ssh-keygen', [
    '-t', 'ed25519',
    '-f', keyPath,
    '-N', '',
    '-C', `${identity}@artel`,
    '-q',
  ], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' })
  if (r.status !== 0) {
    die(`gen-ssh: ssh-keygen exit ${r.status}: ${(r.stderr || r.stdout || '').trim()}`, 1)
  }
  try { fs.chmodSync(keyPath, 0o600) } catch {}

  setIdentity(PROJECT_DIR, identity, { ssh_key: keyPath })
  appendInfraEvent(PROJECT_DIR, 'trust.ssh_key.generated', {
    identity,
    path: keyPath,
    force: !!values.force,
  })
  const pub = readFileSync(`${keyPath}.pub`, 'utf8').trim()
  const size = statSync(keyPath).size
  console.error(`${chalk.green('✓')} keypair for '${identity}' at ${keyPath} (${size} bytes, mode 0600)`)
  console.error(`  ssh_key path recorded in identities.json`)
  console.error(`  ${chalk.dim('public key (paste into GitHub deploy keys etc.):')}`)
  console.log(pub)
  console.error(`\n  ${chalk.dim('reminder: gitignore .artel/trust/keys/ if you keep .artel under version control')}`)
  process.exit(0)
}

// --- gen-key (V11.4) ---

if (sub === 'gen-key') {
  let values
  try {
    ({ values } = parseArgs({
      args: subRest,
      options: {
        force: { type: 'boolean' },
        print: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    }))
  } catch (err) { die(err.message, 2) }
  if (values.help) usage(0)

  const path = masterKeyPath()
  let key
  try {
    key = generateMasterKey(path, { force: !!values.force })
  } catch (err) {
    die(err.message, 1)
  }
  appendInfraEvent(PROJECT_DIR, 'trust.master_key.generated', {
    path,
    force: !!values.force,
  })
  console.error(`${chalk.green('✓')} master key written to ${path} (32 bytes, mode 0600)`)
  if (values.print) {
    console.error(`  ${chalk.dim('base64 (also acceptable as ARTEL_MASTER_KEY env var):')}`)
    console.log(key.toString('base64'))
  } else {
    console.error(`  ${chalk.dim('keep this file safe — losing it makes encrypted credentials unrecoverable')}`)
    console.error(`  ${chalk.dim('to use on another machine: copy the file or pass via ARTEL_MASTER_KEY env var')}`)
  }
  process.exit(0)
}

// --- encrypt (V11.4) ---

if (sub === 'encrypt') {
  try { loadMasterKey() }
  catch (err) { die(`encrypt: ${err.message}`, 1) }
  const fromMode = credentialsMode(PROJECT_DIR)
  let result
  try { result = encryptCredentials(PROJECT_DIR) }
  catch (err) { die(`encrypt: ${err.message}`, 1) }
  if (!result.changed) {
    console.error(`${chalk.dim('credentials already encrypted at')} ${credentialsEncPath(PROJECT_DIR)}`)
  } else {
    appendInfraEvent(PROJECT_DIR, 'trust.credentials.encrypted', { from_mode: fromMode })
    console.error(`${chalk.green('✓')} credentials encrypted at ${credentialsEncPath(PROJECT_DIR)}`)
    console.error(`  ${chalk.dim('plaintext credentials.json removed')}`)
  }
  process.exit(0)
}

// --- decrypt (V11.4) ---

if (sub === 'decrypt') {
  try { loadMasterKey() }
  catch (err) { die(`decrypt: ${err.message}`, 1) }
  const fromMode = credentialsMode(PROJECT_DIR)
  let result
  try { result = decryptCredentials(PROJECT_DIR) }
  catch (err) { die(`decrypt: ${err.message}`, 1) }
  if (!result.changed) {
    console.error(`${chalk.dim('credentials are not encrypted (mode:')} ${credentialsMode(PROJECT_DIR)}${chalk.dim(')')}`)
  } else {
    appendInfraEvent(PROJECT_DIR, 'trust.credentials.decrypted', { from_mode: fromMode })
    console.error(`${chalk.green('✓')} credentials decrypted at ${credentialsPath(PROJECT_DIR)}`)
    console.error(`  ${chalk.dim('encrypted .enc file removed')}`)
    console.error(`  ${chalk.yellow('!')} ${chalk.dim('plaintext credentials.json now in the truststore — gitignore!')}`)
  }
  process.exit(0)
}

console.error(`unknown subcommand: ${sub}`)
usage(2)
