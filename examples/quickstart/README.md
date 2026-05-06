# quickstart — minimal artel project

Copy-and-go template for a project that uses `@antongolub/artel` for
multi-agent orchestration. Walks through the canonical workflow:
init → probe → spawn → status → logs → replay.

## What's here

```
quickstart/
├── README.md                   ← this file
├── package.json                ← minimal
├── .gitignore                  ← ignores artel runtime + secrets
├── .artel/
│   └── QUEUE.md                ← starter work-queue skeleton
├── agents/                     ← role overrides (optional — uses
│                                  platform defaults if absent)
└── .artel/skills/              ← skill overrides for stack-specific
                                   tool patterns (optional)
```

## Setup

```bash
# 1. Install the platform globally (or use npx)
npm install -g @antongolub/artel

# 2. Bootstrap cluster identity
artel init --name quickstart

# 3. Verify engines
artel probe
```

Output should show one or more engines ready (`✓`). Missing or
unauthed engines display a hint per row — fix as needed before
dispatching.

## First dispatch

```bash
artel spawn implementer hello-task -p "echo hello world to stdout"
```

This:
- Pre-creates branch `implementer/hello-task` from the current HEAD
- Writes `.artel/.dispatches/hello-task.{prompt,meta,out}` sidecars
- Captures git context (commit_sha, branch, repo_name) on
  `dispatch.start`
- Spawns the role's engine driver as an OS subprocess
- On exit: appends `dispatch.end` event with disposition + delta

Tail the live event stream:

```bash
artel events -f --task hello-task
```

## When something fails

```bash
# Drill into one task — meta + events + prompt + .out in one view
artel logs hello-task

# Re-run on a different engine to compare
artel replay hello-task --engine claude

# Or check the cluster dashboard
artel status --watch
```

`artel status` shows: FEED · RUNNING · RECENT (with per-dispatch
duration + tokens + delta) · ACTIVITY (7d aggregates) · TIMED-OUT ·
PARKED · QUEUE · TOKENS (with auth-health markers).

## Optional: agent identity + secrets

If you want agent commits to land under a separate git identity (not
your personal one), or you need to inject API tokens into dispatches:

```bash
# 1. Register an agent identity
artel trust set-identity bot --author "artel-bot <bot@cluster.local>"

# 2. Generate a deploy key for it
artel trust gen-ssh bot | gh repo deploy-key add - --title "artel-bot"

# 3. Stash secrets the truststore knows about
op read 'op://Personal/GitHub/token' | artel trust set-credential GITHUB_TOKEN

# 4. Have roles declare what they want via frontmatter:
#    identity: bot
#    requires: GITHUB_TOKEN

# 5. (Optional) encrypt at rest
artel trust gen-key
artel trust encrypt
```

`artel trust list` shows what's registered (credential names — never
values). Each mutation appends an `infra` event to `events.jsonl` with
type `trust.*` for audit (also values-free).

## Customising tool surfaces

Default skills (`file-edit`, `git-write`, `package-manager`,
`test-runner`, ...) ship with the platform. To override
stack-specific bits, drop a file under `.artel/skills/`:

```yaml
# .artel/skills/package-manager.md
---
schema: skill-v1
version: 1
updated_at: 2026-05-04T00:00:00.000Z
description: Bun-based package manager invocations.
tools: Bash(bun install*), Bash(bun add*), Bash(bun remove*)
---
```

Every role using `package-manager` picks it up automatically. Same
precedence rules apply to drivers — drop `.artel/drivers/<name>.mjs`
for a custom engine; ~50 lines.

## Recording an asciinema demo

The walkthrough above is short enough to capture in 60–90 seconds:

```bash
asciinema rec quickstart.cast \
  --command 'artel init --name demo && artel probe && artel spawn implementer hello -p "echo hi" && artel status'
```

Upload to asciinema.org and embed in your project README.

## Next

- Customise `agents/<role>.md` for your project's specific roles
- Wire CI through GitHub Actions — see `.github/workflows/ci.yml` in
  the platform repo for a `zx-semrel + npm OIDC` template
- Read `MIGRATION.md` (in the platform repo) for the full upgrade
  log between versions
