// E2E for `artel logs <task>` — single-dispatch drilldown.

import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  cleanupTempRoots,
  createTempRepo,
  ENGINE_FILES_CORE,
  ENGINE_FILES_UTIL,
  installEngineRuntime,
  runNode,
} from '../_helpers.js'

afterEach(cleanupTempRoots)

const installLogs = (root: string) =>
  installEngineRuntime(root, [
    'engine/cli/logs.mjs',
    ...ENGINE_FILES_CORE,
    ...ENGINE_FILES_UTIL,
  ])

const fixtureMeta = {
  task: 'feature-x',
  role: 'implementer',
  engine: 'codex',
  model: 'gpt-5',
  status: 'completed',
  disposition: 'success',
  branch: 'implementer/feature-x',
  dispatchedAt: '2026-05-03T22:50:00.000Z',
  completedAt: '2026-05-03T22:51:42.000Z',
  usage: { tokens_in: 1500, tokens_out: 800, cache_read: 200 },
  delta: { files_changed: 3, lines_added: 12, lines_removed: 5 },
  git: { commit_sha: 'abc12345' + '0'.repeat(32), branch: 'implementer/feature-x', repo_name: 'antongolub/artel' },
  dispatchId: '01934f00-aaaa-7bbb-8ccc-dddddddddddd',
}

const writeFixture = (root: string) => {
  const dir = join(root, '.artel', '.dispatches')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'feature-x.meta'), JSON.stringify(fixtureMeta) + '\n')
  writeFileSync(
    join(dir, 'feature-x.out'),
    Array.from({ length: 50 }, (_, i) => `out line ${i + 1}`).join('\n') + '\n',
  )
  writeFileSync(join(dir, 'feature-x.prompt'), 'do the thing\n')
  const events = [
    { schema: 'v1', kind: 'workload', type: 'dispatch.start', at: '2026-05-03T22:50:00.000Z', task: 'feature-x', owner_role: 'implementer', owner_provider: 'codex', engine: 'codex', branch: 'implementer/feature-x', dispatch_id: fixtureMeta.dispatchId },
    { schema: 'v1', kind: 'workload', type: 'checkpoint', at: '2026-05-03T22:50:42.000Z', task: 'feature-x', owner_role: 'implementer', dispatch_id: fixtureMeta.dispatchId, last_completed_step: 'read src', next_safe_step: 'refactor parser' },
    { schema: 'v1', kind: 'workload', type: 'dispatch.end', at: '2026-05-03T22:51:42.000Z', task: 'feature-x', owner_role: 'implementer', disposition: 'success', dispatch_id: fixtureMeta.dispatchId },
  ]
  writeFileSync(join(root, '.artel', 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n')
}

describe('artel logs', () => {
  it('renders meta + events + prompt + out for the task', () => {
    const root = createTempRepo()
    installLogs(root)
    writeFixture(root)
    const r = runNode(root, ['engine/cli/logs.mjs', 'feature-x'])
    expect(r.status).toBe(0)
    // Meta block — key fields visible
    expect(r.stdout).toMatch(/Meta/)
    expect(r.stdout).toContain('feature-x')
    expect(r.stdout).toContain('codex')
    expect(r.stdout).toContain('implementer/feature-x')
    expect(r.stdout).toMatch(/disposition\s+success/)
    expect(r.stdout).toMatch(/\+12\/-5/)
    expect(r.stdout).toMatch(/abc12345/)
    expect(r.stdout).toMatch(/antongolub\/artel/)
    // Events — three rows
    expect(r.stdout).toMatch(/Events\s+\(3\)/)
    expect(r.stdout).toContain('dispatch.start')
    expect(r.stdout).toContain('checkpoint')
    expect(r.stdout).toContain('dispatch.end')
    // Prompt + Out present
    expect(r.stdout).toMatch(/Prompt/)
    expect(r.stdout).toContain('do the thing')
    expect(r.stdout).toMatch(/Out\s+\(/)
  })

  it('--json emits structured object with meta / events / prompt / out', () => {
    const root = createTempRepo()
    installLogs(root)
    writeFixture(root)
    const r = runNode(root, ['engine/cli/logs.mjs', 'feature-x', '--json'])
    expect(r.status).toBe(0)
    const parsed = JSON.parse(r.stdout)
    expect(parsed.task).toBe('feature-x')
    expect(parsed.meta.disposition).toBe('success')
    expect(parsed.events).toHaveLength(3)
    expect(parsed.prompt).toContain('do the thing')
    expect(parsed.out).toContain('out line 50')
  })

  it('--events-only suppresses prompt + out', () => {
    const root = createTempRepo()
    installLogs(root)
    writeFixture(root)
    const r = runNode(root, ['engine/cli/logs.mjs', 'feature-x', '--events-only'])
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('Events')
    expect(r.stdout).not.toMatch(/^Prompt$/m)
    expect(r.stdout).not.toMatch(/^Out\s+\(/m)
  })

  it('--lines tails the .out to N lines', () => {
    const root = createTempRepo()
    installLogs(root)
    writeFixture(root)
    const r = runNode(root, ['engine/cli/logs.mjs', 'feature-x', '--lines', '5'])
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('out line 50')
    expect(r.stdout).not.toContain('out line 1\n') // earliest lines trimmed
    expect(r.stdout).toMatch(/last 5 lines of 50/)
  })

  it('exits 1 with helpful error when task not found', () => {
    const root = createTempRepo()
    installLogs(root)
    const r = runNode(root, ['engine/cli/logs.mjs', 'no-such-task'])
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/No dispatch artefacts found/)
  })

  it('handles missing prompt file gracefully', () => {
    const root = createTempRepo()
    installLogs(root)
    writeFixture(root)
    // Remove the prompt; meta + out remain.
    const dir = join(root, '.artel', '.dispatches')
    writeFileSync(join(dir, 'no-prompt.meta'), JSON.stringify({ task: 'no-prompt', role: 'implementer', engine: 'codex' }))
    writeFileSync(join(dir, 'no-prompt.out'), 'output without prompt\n')
    const r = runNode(root, ['engine/cli/logs.mjs', 'no-prompt'])
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('output without prompt')
    expect(r.stdout).not.toMatch(/^Prompt$/m)
  })
})
