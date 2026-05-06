// E2E for trust audit log — every mutator emits an `infra` event with
// type `trust.*` to .artel/events.jsonl. Values are NEVER recorded;
// only names + non-secret metadata.

import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  cleanupTempRoots,
  createTempRepo,
  ENGINE_FILES_CORE,
  ENGINE_FILES_DRIVERS,
  ENGINE_FILES_UTIL,
  installEngineRuntime,
  runNode,
} from '../_helpers.js'

afterEach(cleanupTempRoots)

const installAll = (root: string) =>
  installEngineRuntime(root, [
    'engine/cli/trust.mjs',
    ...ENGINE_FILES_CORE,
    ...ENGINE_FILES_DRIVERS,
    ...ENGINE_FILES_UTIL,
  ])

const readEvents = (root: string) => {
  const path = join(root, '.artel', 'events.jsonl')
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

const sshKeygenAvailable = () => spawnSync('ssh-keygen', ['-V'], { stdio: 'ignore' }).status !== null

describe('trust audit log', () => {
  it('emits trust.identity.set with field list', () => {
    const root = createTempRepo()
    installAll(root)
    runNode(root, [
      'engine/cli/trust.mjs', 'set-identity', 'bot',
      '--author', 'B <b@x>', '--ssh-key', '/keys/bot',
    ])
    const events = readEvents(root)
    const evt = events.find((e) => e.type === 'trust.identity.set')
    expect(evt).toBeTruthy()
    expect(evt.kind).toBe('infra')
    expect(evt.name).toBe('bot')
    expect(evt.fields).toEqual(expect.arrayContaining(['name', 'email', 'ssh_key']))
    // baseline envelope
    expect(evt.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/)
    expect(evt.cluster_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/)
    expect(evt.at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('emits trust.identity.deleted', () => {
    const root = createTempRepo()
    installAll(root)
    runNode(root, ['engine/cli/trust.mjs', 'set-identity', 'bot', '--author', 'B <b@x>'])
    runNode(root, ['engine/cli/trust.mjs', 'delete-identity', 'bot'])
    const evt = readEvents(root).find((e) => e.type === 'trust.identity.deleted')
    expect(evt).toMatchObject({ kind: 'infra', name: 'bot' })
  })

  it('emits trust.credential.set with name + value_length, NEVER value', () => {
    const root = createTempRepo()
    installAll(root)
    runNode(root, ['engine/cli/trust.mjs', 'set-credential', 'GITHUB_TOKEN', '--from-env', 'V'],
      { V: 'ghp_xxxxxxxxxxxxx' })
    const evt = readEvents(root).find((e) => e.type === 'trust.credential.set')
    expect(evt).toMatchObject({ kind: 'infra', name: 'GITHUB_TOKEN', value_length: 17 })
    // The value must NEVER appear anywhere in the event line.
    const line = JSON.stringify(evt)
    expect(line).not.toContain('ghp_xxxxxxxxxxxxx')
  })

  it('emits trust.credential.deleted', () => {
    const root = createTempRepo()
    installAll(root)
    runNode(root, ['engine/cli/trust.mjs', 'set-credential', 'X', '--from-env', 'V'], { V: 'y' })
    runNode(root, ['engine/cli/trust.mjs', 'delete-credential', 'X'])
    const evt = readEvents(root).find((e) => e.type === 'trust.credential.deleted')
    expect(evt).toMatchObject({ kind: 'infra', name: 'X' })
  })

  it('emits trust.master_key.generated', () => {
    const root = createTempRepo()
    installAll(root)
    const keyPath = join(root, 'master.key')
    runNode(root, ['engine/cli/trust.mjs', 'gen-key'], { ARTEL_MASTER_KEY_FILE: keyPath })
    const evt = readEvents(root).find((e) => e.type === 'trust.master_key.generated')
    expect(evt).toMatchObject({ kind: 'infra', force: false })
    expect(evt.path).toContain('master.key')
  })

  it('emits trust.credentials.encrypted with from_mode', () => {
    const root = createTempRepo()
    installAll(root)
    const env = { ARTEL_MASTER_KEY: Buffer.alloc(32, 5).toString('base64') }
    runNode(root, ['engine/cli/trust.mjs', 'set-credential', 'X', '--from-env', 'V'], { ...env, V: 'y' })
    runNode(root, ['engine/cli/trust.mjs', 'encrypt'], env)
    const evt = readEvents(root).find((e) => e.type === 'trust.credentials.encrypted')
    expect(evt).toMatchObject({ kind: 'infra', from_mode: 'plaintext' })
  })

  it('emits trust.credentials.decrypted with from_mode', () => {
    const root = createTempRepo()
    installAll(root)
    const env = { ARTEL_MASTER_KEY: Buffer.alloc(32, 5).toString('base64') }
    runNode(root, ['engine/cli/trust.mjs', 'set-credential', 'X', '--from-env', 'V'], { ...env, V: 'y' })
    runNode(root, ['engine/cli/trust.mjs', 'encrypt'], env)
    runNode(root, ['engine/cli/trust.mjs', 'decrypt'], env)
    const evt = readEvents(root).find((e) => e.type === 'trust.credentials.decrypted')
    expect(evt).toMatchObject({ kind: 'infra', from_mode: 'encrypted' })
  })

  it('emits trust.ssh_key.generated', () => {
    if (!sshKeygenAvailable()) return
    const root = createTempRepo()
    installAll(root)
    runNode(root, ['engine/cli/trust.mjs', 'set-identity', 'bot', '--author', 'B <b@x>'])
    runNode(root, ['engine/cli/trust.mjs', 'gen-ssh', 'bot'])
    const evt = readEvents(root).find((e) => e.type === 'trust.ssh_key.generated')
    expect(evt).toMatchObject({ kind: 'infra', identity: 'bot', force: false })
    expect(evt.path).toMatch(/\.artel\/trust\/keys\/bot$/)
  })

  it('failed mutators do not emit (delete missing → no event)', () => {
    const root = createTempRepo()
    installAll(root)
    const r = runNode(root, ['engine/cli/trust.mjs', 'delete-identity', 'ghost'])
    expect(r.status).not.toBe(0)
    expect(readEvents(root).filter((e) => e.type?.startsWith('trust.'))).toEqual([])
  })

  it("'artel events --kind infra --type trust.*' surfaces audit trail", () => {
    const root = createTempRepo()
    installEngineRuntime(root, [
      'engine/cli/trust.mjs',
      'engine/cli/events.mjs',
      ...ENGINE_FILES_CORE,
      ...ENGINE_FILES_DRIVERS,
      ...ENGINE_FILES_UTIL,
    ])
    runNode(root, ['engine/cli/trust.mjs', 'set-identity', 'bot', '--author', 'B <b@x>'])
    runNode(root, ['engine/cli/trust.mjs', 'set-credential', 'X', '--from-env', 'V'], { V: 'y' })
    const r = runNode(root, ['engine/cli/events.mjs', '--kind', 'infra'])
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('trust.identity.set')
    expect(r.stdout).toContain('trust.credential.set')
  })
})
