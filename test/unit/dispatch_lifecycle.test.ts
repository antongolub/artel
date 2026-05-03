import { afterEach, describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  cleanupTempRoots,
  createTempRepo,
  dispatchLifecycle,
  execGit,
  snapshotRepo,
} from '../_helpers.js'

afterEach(cleanupTempRoots)

const fakeChild = (exitCode: number | null = 0, exitDelayMs = 5) => {
  const child = new EventEmitter() as EventEmitter & { pid: number, kill: (sig: string) => boolean }
  child.pid = 1
  child.kill = () => true
  setTimeout(() => child.emit('exit', exitCode, null), exitDelayMs)
  return child
}

const baseDispatch = (root: string, extra: Record<string, unknown> = {}) => ({
  role: 'implementer' as const,
  task: 'task-x',
  prompt: 'noop',
  platformDir: root,
  projectDir: root,
  projectArtelDir: join(root, '.artel'),
  ...extra,
})

const runOneDispatch = async (
  root: string,
  task: string,
  extra: Record<string, unknown> = {},
  parentEnv: Record<string, string> = {},
) => {
  const child = fakeChild()
  const savedEnv = { ...process.env }
  Object.assign(process.env, parentEnv)
  try {
    await dispatchLifecycle(
      baseDispatch(root, { task, ...extra }),
      { spawnProcess: () => child as never, log: () => {} },
    )
  } finally {
    for (const k of Object.keys(parentEnv)) delete process.env[k]
    Object.assign(process.env, savedEnv)
  }
  return readFileSync(join(root, '.artel', 'events.jsonl'), 'utf8')
    .trim().split('\n').map((l) => JSON.parse(l))
}

describe('dispatchLifecycle: branch protection', () => {
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
      dispatchLifecycle({ role: 'adversary', task: 'existing-task', prompt: 'noop',
        platformDir: root, projectDir: root, projectArtelDir: join(root, '.artel') }),
    ).rejects.toThrow(`branch ${branch} exists at ${branchCommit}`)
  })
})

