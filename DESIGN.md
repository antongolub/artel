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

- **Single source of truth.** The event stream (`events.jsonl`) plus
  per-dispatch sidecars (`.dispatches/*.meta`), cluster identity
  (`cluster.json`), and dispatcher state (`dispatcher_state.json`) are
  the canonical inputs. Everything else is a projection — regenerable,
  derivable, never authoritative.
- **Projections are independent.** Each presentation layer (state.md
  snapshot, terminal dashboard, future HTML view, replay tool) reads
  the canonical inputs directly. Projections do **not** depend on each
  other; the snapshot is not the source for the dashboard, and so on.
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

CLI flags on `artel run` / `artel spawn`: `--model`, `--effort`,
`--sandbox`, `--tools`, `--permission-mode`. `--codex-effort` deprecated
→ `--effort`.

Drivers without an analog for a key: silent ignore, document in driver
header comment.

**Cross-namespace `model` values.** Drivers also drop `model:` values
that belong to a *foreign* engine namespace — same "silent ignore"
rule, applied within the universal key. A role declaring `model: opus`
is a hint about cognitive tier; the codex driver has no analog for the
literal string `opus`, so it omits `-m` and lets codex pick its account
default. Symmetric for the claude driver against codex-namespace values
(`gpt-*`, `o\d`, `chatgpt-*`, `codex-*`). No alias mapping
(`opus → gpt-5`) is performed — the model families aren't equivalents
and forcing a translation is a worse default than the engine's own.
Engine-specific `codex-model:` / `copilot-model:` overrides bypass the
filter (legacy keys are by definition engine-targeted). Copilot proxies
both Anthropic and OpenAI namespaces, so its driver applies no filter.

### 5.1 Driver overlay

A driver is an `.mjs` module exporting at minimum `args(meta,
promptParts, session)`; optional `id` / `command` / `api_version` /
`parseUsage(outPath, sessionId)` / `sessionTokens(opts)` /
`probe()`. Drivers resolve across three layers, project wins:

```
1. <project>/.artel/drivers/<engine>.mjs    (project — wins)
2. ~/.artel/drivers/<engine>.mjs            (user-global)
3. <platform>/engine/drivers/<engine>.mjs   (platform default)
```

Same precedence shape as skills (§8.3). `engine/util/drivers.mjs`
exposes `resolveDriverPath` / `loadDriver` / `listDrivers` /
`discoverDrivers`. `loadDriver` validates the contract (`args` is
required) and throws on unknown names with a `Visible drivers: ...`
list — `--engine ../../foo` injection is impossible because lookup is
by id against the trusted overlay layers.

`artel run --list` and `artel probe` discover all visible drivers
(including overlays). Probe rows show a `(project)` / `(user)` marker
when the loaded driver isn't from the platform.

Env overrides for tests / sandboxes:
- `ARTEL_PROJECT_DIR` — relocate the project layer
- `ARTEL_USER_DRIVERS_DIR` — relocate the user layer

## 6. Tracing

```
ARTEL_DISPATCH_ID         UUID of this dispatch
ARTEL_TRACE_ID            UUID of root chain
ARTEL_PARENT_DISPATCH_ID  UUID of direct parent (null at top level)
ARTEL_PARENT_ROLE         parent role (for policy check)
ARTEL_IDENTITY            agent identity name (when frontmatter declares one)
```

Env propagated by `run.mjs` to child process. If child itself spawns
(orchestrator → architect), `spawn.mjs` reads parent values from env and
uses as `parent_*` for the new dispatch.

Top-level invocation (dispatcher chat): env unset → no parent.

### 6.1 Git context + delta capture

Every dispatch records a structural footprint for offline auditing
without needing the source tree:

```
git:
  commit_sha:  <40-hex, HEAD at dispatch start>
  branch:      <agent branch the dispatch ran on>
  repo_name:   <owner/repo, parsed from origin URL; falls back to dir basename>

delta:
  files_changed:  N
  lines_added:    N
  lines_removed:  N
```

`git` lands on `dispatch.start` events + `.meta` sidecar; `delta`
lands on `dispatch.end`. Computation: `git rev-parse HEAD` pre-spawn,
`git diff --shortstat <start_sha>` post-exit (covers committed +
uncommitted, tracked-only). Both fields are optional — non-git
directories or `git`-not-on-PATH skip cleanly. `status.mjs` RECENT row
shows `+N/-M`; `status.mjs` ACTIVITY panel aggregates over 7d.

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
protected_branch: true            # optional — refuse to overwrite divergent <role>/<task> branches (see §8.2)
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

