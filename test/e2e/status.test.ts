import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanupTempRoots, createTempRepo, ENGINE_FILES_CORE, ENGINE_FILES_DRIVERS, ENGINE_FILES_UTIL, installEngineRuntime, runNode } from '../_helpers.js'

afterEach(cleanupTempRoots)

const installStatus = (root: string) => {
  installEngineRuntime(root, [
    'engine/cli/status.mjs',
    ...ENGINE_FILES_CORE,
    ...ENGINE_FILES_DRIVERS,
    ...ENGINE_FILES_UTIL,
  ])
}

describe('artel status: render new fields', () => {
  it('renders usage tokens annotation in RECENT when meta has usage', () => {
    const root = createTempRepo()
    installStatus(root)
    mkdirSync(join(root, '.artel', '.dispatches'), { recursive: true })

    writeFileSync(
      join(root, '.artel', '.dispatches', 'used.meta'),
      JSON.stringify({
        task: 'used-task', role: 'implementer', engine: 'codex',
        status: 'completed', completedAt: '2026-05-01T00:00:00.000Z',
        usage: { tokens_in: 1500, tokens_out: 800, cache_read: 200, cache_creation: 0, model: 'gpt-5', cost_usd: null },
      }, null, 2) + '\n',
    )
    writeFileSync(join(root, '.artel', '.dispatches', 'used.out'), 'test output\n')

    const status = runNode(root, ['engine/cli/status.mjs'])
    expect(status.status).toBe(0)
    expect(status.stdout).toContain('used-task')
    expect(status.stdout).toMatch(/\d+(k|M)?\/\d+(k|M)?t/)
  })

  it('renders retry indicator when retryCount > 0', () => {
    const root = createTempRepo()
    installStatus(root)
    mkdirSync(join(root, '.artel', '.dispatches'), { recursive: true })

    writeFileSync(
      join(root, '.artel', '.dispatches', 'retried.meta'),
      JSON.stringify({
        task: 'retried-task', role: 'implementer', engine: 'claude',
        status: 'completed', completedAt: '2026-05-01T00:00:00.000Z', retryCount: 2,
      }, null, 2) + '\n',
    )
    writeFileSync(join(root, '.artel', '.dispatches', 'retried.out'), 'output\n')

    const status = runNode(root, ['engine/cli/status.mjs'])
    expect(status.status).toBe(0)
    expect(status.stdout).toContain('retried-task')
    expect(status.stdout).toMatch(/r2/)
  })
})

describe('artel status: timed-out vs parked rendering', () => {
  it('renders timed-out dispatches above parked dispatches', () => {
    const root = createTempRepo()
    installStatus(root)
    mkdirSync(join(root, '.artel', '.dispatches'), { recursive: true })

    writeFileSync(
      join(root, '.artel', '.dispatches', 'timed.meta'),
      JSON.stringify({
        task: 'timed-task', role: 'implementer', engine: 'claude',
        status: 'timed-out', completedAt: '2026-05-01T01:00:00.000Z',
        exitCode: 137, timeout: { timeoutMs: 5000, signal: 'SIGKILL' },
      }, null, 2) + '\n',
    )
    writeFileSync(
      join(root, '.artel', '.dispatches', 'parked.meta'),
      JSON.stringify({
        task: 'parked-task', role: 'implementer', engine: 'claude',
        status: 'parked', completedAt: '2026-05-01T00:30:00.000Z',
        parked: { reason: 'provider-limit', resetAt: '5:20pm', raw: 'hit your limit' },
      }, null, 2) + '\n',
    )

    const status = runNode(root, ['engine/cli/status.mjs'])
    expect(status.status).toBe(0)
    expect(status.stdout).toContain('TIMED-OUT')
    expect(status.stdout).toContain('timed-task')
    expect(status.stdout).toContain('PARKED')
    expect(status.stdout).toContain('parked-task')
    expect(status.stdout.indexOf('TIMED-OUT')).toBeLessThan(status.stdout.indexOf('PARKED'))
  })
})

