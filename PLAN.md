# Plan — collab platform v1 reshape

> Living document. Tracks commit sequence + status. Architecture lives
> in `DESIGN.md`. Update status as commits land; don't delete history.
> Last revised: 2026-05-02.

## Status legend

- `[locked]` — design agreed, ready to start
- `[wip]` — currently in progress
- `[done]` — committed
- `[blocked]` — needs decision (see *Open questions*)
- `[deferred]` — out of v1 scope; namespace reserved per DESIGN.md§13

## Phase 0 — foundations (must precede everything)

| # | Title | Status | Notes |
|---|---|---|---|
| 1 | **Universal terms** in drivers / CLI / frontmatter | `[locked]` | `model` / `effort` / `sandbox` / `tools` / `permission-mode`. Deprecate `codex-effort` / `codex-model` / `copilot-model` / `copilot-tools` for one cycle. CLI flag rename: `--codex-effort` → `--effort`. |
| 2 | **Repository abstraction + `fs` backend** | `[locked]` | Refactor `dispatch_api.mjs` / `dispatch_lifecycle.mjs` / `state_gen.mjs` / `status.mjs` / `parked.mjs` behind interface. Default backend = current fs behavior. Introduces mandatory event fields: `schema`, `kind`, `type`, `id`, `at`, `cluster_id`, `instance_id`. UUID v7 for ids. Reject unknown kinds/types via validator. |
| 3 | **Cluster identity bootstrap** | `[locked]` | `engine/init.mjs` generates `.collab/cluster.json` (cluster_id UUID v7 + name + created_at). `instance_id` regenerated per process start. Every event carries both. |

## Phase 1 — observability & tracing

| # | Title | Status | Notes |
|---|---|---|---|
| 4 | **Tracing (UUIDs + env propagation)** | `[locked]` | `dispatch_id`, `trace_id`, `parent_dispatch_id`, `parent_role`. Env vars `COLLAB_DISPATCH_ID` / `COLLAB_TRACE_ID` / `COLLAB_PARENT_DISPATCH_ID` / `COLLAB_PARENT_ROLE`. Propagated by `run.mjs` into child env. |
| 5 | **Usage capture in drivers** | `[locked]` | Each driver exports `parseUsage(outPath, sessionId) → {tokens_in, tokens_out, cache_read, cache_creation, cost_usd, model} | null`. Lifecycle merges into `dispatch.end` payload + `.meta`. Cost = provider-reported. |
| 6 | **Event rename + back-compat read** | `[locked]` | `claim` → `dispatch.start`, `release` → `dispatch.end`. Read-side accepts both names one cycle. Existing `events.jsonl` from older runs remains valid. |
| 7 | **Retry tracking** | `[locked]` | Fields on `dispatch.start`: `retry_of`, `retry_count`, `retry_reason`. Counter inc only when prev engine+model == new. CLI: `spawn.mjs --retry-of <prev_dispatch_id>`. Threshold N → emit `signal.backoff_required`. |
| 8 | **Sub-role self-reporting API** | `[locked]` | `engine/checkpoint.mjs` CLI shim. Tool surface addition for relevant roles: `Bash(node $COLLAB_HOME/engine/checkpoint.mjs *)`. Body paragraph in role briefs. Emits `checkpoint` event with `last_completed_step` / `next_safe_step`. |

## Phase 2 — coordination & policy

| # | Title | Status | Notes |
|---|---|---|---|
| 9 | **Role dispatch policies** | `[locked]` | Frontmatter keys `dispatchable` (allowlist or `all`) / `non-dispatchable` (denylist). Defaults: dispatcher=all; orchestrator=all\\orchestrator; leaf roles (implementer/architect/cold-reader/adversary/maintainer)=none. Guard in `spawn.mjs` / `run.mjs` reads `COLLAB_PARENT_ROLE`. |
| 10 | **Capability manifest** | `[locked]` | `.collab/cluster.json` content: id, name, exposed roles/engines/models, version, manifest_hash. Loader on init / per-reconcile. |
| 11 | **Reserve `control.*` namespace** | `[locked]` | Repository validator knows kinds `workload`/`infra`/`signal`/`control` and reserved type prefixes (`control.claim.*`, `control.offer.*`, `control.handoff.*`, `control.peer.*`). Unknown rejected. Implementations deferred. |
| 12 | **Fence token field in schema** | `[locked]` | `fence_token` (number, default 0 in v1) on every node-mutating workload event (`dispatch.start`, `queue_node.*`, etc.). Reserved for federation; backends record but no enforcement until claims implemented. |

## Phase 3 — graph + pipelines

