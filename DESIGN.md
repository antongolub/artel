# Design — artel platform

> Living document. Source of truth for architecture through the v1 reshape.
> Update when decisions land; never delete history (use *Revision log* at end).
> Last revised: 2026-05-02.

## 1. Goals

- **Best multi-agent platform**: OS-native, polyglot, audit-friendly. Each
  dispatch is a real OS process; events are git-versionable; roles are
  markdown.
- **Extensible to any task level**: from one-shot prompts to multi-month
  pipelines with deep dispatch trees and parallel branches.
- **Pluggable everywhere**: drivers (engines), repositories (storage),
  agents (roles), pipelines (flows). No single hardcoded backend.
- **Cluster federation**: independent platform installs cooperate over a
  shared event stream.
- **Dynamic by default**: no platform-restart semantics. Every dispatch
  reconciles current state.

## 2. Core principles

- **Append-only events are source of truth.** Queue, dispatcher state,
  meta sidecars, capability manifest — all projections of `events`.
- **Markdown is a human surface, not storage.** `QUEUE.md` / `JOURNAL.md`
  / `state.md` are projections (or human-edit overlays in fs backend).
- **Process-per-dispatch.** No in-process actor system. Each role is a
  CLI invocation with isolated tool surface and sandbox.
- **Driver-contract isolates engine specifics.** Runners (`run.mjs`,
  `spawn.mjs`, `dispatch_lifecycle.mjs`) speak universal terms; drivers
  translate.
- **Schema-versioned, monotonic, no-overwrite.** Repository contract
  guarantees these; backends incapable of guaranteeing → not federation-
  capable.
- **Lazy reconciliation, no daemons.** Each invocation diffs current
  state vs last known and emits delta events. Daemon is an opt-in v2
  optimisation.
- **Federation primitives in v1 schema, implementation deferred.** Not
  laying these now means schema migration later.

## 3. Repository abstraction

All persistent state goes through a single interface. Backends pluggable;
default is filesystem.

```
Repository {
  // Append-only event stream (source of truth)
  appendEvent(event) → eventId
  readEvents({since, traceId, types, kinds, clusterId}) → AsyncIterable<Event>
  subscribe(filter) → AsyncIterable<Event>      // live tail

  // Per-dispatch sidecars
  writeMeta(task, meta) / readMeta(task) / listMeta(filter)

  // Blob store (prompts, .out — large text, often live-stream)
  writeBlob(key, content) / appendBlob(key, chunk) / readBlob(key)
  openBlobAppendStream(key) → WritableStream

  // KV (session ids, dispatcher state)
  putKv(key, value) / getKv(key)

  // Queue / journal (projection from events, write-side may be markdown)
  readQueue() / writeQueue(model) / appendJournal(entry) / readJournal(since)
}
```

**Contract:** `appendEvent` is atomic, monotonic, no-overwrite. Event ids
are UUID v7 (monotonic time-prefix). Backends export `repo_api_version`;
incompatible → refuse.

**Backends (planned):**

| Backend | Use case | Federation-capable |
|---|---|---|
| `fs` (default) | single host, single dev, zero deps | only via shared dir |
| `git` | explicit commit-per-batch, refs as cursors | yes (push/pull) |
| `sqlite` | single cluster, fast reads | no |
| `postgres` | multi-cluster shared state | **yes — federation backbone** |
| `http` | remote Repository over REST/gRPC | yes |

Loader: `engine/repos/<name>.mjs`, parallel to `engine/drivers/`.
Selection: env `ARTEL_REPO=postgres` or `.artel/cluster.json`.

**Markdown queue/journal — hybrid policy** (open question, leaning):
- `fs` backend: markdown is primary storage (compatible with current
  human-edit workflow).
- Other backends: structured-primary; markdown is projection rendered by
  `engine/queue.mjs --show` / edited via `--edit` round-trip.

## 4. Event taxonomy

### 4.1 Kinds

Four orthogonal kinds:

| Kind | Purpose | Examples |
|---|---|---|
| `workload` | actual work execution | `dispatch.start`, `dispatch.end`, `checkpoint`, `queue_node.registered`, `pipeline_run.started` |
| `infra` | entity catalog + runtime availability | `role.registered`, `engine.available`, `cluster.heartbeat` |
| `signal` | derived operational cues | `signal.backoff_required`, `signal.budget_exhausted`, `signal.scope_drift` |
| `control` | inter-cluster coordination protocol | `control.claim.requested`, `control.offer.posted`, `control.peer.registered` |

### 4.2 Mandatory fields (every event)

```
schema           string    schema version, e.g. "v1"
kind             string    workload | infra | signal | control
type             string    e.g. "dispatch.start"
id               string    UUID v7 (monotonic time-prefix)
at               string    ISO-8601 UTC
cluster_id       string    UUID, origin cluster
instance_id      string    UUID, origin process-run
```

