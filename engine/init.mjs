#!/usr/bin/env node
// Consumer-side bootstrap. Idempotent: if `.collab/cluster.json` already
// exists, prints its contents; otherwise generates fresh identity.
//
//   node $COLLAB_HOME/engine/init.mjs                     # bootstrap or print
//   node $COLLAB_HOME/engine/init.mjs --name my-laptop    # with explicit name
//   COLLAB_PROJECT_DIR=/path node $COLLAB_HOME/engine/init.mjs

import { join } from 'node:path'
import { ensureClusterIdentity } from './cluster.mjs'

const PROJECT_DIR = process.env.COLLAB_PROJECT_DIR || process.cwd()
const PROJECT_COLLAB = join(PROJECT_DIR, '.collab')

const argv = process.argv.slice(2)
let name = null
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--name' && argv[i + 1]) name = argv[++i]
  else if (argv[i] === '-h' || argv[i] === '--help') {
    console.error('Usage: node $COLLAB_HOME/engine/init.mjs [--name <cluster-name>]')
    console.error('       Idempotent — re-running prints existing identity without changes.')
    process.exit(argv[i] === '-h' || argv[i] === '--help' ? 0 : 2)
  }
}

const cluster = ensureClusterIdentity(PROJECT_COLLAB, { name })
console.log(JSON.stringify(cluster, null, 2))
