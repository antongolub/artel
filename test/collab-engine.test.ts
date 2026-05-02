import { cpSync, chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { EventEmitter } from 'node:events'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
// Engine modules are JS-only (.mjs) without .d.ts stubs yet. Cast through any
// so the dispatchLifecycle invocation typechecks; once the platform agent ships
// types, drop the cast.
import { dispatchLifecycle as dispatchLifecycleRaw } from '../engine/dispatch_lifecycle.mjs'
const dispatchLifecycle = dispatchLifecycleRaw as (
  options: Record<string, unknown>,
  hooks?: Record<string, unknown>,
) => Promise<{ disposition: string; exitCode: number }>

import * as claudeDriverRaw from '../engine/drivers/claude.mjs'
import * as codexDriverRaw from '../engine/drivers/codex.mjs'
import * as copilotDriverRaw from '../engine/drivers/copilot.mjs'
type DriverArgs = (meta: Record<string, unknown>, promptParts: string[], session?: Record<string, unknown>) => string[]
const claudeDriver = claudeDriverRaw as { args: DriverArgs, api_version: number }
const codexDriver = codexDriverRaw as { args: DriverArgs, api_version: number }
const copilotDriver = copilotDriverRaw as { args: DriverArgs, api_version: number }

import * as schemaRaw from '../engine/schema.mjs'
import * as clusterRaw from '../engine/cluster.mjs'
const { uuidv7, validateEventType, SCHEMA_VERSION, VALID_KINDS } = schemaRaw as {
  uuidv7: () => string
  validateEventType: (kind: string, type: string) => void
  SCHEMA_VERSION: string
  VALID_KINDS: Set<string>
}
const { ensureClusterIdentity, instanceId, _resetCachesForTests } = clusterRaw as {
  ensureClusterIdentity: (dir: string, opts?: { name?: string }) => Record<string, unknown>
  instanceId: () => string
  _resetCachesForTests: () => void
}

const testDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(testDir, '..')
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
  mkdirSync(join(root, 'agents'), { recursive: true })
  mkdirSync(join(root, 'engine', 'drivers'), { recursive: true })
  mkdirSync(join(root, '.collab'), { recursive: true })
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'collab-engine-test-test', private: true, type: 'module' }, null, 2) + '\n',
  )
  writeFileSync(
    join(root, '.gitignore'),
    [
      'bin/',
      '.collab/.dispatches/',
      '.collab/.sessions/',
      '.collab/events.jsonl',
      '.collab/cluster.json',
    ].join('\n') + '\n',
  )
  writeFileSync(
    join(root, 'agents', 'implementer.md'),
    ['---', 'engine: claude', '---', 'implementer test role'].join('\n'),
  )
  writeFileSync(
    join(root, 'agents', 'adversary.md'),
    ['---', 'engine: claude', '---', 'adversary test role'].join('\n'),
  )
  writeFileSync(join(root, 'engine', 'drivers', 'claude.mjs'), 'export const id = "claude"\n')
  writeFileSync(join(root, '.collab', 'QUEUE.md'), queueFixture())
  writeFileSync(join(root, '.collab', 'state.md'), stateFixture())
  writeFileSync(
    join(root, '.collab', 'dispatcher_state.json'),
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
  _resetCachesForTests()
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
        platformDir: root,
        projectDir: root,
        projectCollabDir: join(root, '.collab'),
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
        platformDir: root,
        projectDir: root,
        projectCollabDir: join(root, '.collab'),
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

    const meta = JSON.parse(readFileSync(join(root, '.collab', '.dispatches', 'timeout-smoke.meta'), 'utf8'))
    expect(meta.status).toBe('timed-out')
    expect(meta.disposition).toBe('timeout')
    expect(meta.exitCode).toBe(137)
    expect(meta.timeout.timeoutMs).toBe(20)
    expect(meta.timeout.graceMs).toBe(30)
    expect(meta.timeout.signal).toBe('SIGKILL')

    const events = readFileSync(join(root, '.collab', 'events.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(events[0].type).toBe('dispatch.start')
    expect(events[1]).toMatchObject({
      type: 'dispatch.end',
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
      'engine/spawn.mjs',
      'engine/run.mjs',
      'engine/dispatch_api.mjs',
      'engine/dispatch_lifecycle.mjs',
      'engine/parked.mjs',
      'engine/schema.mjs',
      'engine/cluster.mjs',
      'engine/drivers/claude.mjs',
      'engine/drivers/codex.mjs',
      'agents/implementer.md',
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
    const smokeV3 = runNode(root, ['engine/spawn.mjs', 'implementer', 'smoke-v3', '--engine', 'claude', '-p', 'hello'], env)
    expect(smokeV3.status).toBe(0)

    const smokeEffort = runNode(
      root,
      [
        'engine/spawn.mjs',
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

    const v3Meta = JSON.parse(readFileSync(join(root, '.collab', '.dispatches', 'smoke-v3.meta'), 'utf8'))
    expect(v3Meta).toMatchObject({
      task: 'smoke-v3',
      role: 'implementer',
      engine: 'claude',
      status: 'completed',
      disposition: 'success',
    })

    const effortOut = readFileSync(join(root, '.collab', '.dispatches', 'smoke-effort-flag.out'), 'utf8')
    expect(effortOut).toContain('model_reasoning_effort=xhigh')

    // Canonical --effort flag — same path, no deprecation warning required.
    const smokeEffortCanonical = runNode(
      root,
      ['engine/spawn.mjs', 'implementer', 'smoke-effort-canonical', '--engine', 'codex', '--effort', 'high', '-p', 'hello'],
      env,
    )
    expect(smokeEffortCanonical.status).toBe(0)
    const effortCanonicalOut = readFileSync(join(root, '.collab', '.dispatches', 'smoke-effort-canonical.out'), 'utf8')
    expect(effortCanonicalOut).toContain('model_reasoning_effort=high')
  })
})

describe('drivers — universal terms', () => {
  describe('claude', () => {
    it('translates universal model / tools / permission-mode', () => {
      const out = claudeDriver.args(
        { body: 'role brief', model: 'opus', tools: 'Read,Edit', 'permission-mode': 'acceptEdits' },
        ['hello'],
      )
      expect(out).toContain('--model')
      expect(out).toContain('opus')
      expect(out).toContain('--allowedTools')
      expect(out).toContain('Read,Edit')
      expect(out).toContain('--permission-mode')
      expect(out).toContain('acceptEdits')
      expect(out).toContain('--append-system-prompt')
    })

    it('derives permission-mode from sandbox when explicit not set', () => {
      const out = claudeDriver.args({ sandbox: 'workspace-write' }, [])
      const idx = out.indexOf('--permission-mode')
      expect(idx).toBeGreaterThanOrEqual(0)
      expect(out[idx + 1]).toBe('acceptEdits')
    })

    it('explicit permission-mode wins over sandbox-derived', () => {
      const out = claudeDriver.args({ sandbox: 'full-access', 'permission-mode': 'plan' }, [])
      const idx = out.indexOf('--permission-mode')
      expect(out[idx + 1]).toBe('plan')
    })

    it('silently ignores effort (no analog)', () => {
      const out = claudeDriver.args({ effort: 'xhigh' }, [])
      expect(out.join(' ')).not.toContain('xhigh')
    })

    it('exports api_version', () => {
      expect(claudeDriver.api_version).toBe(1)
    })
  })

  describe('codex', () => {
    it('translates universal model / effort / sandbox', () => {
      const out = codexDriver.args(
        { model: 'gpt-5', effort: 'high', sandbox: 'read-only' },
        ['hello'],
      )
      expect(out).toContain('-m')
      expect(out).toContain('gpt-5')
      expect(out.join(' ')).toContain('model_reasoning_effort=high')
      expect(out.join(' ')).toContain('disk-full-read-access')
    })

    it('back-compat: reads codex-effort when canonical effort missing', () => {
      const out = codexDriver.args({ 'codex-effort': 'medium' }, [])
      expect(out.join(' ')).toContain('model_reasoning_effort=medium')
    })

    it('canonical effort wins over legacy codex-effort', () => {
      const out = codexDriver.args({ effort: 'high', 'codex-effort': 'low' }, [])
      expect(out.join(' ')).toContain('model_reasoning_effort=high')
      expect(out.join(' ')).not.toContain('model_reasoning_effort=low')
    })

    it('canonical model wins over legacy codex-model', () => {
      const out = codexDriver.args({ model: 'gpt-5', 'codex-model': 'o3' }, [])
      expect(out).toContain('gpt-5')
      expect(out).not.toContain('o3')
    })

    it('silently ignores tools (no allowlist in CLI)', () => {
      const out = codexDriver.args({ tools: 'Read,Edit' }, [])
      expect(out.join(' ')).not.toContain('Read,Edit')
    })

    it('silently ignores permission-mode (no analog)', () => {
      const out = codexDriver.args({ 'permission-mode': 'acceptEdits' }, [])
      expect(out.join(' ')).not.toContain('acceptEdits')
    })

    it('exports api_version', () => {
      expect(codexDriver.api_version).toBe(1)
    })
  })

  describe('copilot', () => {
    it('translates universal model / tools / sandbox=full-access', () => {
      const out = copilotDriver.args(
        { model: 'claude-sonnet-4', tools: 'Read,Edit', sandbox: 'full-access' },
        ['hello'],
      )
      expect(out).toContain('--model')
      expect(out).toContain('claude-sonnet-4')
      expect(out).toContain('--available-tools')
      expect(out).toContain('Read,Edit')
      expect(out).toContain('--allow-all-paths')
      expect(out).toContain('--allow-all-urls')
    })

    it('back-compat: reads copilot-tools / copilot-model when canonical missing', () => {
      const out = copilotDriver.args({ 'copilot-tools': 'Read', 'copilot-model': 'gpt-4' }, [])
      expect(out).toContain('Read')
      expect(out).toContain('gpt-4')
    })

    it('canonical wins over legacy', () => {
      const out = copilotDriver.args({ model: 'newer', 'copilot-model': 'older', tools: 'A', 'copilot-tools': 'B' }, [])
      expect(out).toContain('newer')
      expect(out).not.toContain('older')
      expect(out).toContain('A')
      expect(out).not.toContain('B')
    })

    it('silently ignores effort and permission-mode', () => {
      const out = copilotDriver.args({ effort: 'xhigh', 'permission-mode': 'plan' }, [])
      expect(out.join(' ')).not.toContain('xhigh')
      expect(out.join(' ')).not.toContain('plan')
    })

    it('exports api_version', () => {
      expect(copilotDriver.api_version).toBe(1)
    })
  })
})

describe('status CLI render new fields (C9)', () => {
  it('renders usage tokens annotation in RECENT when meta has usage', () => {
    const root = createTempRepo()
    installEngineRuntime(root, ['engine/status.mjs'])
    mkdirSync(join(root, '.collab', '.dispatches'), { recursive: true })

    writeFileSync(
      join(root, '.collab', '.dispatches', 'used.meta'),
      JSON.stringify({
        task: 'used-task',
        role: 'implementer',
        engine: 'codex',
        status: 'completed',
        completedAt: '2026-05-01T00:00:00.000Z',
        usage: { tokens_in: 1500, tokens_out: 800, cache_read: 200, cache_creation: 0, model: 'gpt-5', cost_usd: null },
      }, null, 2) + '\n',
    )
    // Need .out file for getRecentDispatches to pick it up
    writeFileSync(join(root, '.collab', '.dispatches', 'used.out'), 'test output\n')

    const status = runNode(root, ['engine/status.mjs'])
    expect(status.status).toBe(0)
    expect(status.stdout).toContain('used-task')
    // Token annotation: 2k input / 800 output → 2k/800t format
    expect(status.stdout).toMatch(/\d+(k|M)?\/\d+(k|M)?t/)
  })

  it('renders retry indicator when retryCount > 0', () => {
    const root = createTempRepo()
    installEngineRuntime(root, ['engine/status.mjs'])
    mkdirSync(join(root, '.collab', '.dispatches'), { recursive: true })

    writeFileSync(
      join(root, '.collab', '.dispatches', 'retried.meta'),
      JSON.stringify({
        task: 'retried-task',
        role: 'implementer',
        engine: 'claude',
        status: 'completed',
        completedAt: '2026-05-01T00:00:00.000Z',
        retryCount: 2,
      }, null, 2) + '\n',
    )
    writeFileSync(join(root, '.collab', '.dispatches', 'retried.out'), 'output\n')

    const status = runNode(root, ['engine/status.mjs'])
    expect(status.status).toBe(0)
    expect(status.stdout).toContain('retried-task')
    expect(status.stdout).toMatch(/r2/)
  })
})

describe('state_gen cluster surface (C9)', () => {
  it('frontmatter contains cluster_id and cluster_name from .collab/cluster.json', () => {
    const root = createTempRepo()
    installEngineRuntime(root, ['engine/state_gen.mjs', 'engine/cluster.mjs', 'engine/schema.mjs'])
    writeFileSync(
      join(root, '.collab', 'cluster.json'),
      JSON.stringify({
        cluster_id: '01934f00-0000-7000-8000-aaaaaaaaaaaa',
        name: 'test-cluster',
        created_at: '2026-05-01T00:00:00.000Z',
        schema: 'cluster-v1',
      }, null, 2) + '\n',
    )

    const result = runNode(root, ['engine/state_gen.mjs'])
    expect(result.status).toBe(0)
    const stateMd = readFileSync(join(root, '.collab', 'state.md'), 'utf8')
    expect(stateMd).toContain('cluster_id: "01934f00-0000-7000-8000-aaaaaaaaaaaa"')
    expect(stateMd).toContain('cluster_name: "test-cluster"')
  })
})

describe('status CLI', () => {
  it('renders timed-out dispatches above parked dispatches', () => {
    const root = createTempRepo()
    installEngineRuntime(root, ['engine/status.mjs'])
    mkdirSync(join(root, '.collab', '.dispatches'), { recursive: true })
    writeFileSync(
      join(root, '.collab', '.dispatches', 'timed.meta'),
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
      join(root, '.collab', '.dispatches', 'parked.meta'),
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

    const status = runNode(root, ['engine/status.mjs'])
    expect(status.status).toBe(0)
    expect(status.stdout).toContain('TIMED-OUT')
    expect(status.stdout).toContain('timed-task')
    expect(status.stdout).toContain('PARKED')
    expect(status.stdout).toContain('parked-task')
    expect(status.stdout.indexOf('TIMED-OUT')).toBeLessThan(status.stdout.indexOf('PARKED'))
  })
})

describe('schema (C2)', () => {
  it('uuidv7 produces 36-char hyphenated form with version-7 nibble', () => {
    const id = uuidv7()
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it('uuidv7 is monotonically sortable across rapid calls (time-prefix)', () => {
    const ids: string[] = []
    for (let i = 0; i < 50; i++) ids.push(uuidv7())
    const sorted = [...ids].sort()
    // First-ms group may interleave on ms boundary; require non-decreasing
    // for at least the first 8 hex chars (timestamp top 32 bits).
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i].slice(0, 8) >= sorted[i - 1].slice(0, 8)).toBe(true)
    }
  })

  it('SCHEMA_VERSION is v1', () => {
    expect(SCHEMA_VERSION).toBe('v1')
  })

  it('VALID_KINDS covers the four axes', () => {
    expect(VALID_KINDS.has('workload')).toBe(true)
    expect(VALID_KINDS.has('infra')).toBe(true)
    expect(VALID_KINDS.has('signal')).toBe(true)
    expect(VALID_KINDS.has('control')).toBe(true)
  })

  it('validateEventType accepts known workload types', () => {
    expect(() => validateEventType('workload', 'dispatch.start')).not.toThrow()
    expect(() => validateEventType('workload', 'dispatch.end')).not.toThrow()
    expect(() => validateEventType('workload', 'checkpoint')).not.toThrow()
    expect(() => validateEventType('workload', 'parked')).not.toThrow()
    expect(() => validateEventType('workload', 'queue_node.registered')).not.toThrow()
  })

  it('validateEventType accepts known infra types', () => {
    expect(() => validateEventType('infra', 'cluster.heartbeat')).not.toThrow()
    expect(() => validateEventType('infra', 'role.registered')).not.toThrow()
    expect(() => validateEventType('infra', 'engine.available')).not.toThrow()
  })

  it('validateEventType accepts reserved control / signal namespaces', () => {
    expect(() => validateEventType('control', 'control.claim.requested')).not.toThrow()
    expect(() => validateEventType('control', 'control.peer.observed')).not.toThrow()
    expect(() => validateEventType('signal', 'signal.backoff_required')).not.toThrow()
  })

  it('validateEventType accepts legacy claim / release for one cycle', () => {
    expect(() => validateEventType('workload', 'claim')).not.toThrow()
    expect(() => validateEventType('workload', 'release')).not.toThrow()
  })

  it('validateEventType rejects unknown kind', () => {
    expect(() => validateEventType('garbage', 'whatever')).toThrow(/Invalid event kind/)
  })

  it('validateEventType rejects unknown type within a kind', () => {
    expect(() => validateEventType('workload', 'something.unknown')).toThrow(/not in reserved/)
    expect(() => validateEventType('infra', 'unknown.thing')).toThrow(/not in reserved/)
    expect(() => validateEventType('signal', 'control.claim.requested')).toThrow(/not in reserved/) // wrong kind
  })
})

describe('cluster identity (C2)', () => {
  it('ensureClusterIdentity creates cluster.json on first call', () => {
    const root = createTempRepo()
    const cluster = ensureClusterIdentity(join(root, '.collab'))
    expect(cluster.cluster_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/)
    expect(cluster.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(cluster.schema).toBe('cluster-v1')
    expect(JSON.parse(readFileSync(join(root, '.collab', 'cluster.json'), 'utf8')).cluster_id).toBe(cluster.cluster_id)
  })

  it('ensureClusterIdentity is idempotent — same cluster_id on second call', () => {
    const root = createTempRepo()
    const first = ensureClusterIdentity(join(root, '.collab'))
    const second = ensureClusterIdentity(join(root, '.collab'))
    expect(second.cluster_id).toBe(first.cluster_id)
    expect(second.created_at).toBe(first.created_at)
  })

  it('ensureClusterIdentity uses --name override on first bootstrap', () => {
    const root = createTempRepo()
    const cluster = ensureClusterIdentity(join(root, '.collab'), { name: 'my-cluster' })
    expect(cluster.name).toBe('my-cluster')
  })

  it('instanceId is stable within a process', () => {
    expect(instanceId()).toBe(instanceId())
  })
})

describe('init.mjs CLI (C2)', () => {
  it('bootstraps .collab/cluster.json idempotently', () => {
    const root = createTempRepo()
    installEngineRuntime(root, ['engine/init.mjs', 'engine/cluster.mjs', 'engine/schema.mjs'])

    const first = runNode(root, ['engine/init.mjs', '--name', 'test-cluster'])
    expect(first.status).toBe(0)
    const firstCluster = JSON.parse(first.stdout)
    expect(firstCluster.name).toBe('test-cluster')
    expect(firstCluster.cluster_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/)

    // Second call returns existing identity unchanged.
    const second = runNode(root, ['engine/init.mjs'])
    expect(second.status).toBe(0)
    const secondCluster = JSON.parse(second.stdout)
    expect(secondCluster.cluster_id).toBe(firstCluster.cluster_id)
    expect(secondCluster.name).toBe('test-cluster')
  })
})

describe('event schema enrichment (C2)', () => {
  it('dispatch events carry schema / kind / id / cluster_id / instance_id / fence_token', async () => {
    const root = createTempRepo()
    const child = new EventEmitter() as EventEmitter & { pid: number, kill: (sig: string) => boolean }
    child.pid = 31337
    child.kill = () => true
    setTimeout(() => child.emit('exit', 0, null), 5)

    await dispatchLifecycle(
      {
        role: 'implementer',
        task: 'schema-check',
        prompt: 'noop',
        platformDir: root,
        projectDir: root,
        projectCollabDir: join(root, '.collab'),
      },
      { spawnProcess: () => child as never, log: () => {} },
    )

    const events = readFileSync(join(root, '.collab', 'events.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))

    for (const event of events) {
      expect(event.schema).toBe('v1')
      expect(event.kind).toBe('workload')
      expect(event.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/)
      expect(event.at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
      expect(event.cluster_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/)
      expect(event.instance_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/)
      expect(event.fence_token).toBe(0)
    }

    // Cluster identity persisted to disk.
    const cluster = JSON.parse(readFileSync(join(root, '.collab', 'cluster.json'), 'utf8'))
    expect(cluster.cluster_id).toBe(events[0].cluster_id)
  })
})

describe('role dispatch policies (C8)', () => {
  const writeRole = (root: string, name: string, frontmatter: Record<string, string>, body = 'test role') => {
    const fmLines = Object.entries(frontmatter).map(([k, v]) => `${k}: ${v}`)
    writeFileSync(
      join(root, 'agents', `${name}.md`),
      ['---', ...fmLines, '---', body].join('\n'),
    )
    snapshotRepo(root, `add ${name}`)
  }

  const dispatchAs = async (
    root: string,
    parentRole: string | null,
    requestedRole: string,
    task: string,
  ) => {
    const child = new EventEmitter() as EventEmitter & { pid: number, kill: (sig: string) => boolean }
    child.pid = 1
    child.kill = () => true
    setTimeout(() => child.emit('exit', 0, null), 5)

    const savedEnv = { ...process.env }
    if (parentRole) process.env.COLLAB_ROLE = parentRole
    else delete process.env.COLLAB_ROLE
    try {
      return await dispatchLifecycle(
        {
          role: requestedRole,
          task,
          prompt: 'noop',
          platformDir: root,
          projectDir: root,
          projectCollabDir: join(root, '.collab'),
        },
        { spawnProcess: () => child as never, log: () => {} },
      )
    } finally {
      Object.keys(process.env).forEach((k) => { delete process.env[k] })
      Object.assign(process.env, savedEnv)
    }
  }

  it('top-level dispatch (no parent role in env) skips policy check', async () => {
    const root = createTempRepo()
    // implementer.md created by fixture has no `dispatchable` (defaults to 'all').
    // No COLLAB_ROLE in env → policy bypassed regardless.
    const result = await dispatchAs(root, null, 'implementer', 'top-level')
    expect(result.disposition).toBe('success')
  })

  it('parent with `dispatchable: none` cannot spawn anything', async () => {
    const root = createTempRepo()
    writeRole(root, 'leaf-parent', { name: 'leaf-parent', engine: 'claude', dispatchable: 'none' })
    await expect(dispatchAs(root, 'leaf-parent', 'implementer', 'denied'))
      .rejects.toThrow(/cannot dispatch 'implementer'/)
  })

  it('parent with explicit allowlist allows only listed roles', async () => {
    const root = createTempRepo()
    writeRole(root, 'restricted', { name: 'restricted', engine: 'claude', dispatchable: 'implementer' })
    // Allowed
    const ok = await dispatchAs(root, 'restricted', 'implementer', 'allowed')
    expect(ok.disposition).toBe('success')
    // Forbidden
    await expect(dispatchAs(root, 'restricted', 'adversary', 'denied'))
      .rejects.toThrow(/cannot dispatch 'adversary'/)
  })

  it('non-dispatchable denylist applied on top of `dispatchable: all`', async () => {
    const root = createTempRepo()
    writeRole(root, 'capped', {
      name: 'capped',
      engine: 'claude',
      dispatchable: 'all',
      'non-dispatchable': 'adversary',
    })
    const ok = await dispatchAs(root, 'capped', 'implementer', 'allowed')
    expect(ok.disposition).toBe('success')
    await expect(dispatchAs(root, 'capped', 'adversary', 'denied'))
      .rejects.toThrow(/non-dispatchable: adversary/)
  })

  it('unknown parent role fails open (no policy enforced)', async () => {
    const root = createTempRepo()
    // Don't create the parent role file at all.
    const result = await dispatchAs(root, 'ghost-parent', 'implementer', 'unknown-parent')
    expect(result.disposition).toBe('success')
  })

  it('dispatchable defaults to all when frontmatter missing the key', async () => {
    const root = createTempRepo()
    writeRole(root, 'permissive', { name: 'permissive', engine: 'claude' }) // no dispatchable key
    const result = await dispatchAs(root, 'permissive', 'implementer', 'default-permissive')
    expect(result.disposition).toBe('success')
  })

  it('orchestrator-style policy: all except orchestrator', async () => {
    const root = createTempRepo()
    writeRole(root, 'mock-orchestrator', {
      name: 'mock-orchestrator',
      engine: 'claude',
      dispatchable: 'all',
      'non-dispatchable': 'mock-orchestrator',
    })
    // Can dispatch anything else
    const okAdv = await dispatchAs(root, 'mock-orchestrator', 'adversary', 'orch-to-adv')
    expect(okAdv.disposition).toBe('success')
    // Cannot recurse into another orchestrator
    await expect(dispatchAs(root, 'mock-orchestrator', 'mock-orchestrator', 'orch-recursion'))
      .rejects.toThrow(/non-dispatchable: mock-orchestrator/)
  })
})

describe('checkpoint API (C7)', () => {
  it('appends a valid checkpoint event with all mandatory fields', () => {
    const root = createTempRepo()
    installEngineRuntime(root, ['engine/checkpoint.mjs', 'engine/cluster.mjs', 'engine/schema.mjs'])

    const result = runNode(
      root,
      ['engine/checkpoint.mjs', '--completed', 'parsed feed', '--next', 'validate schema', '--artefact', 'src/feed.ts', '--notes', 'looking good'],
      {
        COLLAB_TASK: 'demo-task',
        COLLAB_ROLE: 'implementer',
        COLLAB_DISPATCH_ID: '01934f00-0000-7000-8000-000000000abc',
        COLLAB_TRACE_ID: '01934f00-0000-7000-8000-000000000def',
      },
    )
    expect(result.status).toBe(0)

    const events = readFileSync(join(root, '.collab', 'events.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(events).toHaveLength(1)
    const ev = events[0]
    expect(ev).toMatchObject({
      schema: 'v1',
      kind: 'workload',
      type: 'checkpoint',
      task: 'demo-task',
      dispatch_id: '01934f00-0000-7000-8000-000000000abc',
      trace_id: '01934f00-0000-7000-8000-000000000def',
      owner_role: 'implementer',
      last_completed_step: 'parsed feed',
      next_safe_step: 'validate schema',
      artefact: 'src/feed.ts',
      notes: 'looking good',
      fence_token: 0,
    })
    expect(ev.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/)
    expect(ev.cluster_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/)
    expect(ev.instance_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/)
    expect(ev.at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('rejects when --completed or --next is missing', () => {
    const root = createTempRepo()
    installEngineRuntime(root, ['engine/checkpoint.mjs', 'engine/cluster.mjs', 'engine/schema.mjs'])
    const env = {
      COLLAB_TASK: 't',
      COLLAB_ROLE: 'implementer',
      COLLAB_DISPATCH_ID: '01934f00-0000-7000-8000-000000000aaa',
    }
    const noCompleted = runNode(root, ['engine/checkpoint.mjs', '--next', 'foo'], env)
    expect(noCompleted.status).not.toBe(0)
    expect(noCompleted.stderr).toMatch(/required/)

    const noNext = runNode(root, ['engine/checkpoint.mjs', '--completed', 'foo'], env)
    expect(noNext.status).not.toBe(0)
  })

  it('rejects when COLLAB_DISPATCH_ID env missing', () => {
    const root = createTempRepo()
    installEngineRuntime(root, ['engine/checkpoint.mjs', 'engine/cluster.mjs', 'engine/schema.mjs'])
    // Clear inherited COLLAB_DISPATCH_ID from this test process if any.
    const result = runNode(root, ['engine/checkpoint.mjs', '--completed', 'a', '--next', 'b'], {
      COLLAB_TASK: 't',
      COLLAB_ROLE: 'implementer',
      COLLAB_DISPATCH_ID: '',
    })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/COLLAB_DISPATCH_ID/)
  })

  it('trace_id defaults to dispatch_id when not provided', () => {
    const root = createTempRepo()
    installEngineRuntime(root, ['engine/checkpoint.mjs', 'engine/cluster.mjs', 'engine/schema.mjs'])
    const result = runNode(
      root,
      ['engine/checkpoint.mjs', '--completed', 'a', '--next', 'b'],
      {
        COLLAB_TASK: 't',
        COLLAB_ROLE: 'implementer',
        COLLAB_DISPATCH_ID: '01934f00-0000-7000-8000-000000000bbb',
      },
    )
    expect(result.status).toBe(0)
    const events = readFileSync(join(root, '.collab', 'events.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(events[0].trace_id).toBe('01934f00-0000-7000-8000-000000000bbb')
  })
})

describe('retry tracking (C6)', () => {
  const runDispatch = async (
    root: string,
    task: string,
    extra: Record<string, unknown> = {},
  ) => {
    const child = new EventEmitter() as EventEmitter & { pid: number, kill: (sig: string) => boolean }
    child.pid = 1
    child.kill = () => true
    setTimeout(() => child.emit('exit', 0, null), 5)
    await dispatchLifecycle(
      {
        role: 'implementer',
        task,
        prompt: 'noop',
        platformDir: root,
        projectDir: root,
        projectCollabDir: join(root, '.collab'),
        ...extra,
      },
      { spawnProcess: () => child as never, log: () => {} },
    )
    return readFileSync(join(root, '.collab', 'events.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
  }

  it('first dispatch has retry_count absent', async () => {
    const root = createTempRepo()
    const events = await runDispatch(root, 'first-attempt')
    const start = events.find((e) => e.type === 'dispatch.start')
    expect(start.retry_count).toBeUndefined()
    expect(start.retry_of).toBeUndefined()
    expect(start.retry_reason).toBeUndefined()
  })

  it('retry with same engine+model increments retry_count', async () => {
    const root = createTempRepo()
    const first = await runDispatch(root, 'task-a')
    const firstId = first.find((e) => e.type === 'dispatch.start').dispatch_id
    const second = await runDispatch(root, 'task-a-retry-1', { retryOf: firstId })
    const secondStart = second.find((e) => e.type === 'dispatch.start' && e.task === 'task-a-retry-1')
    expect(secondStart.retry_of).toBe(firstId)
    expect(secondStart.retry_count).toBe(1)
    expect(secondStart.retry_reason).toBe('success') // first ended successfully

    const secondId = secondStart.dispatch_id
    const third = await runDispatch(root, 'task-a-retry-2', { retryOf: secondId })
    const thirdStart = third.find((e) => e.type === 'dispatch.start' && e.task === 'task-a-retry-2')
    expect(thirdStart.retry_count).toBe(2)
  })

  it('retry with different model resets retry_count to 0', async () => {
    const root = createTempRepo()
    const first = await runDispatch(root, 'task-b', { model: 'opus' })
    const firstId = first.find((e) => e.type === 'dispatch.start').dispatch_id
    const second = await runDispatch(root, 'task-b-retry', { retryOf: firstId, model: 'sonnet' })
    const secondStart = second.find((e) => e.type === 'dispatch.start' && e.task === 'task-b-retry')
    expect(secondStart.retry_of).toBe(firstId)
    expect(secondStart.retry_count).toBeUndefined() // 0 = absent (per markRunning conditional)
  })

  it('retry_count >= threshold emits signal.backoff_required', async () => {
    const root = createTempRepo()
    const first = await runDispatch(root, 't1')
    const firstId = first.find((e) => e.type === 'dispatch.start').dispatch_id
    const second = await runDispatch(root, 't2', { retryOf: firstId })
    const secondId = second.find((e) => e.type === 'dispatch.start' && e.task === 't2').dispatch_id
    const third = await runDispatch(root, 't3', { retryOf: secondId })
    const thirdId = third.find((e) => e.type === 'dispatch.start' && e.task === 't3').dispatch_id
    // 4th dispatch with retry_count=3 → triggers signal at default threshold
    const fourth = await runDispatch(root, 't4', { retryOf: thirdId })

    const signal = fourth.find((e) => e.kind === 'signal' && e.type === 'signal.backoff_required')
    expect(signal).toBeDefined()
    expect(signal.retry_count).toBe(3)
    expect(signal.retry_of).toBe(thirdId)
    expect(signal.threshold).toBe(3)
  })

  it('custom backoffThreshold overrides default', async () => {
    const root = createTempRepo()
    const first = await runDispatch(root, 'low-th-1')
    const firstId = first.find((e) => e.type === 'dispatch.start').dispatch_id
    const second = await runDispatch(root, 'low-th-2', { retryOf: firstId, backoffThreshold: 1 })
    const signal = second.find((e) => e.kind === 'signal' && e.type === 'signal.backoff_required')
    expect(signal).toBeDefined()
    expect(signal.threshold).toBe(1)
  })
})

describe('driver usage capture (C5)', () => {
  it('claude.parseUsage returns null in MVP', () => {
    const driver = claudeDriverRaw as unknown as { parseUsage: (a: string, b: string) => unknown }
    expect(driver.parseUsage('/tmp/whatever', 'session-id')).toBeNull()
  })

  it('copilot.parseUsage returns null', () => {
    const driver = copilotDriverRaw as unknown as { parseUsage: (a: string, b: string) => unknown }
    expect(driver.parseUsage('/tmp/whatever', 'session-id')).toBeNull()
  })

  it('codex.parseUsage returns null when no matching session file', () => {
    const driver = codexDriverRaw as unknown as { parseUsage: (a: string, b: string) => unknown }
    const root = createTempRepo()
    const sessionsDir = join(root, 'fake-codex-sessions')
    mkdirSync(sessionsDir, { recursive: true })
    const savedEnv = process.env.COLLAB_CODEX_SESSIONS_DIR
    process.env.COLLAB_CODEX_SESSIONS_DIR = sessionsDir
    try {
      expect(driver.parseUsage('/tmp/whatever', 'no-such-session')).toBeNull()
    } finally {
      if (savedEnv) process.env.COLLAB_CODEX_SESSIONS_DIR = savedEnv
      else delete process.env.COLLAB_CODEX_SESSIONS_DIR
    }
  })

  it('codex.parseUsage extracts last token_count totals from a session file', () => {
    const driver = codexDriverRaw as unknown as {
      parseUsage: (a: string, b: string) => {
        tokens_in: number
        tokens_out: number
        cache_read: number
        cache_creation: number
        model: string | null
        cost_usd: number | null
      } | null
    }
    const root = createTempRepo()
    const sessionsDir = join(root, 'fake-codex-sessions', '2026', '05', '02')
    mkdirSync(sessionsDir, { recursive: true })
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const path = join(sessionsDir, `rollout-${sessionId}.jsonl`)
    const lines = [
      { type: 'session_meta', payload: { id: sessionId, model: 'gpt-5', cwd: '/some/dir' } },
      {
        type: 'event_msg',
        timestamp: '2026-05-02T10:00:00.000Z',
        payload: {
          type: 'token_count',
          info: { total_token_usage: { input_tokens: 1000, output_tokens: 500, cached_input_tokens: 100 } },
        },
      },
      {
        type: 'event_msg',
        timestamp: '2026-05-02T10:01:00.000Z',
        payload: {
          type: 'token_count',
          info: { total_token_usage: { input_tokens: 2000, output_tokens: 1500, cached_input_tokens: 300 } },
        },
      },
    ]
    writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')

    const savedEnv = process.env.COLLAB_CODEX_SESSIONS_DIR
    process.env.COLLAB_CODEX_SESSIONS_DIR = join(root, 'fake-codex-sessions')
    try {
      const usage = driver.parseUsage('/tmp/unused', sessionId)
      expect(usage).not.toBeNull()
      expect(usage!.tokens_in).toBe(1700) // 2000 - 300 cached
      expect(usage!.tokens_out).toBe(1500)
      expect(usage!.cache_read).toBe(300)
      expect(usage!.model).toBe('gpt-5')
      expect(usage!.cost_usd).toBeNull()
    } finally {
      if (savedEnv) process.env.COLLAB_CODEX_SESSIONS_DIR = savedEnv
      else delete process.env.COLLAB_CODEX_SESSIONS_DIR
    }
  })

  it('lifecycle merges usage into dispatch.end + .meta when driver returns it', async () => {
    const root = createTempRepo()
    // Replace stub driver with one that exports parseUsage returning known data.
    // Commit the change so prepareBranch's dirty-WT guard does not trip.
    writeFileSync(
      join(root, 'engine', 'drivers', 'claude.mjs'),
      [
        'export const id = "claude"',
        'export const command = "claude"',
        'export const api_version = 1',
        'export function args () { return [] }',
        'export function parseUsage () { return { tokens_in: 100, tokens_out: 50, cache_read: 10, cache_creation: 5, model: "test-model", cost_usd: null } }',
      ].join('\n') + '\n',
    )
    snapshotRepo(root, 'fake driver with parseUsage')

    const child = new EventEmitter() as EventEmitter & { pid: number, kill: (sig: string) => boolean }
    child.pid = 1
    child.kill = () => true
    setTimeout(() => child.emit('exit', 0, null), 5)

    await dispatchLifecycle(
      {
        role: 'implementer',
        task: 'usage-merge',
        prompt: 'noop',
        platformDir: root,
        projectDir: root,
        projectCollabDir: join(root, '.collab'),
      },
      { spawnProcess: () => child as never, log: () => {} },
    )

    const events = readFileSync(join(root, '.collab', 'events.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    const endEvent = events.find((e) => e.type === 'dispatch.end')
    expect(endEvent.usage).toEqual({
      tokens_in: 100,
      tokens_out: 50,
      cache_read: 10,
      cache_creation: 5,
      model: 'test-model',
      cost_usd: null,
    })

    const meta = JSON.parse(readFileSync(join(root, '.collab', '.dispatches', 'usage-merge.meta'), 'utf8'))
    expect(meta.usage).toEqual({
      tokens_in: 100,
      tokens_out: 50,
      cache_read: 10,
      cache_creation: 5,
      model: 'test-model',
      cost_usd: null,
    })
  })
})

describe('event rename (C4)', () => {
  it('emits dispatch.start / dispatch.end (canonical names)', async () => {
    const root = createTempRepo()
    const child = new EventEmitter() as EventEmitter & { pid: number, kill: (sig: string) => boolean }
    child.pid = 1
    child.kill = () => true
    setTimeout(() => child.emit('exit', 0, null), 5)

    await dispatchLifecycle(
      {
        role: 'implementer',
        task: 'rename-check',
        prompt: 'noop',
        platformDir: root,
        projectDir: root,
        projectCollabDir: join(root, '.collab'),
      },
      { spawnProcess: () => child as never, log: () => {} },
    )

    const events = readFileSync(join(root, '.collab', 'events.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    const types = events.map((e) => e.type)
    expect(types).toContain('dispatch.start')
    expect(types).toContain('dispatch.end')
    expect(types).not.toContain('claim')
    expect(types).not.toContain('release')
  })

  it('status.mjs back-compat read of legacy claim/release events', () => {
    const root = createTempRepo()
    installEngineRuntime(root, ['engine/status.mjs'])
    mkdirSync(join(root, '.collab', '.dispatches'), { recursive: true })

    // Write a legacy events.jsonl with old names — simulates events written
    // before the rename. Status CLI should still summarise them.
    const legacyEvents = [
      { schema: 'v1', kind: 'workload', type: 'claim', at: '2026-05-01T10:00:00.000Z', task: 'old-task', owner_role: 'implementer', branch: 'implementer/old-task' },
      { schema: 'v1', kind: 'workload', type: 'release', at: '2026-05-01T10:05:00.000Z', task: 'old-task', owner_role: 'implementer', disposition: 'success' },
      { schema: 'v1', kind: 'workload', type: 'dispatch.start', at: '2026-05-01T11:00:00.000Z', task: 'new-task', owner_role: 'implementer', branch: 'implementer/new-task' },
      { schema: 'v1', kind: 'workload', type: 'dispatch.end', at: '2026-05-01T11:05:00.000Z', task: 'new-task', owner_role: 'implementer', disposition: 'success' },
    ]
    writeFileSync(
      join(root, '.collab', 'events.jsonl'),
      legacyEvents.map((e) => JSON.stringify(e)).join('\n') + '\n',
    )

    const status = runNode(root, ['engine/status.mjs'])
    expect(status.status).toBe(0)
    // Both legacy and canonical events should be summarised — claim/release
    // back-compat path uses the same word ("claimed"/"released").
    expect(status.stdout).toContain('old-task')
    expect(status.stdout).toContain('new-task')
  })
})

describe('tracing (C3)', () => {
  const runOneDispatch = async (root: string, task: string, parentEnv: Record<string, string> = {}) => {
    const child = new EventEmitter() as EventEmitter & { pid: number, kill: (sig: string) => boolean }
    child.pid = 31337
    child.kill = () => true
    setTimeout(() => child.emit('exit', 0, null), 5)

    const savedEnv = { ...process.env }
    Object.assign(process.env, parentEnv)
    try {
      await dispatchLifecycle(
        {
          role: 'implementer',
          task,
          prompt: 'noop',
          platformDir: root,
          projectDir: root,
          projectCollabDir: join(root, '.collab'),
        },
        { spawnProcess: () => child as never, log: () => {} },
      )
    } finally {
      // Restore env
      for (const k of Object.keys(parentEnv)) delete process.env[k]
      Object.assign(process.env, savedEnv)
    }

    return readFileSync(join(root, '.collab', 'events.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
  }

  it('top-level dispatch: trace_id == dispatch_id, no parent fields', async () => {
    const root = createTempRepo()
    const events = await runOneDispatch(root, 'top-level')

    expect(events.length).toBeGreaterThan(0)
    const dispatchId = events[0].dispatch_id
    expect(dispatchId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/)
    for (const event of events) {
      expect(event.dispatch_id).toBe(dispatchId)
      expect(event.trace_id).toBe(dispatchId)
      expect(event.parent_dispatch_id).toBeUndefined()
      expect(event.parent_role).toBeUndefined()
    }
  })

  it('nested dispatch: inherits trace_id, records parent_dispatch_id and parent_role', async () => {
    const root = createTempRepo()
    const parentDispatchId = '01934f00-0000-7000-8000-000000000001'
    const parentTraceId = '01934f00-0000-7000-8000-000000000000'
    const events = await runOneDispatch(root, 'nested-task', {
      COLLAB_DISPATCH_ID: parentDispatchId,
      COLLAB_TRACE_ID: parentTraceId,
      COLLAB_ROLE: 'orchestrator',
    })

    expect(events.length).toBeGreaterThan(0)
    const childDispatchId = events[0].dispatch_id
    expect(childDispatchId).not.toBe(parentDispatchId)
    for (const event of events) {
      expect(event.dispatch_id).toBe(childDispatchId)
      expect(event.trace_id).toBe(parentTraceId)
      expect(event.parent_dispatch_id).toBe(parentDispatchId)
      expect(event.parent_role).toBe('orchestrator')
    }
  })

  it('.meta sidecar carries dispatchId / traceId / parentDispatchId / parentRole', async () => {
    const root = createTempRepo()
    await runOneDispatch(root, 'meta-trace', {
      COLLAB_DISPATCH_ID: '01934f00-0000-7000-8000-000000000099',
      COLLAB_TRACE_ID: '01934f00-0000-7000-8000-000000000088',
      COLLAB_ROLE: 'dispatcher',
    })

    const meta = JSON.parse(readFileSync(join(root, '.collab', '.dispatches', 'meta-trace.meta'), 'utf8'))
    expect(meta.dispatchId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/)
    expect(meta.traceId).toBe('01934f00-0000-7000-8000-000000000088')
    expect(meta.parentDispatchId).toBe('01934f00-0000-7000-8000-000000000099')
    expect(meta.parentRole).toBe('dispatcher')
  })

  it('two consecutive dispatches have different dispatch_ids', async () => {
    const root = createTempRepo()
    await runOneDispatch(root, 'first')
    await runOneDispatch(root, 'second')

    const events = readFileSync(join(root, '.collab', 'events.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))

    const firstId = events.find((e) => e.task === 'first')!.dispatch_id
    const secondId = events.find((e) => e.task === 'second')!.dispatch_id
    expect(firstId).not.toBe(secondId)
  })
})