### 8.2 Frontmatter contracts

Both role files (`role-v1`) and skill files (`skill-v1`) carry a
mandatory metadata trio:

```yaml
schema: role-v1            # or skill-v1
version: 1                 # positive integer, bumped on edit
updated_at: 2026-05-03T00:00:00.000Z   # ISO-8601 UTC
```

Plus type-specific required fields:
- **role-v1**: `name`, `description`
- **skill-v1**: `description`, `tools`

Validators (`engine/util/contract.mjs`) enforce on every load —
`engine/util/skills.mjs` validates skill files when expanded into
tool patterns; `engine/cli/run.mjs` validates the role file before
dispatching. Files that fail validation are rejected with a clear
error before any side-effects.

Schema version is the migration boundary: when the contract changes,
bump to `role-v2` / `skill-v2` and ship a parallel validator. Old
files keep working under the old validator until consumers migrate.

### 8.3 Skills (tool-surface composition)

Concrete `Bash(...)` patterns are project-specific (`npm` vs `bun` vs
`pnpm` vs `cargo`). Roles must not embed them — that ties an abstract
role to a specific stack. Instead, a role declares **skills** it
needs; each skill maps to concrete tool patterns; projects override
the mapping in their own `.artel/skills/` overlay.

Role frontmatter:
```yaml
skills: file-edit, git-write, package-manager, test-runner
tools: <raw patterns, optional escape hatch>
```

Skill files live at `<platform>/skills/<name>.md` and
`<project>/.artel/skills/<name>.md`. Each skill declares its tool
patterns in its own frontmatter:
```yaml
---
schema: skill-v1
description: <one-liner>
tools: Bash(npm install*), Bash(npm ci*), Bash(npm ls*)
---
<docs about the skill>
```

Resolution at dispatch time (`engine/cli/run.mjs`):
1. Lookup each skill in project overlay first, platform default
   second; first match wins.
2. Concatenate all skill tool lists.
3. Append the role's raw `tools:` (escape hatch — for one-off bits).
4. Deduplicate; pass to driver.
5. CLI `--tools` replaces the whole composed surface.

Projects swapping `npm` → `bun` write a single
`.artel/skills/package-manager.md` override; every role using that
skill picks it up automatically. Role files don't change.

### 8.4 Protected branches

```yaml
protected_branch: true        # default false
```

When set, dispatchLifecycle refuses to overwrite an existing
`<role>/<task>` branch whose tip is not an ancestor of HEAD (would lose
work). Used for review-only roles where every dispatch is meant to be a
fresh fork from master, not a reset of in-flight work.

The platform names no specific roles as protected — projects declare
this per role.

### 8.5 Agent identity + required credentials

```yaml
identity: bot                       # name from .artel/trust/identities.json
requires: GITHUB_TOKEN, NPM_TOKEN   # env-var names from credentials.json
```

`identity:` resolves to a record with `name` / `email` / optional
`ssh_key`. Lifecycle exports `GIT_AUTHOR_*` / `GIT_COMMITTER_*` /
`GIT_SSH_COMMAND` (path shell-quoted, `IdentitiesOnly=yes`) into the
child. CLI `--identity <name>` overrides per-dispatch. `ARTEL_IDENTITY`
exposed to the child for downstream use.

`requires:` enumerates env-var names; lifecycle resolves each through
the credentials registry and merges into the spawn env. Strict —
missing names fail before the child starts. Truststore values
override operator env on collision (registry is authoritative).

Full truststore schema + storage shape lives in §15.

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

Queue is a **projection** over events. No separate persistence required —
`events.jsonl` is canonical, `QUEUE.md` is a human-friendly read-side
projection, `engine/core/queue_graph.mjs` is the machine-friendly one.

### 10.1 V2.1 — Node graph (landed)

**Events** (workload kind, reserved prefix `queue_node.*`):

```
queue_node.created  { node_id, status, lane?, description?, role_hint?, since_at? }
queue_node.updated  { node_id, fields: {...patch}, from_status? }   # null in fields = clear
queue_node.deleted  { node_id, from_status? }
```

**Replay** (`buildGraph(projectDir)`): walks `events.jsonl`, returns
`{ nodes: Map<slug, NodeState> }` where each `NodeState` carries:

