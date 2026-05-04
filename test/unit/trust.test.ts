// Unit tests for engine/util/trust.mjs — identity registry + env builder.

import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as trustModule from '../../engine/util/trust.mjs'
import { cleanupTempRoots, createTempRepo } from '../_helpers.js'

type Identity = { name?: string; email?: string; ssh_key?: string }
const { readIdentities, resolveIdentity, identityEnv, identitiesPath } = trustModule as {
  readIdentities: (projectDir: string) => Record<string, Identity>
  resolveIdentity: (projectDir: string, name: string | null) => Identity | null
  identityEnv: (identity: Identity | null) => Record<string, string>
  identitiesPath: (projectDir: string) => string
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
