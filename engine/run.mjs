#!/usr/bin/env node
// Role dispatcher for the cooperative agent model — see ../AGENTS.md.
// Reads ../agents/<role>.md, picks the engine driver from frontmatter
// `engine: <name>` (default `claude`), spawns the underlying CLI with
// role-scoped surface. Engine drivers live in ./drivers/.
//
// Universal terms (DESIGN.md §5): runner speaks model / effort / sandbox /
// tools / permission-mode. Drivers translate to engine-native flags.
//
//   node $COLLAB_HOME/engine/run.mjs architect "review the design"
//   node $COLLAB_HOME/engine/run.mjs --engine codex --effort xhigh implementer "ship the fixture"
//   node $COLLAB_HOME/engine/run.mjs --task adr-…  --task-attrs '{"phase":"A"}' implementer "ship it"
//   node $COLLAB_HOME/engine/run.mjs --list

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { buildTaskContextBlock, parseJsonObject } from './dispatch_api.mjs'

const here = dirname(fileURLToPath(import.meta.url))
// Platform paths: agents/ + drivers/ live alongside this file in the platform
// repo. They never reference the consumer project's location.
const PLATFORM_DIR = join(here, '..')
const AGENTS_DIR = join(PLATFORM_DIR, 'agents')
const ENGINES_DIR = join(here, 'drivers')

// Frontmatter keys that have been promoted to universal terms. Map:
// legacy → canonical. Run-time normalisation: warn + rewrite. Drivers also
// read both for resilience when invoked outside run.mjs.
const DEPRECATED_FRONTMATTER_KEYS = {
  'codex-model': 'model',
  'codex-effort': 'effort',
  'copilot-model': 'model',
  'copilot-tools': 'tools',
}

const parseFrontmatter = (text) => {
  const match = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!match) return { meta: {}, body: text }
  const meta = {}
  for (const line of match[1].split('\n')) {
    const m = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/)
    if (m) meta[m[1]] = m[2].trim()
  }
  return { meta, body: match[2] }
}

const normaliseFrontmatter = (meta, rolePath) => {
  for (const [legacy, canonical] of Object.entries(DEPRECATED_FRONTMATTER_KEYS)) {
    if (meta[legacy] === undefined) continue
    console.error(`warning: frontmatter "${legacy}" is deprecated; use "${canonical}" (in ${rolePath})`)
    if (meta[canonical] === undefined) meta[canonical] = meta[legacy]
    delete meta[legacy]
  }
  return meta
}

const listRoles = () =>
  existsSync(AGENTS_DIR)
    ? readdirSync(AGENTS_DIR)
        .filter((f) => f.endsWith('.md') && f !== 'README.md')
        .map((f) => f.replace(/\.md$/, ''))
    : []

const listEngines = () =>
  existsSync(ENGINES_DIR)
    ? readdirSync(ENGINES_DIR)
        .filter((f) => f.endsWith('.mjs'))
        .map((f) => f.replace(/\.mjs$/, ''))
    : []

const usage = (code = 2) => {
  const roles = listRoles()
  const engines = listEngines()
  console.error('Usage: node $COLLAB_HOME/engine/run.mjs [options] <role> [...prompt]')
  console.error('       node $COLLAB_HOME/engine/run.mjs --list')
  console.error('')
  console.error('Options:')
  console.error('  --engine <name>            override engine driver')
  console.error('  --model <name>             override model')
  console.error('  --effort <level>           reasoning effort (codex)')
  console.error('  --sandbox <mode>           read-only|workspace-write|full-access')
  console.error('  --tools <list>             tool allowlist (comma-sep)')
  console.error('  --permission-mode <mode>   permission mode (claude)')
  console.error('  --task <slug>              task id for event tracing')
  console.error('  --task-attrs <json>        task attributes (JSON object)')
  if (roles.length) console.error(`Roles: ${roles.join(', ')}`)
  if (engines.length) console.error(`Engines: ${engines.join(', ')}`)
  process.exit(code)
}

const argv = process.argv.slice(2)
if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') usage(0)
if (argv[0] === '--list') {
  for (const r of listRoles()) console.log(r)
  process.exit(0)
}