```
slug                from event.node_id
status              For Owner | In progress | Pending | Blocked | Recently done
lane?               free-text tag (impl, spec, infra, ...)
description?
since_at?           timestamp; set when status=In progress, cleared on exit
created_at          first queue_node.created.at
updated_at          last applied event.at
created_event_id    UUID (debug)
updated_event_id    UUID (debug)
```

`queue_node.updated` for an unknown slug initialises a fresh node — lets
external producers (e.g. cluster B) sync nodes the local stream hasn't
seen the create for.

**CLI surface** (`engine/cli/queue.mjs`):
- `add` / `move` / `done` / `rm` mutate `QUEUE.md` AND emit the
  matching `queue_node.*` event
- `ready` lists Pending nodes sorted by created_at — what a dispatcher
  would pull next
- `graph` dumps the replayed snapshot (machine-readable via `--json`)

### 10.2 V2.2 — Edges (landed)

Reserved prefix `queue_edge.*`. Edge identity is the tuple
`(relation, from, to)` — re-emitting the same triple is a no-op. The
edge's semantic kind lives in the event payload as `relation` (the
event-level `kind` is always `workload` for queue mutations).

```
queue_edge.added    { relation, from, to, attrs? }
queue_edge.removed  { relation, from, to }
```

Relations:

| `relation` | Meaning | Gating? |
|---|---|---|
| `blocks` | src must complete before dst can start | yes |
| `depends_on` | dst needs src's output | yes |
| `supersedes` | src replaced dst | no — informational |
| `parent_of` | src decomposed into dst | no — structure |
| `triggers` | src completion creates dst | no — provenance |
| `derived_from` | dst created from src processing | no — lineage |
| `same_pipeline_run` | both belong to same pipeline run | no — grouping |

