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
    const evt = events(root).find((e) => e.type === 'queue_node.created')
    expect(evt).toMatchObject({
      kind: 'workload',
      node_id: 'hello-task',
      status: 'Pending',
      lane: 'impl',
      fence_token: 0,
    })
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
    const moves = events(root).filter((e) => e.type === 'queue_node.updated')
    expect(moves).toHaveLength(1)
    expect(moves[0]).toMatchObject({
      kind: 'workload',
      node_id: 'task-a',
      from_status: 'Pending',
      fields: { status: 'In progress' },
    })
    expect(moves[0].fields.since_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
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
    const evt = events(root).find((e) => e.type === 'queue_node.updated')
    expect(evt.fields.status).toBe('Recently done')
    expect(evt.fields.since_at).toBeNull() // cleared when leaving In progress
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
    const evt = events(root).find((e) => e.type === 'queue_node.deleted')
    expect(evt).toMatchObject({ kind: 'workload', node_id: 'doomed', from_status: 'Pending' })

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
    const before = events(root).filter((e) => e.type === 'queue_node.updated').length
    runNode(root, ['engine/cli/queue.mjs', 'move', 'a', '--to', 'In progress'])
    const after = events(root).filter((e) => e.type === 'queue_node.updated').length
    expect(after).toBe(before) // no second event
  })
})

describe('artel queue ready / graph (V2.1 event-sourced)', () => {
  it('ready surfaces Pending nodes sorted by creation time', () => {
    const root = createTempRepo()
    installAll(root)
    runNode(root, ['engine/cli/queue.mjs', 'add', 'second-task', '--tag', 'impl'])
    runNode(root, ['engine/cli/queue.mjs', 'add', 'first-task', '--tag', 'spec'])
    // Move one out of Pending so it doesn't show in ready.
    runNode(root, ['engine/cli/queue.mjs', 'move', 'second-task', '--to', 'In progress'])

    const r = runNode(root, ['engine/cli/queue.mjs', 'ready'])
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('first-task')
    expect(r.stdout).not.toContain('second-task')
  })

  it('ready --json emits node objects', () => {
    const root = createTempRepo()
    installAll(root)
    runNode(root, ['engine/cli/queue.mjs', 'add', 'task-a', '--tag', 'impl', 'do', 'thing'])
    const r = runNode(root, ['engine/cli/queue.mjs', 'ready', '--json'])
    expect(r.status).toBe(0)
    const parsed = JSON.parse(r.stdout)
    expect(parsed).toHaveLength(1)
    expect(parsed[0]).toMatchObject({
      slug: 'task-a',
      status: 'Pending',
      lane: 'impl',
      description: 'do thing',
    })
  })

  it('graph reflects mutations: add → move → done end-to-end', () => {
    const root = createTempRepo()
    installAll(root)
    runNode(root, ['engine/cli/queue.mjs', 'add', 'task-a', '--tag', 'impl'])
    runNode(root, ['engine/cli/queue.mjs', 'move', 'task-a', '--to', 'In progress'])
    runNode(root, ['engine/cli/queue.mjs', 'done', 'task-a'])

    const r = runNode(root, ['engine/cli/queue.mjs', 'graph', '--json'])
    expect(r.status).toBe(0)
    const parsed = JSON.parse(r.stdout)
    expect(parsed.nodes).toHaveLength(1)
    expect(parsed.nodes[0]).toMatchObject({
      slug: 'task-a',
      status: 'Recently done',
      lane: 'impl',
    })
    expect(parsed.nodes[0].since_at).toBeUndefined() // cleared on exit from In progress
  })

  it('graph after rm omits the node entirely', () => {
    const root = createTempRepo()
    installAll(root)
    runNode(root, ['engine/cli/queue.mjs', 'add', 'doomed'])
    runNode(root, ['engine/cli/queue.mjs', 'rm', 'doomed'])
    const r = runNode(root, ['engine/cli/queue.mjs', 'graph', '--json'])
    expect(r.status).toBe(0)
    expect(JSON.parse(r.stdout).nodes).toEqual([])
  })

  it('graph empty state shows hint', () => {
    const root = createTempRepo()
    installAll(root)
    const r = runNode(root, ['engine/cli/queue.mjs', 'graph'])
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/no queue_node\.\* events yet/)
  })

  it('events emitted by mutators are valid per schema', () => {
    const root = createTempRepo()
    installAll(root)
    runNode(root, ['engine/cli/queue.mjs', 'add', 'task-a'])
    runNode(root, ['engine/cli/queue.mjs', 'move', 'task-a', '--to', 'In progress'])
    runNode(root, ['engine/cli/queue.mjs', 'rm', 'task-a'])
    const queueEvents = events(root).filter((e) => (e.type || '').startsWith('queue_node.'))
    expect(queueEvents).toHaveLength(3)
    for (const e of queueEvents) {
      expect(e.kind).toBe('workload')
      expect(e.fence_token).toBe(0)
      expect(e.cluster_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/)
      expect(e.at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    }
  })
})

