// Project-side truststore — `.artel/trust/identities.json` (V11).
//
// Goal: separate agent-made commits from the owner's identity.
//   .artel/trust/identities.json
//   {
//     "bot": {
//       "name": "artel-bot",
//       "email": "artel-bot@cluster.local",
//       "ssh_key": "/Users/anton/.ssh/artel-bot"
//     },
//     "owner": { "name": "Anton Golub", "email": "anton@example.com" }
//   }
//
// Roles declare which identity they commit under via frontmatter
// `identity: bot`. Lifecycle reads it, sets GIT_AUTHOR_*/GIT_COMMITTER_*/
// GIT_SSH_COMMAND on the child env. `.artel/trust/identities.json` is
// safe to commit (no secrets); `ssh_key` is a path, not the key itself.
//
// Future: a parallel `credentials.json` for tokens / API keys, mounted
// into env on demand and gitignored. Out of scope for v1.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const TRUST_DIR_REL = ['.artel', 'trust']

const identitiesPath = (projectDir) =>
  join(projectDir, ...TRUST_DIR_REL, 'identities.json')

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

export { identitiesPath }
