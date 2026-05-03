---
schema: skill-v1
version: 1
updated_at: 2026-05-03T00:00:00.000Z
description: Narrow surface to invoke `artel checkpoint` for sub-role self-reporting (DESIGN.md §9).
tools: Bash(artel checkpoint *), Bash(node *engine/cli/checkpoint.mjs*)
---

> v1 · updated 2026-05-03

Granted to roles that should report progress mid-dispatch but don't
need full `node-runtime`. Roles with `node-runtime` already cover this
via the broader `Bash(node *)` pattern and don't need to declare
`checkpoint` separately.