describe('dispatchLifecycle: timeout', () => {
  it('marks timed-out dispatches after SIGTERM then SIGKILL', async () => {
    const root = createTempRepo()
    const startedAt = Date.now()
    const kills: Array<{ signal: string, at: number }> = []
    const child = new EventEmitter() as EventEmitter & { pid: number, kill: (sig: string) => boolean }
    child.pid = 32100
    child.kill = (signal) => {
      kills.push({ signal, at: Date.now() })
      if (signal === 'SIGKILL') setTimeout(() => child.emit('exit', null, 'SIGKILL'), 0)
      return true
    }

    const result = await dispatchLifecycle(
      baseDispatch(root, { task: 'timeout-smoke', prompt: 'sleep 30s', timeoutMs: 20, terminationGraceMs: 30 }),
      { spawnProcess: () => child as never, log: () => {} },
    )

    expect(result.disposition).toBe('timeout')
    expect(result.exitCode).toBe(137)
    expect(kills.map((e) => e.signal)).toEqual(['SIGTERM', 'SIGKILL'])
    expect(kills[0]!.at - startedAt).toBeGreaterThanOrEqual(15)
    expect(kills[1]!.at - kills[0]!.at).toBeGreaterThanOrEqual(25)

    const meta = JSON.parse(readFileSync(join(root, '.artel', '.dispatches', 'timeout-smoke.meta'), 'utf8'))
    expect(meta).toMatchObject({ status: 'timed-out', disposition: 'timeout', exitCode: 137 })
    expect(meta.timeout).toMatchObject({ timeoutMs: 20, graceMs: 30, signal: 'SIGKILL' })

    const events = readFileSync(join(root, '.artel', 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    expect(events[0].type).toBe('dispatch.start')
    expect(events[1]).toMatchObject({ type: 'dispatch.end', task: 'timeout-smoke', disposition: 'timeout', owner_role: 'implementer' })
  })
})

describe('dispatchLifecycle: event schema enrichment', () => {
  it('events carry mandatory fields (schema/kind/id/cluster_id/instance_id/fence_token)', async () => {
    const root = createTempRepo()
    const events = await runOneDispatch(root, 'schema-check')
    for (const e of events) {
      expect(e.schema).toBe('v1')
      expect(e.kind).toBe('workload')
      expect(e.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/)
      expect(e.at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
      expect(e.cluster_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/)
      expect(e.instance_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/)
      expect(e.fence_token).toBe(0)
    }
    const cluster = JSON.parse(readFileSync(join(root, '.artel', 'cluster.json'), 'utf8'))
    expect(cluster.cluster_id).toBe(events[0].cluster_id)
  })
})

describe('dispatchLifecycle: event rename', () => {
  it('emits dispatch.start / dispatch.end (canonical names)', async () => {
    const root = createTempRepo()
    const events = await runOneDispatch(root, 'rename-check')
    const types = events.map((e) => e.type)
    expect(types).toContain('dispatch.start')
    expect(types).toContain('dispatch.end')
    expect(types).not.toContain('claim')
    expect(types).not.toContain('release')
  })
})

describe('dispatchLifecycle: tracing', () => {
  it('top-level dispatch: trace_id == dispatch_id, no parent fields', async () => {
    const root = createTempRepo()
    const events = await runOneDispatch(root, 'top-level')
    const dispatchId = events[0].dispatch_id
    expect(dispatchId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/)
    for (const e of events) {
      expect(e.dispatch_id).toBe(dispatchId)
      expect(e.trace_id).toBe(dispatchId)
      expect(e.parent_dispatch_id).toBeUndefined()
      expect(e.parent_role).toBeUndefined()
    }
  })

  it('nested dispatch: inherits trace_id, records parent_dispatch_id and parent_role', async () => {
    const root = createTempRepo()
    const parentDispatchId = '01934f00-0000-7000-8000-000000000001'
    const parentTraceId = '01934f00-0000-7000-8000-000000000000'
    const events = await runOneDispatch(root, 'nested-task', {}, {
      ARTEL_DISPATCH_ID: parentDispatchId,
      ARTEL_TRACE_ID: parentTraceId,
      ARTEL_ROLE: 'orchestrator',
    })
    const childDispatchId = events[0].dispatch_id
    expect(childDispatchId).not.toBe(parentDispatchId)
    for (const e of events) {
      expect(e.dispatch_id).toBe(childDispatchId)
      expect(e.trace_id).toBe(parentTraceId)
      expect(e.parent_dispatch_id).toBe(parentDispatchId)
      expect(e.parent_role).toBe('orchestrator')
    }
  })

  it('.meta sidecar carries dispatchId / traceId / parentDispatchId / parentRole', async () => {
    const root = createTempRepo()
    await runOneDispatch(root, 'meta-trace', {}, {
      ARTEL_DISPATCH_ID: '01934f00-0000-7000-8000-000000000099',
      ARTEL_TRACE_ID: '01934f00-0000-7000-8000-000000000088',
      ARTEL_ROLE: 'dispatcher',
    })
    const meta = JSON.parse(readFileSync(join(root, '.artel', '.dispatches', 'meta-trace.meta'), 'utf8'))
    expect(meta.dispatchId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/)
    expect(meta.traceId).toBe('01934f00-0000-7000-8000-000000000088')
    expect(meta.parentDispatchId).toBe('01934f00-0000-7000-8000-000000000099')
    expect(meta.parentRole).toBe('dispatcher')
  })

  it('two consecutive dispatches have different dispatch_ids', async () => {
    const root = createTempRepo()
    await runOneDispatch(root, 'first')
    await runOneDispatch(root, 'second')
    const events = readFileSync(join(root, '.artel', 'events.jsonl'), 'utf8')
      .trim().split('\n').map((l) => JSON.parse(l))
    const a = events.find((e) => e.task === 'first')!.dispatch_id
    const b = events.find((e) => e.task === 'second')!.dispatch_id
    expect(a).not.toBe(b)
  })
})

describe('dispatchLifecycle: retry tracking', () => {
  const runDispatch = async (root: string, task: string, extra: Record<string, unknown> = {}) => {
    return runOneDispatch(root, task, extra)
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
    const sStart = second.find((e) => e.type === 'dispatch.start' && e.task === 'task-a-retry-1')
    expect(sStart.retry_of).toBe(firstId)
    expect(sStart.retry_count).toBe(1)
    expect(sStart.retry_reason).toBe('success')

    const secondId = sStart.dispatch_id
    const third = await runDispatch(root, 'task-a-retry-2', { retryOf: secondId })
    const tStart = third.find((e) => e.type === 'dispatch.start' && e.task === 'task-a-retry-2')
    expect(tStart.retry_count).toBe(2)
  })

  it('retry with different model resets retry_count to 0', async () => {
    const root = createTempRepo()
    const first = await runDispatch(root, 'task-b', { model: 'opus' })
    const firstId = first.find((e) => e.type === 'dispatch.start').dispatch_id
    const second = await runDispatch(root, 'task-b-retry', { retryOf: firstId, model: 'sonnet' })
    const sStart = second.find((e) => e.type === 'dispatch.start' && e.task === 'task-b-retry')
    expect(sStart.retry_of).toBe(firstId)
    expect(sStart.retry_count).toBeUndefined() // 0 = absent
  })

  it('retry_count >= threshold emits signal.backoff_required', async () => {
    const root = createTempRepo()
    const first = await runDispatch(root, 't1')
    const firstId = first.find((e) => e.type === 'dispatch.start').dispatch_id
    const second = await runDispatch(root, 't2', { retryOf: firstId })
    const secondId = second.find((e) => e.type === 'dispatch.start' && e.task === 't2').dispatch_id
    const third = await runDispatch(root, 't3', { retryOf: secondId })
    const thirdId = third.find((e) => e.type === 'dispatch.start' && e.task === 't3').dispatch_id
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

describe('dispatchLifecycle: role dispatch policies', () => {
  const writeRole = (root: string, name: string, frontmatter: Record<string, string>) => {
    const fm = Object.entries(frontmatter).map(([k, v]) => `${k}: ${v}`).join('\n')
    writeFileSync(join(root, 'agents', `${name}.md`), `---\n${fm}\n---\n${name} test role\n`)
    snapshotRepo(root, `add ${name}`)
  }

  const dispatchAs = async (
    root: string,
    parentRole: string | null,
    requestedRole: string,
    task: string,
  ) => {
    const child = fakeChild()
    const savedEnv = { ...process.env }
    if (parentRole) process.env.ARTEL_ROLE = parentRole
    else delete process.env.ARTEL_ROLE
    try {
      return await dispatchLifecycle(
        baseDispatch(root, { role: requestedRole, task }),
        { spawnProcess: () => child as never, log: () => {} },
      )
    } finally {
      Object.keys(process.env).forEach((k) => { delete process.env[k] })
      Object.assign(process.env, savedEnv)
    }
  }

  it('top-level dispatch (no parent role in env) skips policy check', async () => {
    const root = createTempRepo()
    const result = await dispatchAs(root, null, 'implementer', 'top-level')
    expect(result.disposition).toBe('success')
  })

  it('parent with `dispatchable: none` cannot spawn anything', async () => {
    const root = createTempRepo()
    writeRole(root, 'leaf-parent', { name: 'leaf-parent', engine: 'claude', dispatchable: 'none' })
    await expect(dispatchAs(root, 'leaf-parent', 'implementer', 'denied'))
      .rejects.toThrow(/cannot dispatch 'implementer'/)
  })

  it('explicit allowlist allows only listed roles', async () => {
    const root = createTempRepo()
    writeRole(root, 'restricted', { name: 'restricted', engine: 'claude', dispatchable: 'implementer' })
    const ok = await dispatchAs(root, 'restricted', 'implementer', 'allowed')
    expect(ok.disposition).toBe('success')
    await expect(dispatchAs(root, 'restricted', 'adversary', 'denied'))
      .rejects.toThrow(/cannot dispatch 'adversary'/)
  })

  it('non-dispatchable denylist applied on top of `dispatchable: all`', async () => {
    const root = createTempRepo()
    writeRole(root, 'capped', {
      name: 'capped', engine: 'claude', dispatchable: 'all', 'non-dispatchable': 'adversary',
    })
    const ok = await dispatchAs(root, 'capped', 'implementer', 'allowed')
    expect(ok.disposition).toBe('success')
    await expect(dispatchAs(root, 'capped', 'adversary', 'denied'))
      .rejects.toThrow(/non-dispatchable: adversary/)
  })

  it('unknown parent role fails open', async () => {
    const root = createTempRepo()
    const result = await dispatchAs(root, 'ghost-parent', 'implementer', 'unknown-parent')
    expect(result.disposition).toBe('success')
  })

  it('dispatchable defaults to all when frontmatter missing the key', async () => {
    const root = createTempRepo()
    writeRole(root, 'permissive', { name: 'permissive', engine: 'claude' })
    const result = await dispatchAs(root, 'permissive', 'implementer', 'default-permissive')
    expect(result.disposition).toBe('success')
  })

  it('orchestrator-style policy: all except itself', async () => {
    const root = createTempRepo()
    writeRole(root, 'mock-orchestrator', {
      name: 'mock-orchestrator', engine: 'claude',
      dispatchable: 'all', 'non-dispatchable': 'mock-orchestrator',
    })
    const ok = await dispatchAs(root, 'mock-orchestrator', 'adversary', 'orch-to-adv')
    expect(ok.disposition).toBe('success')
    await expect(dispatchAs(root, 'mock-orchestrator', 'mock-orchestrator', 'orch-recursion'))
      .rejects.toThrow(/non-dispatchable: mock-orchestrator/)
  })
})

describe('dispatchLifecycle: usage merge from driver', () => {
  it('merges driver.parseUsage result into dispatch.end + .meta', async () => {
    const root = createTempRepo()
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

    const child = fakeChild()
    await dispatchLifecycle(
      baseDispatch(root, { task: 'usage-merge' }),
      { spawnProcess: () => child as never, log: () => {} },
    )

    const events = readFileSync(join(root, '.artel', 'events.jsonl'), 'utf8')
      .trim().split('\n').map((l) => JSON.parse(l))
    const endEvent = events.find((e) => e.type === 'dispatch.end')
    const expectedUsage = { tokens_in: 100, tokens_out: 50, cache_read: 10, cache_creation: 5, model: 'test-model', cost_usd: null }
    expect(endEvent.usage).toEqual(expectedUsage)

    const meta = JSON.parse(readFileSync(join(root, '.artel', '.dispatches', 'usage-merge.meta'), 'utf8'))
    expect(meta.usage).toEqual(expectedUsage)
  })
})
