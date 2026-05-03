#!/usr/bin/env node
// Engine readiness probe — `artel probe`.
// Asks each driver: binary on PATH, version, auth state. Renders a
// compact per-engine row with an actionable hint per problem.
// Exit code: 0 if every engine is fully ready, 1 if any has problems.

import { parseArgs } from 'node:util'
import { discoverDrivers } from '../util/drivers.mjs'

const tty = process.stdout.isTTY
const c = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s)
const dim = (s) => c('2', s)
const bold = (s) => c('1', s)
const green = (s) => c('32', s)
const yellow = (s) => c('33', s)
const red = (s) => c('31', s)

const usage = (code = 0) => {
  console.log(`\
Usage: artel probe [--json]

Asks each engine driver (claude / codex / copilot): binary on PATH,
version, auth state. Renders one line per engine plus a hint when
something needs attention.

Exit code 0 if every engine is fully ready, 1 otherwise.`)
  process.exit(code)
}

let values
try {
  ({ values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  }))
} catch (err) {
  console.error(err.message)
  process.exit(2)
}

if (values.help) usage(0)

// Discover all visible drivers (platform + overlays). Drivers without a
// `probe()` export get a placeholder row — custom drivers without
// readiness logic surface as 'unknown' rather than crashing the panel.
const drivers = await discoverDrivers()
const results = drivers.map(({ id, source, module }) => {
  if (typeof module.probe !== 'function') {
    return {
      engine: id,
      binary: module.command || '?',
      installed: false,
      version: null,
      authState: 'unknown',
      hint: `driver from ${source} does not implement probe()`,
      source,
    }
  }
  return { ...module.probe(), source }
})
const allOk = results.every((r) => r.authState === 'ok')

if (values.json) {
  console.log(JSON.stringify(results, null, 2))
  process.exit(allOk ? 0 : 1)
}

const mark = (state) => state === 'ok' ? green('✓') : state === 'unknown' ? yellow('?') : red('✗')
const stateWord = (r) =>
  r.authState === 'ok'
    ? green('ready')
    : r.authState === 'unknown'
      ? yellow('unknown')
      : red(r.installed ? 'no auth' : 'not installed')

console.log(`\n${bold('artel probe')} ${dim('— engine readiness')}\n`)
for (const r of results) {
  const ver = r.version ? r.version.padEnd(10) : dim('—'.padEnd(10))
  const overlay = r.source && r.source !== 'platform' ? dim(` (${r.source})`) : ''
  const hint = r.hint ? `${dim('·')} ${dim(r.hint)}` : ''
  console.log(`  ${mark(r.authState)} ${r.engine.padEnd(8)}${overlay} ${ver} ${stateWord(r).padEnd(15)} ${hint}`)
}
const ready = results.filter((r) => r.authState === 'ok').length
console.log(`\n${dim(`${ready}/${results.length} engines ready`)}\n`)

process.exit(allOk ? 0 : 1)
