# Plan — collab platform

> Living document. Tracks commit sequence + status. Architecture canon lives
> in `DESIGN.md`. Update status as commits land; don't delete history.
> Last revised: 2026-05-02.

## Scope shift — MVP first

Parent project's work is stalled waiting on this engine. **Goal: ship the
minimum that unblocks them.** Full vision (`DESIGN.md`) stays the north
star, but execution focuses on MVP. Everything not in MVP is `[v2]` —
namespace reserved per `DESIGN.md` so v2 lands without schema migrations.

## Status legend

- `[mvp]` — in MVP scope, locked, ready to start
- `[wip]` — currently in progress
- `[done]` — committed
- `[blocked]` — needs decision
- `[v2]` — out of MVP scope; namespace/schema reserved per `DESIGN.md`

## MVP commit sequence

Each commit must leave `npm test` + `npm run typecheck` green. Each
updates this file's status + revision log.

| # | Title | Status | Notes |
|---|---|---|---|
| C0 | **Lock design + plan docs** | `[mvp]` | Commit `DESIGN.md` + `PLAN.md` so any agent surviving session break has the canon. Prerequisite for everything else. |
| C1 | **Universal driver terms** | `[mvp]` | Add CLI `--model` / `--effort` / `--sandbox` / `--tools` / `--permission-mode` on `run.mjs` / `spawn.mjs`. Drivers translate to engine-native flags. Deprecate `--codex-effort` (alias for `--effort` with warning). Frontmatter: `model` / `effort` etc. as canon; `codex-model` / `codex-effort` / `copilot-model` / `copilot-tools` read with deprecation warning. Drivers without an analog → silent ignore, document in driver header. |
| C2 | **Cluster identity + schema baseline** | `[mvp]` | `engine/init.mjs` (idempotent) generates `.collab/cluster.json` with `cluster_id` (UUID v7), `name`, `created_at`. `instance_id` regenerated per process start. Every event carries `schema` / `kind` / `type` / `id` / `at` / `cluster_id` / `instance_id`. Validator rejects unknown `kind` (allowed: `workload`/`infra`/`signal`/`control`). Reserve `control.*` and `signal.*` type prefixes — validator knows reserved set, future control-events land without schema bump. Add `fence_token` (number, default 0) to node-mutating workload events; no enforcement yet. |
| C3 | **Tracing** | `[mvp]` | `dispatch_id` (UUID v7) + `trace_id` (root chain) + `parent_dispatch_id` + `parent_role` on events. Env vars `COLLAB_DISPATCH_ID` / `COLLAB_TRACE_ID` / `COLLAB_PARENT_DISPATCH_ID` / `COLLAB_PARENT_ROLE` propagated by `run.mjs` to child. Top-level dispatch (chat) → env unset → no parent. |
| C4 | **Event rename + back-compat read** | `[mvp]` | Write side emits `dispatch.start` / `dispatch.end` (was `claim` / `release`). Read side accepts both names for one cycle. Existing `events.jsonl` from old runs remains valid. |
| C5 | **Driver usage capture** | `[mvp]` | Each driver exports `parseUsage(outPath, sessionId) → {tokens_in, tokens_out, cache_read, cache_creation, cost_usd, model} | null`. Lifecycle merges into `dispatch.end` + `.meta`. Cost = whatever provider reports (no internal pricing). |
| C6 | **Retry tracking + `signal.backoff_required`** | `[mvp]` | `dispatch.start` carries `retry_of` / `retry_count` / `retry_reason`. Counter inc only when prev `engine`+`model` == new (different = reset). Computed engine-side in `markRunning`. CLI: `spawn.mjs --retry-of <prev_dispatch_id>`. Threshold `retry_count >= 3` (default) → emit `signal.backoff_required`. |
| C7 | **Sub-role checkpoint API** | `[mvp]` | `engine/checkpoint.mjs` CLI. Reads `COLLAB_TASK` / `COLLAB_ROLE` / `COLLAB_DISPATCH_ID` / `COLLAB_TRACE_ID` from env. Args: `--completed` / `--next` / `--artefact?` / `--notes?`. Emits `checkpoint` event. Role briefs add explanatory paragraph. Tool surface for relevant roles adds `Bash(node $COLLAB_HOME/engine/checkpoint.mjs *)`. |
| C8 | **Role dispatch policies** | `[mvp]` | Frontmatter `dispatchable: all | <list>` (allowlist) + `non-dispatchable: <list>` (denylist). Defaults: `dispatcher`=all; `orchestrator`=all\\orchestrator; leaf roles (`implementer`/`architect`/`cold-reader`/`adversary`/`maintainer`)=none. Guard in `spawn.mjs` / `run.mjs` reads `COLLAB_PARENT_ROLE` env and validates. Throw before side-effects on violation. |
| C9 | **`status.mjs` / `state_gen.mjs` minimal update** | `[mvp]` | Render usage (tokens / cost / duration), retry chain, cluster_id, trace grouping. No queue-graph projection in MVP — flat queue stays. |
| C10 | **`MIGRATION.md` for parent project** | `[mvp]` | Enumerate breaking changes for consumer upgrade: universal-term frontmatter rename (with deprecation window), event-type rename (with back-compat window), new env vars (auto-set, no consumer action), new tool surface for sub-roles (consumer must add to role files), new reserved frontmatter keys (`dispatchable`/`non-dispatchable`), new `.collab/cluster.json` requirement (`engine/init.mjs` handles bootstrap). |

