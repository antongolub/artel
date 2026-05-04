#!/usr/bin/env node
// Unified entry point: `artel <command> [...args]` routes to the matching
// CLI module under engine/cli/. Subcommand modules read process.argv.slice(2)
// directly, so we reshape argv before dynamic-importing the target.

import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const SUBCOMMANDS = {
  init: 'init.mjs',
  run: 'run.mjs',
  spawn: 'spawn.mjs',
  status: 'status.mjs',
  probe: 'probe.mjs',
  logs: 'logs.mjs',
  events: 'events.mjs',
  replay: 'replay.mjs',
  checkpoint: 'checkpoint.mjs',
}

const usage = (code = 2) => {
  const cmds = Object.keys(SUBCOMMANDS).join(' | ')
  console.error(`\
Usage: artel <${cmds}> [...args]

  init        bootstrap .artel/cluster.json for a project
  run         dispatch a role one-shot (low-level)
  spawn       dispatch with task sidecar + branch + timeout
  status      cluster snapshot or live dashboard
  probe       engine readiness (binary + version + auth state)
  logs        drill into a single dispatch (meta + events + prompt + out)
  events      tail / filter the event stream (events.jsonl)
  replay      re-run a past dispatch (same role + prompt, optionally new engine)
  checkpoint  emit a sub-role checkpoint event

Run 'artel <command> --help' for command-specific options.`)
  process.exit(code)
}

const [, , sub, ...rest] = process.argv

if (!sub || sub === '-h' || sub === '--help') usage(sub ? 0 : 2)

const target = SUBCOMMANDS[sub]
if (!target) {
  console.error(`artel: unknown command '${sub}'`)
  usage(2)
}

const here = dirname(fileURLToPath(import.meta.url))
const targetPath = join(here, target)

// Subcommand expects its own args at argv[2..]. Reshape so the imported
// module sees what it would see if invoked directly.
process.argv = [process.argv[0], targetPath, ...rest]

await import(pathToFileURL(targetPath).href)
