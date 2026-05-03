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
runtime** under `.artel/` (gitignored).

- `agents/<role>.md` — markdown role definitions. Frontmatter
  declares engine, model, sandbox, tool surface, dispatch policy.
  Body is the system prompt.
- `engine/` — dispatcher CLI. Reads a role, spawns the appropriate
  CLI agent as an OS subprocess, watchdogs the timeout, captures
  every boundary as a structured event.
- `.artel/` — `events.jsonl` (append-only event stream), per-task
  artefacts under `.dispatches/`, cluster identity, generated state.

Full architecture in [`DESIGN.md`](./DESIGN.md). Status per phase in
[`PLAN.md`](./PLAN.md).

## Try it

```bash
npm install -g @antongolub/artel

artel-init --name my-cluster
artel-run --list
artel-spawn implementer my-task --engine codex --effort high -p "ship the fixture"
artel-status --watch
```

Or clone the repo to read / hack the platform itself:

```bash
git clone https://github.com/antongolub/artel.git
ARTEL_HOME=$PWD/artel
node $ARTEL_HOME/engine/cli/init.mjs --name my-cluster
```

## Status

MVP. Single-cluster, single-host. Expect breakage, expect schema
evolution.

## License

[MIT](./LICENSE)
