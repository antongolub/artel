// E2E for `artel sweep` — prunes old .dispatches/, respects active QUEUE
// entries and --keep N. Emits `cluster.swept` infra event.

import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  cleanupTempRoots,
  createTempRepo,
  ENGINE_FILES_CORE,
  ENGINE_FILES_DRIVERS,
  ENGINE_FILES_UTIL,
  installEngineRuntime,
  runNode,
} from '../_helpers.js'

afterEach(cleanupTempRoots)

const installAll = (root: string) =>
  installEngineRuntime(root, [
    'engine/cli/sweep.mjs',
    ...ENGINE_FILES_CORE,
    ...ENGINE_FILES_DRIVERS,
    ...ENGINE_FILES_UTIL,
  ])

const writeDispatch = (root: string, slug: string, completedAtIso: string, body: string = 'out') => {
  const dir = join(root, '.artel', '.dispatches')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${slug}.meta`), JSON.stringify({ task: slug, completedAt: completedAtIso }))
  writeFileSync(join(dir, `${slug}.out`), body)
  writeFileSync(join(dir, `${slug}.prompt`), 'prompt body')
}

const ago = (ms: number) => new Date(Date.now() - ms).toISOString()

const events = (root: string) => {
  const path = join(root, '.artel', 'events.jsonl')
  return existsSync(path)
    ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : []
}

describe('artel sweep', () => {
  it('removes old dispatches past --older-than threshold', () => {
    const root = createTempRepo()
    installAll(root)
    writeDispatch(root, 'old', ago(60 * 86400000)) // 60 days
    writeDispatch(root, 'fresh', ago(1 * 86400000)) // 1 day
    const r = runNode(root, ['engine/cli/sweep.mjs', '--keep', '0'])
    expect(r.status).toBe(0)
    expect(existsSync(join(root, '.artel', '.dispatches', 'old.meta'))).toBe(false)
    expect(existsSync(join(root, '.artel', '.dispatches', 'fresh.meta'))).toBe(true)
  })

  it('--dry-run prints plan without removing', () => {
    const root = createTempRepo()
    installAll(root)
    writeDispatch(root, 'old', ago(60 * 86400000))
    const r = runNode(root, ['engine/cli/sweep.mjs', '--keep', '0', '--dry-run'])
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('old')
    // Files still present
    expect(existsSync(join(root, '.artel', '.dispatches', 'old.meta'))).toBe(true)
  })

  it('--keep N protects newest dispatches regardless of age', () => {
    const root = createTempRepo()
    installAll(root)
    writeDispatch(root, 'old1', ago(60 * 86400000))
    writeDispatch(root, 'old2', ago(50 * 86400000))
    writeDispatch(root, 'old3', ago(40 * 86400000))
    runNode(root, ['engine/cli/sweep.mjs', '--keep', '2'])
    // Two newest survive (old3, old2); oldest (old1) swept.
    expect(existsSync(join(root, '.artel', '.dispatches', 'old1.meta'))).toBe(false)
    expect(existsSync(join(root, '.artel', '.dispatches', 'old2.meta'))).toBe(true)
    expect(existsSync(join(root, '.artel', '.dispatches', 'old3.meta'))).toBe(true)
  })

  it('skips tasks listed in active QUEUE.md sections', () => {
    const root = createTempRepo()
    installAll(root)
    writeDispatch(root, 'still-active', ago(60 * 86400000))
    writeFileSync(join(root, '.artel', 'QUEUE.md'),
      '# Q\n## For Owner\n- (none)\n## In progress\n- still-active [since 2024-01-01T00:00:00Z]\n## Pending\n- (none)\n## Blocked\n- (none)\n## Recently done\n- (none)\n')
    const r = runNode(root, ['engine/cli/sweep.mjs', '--keep', '0'])
    expect(r.status).toBe(0)
    expect(existsSync(join(root, '.artel', '.dispatches', 'still-active.meta'))).toBe(true)
    expect(r.stdout).toMatch(/1 active/)
  })

  it('skips dispatches with no completedAt (still running)', () => {
    const root = createTempRepo()
    installAll(root)
    const dir = join(root, '.artel', '.dispatches')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'running.meta'), JSON.stringify({ task: 'running', status: 'running' }))
    writeFileSync(join(dir, 'running.out'), '')
    runNode(root, ['engine/cli/sweep.mjs', '--keep', '0'])
    expect(existsSync(join(dir, 'running.meta'))).toBe(true)
  })

  it('emits cluster.swept event with totals', () => {
    const root = createTempRepo()
    installAll(root)
    writeDispatch(root, 'old1', ago(60 * 86400000))
    writeDispatch(root, 'old2', ago(60 * 86400000))
    runNode(root, ['engine/cli/sweep.mjs', '--keep', '0'])
    const evt = events(root).find((e) => e.type === 'cluster.swept')
    expect(evt).toBeTruthy()
    expect(evt.kind).toBe('infra')
    expect(evt.dispatches_removed).toBe(2)
    expect(evt.files_removed).toBe(6) // 2 dispatches × 3 files (meta + out + prompt)
  })

  it('--json emits structured summary', () => {
    const root = createTempRepo()
    installAll(root)
    writeDispatch(root, 'old', ago(60 * 86400000))
    const r = runNode(root, ['engine/cli/sweep.mjs', '--keep', '0', '--json', '--dry-run'])
    expect(r.status).toBe(0)
    const parsed = JSON.parse(r.stdout)
    expect(parsed.candidates).toBe(1)
    expect(parsed.swept).toHaveLength(1)
    expect(parsed.swept[0].task).toBe('old')
    expect(parsed.dry_run).toBe(true)
  })

  it('--older-than rejects malformed values', () => {
    const root = createTempRepo()
    installAll(root)
    const r = runNode(root, ['engine/cli/sweep.mjs', '--older-than', 'forever'])
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/--older-than must look like/)
  })

  it('clean tree → no-op (no event, no error)', () => {
    const root = createTempRepo()
    installAll(root)
    const r = runNode(root, ['engine/cli/sweep.mjs'])
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/nothing to sweep/)
    expect(events(root).filter((e) => e.type === 'cluster.swept')).toEqual([])
  })
})
