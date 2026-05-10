// Unit tests for engine/git/worktree.mjs (V3.3.a).
//
// These exercise the helpers against the real `git` binary. Tests
// build a tiny repo via createTempRepo (already a real git repo with
// at least one commit), then create / list / remove worktrees in it.

import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as worktreeModule from '../../engine/git/worktree.mjs'
import { cleanupTempRoots, createTempRepo, execGit, snapshotRepo } from '../_helpers.js'

const {
  worktreeDir,
  defaultGit,
  createWorktreeForBranch,
  removeWorktree,
  listWorktrees,
} = worktreeModule as {
  worktreeDir: (projectDir: string, branch: string) => string
  defaultGit: (projectDir: string) => (args: string[]) => { status: number; stdout: string; stderr: string }
  createWorktreeForBranch: (projectDir: string, branch: string, gitImpl: ReturnType<typeof worktreeModule.defaultGit>) => string
  removeWorktree: (path: string, gitImpl: ReturnType<typeof worktreeModule.defaultGit>) => { ok: boolean; stderr?: string } | undefined
  listWorktrees: (projectDir: string, gitImpl?: ReturnType<typeof worktreeModule.defaultGit>) => { path: string; branch?: string }[]
}

afterEach(cleanupTempRoots)

describe('worktreeDir', () => {
  it('points at <project>/.artel/.worktrees/<branch>', () => {
    const root = createTempRepo()
    expect(worktreeDir(root, 'implementer/task-x'))
      .toBe(join(root, '.artel', '.worktrees', 'implementer', 'task-x'))
  })
})

describe('createWorktreeForBranch', () => {
  it('creates a worktree at the expected path with the branch checked out', () => {
    const root = createTempRepo()
    const path = createWorktreeForBranch(root, 'implementer/feature-x', defaultGit(root))
    expect(path).toBe(join(root, '.artel', '.worktrees', 'implementer', 'feature-x'))
    expect(existsSync(path)).toBe(true)
    // Worktree should be on the new branch
    const branch = execGit(path, ['rev-parse', '--abbrev-ref', 'HEAD'])
    expect(branch).toBe('implementer/feature-x')
    // Main checkout still on master, untouched
    expect(execGit(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('master')
  })

  it('resets an existing branch to current HEAD without losing history', () => {
    const root = createTempRepo()
    // First create-and-snapshot to give the branch some content
    createWorktreeForBranch(root, 'implementer/iter', defaultGit(root))
    // Modify on the branch via worktree, then advance master beyond it
    writeFileSync(join(root, 'new-on-master.txt'), 'main side\n')
    snapshotRepo(root, 'master moved')
    // Re-create — branch should reset to new HEAD
    const path = createWorktreeForBranch(root, 'implementer/iter', defaultGit(root))
    expect(existsSync(path)).toBe(true)
    expect(execGit(path, ['rev-parse', 'HEAD'])).toBe(execGit(root, ['rev-parse', 'HEAD']))
  })

  it('handles a stale worktree at the path by removing first', () => {
    const root = createTempRepo()
    createWorktreeForBranch(root, 'implementer/zombie', defaultGit(root))
    // Calling again should not throw (cleans up the existing one)
    expect(() => createWorktreeForBranch(root, 'implementer/zombie', defaultGit(root))).not.toThrow()
  })

  it('throws clearly when git fails (not a repo)', () => {
    const root = createTempRepo()
    // Fake git that always fails
    const failing = () => ({ status: 1, stdout: '', stderr: 'fatal: not a git repository' })
    expect(() => createWorktreeForBranch(root, 'implementer/x', failing as never))
      .toThrow(/git branch -f/)
  })
})

describe('removeWorktree', () => {
  it('removes an existing worktree; idempotent on missing', () => {
    const root = createTempRepo()
    const path = createWorktreeForBranch(root, 'implementer/transient', defaultGit(root))
    expect(existsSync(path)).toBe(true)
    const r = removeWorktree(path, defaultGit(root))
    expect(r?.ok).toBe(true)
    expect(existsSync(path)).toBe(false)
    // Calling again is a no-op (path already gone)
    expect(() => removeWorktree(path, defaultGit(root))).not.toThrow()
  })

  it('returns { ok: false } when git fails', () => {
    const root = createTempRepo()
    const path = createWorktreeForBranch(root, 'implementer/x', defaultGit(root))
    const failing = () => ({ status: 1, stdout: '', stderr: 'fatal: bad worktree' })
    const r = removeWorktree(path, failing as never)
    expect(r?.ok).toBe(false)
    expect(r?.stderr).toMatch(/bad worktree/)
  })
})

describe('listWorktrees', () => {
  it('lists the main checkout plus any artel worktrees', () => {
    const root = createTempRepo()
    createWorktreeForBranch(root, 'implementer/wt1', defaultGit(root))
    createWorktreeForBranch(root, 'adversary/wt2', defaultGit(root))
    const list = listWorktrees(root)
    // Each git worktree list entry has a `path`. We expect ≥3:
    // main + 2 added.
    expect(list.length).toBeGreaterThanOrEqual(3)
    const paths = list.map((w) => w.path)
    expect(paths.some((p) => p.endsWith('implementer/wt1'))).toBe(true)
    expect(paths.some((p) => p.endsWith('adversary/wt2'))).toBe(true)
  })

  it('returns [] for non-git directories', () => {
    const list = listWorktrees('/nonexistent-12345abc')
    expect(list).toEqual([])
  })
})

describe('multiple concurrent worktrees coexist', () => {
  it('can hold several siblings without conflict', () => {
    const root = createTempRepo()
    const paths = ['a', 'b', 'c'].map((id) =>
      createWorktreeForBranch(root, `implementer/${id}`, defaultGit(root)))
    for (const p of paths) {
      expect(existsSync(p)).toBe(true)
    }
    // Each on its own branch
    for (let i = 0; i < paths.length; i++) {
      const branch = execGit(paths[i], ['rev-parse', '--abbrev-ref', 'HEAD'])
      expect(branch).toBe(`implementer/${['a', 'b', 'c'][i]}`)
    }
    // Main checkout still on master
    expect(execGit(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('master')
  })
})
