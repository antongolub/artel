#!/usr/bin/env node
// `artel trust <subcommand>` — inspect the project truststore.
//
// v1 surface is read-only: `artel trust list`. Identities are managed
// by hand-editing `.artel/trust/identities.json`. Future iterations may
// add `set` / `gen-ssh` / credentials.

import { parseArgs } from 'node:util'
import { identitiesPath, readIdentities } from '../util/trust.mjs'

const PROJECT_DIR = process.env.ARTEL_PROJECT_DIR || process.cwd()

const tty = process.stdout.isTTY
const c = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s)
const dim = (s) => c('2', s)
const bold = (s) => c('1', s)
const cyan = (s) => c('36', s)

const usage = (code = 2) => {
  console.error(`\
Usage: artel trust <list> [options]

Inspect the project's identity registry at .artel/trust/identities.json.
Edit the file by hand to add or change identities (v1 surface is
read-only).

Subcommands:
  list           print registered identities (--json for machine-readable)`)
  process.exit(code)
}

let values, positionals
try {
  ({ values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
  }))
} catch (err) {
  console.error(err.message)
  usage(2)
}

if (values.help || positionals.length === 0) usage(values.help ? 0 : 2)
const sub = positionals[0]

if (sub !== 'list') {
  console.error(`unknown subcommand: ${sub}`)
  usage(2)
}

const identities = readIdentities(PROJECT_DIR)
const path = identitiesPath(PROJECT_DIR)

if (values.json) {
  console.log(JSON.stringify(identities, null, 2))
  process.exit(0)
}

const names = Object.keys(identities)
console.log(`\n${bold('artel trust list')} ${dim(`— ${path}`)}\n`)
if (!names.length) {
  console.log(`  ${dim('(no identities registered — create the file with)')}\n`)
  console.log(`  ${dim('cat > ' + path + " <<'EOF'")}`)
  console.log(`  ${dim('{ "bot": { "name": "artel-bot", "email": "artel-bot@cluster.local" } }')}`)
  console.log(`  ${dim('EOF')}\n`)
  process.exit(0)
}

for (const name of names.sort()) {
  const id = identities[name]
  const author = id.name && id.email ? `${id.name} <${id.email}>` : (id.name || id.email || dim('—'))
  const ssh = id.ssh_key ? `${dim('· ssh')} ${id.ssh_key}` : ''
  console.log(`  ${cyan(name.padEnd(12))} ${author} ${ssh}`)
}
console.log()