let engineOverride = null
let resumeId = null
let sessionId = null
let modelOverride = null
let effortOverride = null
let sandboxOverride = null
let toolsOverride = null
let permissionModeOverride = null
let task = process.env.COLLAB_TASK || null
let taskAttrs = process.env.COLLAB_TASK_ATTRS ? parseJsonObject(process.env.COLLAB_TASK_ATTRS, 'COLLAB_TASK_ATTRS') : null
const filtered = []
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--engine' && argv[i + 1]) {
    engineOverride = argv[++i]
  } else if (argv[i] === '--resume' && argv[i + 1]) {
    resumeId = argv[++i]
  } else if (argv[i] === '--session-id' && argv[i + 1]) {
    sessionId = argv[++i]
  } else if (argv[i] === '--model' && argv[i + 1]) {
    modelOverride = argv[++i]
  } else if (argv[i] === '--effort' && argv[i + 1]) {
    effortOverride = argv[++i]
  } else if (argv[i] === '--codex-effort' && argv[i + 1]) {
    // Deprecated alias for --effort. Kept for one cycle of back-compat.
    console.error('warning: --codex-effort is deprecated; use --effort')
    effortOverride = argv[++i]
  } else if (argv[i] === '--sandbox' && argv[i + 1]) {
    sandboxOverride = argv[++i]
  } else if (argv[i] === '--tools' && argv[i + 1]) {
    toolsOverride = argv[++i]
  } else if (argv[i] === '--permission-mode' && argv[i + 1]) {
    permissionModeOverride = argv[++i]
  } else if (argv[i] === '--task' && argv[i + 1]) {
    task = argv[++i]
  } else if (argv[i] === '--task-attrs' && argv[i + 1]) {
    taskAttrs = parseJsonObject(argv[++i], '--task-attrs')
  } else {
    filtered.push(argv[i])
  }
}

const [role, ...promptParts] = filtered
if (!role) usage(2)

const rolePath = join(AGENTS_DIR, `${role}.md`)
if (!existsSync(rolePath)) {
  console.error(`Role not found: ${rolePath}`)
  process.exit(1)
}

const { meta, body } = parseFrontmatter(readFileSync(rolePath, 'utf8'))
normaliseFrontmatter(meta, rolePath)
const engineId = engineOverride || meta.engine || 'claude'

// Whitelist against listEngines() — engine name comes from caller and goes into
// `await import(pathToFileURL(...))`. Without this, `--engine ../../foo` could
// import attacker-controlled `.mjs` if any traversal target is reachable.
const engines = listEngines()
if (!engines.includes(engineId)) {
  console.error(`Unknown engine: ${engineId}`)
  console.error(`Available engines: ${engines.join(', ')}`)
  process.exit(1)
}
const enginePath = join(ENGINES_DIR, `${engineId}.mjs`)

const driver = await import(pathToFileURL(enginePath).href)
const taskContext = buildTaskContextBlock({ task, taskAttrs })
const effectivePromptParts = taskContext ? [taskContext, ...promptParts] : promptParts

// Precedence for universal terms: CLI override > role frontmatter > engine
// default. CLI override is per-dispatch (e.g. ad-hoc `--effort xhigh` while
// implementer.md keeps frontmatter clean).
const driverMeta = { ...meta, body, task, taskAttrs }
if (modelOverride) driverMeta.model = modelOverride
if (effortOverride) driverMeta.effort = effortOverride
if (sandboxOverride) driverMeta.sandbox = sandboxOverride
if (toolsOverride) driverMeta.tools = toolsOverride
if (permissionModeOverride) driverMeta['permission-mode'] = permissionModeOverride

const cliArgs = driver.args(driverMeta, effectivePromptParts, { resumeId, sessionId })

// Close stdin (`ignore`) so engines that read from stdin when it's open
// (codex prints "Reading additional input from stdin..." and blocks otherwise)
// don't hang waiting for input that isn't coming.
//
// COLLAB_DISPATCH_ID / COLLAB_TRACE_ID inherit from process.env (set by
// dispatch_lifecycle when it spawned us). If the engine CLI itself shells
// out to spawn.mjs (nested dispatch), the new dispatch reads these env
// vars and treats this dispatch as parent. See DESIGN.md §6.
const childEnv = {
  ...process.env,
  COLLAB_ROLE: role,
  ...(task ? { COLLAB_TASK: task } : {}),
  ...(taskAttrs ? { COLLAB_TASK_ATTRS: JSON.stringify(taskAttrs) } : {}),
}
const child = spawn(driver.command, cliArgs, { stdio: ['ignore', 'inherit', 'inherit'], env: childEnv })
child.on('exit', (code) => process.exit(code ?? 1))
child.on('error', (err) => {
  console.error(`spawn ${driver.command} failed: ${err.message}`)
  process.exit(1)
})
