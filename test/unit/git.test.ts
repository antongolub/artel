// Unit tests for engine/git/git.mjs — pure helpers used by dispatch
// telemetry (V10).

import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as gitModule from '../../engine/git/git.mjs'
import { cleanupTempRoots, createTempRepo, execGit, snapshotRepo } from '../_helpers.js'

const { gitContext, gitDelta, repoNameFromRemote } = gitModule as {
  gitContext: (cwd: string) => { commit_sha: string; branch: string | null; repo_name: string } | null
  gitDelta: (cwd: string, fromSha: string) => { files_changed: number; lines_added: number; lines_removed: number } | null
  repoNameFromRemote: (url: string | null | undefined) => string | null
}

afterEach(cleanupTempRoots)

describe('repoNameFromRemote', () => {
  it.each([
    ['git@github.com:antongolub/artel.git', 'antongolub/artel'],
    ['git@github.com:antongolub/artel', 'antongolub/artel'],
    ['https://github.com/antongolub/artel.git', 'antongolub/artel'],
    ['https://github.com/antongolub/artel', 'antongolub/artel'],
    ['https://gitlab.com/group/sub/proj.git', 'sub/proj'],
    ['ssh://git@gitea.example/owner/proj', 'owner/proj'],
  ])('parses %s → %s', (url, expected) => {
    expect(repoNameFromRemote(url)).toBe(expected)
  })

  it.each([null, undefined, '', 'not-a-url', '/local/path'])(
    'returns null for non-URL input %s',
    (input) => {
      expect(repoNameFromRemote(input as unknown as string)).toBeNull()
    },
  )
})

describe('gitContext', () => {
  it('returns null in a non-git directory', () => {
    expect(gitContext('/tmp')).toEqual(expect.any(Object) as never)
    // /tmp may itself be inside a repo on some systems; use a path that
    // definitely is not.
    expect(gitContext('/nonexistent-123abc')).toBeNull()
  })

  it('captures commit_sha + branch + repo_name in a fresh repo', () => {
    const root = createTempRepo()
    // createTempRepo runs `git init -b master` and commits an initial tree.
    // Add an `origin` so repo_name comes from the remote, not the dir name.
    execGit(root, ['remote', 'add', 'origin', 'git@github.com:test-owner/test-repo.git'])
    const ctx = gitContext(root)
    expect(ctx).not.toBeNull()
    expect(ctx!.commit_sha).toMatch(/^[0-9a-f]{40}$/)
    expect(ctx!.branch).toBe('master')
    expect(ctx!.repo_name).toBe('test-owner/test-repo')
  })

  it('falls back to dir basename when no origin remote is set', () => {
    const root = createTempRepo()
    const ctx = gitContext(root)
    expect(ctx).not.toBeNull()
    expect(ctx!.repo_name).toMatch(/^artel-engine-test-/)
  })
})

describe('gitDelta', () => {
  it('returns zeroes when working tree matches start commit', () => {
    const root = createTempRepo()
    const start = execGit(root, ['rev-parse', 'HEAD'])
    expect(gitDelta(root, start)).toEqual({ files_changed: 0, lines_added: 0, lines_removed: 0 })
  })

  it('counts uncommitted working-tree changes against the start commit', () => {
    const root = createTempRepo()
    const start = execGit(root, ['rev-parse', 'HEAD'])
    writeFileSync(join(root, 'new-file.txt'), 'line1\nline2\nline3\n')
    execGit(root, ['add', 'new-file.txt'])
    const d = gitDelta(root, start)
    expect(d).not.toBeNull()
    expect(d!.files_changed).toBe(1)
    expect(d!.lines_added).toBe(3)
    expect(d!.lines_removed).toBe(0)
  })

  it('counts both committed and uncommitted changes since start', () => {
    const root = createTempRepo()
    const start = execGit(root, ['rev-parse', 'HEAD'])
    // Commit one change.
    writeFileSync(join(root, 'a.txt'), 'a1\na2\n')
    snapshotRepo(root, 'add a.txt')
    // Make another, uncommitted.
    writeFileSync(join(root, 'b.txt'), 'b1\nb2\nb3\n')
    execGit(root, ['add', 'b.txt'])
    const d = gitDelta(root, start)
    expect(d).not.toBeNull()
    expect(d!.files_changed).toBe(2)
    expect(d!.lines_added).toBe(5)
    expect(d!.lines_removed).toBe(0)
  })

  it('returns null for an unreachable sha', () => {
    const root = createTempRepo()
    expect(gitDelta(root, '0'.repeat(40))).toBeNull()
  })

  it('returns null when fromSha is empty/undefined', () => {
    const root = createTempRepo()
    expect(gitDelta(root, '')).toBeNull()
  })
})
