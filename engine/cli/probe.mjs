#!/usr/bin/env node
// Engine readiness probe — `artel probe`.
// Asks each driver: binary on PATH, version, auth state. Renders a
// compact per-engine row with an actionable hint per problem.
//
// Plain text mode: snapshot, no model call, instant.
// `--json` mode: detailed per-engine `checks[]` array, includes a real
//                roundtrip to the model (binary + auth must already be
//                green to attempt). Roundtrips run in parallel.
// Exit code: 0 if every engine is fully ready, 1 if any has problems.

import { parseArgs } from 'node:util'
import { discoverDrivers } from '../drivers/loader.mjs'
import { chalk } from '../util/chalk.mjs'

const usage = (code = 0) => {
  console.log(`\
Usage: artel probe [--json] [--no-ping] [--timeout-ms <n>]

Asks each engine driver (claude / codex / copilot): binary on PATH,
version, auth state. Renders one line per engine plus a hint when
something needs attention.

Plain text mode is a snapshot — no model call, instant.
\`--json\` mode also performs a live roundtrip ("ping → pong") against
each engine whose binary + auth are green. Pass \`--no-ping\` to skip
the model call. \`--timeout-ms\` sets the per-engine roundtrip timeout
(default 30000).

Exit code 0 if every engine is fully ready, 1 otherwise.`)
  process.exit(code)
}

let values
try {
  ({ values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      json: { type: 'boolean' },
      'no-ping': { type: 'boolean' },
      'timeout-ms': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  }))
} catch (err) {
  console.error(err.message)
  process.exit(2)
}

if (values.help) usage(0)

const timeoutMs = values['timeout-ms'] ? Number(values['timeout-ms']) : 30000
const ping = values.json && !values['no-ping']

// Discover all visible drivers (platform + overlays). Drivers without a
// `probe()` export get a placeholder row — custom drivers without
// readiness logic surface as 'unknown' rather than crashing the panel.
const drivers = await discoverDrivers()
const probes = drivers.map(({ id, source, module }) => {
  if (typeof module.probe !== 'function') {
    return {
      probe: {
        engine: id,
        binary: module.command || '?',
        installed: false,
        version: null,
        authState: 'unknown',
        hint: `driver from ${source} does not implement probe()`,
      },
      module,
      source,
    }
  }
  return { probe: module.probe(), module, source }
})

// Roundtrip: only attempt when binary + auth look green AND the driver
// implements roundtrip(). Run all eligible engines in parallel.
const roundtrips = ping
  ? await Promise.all(probes.map(async ({ probe, module }) => {
      if (!probe.installed || probe.authState !== 'ok' || typeof module.roundtrip !== 'function') {
        return null
      }
      try {
        return await module.roundtrip({ timeoutMs })
      } catch (err) {
        return { status: 'down', detail: `roundtrip threw: ${err?.message || String(err)}`, durationMs: null }
      }
    }))
  : probes.map(() => null)

const checksFor = (probe, rt) => {
  const checks = []
  checks.push({
    id: 'binary',
    status: probe.installed ? 'ok' : 'fail',
    detail: probe.installed
      ? `${probe.binary} ${probe.version || '?'} on PATH`
      : (probe.hint || `${probe.binary} not on PATH`),
  })
  checks.push({
    id: 'auth',
    status: probe.authState === 'ok' ? 'ok' : probe.authState === 'unknown' ? 'unknown' : 'fail',
    detail: probe.authState === 'ok'
      ? 'authenticated'
      : (probe.hint || probe.authState),
  })
  if (rt) {
    checks.push({
      id: 'roundtrip',
      status: rt.status,
      detail: rt.detail,
      ...(rt.durationMs != null ? { durationMs: rt.durationMs } : {}),
      ...(rt.response ? { response: rt.response } : {}),
    })
  } else if (ping) {
    // Eligible but skipped by us — keep the row honest.
    checks.push({
      id: 'roundtrip',
      status: 'skipped',
      detail: probe.installed
        ? (typeof probe === 'function' ? 'driver does not implement roundtrip()' : 'auth not green — roundtrip skipped')
        : 'binary missing — roundtrip skipped',
    })
  }
  return checks
}

const overallStatus = (checks) => {
  if (checks.some((c) => c.status === 'fail' || c.status === 'down')) return 'down'
  if (checks.some((c) => c.status === 'unexpected' || c.status === 'unknown' || c.status === 'skipped')) return 'degraded'
  return 'ok'
}

if (values.json) {
  const out = probes.map(({ probe, source }, i) => {
    const checks = checksFor(probe, roundtrips[i])
    return {
      engine: probe.engine,
      source,
      binary: probe.binary,
      version: probe.version,
      status: overallStatus(checks),
      checks,
      hint: probe.hint,
    }
  })
  console.log(JSON.stringify(out, null, 2))
  const allOk = out.every((r) => r.status === 'ok')
  process.exit(allOk ? 0 : 1)
}

// --- text mode ---

const mark = (state) => state === 'ok' ? chalk.green('✓') : state === 'unknown' ? chalk.yellow('?') : chalk.red('✗')
const stateWord = (probe) =>
  probe.authState === 'ok'
    ? chalk.green('ready')
    : probe.authState === 'unknown'
      ? chalk.yellow('unknown')
      : chalk.red(probe.installed ? 'no auth' : 'not installed')

console.log(`\n${chalk.bold('artel probe')} ${chalk.dim('— engine readiness')}\n`)
for (const { probe, source } of probes) {
  const ver = probe.version ? probe.version.padEnd(10) : chalk.dim('—'.padEnd(10))
  const overlay = source && source !== 'platform' ? chalk.dim(` (${source})`) : ''
  const hint = probe.hint ? `${chalk.dim('·')} ${chalk.dim(probe.hint)}` : ''
  console.log(`  ${mark(probe.authState)} ${probe.engine.padEnd(8)}${overlay} ${ver} ${stateWord(probe).padEnd(15)} ${hint}`)
}
const ready = probes.filter(({ probe }) => probe.authState === 'ok').length
console.log(`\n${chalk.dim(`${ready}/${probes.length} engines ready`)}${chalk.dim(' · pass --json for detailed checks + live roundtrip')}\n`)

const allOk = probes.every(({ probe }) => probe.authState === 'ok')
process.exit(allOk ? 0 : 1)
