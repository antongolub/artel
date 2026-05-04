// E2E for `artel events` — filtered tail of events.jsonl.

import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  cleanupTempRoots,
  createTempRepo,
  installEngineRuntime,
  runNode,
} from '../_helpers.js'

afterEach(cleanupTempRoots)

const installEvents = (root: string) =>
  installEngineRuntime(root, ['engine/cli/events.mjs'])

const writeFixture = (root: string) => {
  mkdirSync(join(root, '.artel'), { recursive: true })
  const events = [
    { schema: 'v1', kind: 'workload', type: 'dispatch.start', at: '2026-05-04T10:00:00.000Z', task: 'feature-x', owner_role: 'implementer', engine: 'codex', model: 'gpt-5', branch: 'implementer/feature-x', dispatch_id: '01934f00-aaaa-7bbb-8ccc-000000000001', trace_id: '01934f00-aaaa-7bbb-8ccc-000000000001' },
    { schema: 'v1', kind: 'workload', type: 'checkpoint', at: '2026-05-04T10:00:42.000Z', task: 'feature-x', owner_role: 'implementer', dispatch_id: '01934f00-aaaa-7bbb-8ccc-000000000001', trace_id: '01934f00-aaaa-7bbb-8ccc-000000000001', last_completed_step: 'read src', next_safe_step: 'refactor parser' },
    { schema: 'v1', kind: 'workload', type: 'dispatch.end', at: '2026-05-04T10:01:42.000Z', task: 'feature-x', owner_role: 'implementer', disposition: 'success', delta: { files_changed: 3, lines_added: 12, lines_removed: 5 }, dispatch_id: '01934f00-aaaa-7bbb-8ccc-000000000001', trace_id: '01934f00-aaaa-7bbb-8ccc-000000000001' },
    { schema: 'v1', kind: 'signal', type: 'signal.backoff_required', at: '2026-05-04T10:05:00.000Z', engine: 'codex', retry_count: 3, reason: 'provider-limit' },
    { schema: 'v1', kind: 'workload', type: 'parked', at: '2026-05-04T10:06:00.000Z', task: 'flaky-task', reason: 'auth-expired' },
  ]
  writeFileSync(join(root, '.artel', 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n')
}

describe('artel events', () => {
  it('renders all events from the stream by default', () => {
    const root = createTempRepo()
    installEvents(root)
    writeFixture(root)
    const r = runNode(root, ['engine/cli/events.mjs'])
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('dispatch.start')
    expect(r.stdout).toContain('checkpoint')
    expect(r.stdout).toContain('dispatch.end')
    expect(r.stdout).toContain('signal.backoff_required')
    expect(r.stdout).toContain('parked')
  })

  it('filters by --task', () => {
    const root = createTempRepo()
    installEvents(root)
    writeFixture(root)
    const r = runNode(root, ['engine/cli/events.mjs', '--task', 'feature-x'])
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('feature-x')
    expect(r.stdout).not.toContain('flaky-task')
    expect(r.stdout).not.toContain('signal.backoff_required')
  })

  it('filters by --kind', () => {
    const root = createTempRepo()
    installEvents(root)
    writeFixture(root)
    const r = runNode(root, ['engine/cli/events.mjs', '--kind', 'signal'])
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('signal.backoff_required')
    expect(r.stdout).not.toContain('dispatch.start')
    expect(r.stdout).not.toContain('checkpoint')
  })

  it('filters by --type', () => {
    const root = createTempRepo()
    installEvents(root)
    writeFixture(root)
    const r = runNode(root, ['engine/cli/events.mjs', '--type', 'checkpoint'])
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('checkpoint')
    expect(r.stdout).not.toContain('dispatch.start')
  })

  it('filters by --trace (groups a dispatch chain)', () => {
    const root = createTempRepo()
    installEvents(root)
    writeFixture(root)
    const r = runNode(root, ['engine/cli/events.mjs', '--trace', '01934f00-aaaa-7bbb-8ccc-000000000001'])
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('feature-x')
    expect(r.stdout).not.toContain('flaky-task')
    expect(r.stdout).not.toContain('signal.backoff_required')
  })

  it('--limit caps event count to N most recent', () => {
    const root = createTempRepo()
    installEvents(root)
    writeFixture(root)
    const r = runNode(root, ['engine/cli/events.mjs', '--limit', '2'])
    expect(r.status).toBe(0)
    // Last 2 events: signal.backoff_required and parked
    expect(r.stdout).toContain('signal.backoff_required')
    expect(r.stdout).toContain('parked')
    expect(r.stdout).not.toContain('dispatch.start')
  })

  it('--json emits raw filtered jsonl', () => {
    const root = createTempRepo()
    installEvents(root)
    writeFixture(root)
    const r = runNode(root, ['engine/cli/events.mjs', '--json', '--type', 'dispatch.end'])
    expect(r.status).toBe(0)
    const lines = r.stdout.trim().split('\n').filter(Boolean)
    expect(lines).toHaveLength(1)
    const parsed = JSON.parse(lines[0])
    expect(parsed.type).toBe('dispatch.end')
    expect(parsed.disposition).toBe('success')
  })

  it('handles missing events.jsonl (empty stream)', () => {
    const root = createTempRepo()
    installEvents(root)
    const r = runNode(root, ['engine/cli/events.mjs'])
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('')
  })

  it('rejects malformed --since', () => {
    const root = createTempRepo()
    installEvents(root)
    writeFixture(root)
    const r = runNode(root, ['engine/cli/events.mjs', '--since', 'forever'])
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/--since must look like/)
  })
})
