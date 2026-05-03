---
schema: skill-v1
version: 1
updated_at: 2026-05-03T00:00:00.000Z
description: Modify working tree, branches, and stage area. Excludes commit / push / merge — those remain owner-only.
tools: Bash(git diff*), Bash(git status*), Bash(git log*), Bash(git show*), Bash(git blame*), Bash(git checkout*), Bash(git add*), Bash(git branch*), Bash(git stash*), Bash(git rebase*)
---

> v1 · updated 2026-05-03

Read-write git operations short of `commit` / `push` / `merge`. The
master-branch boundary is owner-only (AGENTS.md§Branching) — sub-roles
prepare changes in the working tree on agent branches; the human
commits.