### 4.3 Workload-specific fields

```
dispatch_id          UUID per dispatch (required for dispatch.* events)
trace_id             UUID, root chain id (= top-level dispatch_id)
parent_dispatch_id   UUID, direct parent (null for top-level)
task                 slug
task_attrs           object|null
fence_token          number, monotonic per node_id (claim guard)
```

### 4.4 Lifecycle verbs (alignment)

For entity-catalog events:

```
<entity>.registered     entered catalog
<entity>.updated        config/content changed
<entity>.deregistered   removed from catalog
```

For runtime availability:

```
<entity>.available      reachable / probe passed
<entity>.unavailable    unreachable / probe failed
```

Entities with both axes: `cluster`, `engine`, `model`.
Entities with lifecycle only: `role`, `policy`, `pipeline`.
Capability is **derived**, not first-class — computed from
role × engine × model + manifest at read time.

### 4.5 Workload-specific event names

Dispatch:
```
dispatch.start          replaces legacy 'claim'; +model, +prompt_hash
dispatch.end            replaces legacy 'release'; +usage{tokens,cost,model,duration_ms}
checkpoint              sub-role-emitted, mid-run; last_completed_step / next_safe_step
parked / unparked       transient state transition (legacy preserved)
escalation              from→to role, reason
review-result           panel outcome
superseded              task replaced
owner-answer            owner intervention (was 'anton-answer')
```

Queue (graph):
```
queue_node.registered/updated/deregistered
queue_edge.registered/deregistered
```

Pipeline:
```
pipeline.registered/updated/deregistered      (definition catalog)
pipeline_run.started/advanced/paused/resumed/completed/failed/aborted
```

### 4.6 Signal kind

Reserved (not all implemented in v1):
```
signal.backoff_required       retry threshold hit
signal.budget_exhausted       token/cost/round budget hit
signal.review_required        change reached gate needing panel
signal.scope_drift            task drifted from brief
signal.cluster_unavailable_observed   derived from heartbeat absence
```

### 4.7 Control kind (federation, reserved)

Repository validates — unknown types refused. Implementations deferred to
post-v1; namespace reserved now to prevent migration.

```
control.claim.requested/granted/renewed/released/expired/fenced
control.offer.posted/accepted/withdrawn
control.handoff.requested/completed
control.peer.registered/deregistered/observed
```

## 5. Universal terms (driver isolation)

Runners speak universal terms; drivers translate. Engine-specific keys
(`codex-effort`, `codex-model`, `copilot-model`, `copilot-tools`) are
deprecated for one cycle, then dropped.

| Universal | claude | codex | copilot |
|---|---|---|---|
| `model` | `--model` | `-m` | `--model` |
| `effort` | (ignored) | `-c model_reasoning_effort=...` | (ignored) |
| `sandbox` | `--permission-mode` map | `-c sandbox_permissions=...` | `--add-dir` / `--allow-all-*` |
| `tools` | `--allowedTools` | (n/a) | `--available-tools` |
| `permission-mode` | `--permission-mode` | (n/a) | (n/a) |

CLI flags on `run.mjs` / `spawn.mjs`: `--model`, `--effort`, `--sandbox`,
`--tools`, `--permission-mode`. `--codex-effort` deprecated → `--effort`.

Drivers without an analog for a key: silent ignore, document in driver
header comment.

## 6. Tracing

```
ARTEL_DISPATCH_ID         UUID of this dispatch
ARTEL_TRACE_ID            UUID of root chain
ARTEL_PARENT_DISPATCH_ID  UUID of direct parent (null at top level)
ARTEL_PARENT_ROLE         parent role (for policy check)
```

Env propagated by `run.mjs` to child process. If child itself spawns
(orchestrator → architect), `spawn.mjs` reads parent values from env and
uses as `parent_*` for the new dispatch.

Top-level invocation (dispatcher chat): env unset → no parent.

## 7. Retries

Counted only when retry lands on **same engine + same model** as the
failed predecessor. Different engine/model → new chain, counter resets.

`dispatch.start` carries:
```
retry_of         UUID of prev dispatch (null if not a retry)
retry_count      derived: 0 first attempt; +1 if same engine+model; reset otherwise
retry_reason     'auth-expired' | 'provider-limit' | 'timeout' | 'error' | 'manual'
```

Computed engine-side in `dispatch_api.markRunning` from prev dispatch
meta. CLI surface: `spawn.mjs --retry-of <prev_dispatch_id>`.

Threshold (`retry_count >= N`, default 3) → emit
`signal.backoff_required` referencing the chain.

## 8. Role file format

Each `agents/<role>.md` is a markdown file with a YAML-ish frontmatter
fence and a body. Body is the system prompt. Frontmatter declares:

