// Shared test helpers. Not picked up by `*.test.ts` glob — leading
// underscore avoids collision; vitest treats this as a regular module.

import { cpSync, chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import * as schemaModule from '../engine/core/schema.mjs'
import * as clusterModule from '../engine/core/cluster.mjs'
import * as idsModule from '../engine/util/ids.mjs'
import * as contractModule from '../engine/util/contract.mjs'
import * as claudeModule from '../engine/drivers/claude.mjs'
import * as codexModule from '../engine/drivers/codex.mjs'
import * as copilotModule from '../engine/drivers/copilot.mjs'
import { dispatchLifecycle as dispatchLifecycleRaw } from '../engine/core/dispatch_lifecycle.mjs'

// -------- typed re-exports of engine modules --------

type DriverArgs = (meta: Record<string, unknown>, promptParts: string[], session?: Record<string, unknown>) => string[]
type Usage = { tokens_in: number; tokens_out: number; cache_read: number; cache_creation: number; model: string | null; cost_usd: number | null }

export const schema = schemaModule as {
  validateEventType: (kind: string, type: string) => void
  SCHEMA_VERSION: string
  VALID_KINDS: Set<string>
}
export const cluster = clusterModule as {
  ensureClusterIdentity: (dir: string, opts?: { name?: string }) => Record<string, unknown>
  readClusterIdentity: (dir: string) => Record<string, unknown> | null
  instanceId: () => string
  _resetCachesForTests: () => void
}
export const ids = idsModule as { uuidv7: () => string }
export const contract = contractModule as {
  validateRoleFrontmatter: (m: Record<string, unknown>, src?: string) => void
  validateSkillFrontmatter: (m: Record<string, unknown>, src?: string) => void
}
type Tokens = { totals: Record<string, number>; perDay: Record<string, number> }
export const claudeDriver = claudeModule as unknown as { args: DriverArgs; api_version: number; parseUsage: (a: string, b: string) => unknown; sessionTokens: (opts: Record<string, unknown>) => Tokens }
export const codexDriver = codexModule as unknown as { args: DriverArgs; api_version: number; parseUsage: (a: string, b: string) => Usage | null; sessionTokens: (opts: Record<string, unknown>) => Tokens }
export const copilotDriver = copilotModule as unknown as { args: DriverArgs; api_version: number; parseUsage: () => unknown; sessionTokens: (opts: Record<string, unknown>) => Tokens }
export const dispatchLifecycle = dispatchLifecycleRaw as (
  options: Record<string, unknown>,
  hooks?: Record<string, unknown>,
) => Promise<{ disposition: string; exitCode: number }>

// -------- temp-repo / git fixture --------

const testDir = dirname(fileURLToPath(import.meta.url))
export const repoRoot = resolve(testDir, '..')

const tempRoots: string[] = []
export const cleanupTempRoots = () => {
  while (tempRoots.length) rmSync(tempRoots.pop()!, { recursive: true, force: true })
  cluster._resetCachesForTests()
}

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
}

export const execGit = (cwd: string, args: string[]) =>
  execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' }).trim()

const initRepo = (cwd: string) => {
  execGit(cwd, ['init', '-b', 'master'])
  // Local user.name/user.email so git operations spawned by the
  // platform-under-test (e.g. `git tag -a` via builtin.git_tag in
  // V3.7.f) have committer info. Without this, CI images that lack
  // global git config fail with "Author identity unknown" — locally
  // ~/.gitconfig usually masks the issue.
  execGit(cwd, ['config', 'user.name', 'Test'])
  execGit(cwd, ['config', 'user.email', 'test@example.com'])
  execGit(cwd, ['add', '.'])
  const tree = execGit(cwd, ['write-tree'])
  const commit = execGit(cwd, ['commit-tree', tree, '-m', 'init'])
  execGit(cwd, ['update-ref', 'refs/heads/master', commit])
  execGit(cwd, ['checkout', '-B', 'master', commit])
}

export const snapshotRepo = (cwd: string, message: string) => {
  execGit(cwd, ['add', '.'])
  const tree = execGit(cwd, ['write-tree'])
  const parent = execGit(cwd, ['rev-parse', 'HEAD'])
  const commit = execGit(cwd, ['commit-tree', tree, '-p', parent, '-m', message])
  const branch = execGit(cwd, ['branch', '--show-current'])
  execGit(cwd, ['update-ref', `refs/heads/${branch}`, commit])
  execGit(cwd, ['checkout', '-B', branch, commit])
}

