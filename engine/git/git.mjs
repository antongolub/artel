// Git context + delta helpers for dispatch telemetry (DESIGN V10).
//
// All exports tolerate non-git directories and missing `git` on PATH —
// they return `null` rather than throwing. Callers persist what's
// available; dispatchers without git context just emit events without
// the `git` / `delta` keys.

import { execFileSync } from 'node:child_process'
import { basename } from 'node:path'

const GIT_TIMEOUT_MS = 1000

const tryGit = (cwd, args) => {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return null
  }
}

// Strip the URL down to `owner/repo`. Handles SSH (`git@host:path.git`),
// HTTPS (`https://host/path[.git]`), and other forms. Returns null if no
// owner/repo shape can be extracted — caller can fall back to dir name.
export const repoNameFromRemote = (url) => {
  if (!url) return null
  // SSH:    git@github.com:owner/repo(.git)?
  let m = url.match(/^[^@]+@[^:]+:([^/]+\/[^/.]+)(?:\.git)?$/)
  if (m) return m[1]
  // HTTPS / git protocol: <scheme>://[user@]host[:port]/owner/repo(.git)?
  m = url.match(/^[a-z]+:\/\/[^/]+\/(.+?)(?:\.git)?\/?$/)
  if (m) {
    const path = m[1]
    // Trim to last two segments — handles GitLab nested groups and
    // path-prefixed forwards.
    const parts = path.split('/').filter(Boolean)
    if (parts.length >= 2) return parts.slice(-2).join('/')
  }
  return null
}

// Snapshot of the project's git context at a point in time. Returns
// `{ commit_sha, branch, repo_name }` or `null` if the directory isn't a
// git working tree.
export const gitContext = (cwd) => {
  const sha = tryGit(cwd, ['rev-parse', 'HEAD'])
  if (!sha) return null
  const branch = tryGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const remote = tryGit(cwd, ['remote', 'get-url', 'origin'])
  const repo_name = repoNameFromRemote(remote) || basename(cwd)
  return {
    commit_sha: sha,
    branch: branch || null,
    repo_name,
  }
}

// Cumulative diff from `fromSha` to current working tree (committed +
// uncommitted, tracked files only). Returns
// `{ files_changed, lines_added, lines_removed }` or `null` if the diff
// can't be computed (e.g. not a git repo, fromSha unreachable). Untracked
// files are not counted — they surface in `git status` separately.
export const gitDelta = (cwd, fromSha) => {
  if (!fromSha) return null
  const out = tryGit(cwd, ['diff', '--shortstat', fromSha])
  if (out === null) return null
  if (out === '') return { files_changed: 0, lines_added: 0, lines_removed: 0 }
  // Examples shortstat outputs:
  //   ` 3 files changed, 12 insertions(+), 5 deletions(-)`
  //   ` 1 file changed, 4 insertions(+)`
  //   ` 1 file changed, 2 deletions(-)`
  const m = out.match(/(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/)
  if (!m) return null
  return {
    files_changed: Number(m[1]) || 0,
    lines_added: Number(m[2]) || 0,
    lines_removed: Number(m[3]) || 0,
  }
}
