---
schema: skill-v1
version: 1
updated_at: 2026-05-03T00:00:00.000Z
description: Run the project's tests + arbitrary `<pkg-mgr> run` scripts. **Project-specific** — override in .artel/skills/.
tools: Bash(npm test*), Bash(npm run *)
---

> v1 · updated 2026-05-03

Default ships with `npm test` / `npm run` patterns. Override in
`.artel/skills/test-runner.md` for non-npm stacks (e.g.,
`Bash(bun test*)`, `Bash(pytest*)`, `Bash(cargo test*)`).