Gating relations participate in dispatch readiness; the rest are
informational (tracked but don't affect status).

**Status derivation** — `effectiveStatus(graph, slug)`:

```
declared = In progress  →  effective = In progress  (sticky; owner forced through)
declared = Recently done →  effective = Recently done
declared = Pending + has unresolved gating inbound  →  effective = Blocked
otherwise                                          →  effective = declared
```

"Unresolved" = upstream node's status ≠ `Recently done`.

`readyForDispatch(graph)` returns Pending nodes with no unresolved
gating inbound, sorted by `created_at` ascending.

**Cycle detection.** `findGatingCycle(graph, from, to, relation)`
walks outgoing gating edges from `to`; if it reaches `from`, the
hypothetical edge would close a cycle. Reports the path
`[from, to, ..., from]` or null. CLI `artel queue link` invokes this
before emitting the event — cycles never persist to events.jsonl.
Self-edges (`from === to`) rejected at the same gate.

**CLI:**
- `artel queue link <from> <to> --relation <R>` — emits `queue_edge.added`
  after validation (nodes exist, no self-edge, no gating cycle for
  `blocks` / `depends_on`).
- `artel queue unlink <from> <to> --relation <R>` — emits
  `queue_edge.removed`. Errors if the edge isn't present.
- `artel queue ready` filters by gating; surfaces a `Held by upstream`
  panel showing which Pending nodes are blocked and by what.
- `artel queue graph --json` includes `edges` + per-node
  `effective_status`.

### 10.3 Status projection contract

| QUEUE.md section | Declared status (V2.1) | Effective status (V2.2) |
|---|---|---|
| `For Owner` | explicit | declared (V2.3 may derive from edges) |
| `In progress` | explicit | declared (sticky) |
| `Pending` | explicit | declared, OR `Blocked` if unresolved gating inbound |
| `Blocked` | explicit | declared, OR derived from edges |
| `Recently done` | explicit | declared (sticky) |

V2.2 lands the **derived `Blocked`** path: a Pending node with an
unresolved gating inbound edge is effectively Blocked regardless of
its declared status. Owner-facing tools (`artel queue graph`,
`artel queue ready`) surface both — declared shows what was set,
effective reflects upstream constraints.

## 11. Pipelines

Declarative flow definitions. Stored as JSON at
`.artel/pipelines/<id>.json` (V3.1; YAML support possible later
without breaking the events vocabulary). Versioned. Lifecycle:
`pipeline.registered` / `.updated` / `.deregistered` (workload).

### 11.1 V3.1 — registry + linear runs (landed)

**Node types:**
- `dispatch` — spawns sub-role via `dispatchLifecycle`
- `terminal` — sink with `final_state: completed | failed | aborted | superseded`

**Edges:** `{ from, on_disposition, to }`. `on_disposition` ∈
`success | parked | timeout | error | *`. Resolution is
exact-match-first, wildcard-fallback. No matching edge for the actual
disposition → run aborts with `abort_reason`.

**Validation** at register time:
- id matches slug regex
- version is a positive integer
- entry references a registered node
- every node has its required fields (`role` + `prompt` for dispatch,
  valid `final_state` for terminal)
- every edge endpoint exists; edges don't originate from terminals
- at least one terminal is reachable from `entry`

**Run** is synchronous: walk node-by-node, dispatch each `dispatch`
inline, pick next via `resolveNext`, stop on `terminal` or
no-transition. `pipeline_run_id` (UUID v7) propagated into each
dispatch's `taskAttrs` along with `pipeline_id` / `pipeline_node_id`
so events.jsonl reconstructs the chain.

**Lifecycle events (V3.1):**
- `pipeline.registered` (workload) — on `register`; payload includes
  `pipeline_id`, `pipeline_version`, `source_path`, `node_count`,
  `edge_count`
- `pipeline_run.started` (workload) — on `run`; payload `pipeline_run_id`,
  `pipeline_id`, `pipeline_version`, `entry_node`
- `pipeline_run.ended` (workload) — on terminal or abort; payload
  `pipeline_run_id`, `final_state`, `last_node`, `last_disposition`,
  `abort_reason?`

### 11.2 V3.2+ — open

Reserved by the spec; not yet implemented:
- `parallel` — fan-out + join (`all-complete` / `any-complete` / `k-of-n`)
- `condition` — pure decision
- `pause` — return-of-control, waits on signal
- `handler` — built-in (`builtin.git_squash`, etc.)
- `subpipeline` — composition

**Additional edges:** `on_signal: <type>`, `on_budget_exhausted`.
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

## 13. Truststore

Operational state for agent-as-actor: who an agent commits as, what
secrets it can read, and how those secrets sit at rest. Lives in
`.artel/trust/`, **outside** `events.jsonl` — credentials in an
append-only history would be unrecoverable. Two parallel registries:

```
.artel/trust/
├── identities.json            # commit-safe (no secrets, just author info)
├── credentials.json           # gitignore — opaque secrets
├── credentials.json.enc       # if encrypted at rest (mutually exclusive)
└── keys/<identity>            # generated SSH keys (mode 0600)
└── keys/<identity>.pub
```

### 13.1 Identities

```json
{
  "bot":   { "name": "artel-bot", "email": "bot@cluster.local",
             "ssh_key": "/.../keys/bot" },
  "owner": { "name": "Anton Golub", "email": "anton@example.com" }
}
```

`identity:` in role frontmatter (or `--identity` CLI override)
selects an entry. Lifecycle injects:
```
GIT_AUTHOR_NAME / GIT_AUTHOR_EMAIL
GIT_COMMITTER_NAME / GIT_COMMITTER_EMAIL
GIT_SSH_COMMAND="ssh -i \"<ssh_key>\" -o IdentitiesOnly=yes"
ARTEL_IDENTITY=<name>
```

`IdentitiesOnly=yes` ensures git doesn't accidentally use the
operator's `ssh-agent` keys. Unknown name fails dispatch with a
`Known: ...` list before the child starts.

### 13.2 Credentials

```json
{
  "GITHUB_TOKEN": "ghp_…",
  "NPM_TOKEN":    "npm_…"
}
```

Keys are env-var names (regex `^[A-Za-z_][A-Za-z0-9_]*$`); values are
opaque strings. `requires: NAME1, NAME2` in role frontmatter resolves
via the registry and merges into the spawn env. Strict —
missing names fail before the child starts. Truststore values
override operator env on collision (registry is authoritative).

`artel trust list` shows credential **names only** — values never via
CLI. `set-credential` reads from stdin or `--from-env <VAR>`; never
`--value` (shell history risk).

### 13.3 Encryption at rest

Optional, opt-in. Mode is detected by file shape:

| on disk | mode |
|---|---|
| `credentials.json.enc` | encrypted |
| `credentials.json` | plaintext |
| neither | empty |

`artel trust encrypt` flips plaintext → encrypted; `decrypt` reverses.
Mutators (`set-credential` / `delete-credential`) follow the existing
mode; reads decrypt transparently.

Cipher: AES-256-GCM, fresh IV per write, schema
`secret-aes-256-gcm-v1`:
```json
{
  "schema": "secret-aes-256-gcm-v1",
  "iv":     "<base64, 12 bytes>",
  "tag":    "<base64, 16 bytes>",
  "ciphertext": "<base64>"
}
```

Auth-tag failure or wrong key throws `decryption failed (wrong key or
tampered file)` — never silently returns garbage.

### 13.4 Master key

Resolution order (first hit wins):
1. `ARTEL_MASTER_KEY` env (32 bytes base64-decoded — CI-friendly)
2. `ARTEL_MASTER_KEY_FILE` env (path)
3. `~/.config/artel/master.key` (XDG-aware via `$XDG_CONFIG_HOME`)

Format: 32 random bytes, base64-encoded text, mode 0600. Generated by
`artel trust gen-key`. The key lives **outside** the project tree so
the repo stays committable; losing the key means losing the encrypted
credentials (acceptable for local dev — back up to a password manager).

### 13.5 Threat model

Defends against accidental disclosure (screen share, git commit,
file backup). Does **not** defend against an attacker with read access
to both the project tree and the key file — encryption only helps when
the key lives elsewhere (CI secret, separate machine, OS keychain).

### 13.6 Audit log

Every trust mutator appends an `infra` event to `.artel/events.jsonl`.
`engine/util/audit.mjs#appendInfraEvent` wraps the envelope; `trust.`
is reserved in `RESERVED_TYPE_PREFIXES.infra`. Events:

| Mutator | Type | Payload (always sans secrets) |
|---|---|---|
| `set-identity` | `trust.identity.set` | `{ name, fields: ['name','email','ssh_key'] }` |
| `delete-identity` | `trust.identity.deleted` | `{ name }` |
| `set-credential` | `trust.credential.set` | `{ name, value_length }` |
| `delete-credential` | `trust.credential.deleted` | `{ name }` |
| `gen-ssh` | `trust.ssh_key.generated` | `{ identity, path, force }` |
| `gen-key` | `trust.master_key.generated` | `{ path, force }` |
| `encrypt` | `trust.credentials.encrypted` | `{ from_mode }` |
| `decrypt` | `trust.credentials.decrypted` | `{ from_mode }` |

Failed mutations (e.g. `delete-identity` on a missing name) don't
emit. Surface the trail with `artel events --kind infra --type
'trust.*'`.

### 13.7 What's deferred

- OS keychain integration (macOS Keychain, libsecret, Windows
  Credential Manager). The `ARTEL_MASTER_KEY` env path covers most CI
  scenarios without it.
- Per-cluster vs per-project credential scoping — currently per-project.

## 14. What's deferred (reserved, not implemented in v1)

- Real claim/lease implementation (renewal loops, conflict detector).
- Capability-based work routing engine.
- Network transports beyond `fs`: `git`, `sqlite`, `postgres`, `http`.
- Auth between clusters (sign+verify events).
- Federation discovery beyond static manifest.
- Daemon/file-watcher (lazy reconcile in v1).

(V8 replay, V9 heartbeats, V10 deltas, V11 truststore, and `artel
events` / `logs` / `probe` are now implemented — moved out of this
list as they landed.)

V1 commits the **schema and reserved namespaces** so the remaining
items can land without migrations.

## 15. Not in scope

- Quorum protocols (Paxos/Raft). Eventual consistency suffices for our
  use-case; no global state requiring linearisability.
- Real-time streaming WebSocket for status. `subscribe` is async-iter;
  status.mjs polls or tails as needed.
- Owned model price tables. Cost = whatever provider reports. Engine
  trusts provider; no internal pricing.

## Revision log

- **2026-05-04** — Doc sync after V6 / V8 / V9 / V10 / V11 + the
  `probe` / `logs` / `events` / `replay` / `trust` subcommands all
  landed. New: §5.1 (driver overlay precedence), §6.1 (git context +
  delta capture), §8.5 (identity / requires frontmatter), §13
  (truststore — identities, credentials, encryption at rest, master
  key resolution, threat model). §14 deferred list pruned of items
  now implemented; §13 → §14, §14 → §15 renumbered.
- **2026-05-02** — MVP carve confirmed. Architecture stays as written;
  execution scope narrowed in `PLAN.md` under parent-project urgency.
  Repository abstraction, queue-graph, pipelines, federation transports
  moved to v2. Schema fields and reserved namespaces stay in MVP so v2
  lands without migrations. Defaults locked for `PLAN.md` Q1–Q4.
- **2026-05-02** — Initial draft. Foundations + federation primitives
  reserved for v1. Pipelines, queue-graph, control-kind taxonomy locked.