describe('artel queue link / unlink (V2.2)', () => {
  it('link emits queue_edge.added; unlink removes', () => {
    const root = createTempRepo()
    installAll(root)
    runNode(root, ['engine/cli/queue.mjs', 'add', 'a'])
    runNode(root, ['engine/cli/queue.mjs', 'add', 'b'])
    const linked = runNode(root,
      ['engine/cli/queue.mjs', 'link', 'a', 'b', '--relation', 'blocks'])
    expect(linked.status).toBe(0)
    const addedEvt = events(root).find((e) => e.type === 'queue_edge.added')
    expect(addedEvt).toMatchObject({
      kind: 'workload',
      relation: 'blocks',
      from: 'a',
      to: 'b',
      fence_token: 0,
    })

    const unlinked = runNode(root,
      ['engine/cli/queue.mjs', 'unlink', 'a', 'b', '--relation', 'blocks'])
    expect(unlinked.status).toBe(0)
    const removedEvt = events(root).find((e) => e.type === 'queue_edge.removed')
    expect(removedEvt).toMatchObject({ relation: 'blocks', from: 'a', to: 'b' })
  })

  it('link rejects unknown relation', () => {
    const root = createTempRepo()
    installAll(root)
    runNode(root, ['engine/cli/queue.mjs', 'add', 'a'])
    runNode(root, ['engine/cli/queue.mjs', 'add', 'b'])
    const r = runNode(root,
      ['engine/cli/queue.mjs', 'link', 'a', 'b', '--relation', 'frobs'])
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/invalid relation/)
  })

  it('link rejects self-edge', () => {
    const root = createTempRepo()
    installAll(root)
    runNode(root, ['engine/cli/queue.mjs', 'add', 'a'])
    const r = runNode(root,
      ['engine/cli/queue.mjs', 'link', 'a', 'a', '--relation', 'blocks'])
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/self-edges not allowed/)
  })

  it('link rejects unknown nodes', () => {
    const root = createTempRepo()
    installAll(root)
    runNode(root, ['engine/cli/queue.mjs', 'add', 'a'])
    const r = runNode(root,
      ['engine/cli/queue.mjs', 'link', 'a', 'ghost', '--relation', 'blocks'])
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/'ghost' is not a known node/)
  })

  it('link rejects gating cycle (a→b exists, b→a refused)', () => {
    const root = createTempRepo()
    installAll(root)
    runNode(root, ['engine/cli/queue.mjs', 'add', 'a'])
    runNode(root, ['engine/cli/queue.mjs', 'add', 'b'])
    runNode(root,
      ['engine/cli/queue.mjs', 'link', 'a', 'b', '--relation', 'blocks'])
    const r = runNode(root,
      ['engine/cli/queue.mjs', 'link', 'b', 'a', '--relation', 'blocks'])
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/would create a cycle/)
  })

  it('non-gating relations are NOT cycle-checked', () => {
    const root = createTempRepo()
    installAll(root)
    runNode(root, ['engine/cli/queue.mjs', 'add', 'a'])
    runNode(root, ['engine/cli/queue.mjs', 'add', 'b'])
    runNode(root,
      ['engine/cli/queue.mjs', 'link', 'a', 'b', '--relation', 'parent_of'])
    const r = runNode(root,
      ['engine/cli/queue.mjs', 'link', 'b', 'a', '--relation', 'parent_of'])
    expect(r.status).toBe(0) // weird but allowed; parent_of cycles aren't gating
  })

  it('unlink on missing edge → exit 1', () => {
    const root = createTempRepo()
    installAll(root)
    runNode(root, ['engine/cli/queue.mjs', 'add', 'a'])
    runNode(root, ['engine/cli/queue.mjs', 'add', 'b'])
    const r = runNode(root,
      ['engine/cli/queue.mjs', 'unlink', 'a', 'b', '--relation', 'blocks'])
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/edge .* not found/)
  })

  it('ready filters out Pending nodes blocked by gating upstream', () => {
    const root = createTempRepo()
    installAll(root)
    runNode(root, ['engine/cli/queue.mjs', 'add', 'upstream'])
    runNode(root, ['engine/cli/queue.mjs', 'add', 'downstream'])
    runNode(root,
      ['engine/cli/queue.mjs', 'link', 'upstream', 'downstream', '--relation', 'blocks'])
    const r = runNode(root, ['engine/cli/queue.mjs', 'ready', '--json'])
    expect(r.status).toBe(0)
    const parsed = JSON.parse(r.stdout)
    expect(parsed.map((n: { slug: string }) => n.slug)).toEqual(['upstream'])
  })

  it('ready --human surfaces "Held by upstream" hint', () => {
    const root = createTempRepo()
    installAll(root)
    runNode(root, ['engine/cli/queue.mjs', 'add', 'upstream'])
    runNode(root, ['engine/cli/queue.mjs', 'add', 'downstream'])
    runNode(root,
      ['engine/cli/queue.mjs', 'link', 'upstream', 'downstream', '--relation', 'blocks'])
    const r = runNode(root, ['engine/cli/queue.mjs', 'ready'])
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/Held by upstream/)
    expect(r.stdout).toContain('downstream')
    expect(r.stdout).toContain('upstream')
    expect(r.stdout).toMatch(/blocks/)
  })

  it('graph --json emits edges + per-node effective_status', () => {
    const root = createTempRepo()
    installAll(root)
    runNode(root, ['engine/cli/queue.mjs', 'add', 'upstream'])
    runNode(root, ['engine/cli/queue.mjs', 'add', 'downstream'])
    runNode(root,
      ['engine/cli/queue.mjs', 'link', 'upstream', 'downstream', '--relation', 'blocks'])
    const r = runNode(root, ['engine/cli/queue.mjs', 'graph', '--json'])
    expect(r.status).toBe(0)
    const parsed = JSON.parse(r.stdout)
    expect(parsed.edges).toHaveLength(1)
    expect(parsed.edges[0]).toMatchObject({ relation: 'blocks', from: 'upstream', to: 'downstream' })
    const downstream = parsed.nodes.find((n: { slug: string }) => n.slug === 'downstream')
    expect(downstream.status).toBe('Pending')
    expect(downstream.effective_status).toBe('Blocked')
  })
})