## Out of MVP — v2 (namespace reserved)

Schema fields and type prefixes for these already reserved in C2 — adding
implementations later requires no migration.

| # | Title | Status | Why deferred |
|---|---|---|---|
| V1 | Repository abstraction + non-fs backends | `[v2]` | Refactor; fs behavior works for parent project today. |
| V2 | Queue graph model | `[v2]` | Flat sections in `QUEUE.md` cover parent project's flow. |
| V3 | Pipeline registry + engine | `[v2]` | Orchestrator does flow-routing in-LLM today. Formalisation post-MVP. |
| V4 | Capability manifest + federation | `[v2]` | Parent project is single-cluster. |
| V5 | Real claim/lease + fence enforcement | `[v2]` | Federation-only. Field reserved in C2; enforcement follows. |
| V6 | Driver `api_version` + plug-in overlay loader | `[v2]` | Current 3 drivers in-tree suffice. |
| V7 | Infra reconcile pass + availability events | `[v2]` | `cluster.heartbeat` ships in C2; `role.*` / `engine.*` lifecycle events when needed. |
| V8 | Replay tooling | `[v2]` | Debugging convenience; not blocker. |
| V9 | Mid-run heartbeats from lifecycle | `[v2]` | Checkpoint API covers observability gap. |

## Open questions — defaults locked

Owner answered "Ok" + MVP-pivot on 2026-05-02 → defaults locked:

| # | Question | Locked answer |
|---|---|---|
| Q1 | Markdown queue/journal hybrid vs always-projection | hybrid (fs primary; v2 backends render projection) |
| Q2 | Default retry threshold for `signal.backoff_required` | 3 |
| Q3 | Default lease TTL (v2) | 5 minutes |
| Q4 | Reserve more `signal.*` types now? | reserve the 5 named in `DESIGN.md` §4.6 |

## Working agreements

- Each commit must leave `npm test` + `npm run typecheck` green.
- Each commit updates this file's status + adds revision log entry.
- Schema-affecting commits update `DESIGN.md` taxonomy section.
- No commit lands `master` directly. Owner commits per `AGENTS.md`.
- Commits stay narrow — one logical change per commit.
- Pre-existing `events.jsonl` / `.meta` from old code remain readable through MVP transition (back-compat read for one cycle, stripped in v2).

## Revision log

- **2026-05-02** — MVP carve. Phase reshape under parent-project urgency.
  Phases 0–5 from prior plan compressed to C0–C10. Phase 6 + heavier
  refactors moved to `[v2]` with namespaces reserved. Defaults locked
  for Q1–Q4.
- **2026-05-02** — Initial plan draft. Phases 0–5 locked, Phase 6
  deferred with namespaces reserved. Open Q1–Q4 awaiting owner.