| # | Title | Status | Notes |
|---|---|---|---|
| 13 | **Queue graph model** | `[locked]` | Events `queue_node.registered/updated/deregistered`, `queue_edge.registered/deregistered`. Edge types: `blocks`, `supersedes`, `parent_of`, `triggers`, `same_pipeline_run`, `derived_from`. Status sections in `QUEUE.md` become projections via `state_gen.mjs`. |
| 14 | **Pipeline registry** | `[locked]` | `.collab/pipelines/<id>.yaml` definition format (nodes / edges / entry / exits). Lifecycle events `pipeline.registered/updated/deregistered`. Loader + parser + validator. |
| 15 | **Pipeline engine** | `[locked]` | `engine/pipeline.mjs run/list/show`. Stateless reactor: triggers on `dispatch.end` / `signal.*` / periodic. Run events `pipeline_run.started/advanced/paused/resumed/completed/failed/aborted`. Run state reconstructible from events. |
| 16 | **Pipeline ↔ trace integration** | `[locked]` | Dispatches carry `pipeline_run_id` + `pipeline_node_id`. Trace tree shows pipeline → dispatches → checkpoints. |

## Phase 4 — infra reconcile + signals

| # | Title | Status | Notes |
|---|---|---|---|
| 17 | **Infra event taxonomy + reconcile pass** | `[locked]` | Lazy reconciliation at every `spawn.mjs` / `status.mjs` invocation: hash `agents/`, drivers, manifest; emit deltas (`role.registered/updated/deregistered`, `engine.registered/updated/deregistered`, `model.*`, `policy.updated`, `cluster.heartbeat`). No daemon. |
| 18 | **Signal kind taxonomy** | `[locked]` | Reserved types: `signal.backoff_required`, `signal.budget_exhausted`, `signal.review_required`, `signal.scope_drift`, `signal.cluster_unavailable_observed`. Emitters: lifecycle (backoff), pipeline engine (budget), reconciler (cluster_unavailable_observed). |
| 19 | **Runtime availability events** | `[locked]` | `engine.available/unavailable` (driver health probe at first use), `model.available/unavailable` (driver-emit on provider response: auth-expired / rate-limit / etc.). |

## Phase 5 — extensibility & adoption

| # | Title | Status | Notes |
|---|---|---|---|
| 20 | **Driver `api_version` + plug-in loader** | `[locked]` | Drivers export `api_version`. Loader scans `engine/drivers/` (platform) + `$COLLAB_HOME/.local/drivers/` (user) + `<projectDir>/.collab/drivers/` (project overlay). Same for roles: `agents/` + project's `.collab/agents/` overlay. |
| 21 | **Status / state_gen update for new fields** | `[locked]` | Render usage, retry_count, fence_token, pipeline_run_id, trace tree grouping. Computed `QUEUE.md` projection from graph events. |
| 22 | **Replay tooling** | `[locked]` | `engine/replay.mjs`: read events range, reconstruct trace tree / pipeline runs / queue state. Useful for debugging + post-mortem. |
| 23 | **Migration notes for consumer** | `[locked]` | `MIGRATION.md`: enumerate breaking changes for parent project consuming this engine. Universal-term frontmatter rename, event-type rename (with back-compat window), new env vars (auto-set), new tool surface for sub-roles, new reserved frontmatter keys (`dispatchable`/`non-dispatchable`). |

## Phase 6 — federation transports (deferred to v2)

| # | Title | Status | Notes |
|---|---|---|---|
| 24 | SQLite backend | `[deferred]` | Single-host high-throughput. |
| 25 | Git-shared backend | `[deferred]` | Federation via push/pull. |
| 26 | Postgres backend | `[deferred]` | Multi-cluster shared events. |
| 27 | HTTP backend | `[deferred]` | Remote Repository over REST/gRPC. |
| 28 | Real claim/lease implementation | `[deferred]` | `control.claim.*` event handlers; lease renewal loop; conflict detector with fence-token enforcement. |
| 29 | Capability-based routing | `[deferred]` | `control.offer.*` / `control.handoff.*` flows; capability matching against peer manifests. |
| 30 | Federation auth | `[deferred]` | Sign + verify events; cross-cluster trust model. |
| 31 | Discovery beyond static manifest | `[deferred]` | Gossip / DNS-style; auto-registration. |

## Open questions

| # | Question | Owner | Default if unresolved |
|---|---|---|---|
| Q1 | Markdown queue/journal: hybrid (fs primary) vs always-projection across backends? | owner | hybrid (fs primary, others projection) — current leaning |
| Q2 | Default retry threshold N before `signal.backoff_required`? | owner | 3 |
| Q3 | Default `lease_ttl_ms` for claims when implemented? | owner (v2) | 5 minutes |
| Q4 | Reserve more `signal.*` types now or add as needed? | owner | reserve the five already named; add as needed |

## Working agreements

- Each commit must leave `npm test` + `npm run typecheck` green.
- Each commit updates this file's status + adds revision log entry.
- Schema-affecting commits update `DESIGN.md` taxonomy section.
- No commit lands `master` directly. Owner commits per AGENTS.md.

## Revision log

- **2026-05-02** — Initial plan draft. Phases 0–5 locked, Phase 6
  deferred with namespaces reserved. Open Q1–Q4 awaiting owner.