const queueFixture = () =>
  [
    '# Work queue', '',
    '## For Owner', '- (none)', '',
    '## In progress', '- [infra] timeout smoke [task: timeout-smoke]', '',
    '## Pending', '- (none)', '',
    '## Blocked', '- (none)', '',
    '## Recently done', '- (none)', '',
  ].join('\n')

const stateFixture = () =>
  [
    '---',
    'generated_at: "2026-05-01T00:00:00.000Z"',
    'acting_role: "dispatcher"', 'acting_provider: "claude"',
    'dispatcher_status: "idle"', 'dispatcher_session: "test"',
    'orchestrator_engine: "claude"', 'orchestrator_session_id: "orch-test"',
    '---', '', '# state', '',
  ].join('\n')

const roleFixture = (name: string, extras: string[] = []) => [
  '---',
  `name: ${name}`,
  `description: ${name} test fixture`,
  'schema: role-v1',
  'version: 1',
  'updated_at: 2026-05-03T00:00:00.000Z',
  'engine: claude',
  ...extras,
  '---',
  `${name} test role`,
].join('\n')

export const createTempRepo = () => {
  const root = mkdtempSync(join(tmpdir(), 'artel-engine-test-'))
  tempRoots.push(root)
  mkdirSync(join(root, 'agents'), { recursive: true })
  mkdirSync(join(root, 'engine', 'drivers'), { recursive: true })
  mkdirSync(join(root, '.artel'), { recursive: true })
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'artel-engine-test-test', private: true, type: 'module' }, null, 2) + '\n',
  )
  writeFileSync(
    join(root, '.gitignore'),
    ['bin/', '.artel/.dispatches/', '.artel/.sessions/', '.artel/.worktrees/', '.artel/events.jsonl', '.artel/cluster.json'].join('\n') + '\n',
  )
  writeFileSync(join(root, 'agents', 'implementer.md'), roleFixture('implementer'))
  writeFileSync(join(root, 'agents', 'adversary.md'), roleFixture('adversary', ['protected_branch: true']))
  writeFileSync(join(root, 'engine', 'drivers', 'claude.mjs'), 'export const id = "claude"\n')
  writeFileSync(join(root, '.artel', 'QUEUE.md'), queueFixture())
  writeFileSync(join(root, '.artel', 'state.md'), stateFixture())
  writeFileSync(
    join(root, '.artel', 'dispatcher_state.json'),
    JSON.stringify({ role: 'dispatcher', provider: 'claude', control_status: 'idle', session: 'test' }, null, 2) + '\n',
  )
  initRepo(root)
  return root
}

export const installEngineRuntime = (root: string, files: string[]) => {
  for (const relative of files) {
    const from = join(repoRoot, relative)
    const to = join(root, relative)
    mkdirSync(dirname(to), { recursive: true })
    cpSync(from, to)
  }
}

export const installStub = (root: string, name: string, body: string) => {
  const binDir = join(root, 'bin')
  mkdirSync(binDir, { recursive: true })
  const path = join(binDir, name)
  writeFileSync(path, body)
  chmodSync(path, 0o755)
  return binDir
}

export const runNode = (cwd: string, args: string[], env: Record<string, string> = {}) =>
  spawnSync('node', args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8' })

// Bundled lists of files needed by various e2e CLI smoke tests.
// Centralised so adding a new dependency in a CLI = one place to update.
export const ENGINE_FILES_CORE = [
  'engine/core/dispatch_api.mjs',
  'engine/core/dispatch_lifecycle.mjs',
  'engine/core/parked.mjs',
  'engine/core/schema.mjs',
  'engine/core/cluster.mjs',
  'engine/core/queue_graph.mjs',
]
export const ENGINE_FILES_UTIL = [
  'engine/util/cli.mjs',
  'engine/util/ids.mjs',
  'engine/util/fs.mjs',
  'engine/util/frontmatter.mjs',
  'engine/util/skills.mjs',
  'engine/util/contract.mjs',
  'engine/util/git.mjs',
  'engine/util/drivers.mjs',
  'engine/util/proc.mjs',
  'engine/util/trust.mjs',
  'engine/util/crypto.mjs',
  'engine/util/audit.mjs',
  'engine/util/pipelines.mjs',
  'engine/util/worktree.mjs',
  'engine/util/handlers.mjs',
]
export const ENGINE_FILES_DRIVERS = [
  'engine/drivers/claude.mjs',
  'engine/drivers/codex.mjs',
  'engine/drivers/copilot.mjs',
]
