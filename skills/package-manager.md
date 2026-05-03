---
schema: skill-v1
version: 1
updated_at: 2026-05-03T00:00:00.000Z
description: Project's package manager invocations. **Project-specific** — override in .artel/skills/.
tools: Bash(npm install*), Bash(npm ci*), Bash(npm ls*)
---

> v1 · updated 2026-05-03

Default ships with `npm` patterns since the platform itself is
npm-based. **Override in `.artel/skills/package-manager.md`** for
projects on bun / pnpm / yarn / cargo / pip / go-modules / etc.
Roles reference this skill by name; the override updates all roles
without touching role files.
