// E2E for `artel queue` — programmatic mutations of .artel/QUEUE.md.

import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
    'engine/cli/queue.mjs',
    ...ENGINE_FILES_CORE,
    ...ENGINE_FILES_DRIVERS,
    ...ENGINE_FILES_UTIL,
  ])

const queuePath = (root: string) => join(root, '.artel', 'QUEUE.md')
const readQueue = (root: string) => readFileSync(queuePath(root), 'utf8')
const events = (root: string) => {
  const path = join(root, '.artel', 'events.jsonl')
  return existsSync(path)
    ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : []
}

describe('artel queue', () => {
  it('add appends to Pending by default with --tag prefix', () => {
    const root = createTempRepo()
    installAll(root)
    const r = runNode(root, ['engine/cli/queue.mjs', 'add', 'hello-task', '--tag', 'impl'])
    expect(r.status).toBe(0)
    const md = readQueue(root)
    expect(md).toMatch(/## Pending\n+- \[impl\] hello-task/)
    const evt = events(root).find((e) => e.type === 'queue.entry.added')
    expect(evt).toMatchObject({ kind: 'infra', task: 'hello-task', section: 'Pending', tag: 'impl' })
  })

  it('add --section places in the specified section', () => {
    const root = createTempRepo()
    installAll(root)
    runNode(root, ['engine/cli/queue.mjs', 'add', 'fix-bug', '--section', 'For Owner'])
    const md = readQueue(root)
    expect(md).toMatch(/## For Owner\n+- fix-bug/)
  })

  it('add rejects duplicate slug', () => {
    const root = createTempRepo()
    installAll(root)
    runNode(root, ['engine/cli/queue.mjs', 'add', 'dup'])
    const second = runNode(root, ['engine/cli/queue.mjs', 'add', 'dup'])
    expect(second.status).not.toBe(0)
    expect(second.stderr).toMatch(/already in queue/)
  })

  it('add rejects invalid slug', () => {
    const root = createTempRepo()
    installAll(root)
    const r = runNode(root, ['engine/cli/queue.mjs', 'add', '_bad'])
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/invalid task slug/)
  })

  it('add rejects unknown section', () => {
    const root = createTempRepo()
    installAll(root)
    const r = runNode(root, ['engine/cli/queue.mjs', 'add', 'x', '--section', 'Limbo'])
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/invalid section/)
  })

  it('move relocates entry; In progress stamps [since <iso>]', () => {
    const root = createTempRepo()
    installAll(root)
    runNode(root, ['engine/cli/queue.mjs', 'add', 'task-a', '--tag', 'impl'])
    runNode(root, ['engine/cli/queue.mjs', 'move', 'task-a', '--to', 'In progress'])
    const md = readQueue(root)
    expect(md).toMatch(/## Pending\n+- \(none\)/)
    // Fixture's QUEUE.md has a pre-existing In progress entry — match
    // against that section non-greedily to tolerate other items in there.
    expect(md).toMatch(/## In progress[\s\S]*?- \[impl\] task-a \[since \d{4}-\d{2}-\d{2}T/)
    const moves = events(root).filter((e) => e.type === 'queue.entry.moved')
    expect(moves).toHaveLength(1)
    expect(moves[0]).toMatchObject({ task: 'task-a', from: 'Pending', to: 'In progress' })
  })

  it('moving out of In progress strips stale [since] tag', () => {
    const root = createTempRepo()
    installAll(root)
    runNode(root, ['engine/cli/queue.mjs', 'add', 'task-a'])
    runNode(root, ['engine/cli/queue.mjs', 'move', 'task-a', '--to', 'In progress'])
    runNode(root, ['engine/cli/queue.mjs', 'move', 'task-a', '--to', 'Pending'])
    const md = readQueue(root)
    expect(md).toMatch(/## Pending\n+- task-a/)
    expect(md).not.toMatch(/\[since/)
  })

  it('done is a shorthand for move --to "Recently done"', () => {
    const root = createTempRepo()
    installAll(root)
    runNode(root, ['engine/cli/queue.mjs', 'add', 'wrap-up', '--tag', 'impl'])
    const r = runNode(root, ['engine/cli/queue.mjs', 'done', 'wrap-up'])
    expect(r.status).toBe(0)
    expect(readQueue(root)).toMatch(/## Recently done\n+- \[impl\] wrap-up/)
    const evt = events(root).find((e) => e.type === 'queue.entry.moved')
    expect(evt.to).toBe('Recently done')
  })

  it('move on missing slug → exit 1', () => {
    const root = createTempRepo()
    installAll(root)
    const r = runNode(root, ['engine/cli/queue.mjs', 'move', 'ghost', '--to', 'Pending'])
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/'ghost' not found/)
  })

  it('rm removes entry; missing → exit 1', () => {
    const root = createTempRepo()
    installAll(root)
    runNode(root, ['engine/cli/queue.mjs', 'add', 'doomed'])
    const ok = runNode(root, ['engine/cli/queue.mjs', 'rm', 'doomed'])
    expect(ok.status).toBe(0)
    expect(readQueue(root)).not.toContain('doomed')
    const evt = events(root).find((e) => e.type === 'queue.entry.removed')
    expect(evt).toMatchObject({ task: 'doomed' })

    const missing = runNode(root, ['engine/cli/queue.mjs', 'rm', 'doomed'])
    expect(missing.status).toBe(1)
  })

  it('list shows counts + slugs', () => {
    const root = createTempRepo()
    installAll(root)
    runNode(root, ['engine/cli/queue.mjs', 'add', 'a'])
    runNode(root, ['engine/cli/queue.mjs', 'add', 'b'])
    runNode(root, ['engine/cli/queue.mjs', 'add', 'c', '--section', 'For Owner'])
    const r = runNode(root, ['engine/cli/queue.mjs', 'list'])
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/Pending.*\(2\)/)
    expect(r.stdout).toMatch(/For Owner.*\(1\)/)
    expect(r.stdout).toContain('a')
    expect(r.stdout).toContain('b')
    expect(r.stdout).toContain('c')
  })

  it('list --json emits sectioned structure', () => {
    const root = createTempRepo()
    installAll(root)
    runNode(root, ['engine/cli/queue.mjs', 'add', 'task-a', '--tag', 'impl'])
    const r = runNode(root, ['engine/cli/queue.mjs', 'list', '--json'])
    expect(r.status).toBe(0)
    const parsed = JSON.parse(r.stdout)
    const pending = parsed.find((s: { name: string }) => s.name === 'Pending')
    expect(pending.items).toEqual(['[impl] task-a'])
  })

  it('list --section filters output', () => {
    const root = createTempRepo()
    installAll(root)
    runNode(root, ['engine/cli/queue.mjs', 'add', 'urgent', '--section', 'For Owner'])
    runNode(root, ['engine/cli/queue.mjs', 'add', 'later'])
    const r = runNode(root, ['engine/cli/queue.mjs', 'list', '--section', 'For Owner', '--json'])
    expect(r.status).toBe(0)
    const parsed = JSON.parse(r.stdout)
    expect(parsed).toHaveLength(1)
    expect(parsed[0].name).toBe('For Owner')
    expect(parsed[0].items).toEqual(['urgent'])
  })

  it('add bootstraps QUEUE.md when missing', () => {
    const root = createTempRepo()
    installAll(root)
    // Remove the fixture-supplied QUEUE.md to simulate fresh project.
    const path = queuePath(root)
    rmSync(path)
    runNode(root, ['engine/cli/queue.mjs', 'add', 'bootstrapped'])
    const md = readQueue(root)
    expect(md).toMatch(/^# Work queue/)
    expect(md).toMatch(/## Pending\n+- bootstrapped/)
    // All canonical sections present
    for (const section of ['For Owner', 'In progress', 'Pending', 'Blocked', 'Recently done']) {
      expect(md).toContain(`## ${section}`)
    }
  })

  it('preserves item description with em-dash separator', () => {
    const root = createTempRepo()
    installAll(root)
    runNode(root, ['engine/cli/queue.mjs', 'add', 'task-a', '--tag', 'impl', 'short', 'description'])
    const md = readQueue(root)
    expect(md).toMatch(/- \[impl\] task-a — short description/)
  })

  it('moving In progress → In progress is a no-op (no event)', () => {
    const root = createTempRepo()
    installAll(root)
    runNode(root, ['engine/cli/queue.mjs', 'add', 'a'])
    runNode(root, ['engine/cli/queue.mjs', 'move', 'a', '--to', 'In progress'])
    const before = events(root).filter((e) => e.type === 'queue.entry.moved').length
    runNode(root, ['engine/cli/queue.mjs', 'move', 'a', '--to', 'In progress'])
    const after = events(root).filter((e) => e.type === 'queue.entry.moved').length
    expect(after).toBe(before) // no second event
  })
})
