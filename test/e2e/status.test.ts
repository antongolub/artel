import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanupTempRoots, createTempRepo, ENGINE_FILES_DRIVERS, ENGINE_FILES_UTIL, installEngineRuntime, runNode } from '../_helpers.js'

afterEach(cleanupTempRoots)

const installStatus = (root: string) => {
  installEngineRuntime(root, ['engine/cli/status.mjs', ...ENGINE_FILES_DRIVERS, ...ENGINE_FILES_UTIL])
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
