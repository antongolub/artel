import { cpSync, chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { EventEmitter } from 'node:events'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error collab engine scripts are JS-only CLI modules under test.
import { dispatchLifecycle } from '../../../collab/engine/dispatch_lifecycle.mjs'

const testDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(testDir, '../../..')
const tempRoots: string[] = []
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
}

const execGit = (cwd: string, args: string[]) =>
  execFileSync('git', args, {
    cwd,
    env: gitEnv,
    encoding: 'utf8',
  }).trim()

const initRepo = (cwd: string) => {
  execGit(cwd, ['init', '-b', 'master'])
  execGit(cwd, ['add', '.'])
  const tree = execGit(cwd, ['write-tree'])
  const commit = execGit(cwd, ['commit-tree', tree, '-m', 'init'])
  execGit(cwd, ['update-ref', 'refs/heads/master', commit])
  execGit(cwd, ['checkout', '-B', 'master', commit])
}

const snapshotRepo = (cwd: string, message: string) => {
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
    '# Work queue',
    '',
    '## For Owner',
    '- (none)',
    '',
    '## In progress',
    '- [infra] timeout smoke [task: timeout-smoke]',
    '',
    '## Pending',
    '- (none)',
    '',
    '## Blocked',
    '- (none)',
    '',
    '## Recently done',
    '- (none)',
    '',
  ].join('\n')

const stateFixture = () =>
  [
    '---',
    'generated_at: "2026-05-01T00:00:00.000Z"',
    'acting_role: "dispatcher"',
    'acting_provider: "claude"',
    'dispatcher_status: "idle"',
    'dispatcher_session: "test"',
    'orchestrator_engine: "claude"',
    'orchestrator_session_id: "orch-test"',
    '---',
    '',
    '# state',
    '',
  ].join('\n')

const createTempRepo = () => {
  const root = mkdtempSync(join(tmpdir(), 'collab-engine-test-'))
  tempRoots.push(root)
  mkdirSync(join(root, 'collab', 'agents'), { recursive: true })
  mkdirSync(join(root, 'collab', 'engine', 'drivers'), { recursive: true })
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'collab-engine-test-test', private: true, type: 'module' }, null, 2) + '\n',
  )
  writeFileSync(
    join(root, '.gitignore'),
    ['bin/', 'collab/.dispatches/', 'collab/.sessions/', 'collab/events.jsonl'].join('\n') + '\n',
  )
  writeFileSync(
    join(root, 'collab', 'agents', 'implementer.md'),
    ['---', 'engine: claude', '---', 'implementer test role'].join('\n'),
  )
  writeFileSync(
    join(root, 'collab', 'agents', 'adversary.md'),
    ['---', 'engine: claude', '---', 'adversary test role'].join('\n'),
  )
  writeFileSync(join(root, 'collab', 'engine', 'drivers', 'claude.mjs'), 'export const id = "claude"\n')
  writeFileSync(join(root, 'collab', 'QUEUE.md'), queueFixture())
  writeFileSync(join(root, 'collab', 'state.md'), stateFixture())
  writeFileSync(
    join(root, 'collab', 'dispatcher_state.json'),
    JSON.stringify({ role: 'dispatcher', provider: 'claude', control_status: 'idle', session: 'test' }, null, 2) + '\n',
  )
  initRepo(root)
  return root
}

const installEngineRuntime = (root: string, files: string[]) => {
  for (const relative of files) {
    const from = join(repoRoot, relative)
    const to = join(root, relative)
    mkdirSync(dirname(to), { recursive: true })
    cpSync(from, to)
  }
}

const installStub = (root: string, name: string, body: string) => {
  const binDir = join(root, 'bin')
  mkdirSync(binDir, { recursive: true })
  const path = join(binDir, name)
  writeFileSync(path, body)
  chmodSync(path, 0o755)
  return binDir
}

const runNode = (cwd: string, args: string[], env: Record<string, string> = {}) =>
  spawnSync('node', args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  })

afterEach(() => {
  while (tempRoots.length) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true })
  }
})

