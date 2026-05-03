#!/usr/bin/env node
// Consumer-side bootstrap. Idempotent: if `.artel/cluster.json` already
// exists, prints its contents; otherwise generates a fresh identity.

import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { ensureClusterIdentity } from '../core/cluster.mjs'

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    name: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
})

if (values.help) {
  console.error(`\
Usage: artel init [--name <cluster-name>]
Idempotent — re-running prints the existing identity without changes.`)
  process.exit(0)
}

const projectArtelDir = join(process.env.ARTEL_PROJECT_DIR || process.cwd(), '.artel')
const cluster = ensureClusterIdentity(projectArtelDir, { name: values.name ?? null })
console.log(JSON.stringify(cluster, null, 2))
