---
schema: skill-v1
version: 1
updated_at: 2026-05-03T00:00:00.000Z
description: Run Node.js scripts. Project-specific — override in .artel/skills/ for non-Node stacks.
tools: Bash(node *)
---

> v1 · updated 2026-05-03

Generic `node` invocation. Replace this skill in a project's
`.artel/skills/` if the project doesn't use Node (or rename and
declare `python-runtime` / `go-runtime` / etc. on roles).
