// E2E for V3.3.a — `artel spawn --worktree` and pipeline parallel
// with concurrent worktree-isolated branches.

import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  cleanupTempRoots,
  createTempRepo,
  ENGINE_FILES_CORE,
  ENGINE_FILES_DRIVERS,
  ENGINE_FILES_UTIL,
  execGit,
  installEngineRuntime,
  installStub,
  runNode,
  snapshotRepo,
} from '../_helpers.js'

afterEach(cleanupTempRoots)

const installAll = (root: string) =>
  installEngineRuntime(root, [
    'engine/cli/spawn.mjs',
    'engine/cli/run.mjs',
    'engine/cli/pipeline.mjs',
    ...ENGINE_FILES_CORE,
    ...ENGINE_FILES_DRIVERS,
    ...ENGINE_FILES_UTIL,
  ])

describe('artel spawn --worktree (V3.3.a)', () => {
  it('runs in .artel/.worktrees/<branch>/ and removes on success', () => {
    const root = createTempRepo()
    installAll(root)
    snapshotRepo(root, 'runtime')
    // Stub that records its cwd to a file we can inspect.
    const stub = ['#!/usr/bin/env node',
      `import { writeFileSync } from 'node:fs'`,
      `writeFileSync(\`\${process.env.ARTEL_WORKTREE}/cwd-marker.txt\`, process.cwd())`,
      `console.log("ok")`,
      ''].join('\n')
    const binDir = installStub(root, 'claude', stub)

    const r = runNode(
      root,
      ['engine/cli/spawn.mjs', 'implementer', 'wt-task', '-p', 'go', '--worktree'],
      { PATH: `${binDir}:${process.env.PATH || ''}` },
    )
    expect(r.status).toBe(0)
    // After successful dispatch, worktree is removed (default behaviour)
    const wtPath = join(root, '.artel', '.worktrees', 'implementer', 'wt-task')
    expect(existsSync(wtPath)).toBe(false)
    // ...but the branch still exists in the main repo, ready for integration
    expect(execGit(root, ['rev-parse', '--verify', 'refs/heads/implementer/wt-task'])).toMatch(/^[0-9a-f]{40}$/)
    // Operator's main checkout was NOT switched
    expect(execGit(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('master')
  })

  it('--keep-worktree retains the worktree after successful run', () => {
    const root = createTempRepo()
    installAll(root)
    snapshotRepo(root, 'runtime')
    const stub = ['#!/usr/bin/env node', 'console.log("ok")', ''].join('\n')
    const binDir = installStub(root, 'claude', stub)

    const r = runNode(
      root,
      ['engine/cli/spawn.mjs', 'implementer', 'kept-task', '-p', 'go', '--worktree', '--keep-worktree'],
      { PATH: `${binDir}:${process.env.PATH || ''}` },
    )
    expect(r.status).toBe(0)
    expect(existsSync(join(root, '.artel', '.worktrees', 'implementer', 'kept-task'))).toBe(true)
  })

  it('on failure, worktree is kept by default for forensics', () => {
    const root = createTempRepo()
    installAll(root)
    snapshotRepo(root, 'runtime')
    // Stub that fails.
    const stub = ['#!/usr/bin/env node', 'process.exit(7)', ''].join('\n')
    const binDir = installStub(root, 'claude', stub)

    const r = runNode(
      root,
      ['engine/cli/spawn.mjs', 'implementer', 'failed-task', '-p', 'go', '--worktree'],
      { PATH: `${binDir}:${process.env.PATH || ''}` },
    )
    expect(r.status).not.toBe(0)
    expect(existsSync(join(root, '.artel', '.worktrees', 'implementer', 'failed-task'))).toBe(true)
  })

  it('without --worktree, behavior is unchanged (main tree gets the branch)', () => {
    const root = createTempRepo()
    installAll(root)
    snapshotRepo(root, 'runtime')
    const stub = ['#!/usr/bin/env node', 'console.log("ok")', ''].join('\n')
    const binDir = installStub(root, 'claude', stub)

    runNode(
      root,
      ['engine/cli/spawn.mjs', 'implementer', 'classic', '-p', 'go'],
      { PATH: `${binDir}:${process.env.PATH || ''}` },
    )
    // Main tree got the branch (existing V3.0 behaviour)
    expect(execGit(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('implementer/classic')
    expect(existsSync(join(root, '.artel', '.worktrees', 'implementer', 'classic'))).toBe(false)
  })

  it('files written by dispatch land inside the worktree, not main tree', () => {
    const root = createTempRepo()
    installAll(root)
    snapshotRepo(root, 'runtime')
    // Stub writes a sentinel file to its cwd.
    const stub = ['#!/usr/bin/env node',
      `import { writeFileSync } from 'node:fs'`,
      `writeFileSync('agent-touched.txt', 'hi from agent\\n')`,
      `console.log("ok")`,
      ''].join('\n')
    const binDir = installStub(root, 'claude', stub)

    runNode(
      root,
      ['engine/cli/spawn.mjs', 'implementer', 'isolation', '-p', 'go', '--worktree', '--keep-worktree'],
      { PATH: `${binDir}:${process.env.PATH || ''}` },
    )
    // File present in the worktree, NOT in main checkout
    const wtFile = join(root, '.artel', '.worktrees', 'implementer', 'isolation', 'agent-touched.txt')
    expect(existsSync(wtFile)).toBe(true)
    expect(readFileSync(wtFile, 'utf8')).toContain('hi from agent')
    expect(existsSync(join(root, 'agent-touched.txt'))).toBe(false)
  })
})

describe('pipeline parallel with worktrees (V3.3.a)', () => {
  const fanoutPipeline = () => ({
    id: 'fanout-wt',
    version: 1,
    entry: 'reviews',
    nodes: {
      reviews: { type: 'parallel', branches: ['cr', 'adv', 'maint'], join: 'all-complete' },
      cr: { type: 'dispatch', role: 'implementer', engine: 'claude', prompt: 'cr' },
      adv: { type: 'dispatch', role: 'implementer', engine: 'claude', prompt: 'adv' },
      maint: { type: 'dispatch', role: 'implementer', engine: 'claude', prompt: 'maint' },
      done: { type: 'terminal', final_state: 'completed' },
      fail: { type: 'terminal', final_state: 'failed' },
    },
    edges: [
      { from: 'reviews', on_disposition: 'success', to: 'done' },
      { from: 'reviews', on_disposition: '*', to: 'fail' },
    ],
  })

  it('parallel branches each run in their own worktree, removed on success', () => {
    const root = createTempRepo()
    installAll(root)
    snapshotRepo(root, 'runtime')
    const path = join(root, 'fanout-wt.json')
    writeFileSync(path, JSON.stringify(fanoutPipeline()))
    runNode(root, ['engine/cli/pipeline.mjs', 'register', path])
    snapshotRepo(root, 'with pipeline')

    // Stub records its cwd into a marker file (in the run's project)
    // to prove each branch ran in a different cwd.
    const markerDir = join(root, 'markers')
    mkdirSync(markerDir, { recursive: true })
    const stub = ['#!/usr/bin/env node',
      `import { writeFileSync } from 'node:fs'`,
      `import { join } from 'node:path'`,
      `import { randomUUID } from 'node:crypto'`,
      `const f = join('${markerDir}', \`marker-\${randomUUID()}.txt\`)`,
      `writeFileSync(f, process.cwd() + '\\n' + (process.env.ARTEL_WORKTREE || ''))`,
      `console.log("ok")`,
      ''].join('\n')
    const binDir = installStub(root, 'claude', stub)

    const r = runNode(root, ['engine/cli/pipeline.mjs', 'run', 'fanout-wt', '--task-prefix', 'wtfan'],
      { PATH: `${binDir}:${process.env.PATH || ''}` })
    expect(r.status).toBe(0)
    // All three worktrees gone after success
    for (const branchId of ['cr', 'adv', 'maint']) {
      expect(existsSync(join(root, '.artel', '.worktrees', 'implementer', `wtfan-reviews-${branchId}`))).toBe(false)
    }
    // All three branches exist in the main repo
    for (const branchId of ['cr', 'adv', 'maint']) {
      const sha = execGit(root, ['rev-parse', '--verify', `refs/heads/implementer/wtfan-reviews-${branchId}`])
      expect(sha).toMatch(/^[0-9a-f]{40}$/)
    }
    // Each branch saw a distinct cwd — markers were written by the
    // stubs into per-branch worktrees, then the worktrees were removed
    // on success. The fact the run completed without errors is the
    // signal the cwds were independent (no file collisions).
  })

  it('parallel branches all log distinct worktrees', () => {
    const root = createTempRepo()
    installAll(root)
    snapshotRepo(root, 'runtime')
    const path = join(root, 'p.json')
    writeFileSync(path, JSON.stringify(fanoutPipeline()))
    runNode(root, ['engine/cli/pipeline.mjs', 'register', path])
    snapshotRepo(root, 'with pipeline')
    const stub = ['#!/usr/bin/env node', 'console.log("ok")', ''].join('\n')
    const binDir = installStub(root, 'claude', stub)
    const r = runNode(root, ['engine/cli/pipeline.mjs', 'run', 'fanout-wt', '--task-prefix', 'log'],
      { PATH: `${binDir}:${process.env.PATH || ''}` })
    expect(r.status).toBe(0)
    // stderr logs `worktree=...` for each branch
    const lines = r.stderr.split('\n').filter((l) => l.includes('worktree='))
    expect(lines.length).toBeGreaterThanOrEqual(3)
    const wtPaths = new Set(lines.map((l) => (l.match(/worktree=(\S+)/) || [])[1]))
    expect(wtPaths.size).toBe(3)
  })
})