```yaml
name: implementer                 # role identifier (matches filename)
description: <one-line summary>
schema: role-v1                   # frontmatter schema version (mandatory)
version: 1                        # role content version, bumped on edit
updated_at: 2026-05-03T00:00:00.000Z   # ISO-8601 UTC timestamp of last edit
engine: claude                    # default driver; CLI override possible
model: opus                       # universal — drivers translate
effort: high                      # universal (codex-only) — drivers translate
sandbox: workspace-write          # universal — drivers translate
tools: Read, Edit, Bash(npm *)    # universal — drivers translate
permission-mode: acceptEdits      # universal (claude-only) — drivers translate
persistent: true                  # optional — keep session across dispatches
dispatchable: all                 # ACL allowlist (see §8.1)
non-dispatchable: orchestrator    # ACL denylist (see §8.1)
```

`schema` / `version` / `updated_at` are **mandatory in v1**. Tooling
uses them to detect drift between platform and project overlays, surface
stale roles in dashboards, and gate v2 features on schema migrations.
Bump `version` on any meaningful body or frontmatter edit; refresh
`updated_at` with a full ISO-8601 UTC timestamp (`new Date().toISOString()`).

Drivers / runners read these fields opportunistically — unknown
frontmatter keys are ignored, so adding project-specific keys is safe.

### 8.1 Role policies (dispatch ACL)

```yaml
dispatchable: all                  # or comma-list of role names; missing = none
non-dispatchable: orchestrator     # denylist on top of `dispatchable`
```

Defaults (platform-shipped, consumer-overridable):
- `dispatcher`: dispatchable = all
- `orchestrator`: dispatchable = all, non-dispatchable = orchestrator
- `implementer`/`architect`/`cold-reader`/`adversary`/`maintainer`:
  dispatchable = (none) — leaf roles

Enforcement: `spawn.mjs` / `run.mjs` read `ARTEL_PARENT_ROLE` from env;
if set and parent's policy denies the requested role, throw before any
side-effect. Top-level (dispatcher chat) → env empty → no policy check.

## 9. Sub-role self-reporting

CLI shim `engine/cli/checkpoint.mjs`. Sub-role calls between phases:

```bash
node $ARTEL_HOME/engine/cli/checkpoint.mjs \
  --completed "parsed registry feed" \
  --next "validate against schema" \
  [--artefact path] [--notes "..."]
```

Reads `ARTEL_TASK` / `ARTEL_ROLE` / `ARTEL_DISPATCH_ID` /
`ARTEL_TRACE_ID` from env. Appends `checkpoint` event with
`last_completed_step` / `next_safe_step` / `artefact` / `notes`.

Tool surface: relevant role files add
`Bash(node $ARTEL_HOME/engine/cli/checkpoint.mjs *)`.

Role briefs add a paragraph: "between phases call checkpoint — gives
dispatcher real-time visibility without consuming your context".

## 10. Queue as a graph

Queue is a **projection** over events. No separate persistence.

**Nodes:**
```
node.id            UUID
node.title         human-readable
node.status        derived: pending | running | blocked | paused | completed | superseded
node.priority      derived from priority edges + pipeline attrs
node.owner_cluster UUID
node.attrs         object
```

**Edges (typed):**

| Type | Meaning | Lifecycle |
|---|---|---|
| `blocks` | dst cannot start until src completed | registered → deregistered (block snat) |
| `supersedes` | src replaced dst | registered (immutable) |
| `parent_of` | src decomposed into dst | registered (immutable) |
| `triggers` | src completion creates dst | registered (immutable) |
| `same_pipeline_run` | both belong to same run | lifetime = run |
| `derived_from` | dst created from src processing | registered (immutable) |

**Status projection** (computed by `state_gen.mjs`):

| QUEUE.md section | Predicate |
|---|---|
| `For Owner` | inbound `pause_for_owner` edge or `signal.review_required` unhandled |
| `In progress` | live dispatch with `node_id = this` |
| `Pending` | no inbound `blocks` unresolved, no live dispatch, not completed |
| `Blocked` | unresolved inbound `blocks` |
| `Recently done` | completed within window N |

## 11. Pipelines

Declarative flow definitions. Stored as `.artel/pipelines/<id>.yaml`.
Versioned. Lifecycle: `pipeline.registered/.updated/.deregistered`.

**Node types:**
- `dispatch` — spawns sub-role
- `parallel` — fan-out + join (`all-complete` / `any-complete` / `k-of-n`)
- `condition` — pure decision
- `pause` — return-of-control, waits on signal
- `handler` — built-in (`builtin.git_squash`, etc.)
- `subpipeline` — composition

**Edges:** `on_success`, `on_failure`, `on_parked`, `on_timeout`,
`on_budget_exhausted`, `on_signal: <type>`, `on_disposition: <wildcard>`.
Loops bounded by `max_visits` per node.

