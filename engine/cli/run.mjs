#!/usr/bin/env node
// Role dispatcher. Reads ../agents/<role>.md, picks the engine driver from
// frontmatter `engine: <name>` (default `claude`), spawns the underlying
// CLI with role-scoped surface.
//
// Universal terms (DESIGN.md §5): runner speaks model / effort / sandbox /
// tools / permission-mode. Drivers translate to engine-native flags.

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parseArgs } from 'node:util'
import { buildTaskContextBlock, parseJsonObject } from '../core/dispatch_api.mjs'
import { parseFrontmatter, normaliseFrontmatter } from '../agents/frontmatter.mjs'
import { expandSkills } from '../agents/skills.mjs'
import { validateRoleFrontmatter } from '../agents/contract.mjs'
import { listDrivers, loadDriver } from '../drivers/loader.mjs'
import { die } from '../util/chalk.mjs'
import { config, dispatchEnv } from '../config/env.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const PLATFORM_DIR = join(here, '..', '..')
const AGENTS_DIR = join(PLATFORM_DIR, 'agents')
const PLATFORM_SKILLS_DIR = join(PLATFORM_DIR, 'skills')
const PROJECT_SKILLS_DIR = config.skillsDir

const listDir = (dir, ext) =>
  existsSync(dir)
    ? readdirSync(dir).filter((f) => f.endsWith(ext)).map((f) => f.slice(0, -ext.length))
    : []

const listRoles = () => listDir(AGENTS_DIR, '.md').filter((n) => n !== 'README')

const usage = (code = 2) => {
  const roles = listRoles()
  const engines = listDrivers()
  console.error(`\
Usage: artel run [options] <role> [...prompt]
       artel run --list

Options:
  --engine <name>            override engine driver
  --model <name>             override model
  --effort <level>           reasoning effort (codex)
  --sandbox <mode>           read-only|workspace-write|full-access
  --tools <list>             tool allowlist (comma-sep)
  --permission-mode <mode>   permission mode (claude)
  --task <slug>              task id for event tracing
  --task-attrs <json>        task attributes (JSON object)
${roles.length ? `Roles: ${roles.join(', ')}\n` : ''}\
${engines.length ? `Engines: ${engines.join(', ')}` : ''}`)
  process.exit(code)
}

const OPTIONS = {
  engine: { type: 'string' },
  resume: { type: 'string' },
  'session-id': { type: 'string' },
  model: { type: 'string' },
  effort: { type: 'string' },
  'codex-effort': { type: 'string' }, // deprecated alias for --effort
  sandbox: { type: 'string' },
  tools: { type: 'string' },
  'permission-mode': { type: 'string' },
  task: { type: 'string' },
  'task-attrs': { type: 'string' },
  list: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
}

let values, positionals
try {
  ({ values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: OPTIONS,
    allowPositionals: true,
  }))
} catch (err) {
  console.error(err.message)
  usage(2)
}

if (values.help) usage(0)
if (values.list) {
  for (const r of listRoles()) console.log(r)
  process.exit(0)
}
if (positionals.length === 0) usage(2)

if (values['codex-effort'] && !values.effort) {
  console.error('warning: --codex-effort is deprecated; use --effort')
  values.effort = values['codex-effort']
}

const [role, ...promptParts] = positionals
const dEnv = dispatchEnv()
const task = values.task || dEnv.task
const taskAttrs = values['task-attrs']
  ? parseJsonObject(values['task-attrs'], '--task-attrs')
  : dEnv.taskAttrs
    ? parseJsonObject(dEnv.taskAttrs, 'ARTEL_TASK_ATTRS')
    : null

const rolePath = join(AGENTS_DIR, `${role}.md`)
if (!existsSync(rolePath)) die(`Role not found: ${rolePath}`)

const { meta, body } = parseFrontmatter(readFileSync(rolePath, 'utf8'))
normaliseFrontmatter(meta, rolePath)
validateRoleFrontmatter(meta, rolePath)

const engineId = values.engine || meta.engine || 'claude'

// loadDriver resolves <engineId>.mjs across the overlay layers:
//   project (.artel/drivers/) > user (~/.artel/drivers/) > platform.
// Throws on unknown id (whitelist effect — only ids surfaced by
// listDrivers() are loadable, defeating `--engine ../../foo`).
let driver
try {
  ;({ module: driver } = await loadDriver(engineId))
} catch (err) {
  die(err.message)
}

// Compose the role's tool surface from declared skills + raw `tools:`.
// Skills (e.g. `git-write, file-edit`) expand from skills/<name>.md;
// `tools:` adds raw patterns inline. Project skill overrides win over
// platform defaults. CLI `--tools` replaces the whole composed surface.
const skillNames = (meta.skills || '').split(',').map((s) => s.trim()).filter(Boolean)
const skillTools = expandSkills(skillNames, [PROJECT_SKILLS_DIR, PLATFORM_SKILLS_DIR])
const rawTools = (meta.tools || '').split(',').map((s) => s.trim()).filter(Boolean)
const composedTools = [...new Set([...skillTools, ...rawTools])].join(', ')

// Precedence for universal terms: CLI override > role frontmatter > driver
// default. Per-dispatch CLI override means `implementer.md` can stay clean
// while a one-off run uses `--effort xhigh`.
const driverMeta = { ...meta, body, task, taskAttrs, tools: composedTools }
for (const key of ['model', 'effort', 'sandbox', 'tools', 'permission-mode']) {
  if (values[key]) driverMeta[key] = values[key]
}

const taskContext = buildTaskContextBlock({ task, taskAttrs })
const promptWithContext = taskContext ? [taskContext, ...promptParts] : promptParts

const cliArgs = driver.args(driverMeta, promptWithContext, {
  resumeId: values.resume || null,
  sessionId: values['session-id'] || null,
})

// Close stdin (`ignore`) so engines that read from stdin when it's open
// (codex prints "Reading additional input from stdin..." and blocks) don't
// hang waiting for input that isn't coming.
//
// ARTEL_DISPATCH_ID / ARTEL_TRACE_ID inherit from process.env (set by
// dispatch_lifecycle when it spawned us). If the engine CLI itself shells
// out to spawn.mjs (nested dispatch), the new dispatch reads these and
// treats this dispatch as parent. See DESIGN.md §6.
const child = spawn(driver.command, cliArgs, {
  stdio: ['ignore', 'inherit', 'inherit'],
  env: {
    ...process.env,
    ARTEL_ROLE: role,
    ...(task ? { ARTEL_TASK: task } : {}),
    ...(taskAttrs ? { ARTEL_TASK_ATTRS: JSON.stringify(taskAttrs) } : {}),
  },
})
child.on('exit', (code) => process.exit(code ?? 1))
child.on('error', (err) => die(`spawn ${driver.command} failed: ${err.message}`))