describe('dispatchLifecycle', () => {
  it('refuses to overwrite a divergent protected branch', async () => {
    const root = createTempRepo()
    const branch = 'adversary/existing-task'

    execGit(root, ['checkout', '-B', branch])
    writeFileSync(join(root, 'branch.txt'), 'branch-only\n')
    execGit(root, ['add', 'branch.txt'])
    const branchTree = execGit(root, ['write-tree'])
    const branchCommit = execGit(root, ['commit-tree', branchTree, '-p', 'HEAD', '-m', 'branch'])
    execGit(root, ['update-ref', `refs/heads/${branch}`, branchCommit])
    execGit(root, ['checkout', 'master'])

    await expect(
      dispatchLifecycle({
        role: 'adversary',
        task: 'existing-task',
        prompt: 'noop',
        collabDir: join(root, 'collab'),
      }),
    ).rejects.toThrow(`branch ${branch} exists at ${branchCommit}`)
  })

  it('marks timed-out dispatches after SIGTERM then SIGKILL', async () => {
    const root = createTempRepo()
    const startedAt = Date.now()
    const kills: Array<{ signal: string, at: number }> = []
    const child = new EventEmitter() as EventEmitter & {
      pid: number
      kill: (signal: string) => boolean
    }
    child.pid = 32100
    child.kill = (signal) => {
      kills.push({ signal, at: Date.now() })
      if (signal === 'SIGKILL') setTimeout(() => child.emit('exit', null, 'SIGKILL'), 0)
      return true
    }

    const result = await dispatchLifecycle(
      {
        role: 'implementer',
        task: 'timeout-smoke',
        prompt: 'sleep 30s',
        timeoutMs: 20,
        terminationGraceMs: 30,
        collabDir: join(root, 'collab'),
      },
      {
        spawnProcess: () => child as never,
        log: () => {},
      },
    )

    expect(result.disposition).toBe('timeout')
    expect(result.exitCode).toBe(137)
    expect(kills.map((entry) => entry.signal)).toEqual(['SIGTERM', 'SIGKILL'])
    expect(kills[0]!.at - startedAt).toBeGreaterThanOrEqual(15)
    expect(kills[1]!.at - kills[0]!.at).toBeGreaterThanOrEqual(25)

    const meta = JSON.parse(readFileSync(join(root, 'collab', '.dispatches', 'timeout-smoke.meta'), 'utf8'))
    expect(meta.status).toBe('timed-out')
    expect(meta.disposition).toBe('timeout')
    expect(meta.exitCode).toBe(137)
    expect(meta.timeout.timeoutMs).toBe(20)
    expect(meta.timeout.graceMs).toBe(30)
    expect(meta.timeout.signal).toBe('SIGKILL')

    const events = readFileSync(join(root, 'collab', 'events.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(events[0].type).toBe('claim')
    expect(events[1]).toMatchObject({
      type: 'release',
      task: 'timeout-smoke',
      disposition: 'timeout',
      owner_role: 'implementer',
    })
  })
})

describe('spawn CLI regressions', () => {
  it('keeps smoke-v3 and smoke-effort-flag alive through the lifecycle refactor', () => {
    const root = createTempRepo()
    installEngineRuntime(root, [
      'collab/engine/spawn.mjs',
      'collab/engine/run.mjs',
      'collab/engine/dispatch_api.mjs',
      'collab/engine/dispatch_lifecycle.mjs',
      'collab/engine/parked.mjs',
      'collab/engine/drivers/claude.mjs',
      'collab/engine/drivers/codex.mjs',
      'collab/agents/implementer.md',
    ])
    snapshotRepo(root, 'runtime')

    const binDir = installStub(
      root,
      'claude',
      ['#!/usr/bin/env node', 'console.log("smoke-v3-ok")'].join('\n'),
    )
    installStub(
      root,
      'codex',
      ['#!/usr/bin/env node', 'console.log(process.argv.slice(2).join(" "))'].join('\n'),
    )

    const env = { PATH: `${binDir}:${process.env.PATH || ''}` }
    const smokeV3 = runNode(root, ['collab/engine/spawn.mjs', 'implementer', 'smoke-v3', '--engine', 'claude', '-p', 'hello'], env)
    expect(smokeV3.status).toBe(0)

    const smokeEffort = runNode(
      root,
      [
        'collab/engine/spawn.mjs',
        'implementer',
        'smoke-effort-flag',
        '--engine',
        'codex',
        '--codex-effort',
        'xhigh',
        '-p',
        'hello',
      ],
      env,
    )
    expect(smokeEffort.status).toBe(0)

    const v3Meta = JSON.parse(readFileSync(join(root, 'collab', '.dispatches', 'smoke-v3.meta'), 'utf8'))
    expect(v3Meta).toMatchObject({
      task: 'smoke-v3',
      role: 'implementer',
      engine: 'claude',
      status: 'completed',
      disposition: 'success',
    })

    const effortOut = readFileSync(join(root, 'collab', '.dispatches', 'smoke-effort-flag.out'), 'utf8')
    expect(effortOut).toContain('model_reasoning_effort=xhigh')
  })
})

describe('status CLI', () => {
  it('renders timed-out dispatches above parked dispatches', () => {
    const root = createTempRepo()
    installEngineRuntime(root, ['collab/engine/status.mjs'])
    mkdirSync(join(root, 'collab', '.dispatches'), { recursive: true })
    writeFileSync(
      join(root, 'collab', '.dispatches', 'timed.meta'),
      JSON.stringify(
        {
          task: 'timed-task',
          role: 'implementer',
          engine: 'claude',
          status: 'timed-out',
          completedAt: '2026-05-01T01:00:00.000Z',
          exitCode: 137,
          timeout: { timeoutMs: 5000, signal: 'SIGKILL' },
        },
        null,
        2,
      ) + '\n',
    )
    writeFileSync(
      join(root, 'collab', '.dispatches', 'parked.meta'),
      JSON.stringify(
        {
          task: 'parked-task',
          role: 'implementer',
          engine: 'claude',
          status: 'parked',
          completedAt: '2026-05-01T00:30:00.000Z',
          parked: { reason: 'provider-limit', resetAt: '5:20pm', raw: 'hit your limit' },
        },
        null,
        2,
      ) + '\n',
    )

    const status = runNode(root, ['collab/engine/status.mjs'])
    expect(status.status).toBe(0)
    expect(status.stdout).toContain('TIMED-OUT')
    expect(status.stdout).toContain('timed-task')
    expect(status.stdout).toContain('PARKED')
    expect(status.stdout).toContain('parked-task')
    expect(status.stdout.indexOf('TIMED-OUT')).toBeLessThan(status.stdout.indexOf('PARKED'))
  })
})
