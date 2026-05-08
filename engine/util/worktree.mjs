// Git worktree helpers (V3.3.a).
//
// A worktree gives a dispatch its own checkout of an agent branch
// without touching the operator's main working tree. This unlocks two
// things:
//   1. Isolation — operator can keep editing in their main checkout
//      while a dispatch runs.
//   2. True concurrency — pipeline `parallel` branches each get a
//      separate working tree, so they don't race on file state.
//
// Worktrees live under `.artel/.worktrees/<branch>/`. Cleanup is the
// caller's responsibility — dispatchLifecycle removes on success and
// keeps on failure (forensics). `artel sweep` (future) can prune
// orphans.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

const WORKTREES_REL = ['.artel', '.worktrees']

// Resolve where a branch's worktree lives. Slashes in branch names
// (`implementer/task-x`) become directory nesting — that's fine; git
// handles it. Caller mkdir-p's parents.
export const worktreeDir = (projectDir, branch) =>
  join(projectDir, ...WORKTREES_REL, branch)

const gitText = (gitImpl, args) => {
  const r = gitImpl(args)
  return {
    status: r.status,
    stdout: typeof r.stdout === 'string' ? r.stdout : r.stdout?.toString('utf8') || '',
    stderr: typeof r.stderr === 'string' ? r.stderr : r.stderr?.toString('utf8') || '',
  }
}

// Default git invoker — `git` in the project dir, sync, captured.
// Tests inject their own to avoid hitting real git.
export const defaultGit = (projectDir) =>
  (args) => {
    try {
      const out = execFileSync('git', args, {
        cwd: projectDir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      return { status: 0, stdout: out, stderr: '' }
    } catch (err) {
      return {
        status: err.status ?? 1,
        stdout: err.stdout?.toString('utf8') || '',
        stderr: err.stderr?.toString('utf8') || err.message,
      }
    }
  }

// Create / reset a branch at HEAD without touching the main working
// tree, then add a worktree at the requested path checked out to that
// branch. Returns the worktree path. Throws on git failure with the
// captured stderr in the message.
export const createWorktreeForBranch = (projectDir, branch, gitImpl) => {
  const path = worktreeDir(projectDir, branch)

  // If a stale worktree exists at this path (left from a prior crash
  // or `artel sweep` not run), remove it first so `add` doesn't fail.
  if (existsSync(path)) {
    const removed = gitText(gitImpl, ['worktree', 'remove', '--force', path])
    // Worktrees git doesn't know about may not be removable — fall
    // back to plain rmdir attempt; if that fails, surface to caller.
    if (removed.status !== 0 && existsSync(path)) {
      throw new Error(
        `worktree: stale path ${path} could not be cleaned up: ${removed.stderr}`,
      )
    }
  }

  // Create or reset the branch at HEAD (without checking it out in
  // the main working tree). `git branch -f <branch> HEAD` is the
  // worktree-friendly equivalent of `git checkout -B <branch>`.
  const setBranch = gitText(gitImpl, ['branch', '-f', branch, 'HEAD'])
  if (setBranch.status !== 0) {
    throw new Error(`worktree: git branch -f ${branch} failed:\n${setBranch.stderr}`)
  }

  // Ensure parent dir exists (worktree paths can include slashes from
  // role names; git won't mkdir-p the parents).
  mkdirSync(dirname(path), { recursive: true })

  const add = gitText(gitImpl, ['worktree', 'add', path, branch])
  if (add.status !== 0) {
    throw new Error(`worktree: git worktree add ${path} ${branch} failed:\n${add.stderr}`)
  }
  return path
}

// Remove the worktree at `path`. `--force` so locally-modified files
// don't block cleanup. Idempotent — silently succeeds if the path
// is already gone.
export const removeWorktree = (path, gitImpl) => {
  if (!existsSync(path)) return
  const r = gitText(gitImpl, ['worktree', 'remove', '--force', path])
  if (r.status !== 0) {
    // Don't throw — cleanup failures shouldn't bring down dispatch
    // post-processing. Caller logs.
    return { ok: false, stderr: r.stderr }
  }
  return { ok: true }
}

// List paths of all worktrees git knows about for this project. Output
// is `git worktree list --porcelain` parsed minimally. Used by sweep
// to find orphans.
export const listWorktrees = (projectDir, gitImpl = defaultGit(projectDir)) => {
  const r = gitText(gitImpl, ['worktree', 'list', '--porcelain'])
  if (r.status !== 0) return []
  const out = []
  let cur = null
  for (const line of r.stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (cur) out.push(cur)
      cur = { path: line.slice('worktree '.length).trim() }
    } else if (line.startsWith('branch ') && cur) {
      cur.branch = line.slice('branch refs/heads/'.length).trim()
    }
  }
  if (cur) out.push(cur)
  return out
}
