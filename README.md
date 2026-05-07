# artel

> Multi-agent orchestration research. A thin coordination layer for
> CLI-based agents. Exploratory; not for production.

## The question

Can multi-agent coordination be built from mostly Unix-like primitives
— processes, files, append-only logs — and still get good ergonomics,
low latency, and a programming model that maps cleanly onto how
engineers already work with code?

Concretely: every action is a real OS process. Every state change is
one append to a file. Every history is replayable from a git log.
Every agent is a CLI tool, regardless of language or vendor. Every
cluster is federation-ready by default.

artel is the experiment that probes that question.

## What this is NOT

- **Workflow automation platform** (like [n8n](https://n8n.io)).
  Visual node editors, service integrations, browser UIs, persistent
  servers — different category. artel has none of those.
- **In-process agent framework** (LangGraph, CrewAI, AutoGen). Single
  runtime, in-memory actors — different design point. artel runs
  each dispatch as a separate OS process and coordinates through
  files and events.
- **Production tooling.** Schema and APIs change. Federation,
  repository abstraction, queue graph, pipelines — reserved in
  schema, not implemented.

## Design principles

- **Minimalism.** No framework, no DSL, no server, no build step.
- **Speed.** File appends are fast. Time-prefixed UUID v7 events sort
  without an index. Dispatch latency ≈ agent CLI startup.
- **Audit-friendly.** Every action is an event in `events.jsonl`.
  Git replays the full history.
- **Polyglot.** Any CLI is a candidate driver. Three ship in-tree
  (claude / codex / copilot); a new driver is ~50 lines.

## Architecture (sketch)

Two layers — a **shared platform** (this repo) and a **per-project
runtime** under `.artel/` (gitignored where it holds runtime state).

- `agents/<role>.md` — markdown role definitions. Frontmatter declares
  engine, model, sandbox, tool surface, dispatch policy, identity,
  required credentials. Body is the system prompt.
- `skills/<name>.md` — composable tool-surface fragments. Roles declare
  abstract `skills:`; projects override stack-specific patterns
  (`npm` → `bun`) without touching role files.
- `engine/` — dispatcher CLI. Reads a role, spawns the matching driver
  CLI as an OS subprocess, watchdogs the timeout, captures every
  boundary as a structured event. Drivers ship in-tree (claude / codex
  / copilot); custom drivers drop into `.artel/drivers/<name>.mjs`.
- `.artel/` — per-project runtime: `events.jsonl` (append-only event
  stream), per-task artefacts under `.dispatches/`, cluster identity,
  optional skill / driver overlays, optional truststore for agent git
  identities and credentials.

Full architecture in [`DESIGN.md`](./DESIGN.md). Status per phase in
[`PLAN.md`](./PLAN.md). Schema migration notes in
[`MIGRATION.md`](./MIGRATION.md) (handoff-only, regenerated per
upgrade cycle).

## CLI

```
artel <init | probe | run | spawn | status | logs | events | replay | trust | queue | pipeline | sweep | checkpoint>
```

| command | what it does |
|---|---|
| `init` | bootstrap `.artel/cluster.json` for a project |
| `probe` | engine readiness — binary on PATH, version, auth state, optional live roundtrip |
| `run` | dispatch a role one-shot (low-level) |
| `spawn` | dispatch with task sidecar + branch + timeout |
| `status` | cluster snapshot or live dashboard (FEED · RUNNING · RECENT · ACTIVITY · QUEUE · TOKENS) |
| `logs <task>` | drill into a single dispatch (meta + events + prompt + out) |
| `events` | tail / filter the event stream — `--task` `--trace` `--kind` `--type` `--since` `-f` |
| `replay <task | dispatch-id>` | re-run a past dispatch on the same or a different engine |
| `trust` | inspect / manage agent identities, credentials, SSH keys, encryption |
| `queue` | inspect / mutate `.artel/QUEUE.md` + edges — `list / add / move / done / rm / link / unlink / ready / graph` |
| `pipeline` | declarative flows — `register / list / show / run` |
| `sweep` | prune old `.dispatches/` artefacts (keeps active + newest `--keep`) |
| `checkpoint` | sub-role self-report between phases |

Run `artel <cmd> --help` for command-specific options.

## Try it

```bash
npm install -g @antongolub/artel

# 1. Bootstrap the project's runtime
artel init --name my-cluster

# 2. Verify engines are reachable + authed
artel probe

# 3. Dispatch
artel spawn implementer my-task --engine codex --effort high -p "ship the fixture"

# 4. Watch live
artel status --watch
artel events -f --task my-task

# 5. Drill in when something fails
artel logs my-task

# 6. Re-run on a different engine
artel replay my-task --engine claude
```

Or clone the repo to read / hack the platform itself:

```bash
git clone https://github.com/antongolub/artel.git
ARTEL_HOME=$PWD/artel
node $ARTEL_HOME/engine/cli/artel.mjs init --name my-cluster
```

A copy-and-go template lives in [`examples/quickstart/`](./examples/quickstart/)
— minimal `package.json`, `.gitignore`, `.artel/QUEUE.md` skeleton,
plus a walkthrough of init → probe → spawn → status → logs → replay.

### Optional: truststore for agent identity + secrets

Separate agent-made commits from your operator identity. Inject API
tokens into the dispatch env without exposing them in the repo or
shell history.

```bash
artel trust set-identity bot --author "artel-bot <bot@cluster.local>"
artel trust gen-ssh bot | gh repo deploy-key add - --title "artel-bot"
op read 'op://Personal/GitHub/token' | artel trust set-credential GITHUB_TOKEN

# Roles declare what they want via frontmatter:
#   identity: bot
#   requires: GITHUB_TOKEN

# Optional encryption at rest (AES-256-GCM, master key outside the repo):
artel trust gen-key
artel trust encrypt
```

## Status

MVP. Single-cluster, single-host. Expect breakage, expect schema
evolution.

## License

[MIT](./LICENSE)