describe('artel status: dashboard context', () => {
  it('renders cluster id (short) + name on header context line', () => {
    const root = createTempRepo()
    installStatus(root)
    writeFileSync(
      join(root, '.artel', 'cluster.json'),
      JSON.stringify({
        cluster_id: '01934f00-aaaa-7bbb-8ccc-dddddddddddd',
        name: 'demo-cluster',
        schema: 'cluster-v1',
      }) + '\n',
    )
    const status = runNode(root, ['engine/cli/status.mjs'])
    expect(status.status).toBe(0)
    expect(status.stdout).toMatch(/cluster\s+01934f00/)
    expect(status.stdout).toContain('demo-cluster')
  })

  it('expands PENDING and BLOCKED queue sections with task names', () => {
    const root = createTempRepo()
    installStatus(root)
    writeFileSync(
      join(root, '.artel', 'QUEUE.md'),
      [
        '# Work queue', '',
        '## For Owner', '- (none)', '',
        '## In progress', '- (none)', '',
        '## Pending', '- [spec] something to design', '- [impl] another task', '',
        '## Blocked', '- [research] external dependency', '',
        '## Recently done', '- (none)', '',
      ].join('\n'),
    )
    const status = runNode(root, ['engine/cli/status.mjs'])
    expect(status.status).toBe(0)
    expect(status.stdout).toContain('PENDING')
    expect(status.stdout).toContain('something to design')
    expect(status.stdout).toContain('another task')
    expect(status.stdout).toContain('BLOCKED')
    expect(status.stdout).toContain('external dependency')
  })

  it('renders dispatch duration in RECENT when meta has dispatchedAt + completedAt', () => {
    const root = createTempRepo()
    installStatus(root)
    mkdirSync(join(root, '.artel', '.dispatches'), { recursive: true })
    writeFileSync(
      join(root, '.artel', '.dispatches', 'dur.meta'),
      JSON.stringify({
        task: 'duration-task', role: 'implementer', engine: 'codex',
        status: 'completed', disposition: 'success',
        dispatchedAt: '2026-05-01T00:00:00.000Z',
        completedAt: '2026-05-01T00:00:42.000Z',
      }) + '\n',
    )
    writeFileSync(join(root, '.artel', '.dispatches', 'dur.out'), 'output\n')
    const status = runNode(root, ['engine/cli/status.mjs'])
    expect(status.status).toBe(0)
    expect(status.stdout).toContain('duration-task')
    // formatDuration(42000) → '42s'
    expect(status.stdout).toMatch(/codex \S+ \(42s\)/)
  })

  it('flags engine with recent auth-expired park as ⚠ in TOKENS', () => {
    const root = createTempRepo()
    installStatus(root)
    mkdirSync(join(root, '.artel', '.dispatches'), { recursive: true })
    writeFileSync(
      join(root, '.artel', '.dispatches', 'authfail.meta'),
      JSON.stringify({
        task: 'fail', role: 'orchestrator', engine: 'copilot',
        status: 'parked', disposition: 'parked',
        completedAt: new Date().toISOString(),
        parked: { reason: 'auth-expired', raw: 'Not logged in' },
      }) + '\n',
    )
    const status = runNode(root, ['engine/cli/status.mjs'])
    expect(status.status).toBe(0)
    // Copilot row should be flagged with ⚠ marker.
    expect(status.stdout).toMatch(/⚠\s+Copilot/)
  })
})

describe('artel status: legacy event back-compat', () => {
  it('summarises legacy claim/release events alongside canonical dispatch.start/end', () => {
    const root = createTempRepo()
    installStatus(root)
    mkdirSync(join(root, '.artel', '.dispatches'), { recursive: true })

    const events = [
      { schema: 'v1', kind: 'workload', type: 'claim', at: '2026-05-01T10:00:00.000Z', task: 'old-task', owner_role: 'implementer', branch: 'implementer/old-task' },
      { schema: 'v1', kind: 'workload', type: 'release', at: '2026-05-01T10:05:00.000Z', task: 'old-task', owner_role: 'implementer', disposition: 'success' },
      { schema: 'v1', kind: 'workload', type: 'dispatch.start', at: '2026-05-01T11:00:00.000Z', task: 'new-task', owner_role: 'implementer', branch: 'implementer/new-task' },
      { schema: 'v1', kind: 'workload', type: 'dispatch.end', at: '2026-05-01T11:05:00.000Z', task: 'new-task', owner_role: 'implementer', disposition: 'success' },
    ]
    writeFileSync(
      join(root, '.artel', 'events.jsonl'),
      events.map((e) => JSON.stringify(e)).join('\n') + '\n',
    )

    const status = runNode(root, ['engine/cli/status.mjs'])
    expect(status.status).toBe(0)
    expect(status.stdout).toContain('old-task')
    expect(status.stdout).toContain('new-task')
  })
})