**Entry triggers:** `queue.pull` / `event.subscribe` / `schedule.cron` /
`manual`.

**Exits:** named terminals with `final_state: completed | failed | aborted | superseded`.

**Pipeline run** (execution instance):
- `pipeline_run_id` UUID, distinct from `pipeline_id`.
- `pipeline_version` snapshot of definition at start (no in-flight drift).
- Becomes a queue_node (root). Child dispatches/handlers tagged with
  `pipeline_run_id` + `pipeline_node_id`. Trace tree shows full hierarchy.

**Pipeline engine** = stateless reactor on events. Triggers re-eval on:
- `dispatch.end` belonging to a pipeline run
- `signal.*` matching paused-run `resume_on`
- periodic reconcile (cron triggers, queue.pull)

State of run fully reconstructible from events.

## 12. Federation primitives

### 12.1 Cluster identity

`engine/cli/init.mjs` generates `.artel/cluster.json` on first run:
```json
{
  "cluster_id": "01934f...UUID-v7...",
  "name": "lockfile-team-laptop",
  "created_at": "2026-05-02T...",
  "manifest": { ... }
}
```

`instance_id` regenerated per process start, written to event stream
via `cluster.heartbeat`.

### 12.2 Liveness

`cluster.heartbeat` (infra) periodic, includes `last_seen_at`, `load`,
`manifest_hash`, `instance_id`. Other clusters' silence-detector emits
`signal.cluster_unavailable_observed` after N missed intervals.

### 12.3 Claim / lease (control)

```
control.claim.requested  { node_id, claim_id, requestor_cluster, lease_ttl_ms }
control.claim.granted    { claim_id, node_id, granted_to, fence_token, lease_expires_at }
control.claim.renewed    { claim_id, fence_token, lease_expires_at }
control.claim.released   { claim_id, reason }
control.claim.expired    { claim_id, observed_by }      // derived
control.claim.fenced     { old_claim_id, new_claim_id, new_fence_token }
```

**Fence token:** monotonic counter per node_id; incremented on each
`claim.granted`. Any node-mutating event (`dispatch.start`,
`queue_node.updated`, etc.) carries `fence_token`. Repository rejects
writes with token < current. Critical safety for weak-consistency
backends.

### 12.4 Conflict resolution

Race on `claim.requested`:
- Strong-consistency backend (postgres serializable): first-writer wins.
- Weak-consistency: both append. Detector (any cluster) compares
  `claim_id` (UUID v7 — time-prefix). Lower wins. Loser observes,
  emits `control.claim.fenced` against itself, aborts via
  `dispatch.aborted` (`reason: fenced`).

### 12.5 Discovery

V1: static `.artel/federation.json` listing peer clusters.
V2 (deferred): gossip / DNS-style. Events:
```
control.peer.registered    { peer_cluster_id, transport_endpoint, manifest_hash }
control.peer.deregistered  { peer_cluster_id, reason }
control.peer.observed      { peer_cluster_id, source }     // derived first-sight
```

### 12.6 Work offer / handoff (control, deferred)

```
control.offer.posted       { node_id, required_capability, offerer }
control.offer.accepted     { offer_id, accepter }
control.offer.withdrawn    { offer_id, reason }

control.handoff.requested  { from, to, node_id, claim_id }
control.handoff.completed  { from, to, node_id, new_claim_id }
```

## 13. What's deferred (reserved, not implemented in v1)

- Real claim/lease implementation (renewal loops, conflict detector).
- Capability-based work routing engine.
- Mid-run heartbeats from lifecycle (rely on checkpoint API for now).
- Network transports beyond `fs`: `git`, `sqlite`, `postgres`, `http`.
- Auth between clusters (sign+verify events).
- Federation discovery beyond static manifest.
- Daemon/file-watcher (lazy reconcile in v1).
- `engine/replay.mjs` tooling.

V1 commits the **schema and reserved namespaces** so these can land
without migrations.

## 14. Not in scope

- Quorum protocols (Paxos/Raft). Eventual consistency suffices for our
  use-case; no global state requiring linearisability.
- Real-time streaming WebSocket for status. `subscribe` is async-iter;
  status.mjs polls or tails as needed.
- Owned model price tables. Cost = whatever provider reports. Engine
  trusts provider; no internal pricing.

## Revision log

- **2026-05-02** — MVP carve confirmed. Architecture stays as written;
  execution scope narrowed in `PLAN.md` under parent-project urgency.
  Repository abstraction, queue-graph, pipelines, federation transports
  moved to v2. Schema fields and reserved namespaces stay in MVP so v2
  lands without migrations. Defaults locked for `PLAN.md` Q1–Q4.
- **2026-05-02** — Initial draft. Foundations + federation primitives
  reserved for v1. Pipelines, queue-graph, control-kind taxonomy locked.
