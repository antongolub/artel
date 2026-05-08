# Plan — artel platform

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
| C0 | **Lock design + plan docs** | `[done]` | Committed `5da7ee4` (rescope) + `8a48c0d` (initial). |
| C1 | **Universal driver terms** | `[done]` | Drivers translate `model` / `effort` / `sandbox` / `tools` / `permission-mode`; legacy keys (`codex-model` / `codex-effort` / `copilot-model` / `copilot-tools`) back-compat-read with deprecation warning in `run.mjs`. CLI flags `--model` / `--effort` / `--sandbox` / `--tools` / `--permission-mode` on `run.mjs` + `spawn.mjs` + `dispatch_lifecycle.mjs`. `--codex-effort` deprecated alias. Drivers export `api_version=1`. 21 tests green (17 new). |
| C2 | **Cluster identity + schema baseline** | `[done]` | `engine/init.mjs` + `engine/cluster.mjs` + `engine/schema.mjs`. Idempotent bootstrap of `.artel/cluster.json` (cluster_id UUID v7, name, created_at). `instance_id` per-process. Every event carries `schema`/`kind`/`type`/`id`/`at`/`cluster_id`/`instance_id`; workload events also carry `fence_token: 0` (reserved for federation, no enforcement v1). `validateEventType` rejects unknown kind / unreserved type prefix. Namespaces reserved: `workload`/`infra`/`signal`/`control` with full prefix table. Legacy `claim`/`release` accepted one cycle. 37 tests green (16 new for schema + cluster + init.mjs CLI + event-enrichment). |
| C3 | **Tracing** | `[done]` | `dispatch_id` (UUID v7) + `trace_id` + `parent_dispatch_id` + `parent_role` on every event + .meta. Env propagation: dispatch_lifecycle reads `ARTEL_DISPATCH_ID` / `ARTEL_ROLE` / `ARTEL_TRACE_ID` from env (= parent context); generates new dispatch_id; sets `ARTEL_DISPATCH_ID`/`TRACE_ID` for child run.mjs; run.mjs passes them down via process.env to engine CLI. Nested dispatch chain reconstructs from (dispatch_id, parent_dispatch_id, trace_id) tuples. 41 tests green (4 new). |
| C4 | **Event rename + back-compat read** | `[done]` | `dispatch_api.markRunning/markReleased` emit `dispatch.start`/`dispatch.end`. Read side: `state_gen.mjs` activeTasks filter accepts both legacy `claim` and canonical `dispatch.start`; `status.mjs` `summarizeEvent` accepts both pairs. Existing `events.jsonl` with legacy names still summarises in dashboard. 43 tests green (2 new). |
| C5 | **Driver usage capture** | `[done]` | All drivers export `parseUsage(outPath, sessionId)`. codex implementation walks `~/.codex/sessions/` (override via `ARTEL_CODEX_SESSIONS_DIR`), finds rollout file by id, reads last `token_count` event for cumulative usage; cost = null (provider zone). claude/copilot return null with TODO for v2 (claude needs `--output-format json`; copilot has no per-dispatch surface). Lifecycle dynamically imports driver, calls parseUsage post-exit, merges into `dispatch.end` event + `.meta` when non-null. 48 tests green (5 new). |
| C6 | **Retry tracking + `signal.backoff_required`** | `[done]` | `dispatch.start` carries `retry_of` / `retry_count` / `retry_reason` / `model`. dispatchLifecycle looks up prev dispatch by id in events.jsonl, compares engine+effective-model, increments counter (reset on mismatch). retry_reason from prev dispatch.end disposition. CLI: `spawn.mjs --retry-of <prev_dispatch_id>`. Threshold via `backoffThreshold` param (default 3) → emit `signal.backoff_required` with engine/model/retry_count/threshold context. 53 tests green (5 new). |
| C7 | **Sub-role checkpoint API** | `[done]` | `engine/checkpoint.mjs` CLI shim — reads task/role/dispatch_id/trace_id from `ARTEL_*` env (auto-set by run.mjs); args `--completed` / `--next` / `--artefact?` / `--notes?`; appends `checkpoint` event with all mandatory fields. Implementer.md + architect.md role briefs gain explanatory paragraph. Architect tool surface adds narrow `Bash(node *engine/checkpoint.mjs*)` (implementer already covered by `Bash(node *)`). 57 tests green (4 new). |
| C8 | **Role dispatch policies** | `[done]` | `parseDispatchPolicy` + `checkDispatchPolicy` in dispatch_lifecycle. Reads parent role from `ARTEL_ROLE` env, parses `dispatchable: all | none | <list>` + `non-dispatchable: <list>` from parent's frontmatter, throws before any side-effects on violation. Default `dispatchable: all` (back-compat). Top-level dispatch (no env) skips check. Unknown parent fails open. Platform agents/ files updated: `dispatcher: all`, `orchestrator: all + non-dispatchable: orchestrator`, leaf roles (`adversary`/`architect`/`cold-reader`/`implementer`/`maintainer`): `dispatchable: none`. Also migrated orchestrator's `codex-effort` → canonical `effort`. 64 tests green (7 new). |
| C9 | **`status.mjs` / `state_gen.mjs` minimal update** | `[done]` | `getRecentDispatches` reads usage / retryCount / dispatchId / traceId from .meta; `renderRecent` annotates each line with `[<in>/<out>t]` tokens (when present) and `r<N>` retry indicator (when >0). `state_gen.mjs` frontmatter gains `cluster_id` + `cluster_name` from `.artel/cluster.json`. Trace grouping and full per-day usage charts deferred to v2. 67 tests green (3 new). |
| C10 | **`MIGRATION.md` for parent project** | `[done]` | Sectioned doc: TL;DR table, then 11 sections (one per MVP commit + test infra). Covers frontmatter renames with deprecation, event renames with back-compat, schema baseline + reserved namespaces, tracing (auto-set env), usage capture, retry tracking, checkpoint API tool-surface additions, dispatch policies (default all = back-compat), status / state_gen surfacing, and v2 follow-ups. |

## Out of MVP — v2 (namespace reserved)

Schema fields and type prefixes for these already reserved in C2 — adding
implementations later requires no migration.

| # | Title | Status | Why deferred |
|---|---|---|---|
| V1 | Repository abstraction + non-fs backends | `[v2]` | Refactor; fs behavior works for parent project today. |
| V2 | **Queue graph model (V2.1 nodes + V2.2 edges)** | `[done]` | **V2.1 (nodes):** event-sourced read-side over `queue_node.*` workload events. `engine/core/queue_graph.mjs#buildGraph(projectDir)` replays into `{ nodes, edges }` snapshot. Mutators (`artel queue add / move / rm`) emit canonical events alongside `QUEUE.md`. New subcommands `artel queue ready` (dispatchable Pending) and `artel queue graph` (snapshot, `--json`). **V2.2 (edges):** `queue_edge.*` workload events with seven relations (`blocks` / `depends_on` / `supersedes` / `parent_of` / `triggers` / `derived_from` / `same_pipeline_run`); identity is the tuple `(relation, from, to)`. Gating relations (`blocks`, `depends_on`) participate in dispatch readiness — a Pending node with unresolved gating inbound is effectively `Blocked`. `effectiveStatus` overlays this on declared status (In progress / Recently done are sticky). `findGatingCycle` does DFS at link time so cycles never persist. New CLI: `artel queue link <from> <to> --relation <R>` and `unlink ...`; `ready` surfaces "Held by upstream" hint; `graph --json` includes `edges` + per-node `effective_status`. 345 tests green (28 new — 18 graph unit covering edge replay / effectiveStatus / readyForDispatch filtering / cycle detection + 10 e2e covering link/unlink/cycle-rejection/ready-with-edges/graph-with-edges). |
| V3 | **Pipelines (V3.1–V3.6)** | `[done]` | Cumulative through V3.6: linear `dispatch` + `terminal` (V3.1), `parallel` fan-out + worst-of-children all-complete join (V3.2.a), `condition` pure routing with atomic predicates over dotted attrs paths (V3.2.b), git-worktree isolation + concurrent `parallel` via `Promise.all` (V3.3.a), `artel sweep` worktree prune cross-checked against `git worktree list` (V3.3.b), `any-complete` / `k-of-n` joins with first-success cancellation via `AbortController` + SIGTERM→SIGKILL grace (V3.3.c), `artel pipeline runs` / `status` observability over `events.jsonl` (V3.4.a), `{{ dotted.path }}` prompt template substitution at dispatch time (V3.5), recursive predicate vocabulary — `not`/`and`/`or` compounds + `gt`/`gte`/`lt`/`lte`/`ne` comparison ops, `show` renders nested predicates (V3.6). 4 node types: `dispatch` / `parallel` / `condition` / `terminal`. Schema lives at `.artel/pipelines/<id>.json`; events `pipeline.registered` / `pipeline_run.started` / `pipeline_run.ended` (workload). CLI: `register` / `list` / `show` / `run` / `runs` / `status`. Walker honours sticky `In progress` / `Recently done` semantics from V2. Reachability check follows parallel branches AND condition then/else. `cancelled` disposition distinct from `error` / `timeout` / `parked`; excluded from worst-of-children aggregate. Templates render against the merged attrs blob (user `--attrs` + pipeline-injected ids); fail-fast on missing/non-scalar. Predicate ops fail-closed on missing / wrong-typed attrs. 508 tests green (~150 across V3 — 100 unit + 50 e2e). V3.x open: `pause` / `signal` / `handler` / `subpipeline`, branch-level timeout budgets, operator cancel of full pipeline run. |
| V4 | Capability manifest + federation | `[v2]` | Parent project is single-cluster. |
| V5 | Real claim/lease + fence enforcement | `[v2]` | Federation-only. Field reserved in C2; enforcement follows. |
| V6 | **Driver plugin overlay loader** | `[done]` | `engine/util/drivers.mjs` resolves `<engineId>.mjs` across three layers (project `.artel/drivers/` → user `~/.artel/drivers/` → platform). `loadDriver` validates the contract (`args` required); `discoverDrivers` returns `{id, source, module}` for every visible engine. `run.mjs` and `dispatch_lifecycle.mjs` use the loader; `probe.mjs` discovers all drivers dynamically and shows `(project)` / `(user)` overlay markers. `api_version` already exported by all in-tree drivers (since C5). 143 tests green (12 new — 8 unit on loader + 3 overlay e2e + 1 driver-list assertion). |
| V7 | Infra reconcile pass + availability events | `[v2]` | `cluster.heartbeat` ships in C2; `role.*` / `engine.*` lifecycle events when needed. |
| V8 | **Replay tooling** | `[done]` | `artel replay <task | dispatch-id>` re-runs a past dispatch on the same or a different engine. Resolves target by slug (most-recent meta) or UUID v7 dispatch_id; pulls role + prompt from `.meta` and `.prompt` sidecars; spawns a new dispatch with auto-generated slug `<orig>-replay-<short>` and `--retry-of <orig-id>` so the chain reconstructs from events.jsonl. Flags: `--engine`, `--model`, `--task` (override slug), `--effort`, `--sandbox`, `--tools`, `--permission-mode`, `--timeout-ms`. Errors helpfully when target / prompt missing. 162 tests green (6 new e2e). |
| V9 | **Mid-run heartbeats from lifecycle** | `[done]` | Lifecycle emits a `heartbeat` event every `ARTEL_HEARTBEAT_INTERVAL_MS` (default 60s) until the child exits or settles, plus updates `.meta.lastHeartbeatAt` + `.meta.pidAlive`. `0` disables. `heartbeat` added to reserved workload types in schema. `interval.unref()` so a stuck heartbeat can never keep node alive past settle. Status RUNNING gets a `hb Ns ago` annotation coloured by freshness (green ≤90s, yellow ≤5m, red older). 176 tests green (5 new — 4 unit + 1 status e2e). |
| V10 | **Dispatch deltas + git context in telemetry** | `[done]` | `engine/util/git.mjs` exposes `gitContext` + `gitDelta`. Lifecycle calls `gitContext` pre-`markRunning` (captures `commit_sha` / `branch` / `repo_name` — origin URL parsed; SSH + HTTPS; falls back to project basename). Calls `gitDelta(commit_sha)` post-exit (working-tree diff via `git diff --shortstat <sha>` covers committed + uncommitted, tracked-only). Both flow into `dispatch.start` / `dispatch.end` event payloads + `.meta` sidecar. `status.mjs` RECENT row gets `+N/-M` delta annotation when present. Tolerates non-git dirs / git-not-on-PATH. 131 tests green (20 new — 11 git unit + 1 spawn e2e + 1 status e2e + existing). |
| V11 | **Agent identity & credentials (truststore)** | `[done]` | **V11.1 (identities):** `.artel/trust/identities.json` registers named git identities. Roles declare `identity: <name>`; lifecycle injects `GIT_AUTHOR_*` / `GIT_COMMITTER_*` / `GIT_SSH_COMMAND`. **V11.2 (credentials):** `.artel/trust/credentials.json` (gitignore) holds opaque secrets. Roles declare `requires: <NAMES>`; lifecycle merges into spawn env, strict on missing. CLI shows names only. **V11.3 (mutators + keygen):** `artel trust` is multi-subcommand — `set-identity` / `delete-identity` / `set-credential` (stdin or `--from-env`, never `--value`) / `delete-credential` / `gen-ssh` (ed25519, prints pubkey on stdout for `\| gh repo deploy-key add -`). Atomic writes; credentials.json auto-`chmod 600`. **V11.4 (encryption at rest):** AES-256-GCM via pure node `crypto`. Master key (32 random bytes, base64) at `~/.config/artel/master.key` by default — overridable via `ARTEL_MASTER_KEY_FILE` (path) or `ARTEL_MASTER_KEY` (inline base64, for CI). `artel trust gen-key [--print]` writes the key 0600. `artel trust encrypt` seals existing creds in place to `credentials.json.enc` (fresh IV per write); `decrypt` reverses. Mode auto-detected by file shape; mutators reseal on every write; reads transparently decrypt. Auth-tag failure or wrong key throws helpful error. `artel trust list` shows mode badge (empty / plaintext / encrypted). Encrypted creds still flow into dispatch env via existing `requires:` path. 267 tests green (91 new across V11.1–V11.4). |

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

- **2026-05-08** — V3.6 — condition predicate vocabulary expansion.
  `engine/util/pipelines.mjs` adds compound predicates and
  comparison operators on top of the V3.2.b atomic vocabulary.
  Compounds (recursive, no `attr`): `not: <pred>` (single nested),
  `and: [<pred>, ...]` (non-empty array), `or: [<pred>, ...]`
  (non-empty array). New atomics: `gt`/`gte`/`lt`/`lte` (numeric;
  fail-closed on missing or non-numeric attr — non-numeric values
  never silently take a comparison branch) and `ne` (strict !==,
  accepts any value). New exports `VALID_ATOMIC_OPS` /
  `VALID_COMPOUND_OPS`; `VALID_PREDICATE_OPS` kept (combined set)
  for back-compat with V3.2.b importers. Validator extracted into
  recursive `validatePredicateShape(pred, source, nid, path)` —
  errors include the full dotted path
  (e.g. `.if.and[0].not.attr`) so operators can pinpoint which
  nested predicate is broken. `evaluatePredicate` recurses through
  compounds before falling through to the atomic switch, so order
  is: `not` → `and` (every) → `or` (some) → atomic. Compounds
  short-circuit naturally via JS `&&` / `||`. `engine/cli/pipeline.mjs`
  gets a `renderPredicate(pred)` helper used by `show` to print
  nested predicates compactly: `not(...)`, `(p1 and p2)`,
  `(p1 or p2)` with atomic leaves rendered as
  `<attr> <op> <value>`. 508 tests green (22 new — 17 unit on
  validator compounds / validator comparisons / evaluator
  compounds / evaluator comparisons + 5 e2e on and/or-with-not /
  gte routing / register error path / show nested rendering).
- **2026-05-08** — V3.5 — prompt template substitution.
  `engine/util/pipelines.mjs` exposes `renderTemplate(template,
  scope)` — `{{ dotted.path }}` substitution against the merged
  attrs blob (user `--attrs` JSON + pipeline-injected
  `pipeline_run_id` / `pipeline_id` / `pipeline_node_id` /
  `pipeline_parallel_of`). Reuses the existing `readPath` helper
  used by `evaluatePredicate` so both V3.2.b condition predicates
  and V3.5 templates share scope semantics. Whitespace-tolerant
  (`{{x}}`, `{{ x }}`, `{{  x  }}`). Fail-fast: missing attribute,
  null/undefined, or object/array value all throw with helpful
  errors caught by `runDispatchNode` and surfaced as the run's
  `abort_reason`. Coerces scalar (string|number|boolean) to string
  via `String(v)`. No recursion: substituted values aren't
  re-scanned (closes the infinite-loop foot-gun). Vocabulary
  intentionally minimal — no conditionals, loops, filters, or
  escapes; literal `{{` is reserved (encode via the scope if a real
  prompt needs that bigraph). Walker integration: `runDispatchNode`
  builds `taskAttrs` once, renders `node.prompt` against it, passes
  rendered string to `dispatchLifecycle`. Render errors flow
  through the same `__error` channel as dispatch throws, so the
  parallel walker also handles them (sibling cancel + abort). 486
  tests green (16 new — 12 unit covering substitution / dotted
  paths / whitespace / coercion / missing-attr / object-rejection /
  pipeline-injected ids / no-recursion + 4 e2e covering
  --attrs+injected-ids substitution / missing-attr abort /
  parallel branches / no-template back-compat).
- **2026-05-08** — V3.3.c — `any-complete` / `k-of-n` parallel joins
  with cancellation. `engine/util/pipelines.mjs` extends
  `VALID_JOIN_POLICIES` to `{all-complete, any-complete, k-of-n}`;
  k-of-n requires integer `k` in `[1, branches.length]` (validated at
  register). New helpers `quorumOf(node)` (1 for any-complete, `k`
  for k-of-n, `branches.length` for all-complete) and
  `aggregateForJoin(dispositions, join, k)` (success once quorum is
  met regardless of trailing branches; otherwise falls through to
  `aggregateDisposition` worst-of-children). `aggregateDisposition`
  itself now filters out `cancelled` first — a cancelled branch
  reflects intentional teardown, not a real outcome.
  `engine/core/dispatch_lifecycle.mjs` accepts an `abortSignal`
  option; on abort sends SIGTERM, then SIGKILL after the existing
  termination-grace window. New `disposition: 'cancelled'` distinct
  from error / timeout / parked. Worktree cleanup treats `cancelled`
  like `success` (intentional, not forensic). `engine/cli/pipeline.mjs`
  walker switches the parallel block from `Promise.all` to
  progressive quorum collection: each branch gets its own
  `AbortController`; `Promise.race` resolves them with index +
  branchId so the walker can back-map; once `succeeded >= quorum` it
  aborts siblings + collects trailing settles via `Promise.allSettled`.
  `show` renders `k=` for k-of-n. 470 tests green (17 new — 13 unit
  on join validator / quorumOf / aggregateForJoin / cancelled
  exclusion + 4 e2e on first-success-wins / k=2-of-3 / all-fail
  fallthrough / show k-of-n; e2e timing-tolerant — accept either
  `cancelled` or `error` per branch but assert at least one was
  actually cancelled).
- **2026-05-04** — V3.4.a — pipeline run observability.
  Two read-side helpers in `engine/util/pipelines.mjs`:
  `listPipelineRuns(projectDir, { limit, pipelineId })` joins
  `pipeline_run.started`/`.ended` from events.jsonl into
  newest-first run summaries (run_id, pipeline_id, pipeline_version,
  started_at, ended_at, final_state, last_node, last_disposition,
  duration_ms, abort_reason). `pipelineRunDetail(projectDir, runId)`
  reconstructs the per-node timeline by joining `dispatch.start`/`.end`
  events tagged with the run_id via `task_attrs.pipeline_run_id` —
  surfaces parallel_of for fan-out branches. New CLI subcommands
  `artel pipeline runs [--limit N] [--pipeline <id>] [--json]` (one
  row per run with state badge + duration + last node) and
  `artel pipeline status <run-id-or-fragment> [--json]` (summary
  block + Steps panel; trailing-fragment match for ergonomics).
  In-flight runs (started, not yet ended) appear in `runs` without
  a final_state. Pure read-side — events.jsonl is the source of
  truth, no extra state. 453 tests green (18 new — 10 unit on
  listPipelineRuns + pipelineRunDetail + 8 e2e on runs/status CLI
  with full + fragment matching, --json shape, empty-state hint).
- **2026-05-04** — V3.2.b + V3.3.b — closing V3 polish.
  **Condition node (V3.2.b)**: pure routing without dispatch.
  Predicate vocabulary: `equals` / `in` / `exists` over dotted-path
  attrs (`pipeline_id`, `attrs.target`, `attrs.flags.skip_tests`).
  Validator checks `then` / `else` references, exactly-one operator,
  array shape for `in`, boolean for `exists`. Walker short-circuits
  to the chosen branch — no event emitted (the route is implicit
  in subsequent dispatch attrs). Reachability follows
  `then`/`else`. **Worktree sweep (V3.3.b)**: `artel sweep` now
  prunes orphaned `.artel/.worktrees/<branch>/` directories
  cross-checked against `git worktree list` (so we don't fs-rm
  paths that aren't in git's worktree registry, which would
  corrupt it). Active QUEUE entries — by full branch or trailing
  task slug — are held; `--older-than` threshold gates the rest.
  Single `cluster.swept` event gains `worktrees_removed` field.
  JSON output includes `worktrees_swept` array. 435 tests green
  (22 new — 13 condition unit + 4 condition e2e + 5 sweep-worktrees
  e2e guarded by `git --version`).
- **2026-05-04** — V3.3.a landed: git worktrees + concurrent pipeline parallel.
  `engine/util/worktree.mjs` exposes `createWorktreeForBranch` /
  `removeWorktree` / `listWorktrees` / `worktreeDir`. Lifecycle gains
  `useWorktree` (and `keepWorktreeOnSuccess`) options: branch is
  created via `git branch -f` + `git worktree add` instead of
  `git checkout -B` in main. Child dispatches run with cwd set to
  the worktree path; V10 git context + delta capture runs there too.
  Dirty-tree guard skipped in worktree mode (main untouched). On
  success the worktree is removed; on parked/timeout/error it's kept
  for the operator to `cd` in. Pipeline parallel branches now use
  worktrees by default and dispatch via `Promise.all` — real
  wall-clock concurrency. Operator stays on `master` while
  dispatches work in isolation. `artel spawn --worktree` and
  `--keep-worktree` flags exposed. Test fixture gitignores
  `.artel/.worktrees/`. 413 tests green (17 new — 10 worktree unit
  + 7 e2e). V3.3.b open: sweep prune for stale worktrees, true
  cancellation for `any-complete` / `k-of-n` joins.
- **2026-05-04** — V3.2.a landed: pipelines `parallel` node + all-complete join.
  `engine/util/pipelines.mjs` validates parallel nodes (non-empty
  branches, all dispatch-typed, no self-reference, no dups; default
  join `all-complete`). Reachability follows parallel branches so a
  parallel-only flow passes. New `aggregateDisposition` joins
  branches via worst-severity rule (`error > timeout > parked > else
  success`). Walker fans out sequentially (real concurrency over a
  shared git working tree needs worktrees — V3.3); each branch's
  taskAttrs carry `pipeline_parallel_of: <parent-node-id>` for
  external filtering. `show` renders parallel rows; `run` logs each
  branch's disposition + the aggregate. 396 tests green (18 new — 11
  unit covering validator + aggregateDisposition + reachability + 7
  e2e covering parallel happy path / failure aggregation / branch
  attrs / show rendering). V3.2.b open: `any-complete` / `k-of-n`,
  `condition` / `pause` / `signal` / `handler` / `subpipeline`.
- **2026-05-04** — V3.1 landed: pipeline registry + linear runs.
  `engine/util/pipelines.mjs` (parser/validator/resolveNext + listing
  helpers); `engine/cli/pipeline.mjs` (register / list / show / run).
  JSON pipeline files at `.artel/pipelines/<id>.json` with `dispatch`
  + `terminal` node types and `on_disposition` edges. Validator
  enforces structural integrity (slugs, refs, reachable terminal,
  no edges from terminals). `run` walks synchronously via
  `dispatchLifecycle`, picks next node via exact-disposition →
  wildcard `*` fallback, propagates `pipeline_run_id` /
  `pipeline_id` / `pipeline_node_id` into each dispatch's
  `taskAttrs`, emits `pipeline_run.started` / `.ended`. Aborts
  cleanly on dispatch throw or no matching transition (event has
  `abort_reason`). DESIGN §11 still describes the full V3 (parallel
  / condition / pause / handler / subpipeline) — V3.2+ open.
  378 tests green (33 new — 13 unit + 20 e2e).
- **2026-05-04** — V2.2 landed: queue graph edges + cycle detection.
  `queue_edge.*` workload events with seven relations; gating subset
  (`blocks` / `depends_on`) drives status derivation. `engine/core/
  queue_graph.mjs` extended with `incomingEdges` / `outgoingEdges` /
  `hasUnresolvedUpstream` / `effectiveStatus` / `findGatingCycle`
  pure helpers. CLI gains `artel queue link` / `unlink` (validates
  src/dst exist, rejects self-edges, rejects gating cycles before
  emit); `ready` filters on gating with "Held by upstream" hint;
  `graph --json` includes edges + `effective_status` per node.
  `events.mjs` formatter renders `<from> --rel-> <to>` for edge
  events. DESIGN §10.2 marked landed; §10.3 status contract reframed
  as declared vs effective. 345 tests green (28 new — 18 graph unit
  + 10 e2e). V2.3 (markdown ↔ events reconciliation; pipelines as
  graph traversal patterns) remains open.
- **2026-05-04** — V2.1 landed: queue graph (nodes-only).
  `engine/core/queue_graph.mjs` replays `queue_node.*` workload events
  from `events.jsonl` into `Map<slug, NodeState>`. `engine/util/audit.mjs`
  factored to share envelope code; gains `appendWorkloadEvent` alongside
  `appendInfraEvent`. `artel queue` mutators (`add` / `move` / `rm`)
  switch from `queue.entry.*` infra to canonical `queue_node.*`
  workload events (`queue.` dropped from infra reserved prefixes —
  was speculative). New subcommands `artel queue ready` (dispatchable
  Pending nodes, sorted by created_at) and `artel queue graph` (full
  replay snapshot, `--json` for tooling). `events.mjs` formatter
  surfaces `node=` / `status=` / `lane=` / `from=` for the new vocab.
  DESIGN §10 rewritten — §10.1 V2.1 nodes (landed), §10.2 V2.2 edges
  (reserved prefix `queue_edge.*`, deferred), §10.3 status projection
  contract showing V2.1 explicit vs V2.2 derived. 317 tests green
  (15 new — 9 graph unit + 6 e2e).
- **2026-05-04** — `artel queue` + `artel sweep` (housekeeping pair).
  **`artel queue`** is a programmatic editor for `.artel/QUEUE.md` —
  `list` (`--section` filter, `--json`), `add` (slug + optional `--tag`
  + free-text description, default section Pending), `move --to <S>`
  (auto-stamps `[since <iso>]` when moving into In progress, strips
  on exit), `done` (sugar for `move --to "Recently done"`), `rm`.
  Bootstraps a missing QUEUE.md with the canonical 5-section
  skeleton. Each mutation emits `queue.entry.*` infra events
  (`queue.` added to RESERVED_TYPE_PREFIXES.infra).
  **`artel sweep`** prunes `.artel/.dispatches/<task>.{meta,out,prompt}`
  triplets older than `--older-than` (default 30d), excluding tasks
  in active QUEUE sections (For Owner / In progress / Pending /
  Blocked) and the newest `--keep N` dispatches (default 20).
  `--dry-run` plans only; `--json` for scripts. Emits a single
  `cluster.swept` summary event with file count + bytes freed.
  Rejects malformed `--older-than`. 302 tests green (25 new — 14
  queue + 9 sweep + 2 cross-checks).
- **2026-05-04** — Trust audit log + examples/quickstart.
  `engine/util/audit.mjs` exposes `appendInfraEvent(projectDir, type,
  payload)` — wraps SCHEMA_VERSION + envelope baseline (id / at /
  cluster_id / instance_id) for one-shot CLIs that aren't dispatch
  contexts. `trust.` added to `RESERVED_TYPE_PREFIXES.infra`. Each
  `artel trust` mutator (`set-identity` / `delete-identity` /
  `set-credential` / `delete-credential` / `gen-ssh` / `gen-key` /
  `encrypt` / `decrypt`) appends a `trust.*` infra event — values
  NEVER recorded; only names + length + non-secret metadata. Failed
  mutations don't emit. `artel events --kind infra` surfaces the
  audit trail. `examples/quickstart/` ships a copy-and-go template
  with `package.json` / `.gitignore` (covers credentials and keys) /
  `.artel/QUEUE.md` skeleton + a README walkthrough of init → probe →
  spawn → status / events → logs → replay → trust. 277 tests green
  (10 new e2e for audit). DESIGN §13.6 audit-log entry can flip from
  deferred → done in a follow-up.
- **2026-05-04** — V11.4 landed: encryption at rest for credentials.
  Pure-node `crypto.mjs` exposes `encryptJson` / `decryptJson` /
  `generateMasterKey` / `loadMasterKey` / `masterKeyPath` (AES-256-GCM,
  fresh IV per write, schema `secret-aes-256-gcm-v1`). Master key
  default at `~/.config/artel/master.key` (XDG-aware), overridable via
  `ARTEL_MASTER_KEY_FILE` (path) or `ARTEL_MASTER_KEY` (inline base64
  — CI-friendly). `trust.mjs` gains `credentialsMode` /
  `encryptCredentials` / `decryptCredentials`; `readCredentials` and
  `writeCredentials` auto-detect mode and route through the cipher
  when `.enc` is on disk. New CLI subcommands `gen-key` (writes 0600,
  refuses overwrite), `encrypt` (seals plaintext → .enc + removes
  plaintext, idempotent), `decrypt` (reverse). `artel trust list`
  shows the mode badge. Encrypted creds still flow into dispatch env
  via `requires:` — no change for downstream roles. 267 tests green
  (30 new across crypto unit + trust integration + CLI e2e).
  Encryption-at-rest closes V11. Per-cluster scoping + audit log
  remain open follow-ups but are not blocking — flagged informally,
  no [v2] entry filed.
- **2026-05-04** — V11.3 landed: trust mutators + SSH keygen.
  `artel trust` now multi-subcommand: `set-identity --author "N <e>"
  [--ssh-key]`, `delete-identity`, `set-credential` (stdin or
  `--from-env VAR` — never `--value` for shell-history safety),
  `delete-credential`, `gen-ssh <identity> [--force]`. Atomic JSON
  writes (rename-into-place); credentials.json auto-chmod 0600;
  gen-ssh shells `ssh-keygen -t ed25519 -N ''`, writes to
  `.artel/trust/keys/<name>`, updates identity's ssh_key, prints public
  key on stdout (other output to stderr — pipe-friendly). 237 tests
  green (21 new — 13 unit + 8 e2e + 3 keygen guarded by host
  `ssh-keygen` availability). Encryption-at-rest deferred (V11.4 —
  needs key-management design call).
- **2026-05-04** — V11.2 landed: credential injection.
  `.artel/trust/credentials.json` (gitignore!) — opaque token/secret
  registry keyed by env-var name. Roles declare `requires: A, B, C` in
  frontmatter; lifecycle resolves each via `resolveRequires` and merges
  into spawn env. Strict — missing names throw before the child starts
  (`requires: X but credentials.json is missing`). `artel trust list`
  shows credential **names only** — values never exposed by CLI. JSON
  shape changed to `{ identities, credentials: [names] }`. Truststore
  values override operator env on name collision. 216 tests green
  (21 new — 16 unit + 5 e2e).
- **2026-05-04** — V11.1 landed: agent identity (truststore v1).
  `.artel/trust/identities.json` registers named git identities (name +
  email + optional ssh_key path); `engine/util/trust.mjs` resolves and
  builds the env-var slice. Lifecycle injects `GIT_AUTHOR_*` /
  `GIT_COMMITTER_*` / `GIT_SSH_COMMAND` per role's `identity:`
  frontmatter, with `--identity` CLI override (CLI wins). `ARTEL_IDENTITY`
  exposed to child. Unknown names fail with helpful Known: list.
  `artel trust list` read-only inspector. Credentials (tokens / OAuth)
  and SSH keygen deferred to V11.2. 195 tests green (19 new).
- **2026-05-04** — V9 landed: mid-run heartbeats. Lifecycle emits a
  `heartbeat` event every `ARTEL_HEARTBEAT_INTERVAL_MS` (default 60s)
  while the child is alive; updates `.meta.lastHeartbeatAt` + `pidAlive`.
  `interval.unref()` so it never holds the process open past settle.
  `cleanupTimers` clears the handle on exit / timeout / error. Schema:
  added `heartbeat` to reserved workload types. Status RUNNING shows a
  `hb Ns ago` annotation coloured by freshness (green ≤90s, yellow ≤5m,
  red older). 176 tests green (5 new).
- **2026-05-04** — `artel events` — tail / filter the event stream.
  Replaces manual `tail -f .artel/events.jsonl | jq` workflow. Filters:
  `--task` / `--trace` / `--kind` / `--type` / `--since 30s|5m|2h|1d` /
  `--limit N`. Follow mode (`-f`) polls jsonl every 500ms and renders
  new appends. JSON pass-through (`--json`) for piping. Per-kind colour:
  workload cyan, signal/infra yellow, control magenta. Out-of-backlog
  QoL win. 171 tests green (8 new e2e).
- **2026-05-04** — V8 landed: `artel replay <task | dispatch-id>`.
  Resolves target by slug or dispatch_id, pulls role + prompt from
  sidecars, spawns a new dispatch with `--retry-of <orig-id>` and auto-
  generated `<orig>-replay-<short>` slug. CLI overrides for engine /
  model / task / effort / sandbox / tools / permission-mode /
  timeout-ms. Helpful errors for missing target or pre-V1 dispatches
  without a prompt sidecar. 162 tests green (6 new e2e).
- **2026-05-04** — `artel probe --json` — detailed checks + live roundtrip.
  Each driver gains an async `roundtrip()` export that invokes the engine
  with a minimal "say pong" prompt and reports `{ status, detail,
  durationMs, response }`. probe.mjs `--json` mode runs probe() (sync)
  and roundtrip() (async, parallel via Promise.all) per driver, assembles
  a `checks: [binary, auth, roundtrip]` array per engine, plus an overall
  `status: ok | degraded | down`. Plain text mode unchanged (instant
  snapshot, no model call). Flags: `--no-ping` to skip roundtrip in JSON
  mode, `--timeout-ms <n>` for per-engine timeout (default 30s).
  New `engine/util/proc.mjs` async-spawn-with-timeout helper. 156 tests
  green (2 new e2e — roundtrip ok/unexpected/skipped paths).
- **2026-05-03** — `artel status` ACTIVITY panel — surface for V10 deltas.
  Aggregates `.dispatches/*.meta` over 7d: total count, dispositions
  (`N✓ M⚠ K⏱ L✗`), summed `delta` (`+lines/-lines across N files`),
  by-role and by-engine breakdowns. Skips entirely when no dispatches in
  window. Renders between RECENT and TIMED-OUT sections. 154 tests
  green (3 new e2e).
- **2026-05-03** — `artel status` empty-state robustness. Was crashing
  with `ENOENT` on missing `.artel/QUEUE.md` (e.g. fresh init, or
  status invoked from a directory without artel runtime). Now renders
  a skeleton with friendly per-section hints — `QUEUE (no .artel/QUEUE.md
  — create one to start tracking work)`, `RUNNING  (no dispatcher_state.json
  — no active dispatcher session)`. 151 tests green (2 new e2e).
- **2026-05-03** — `artel logs <task>` — single-dispatch drilldown.
  Reads `.meta` + `.out` + `.prompt` sidecars + matching events from
  `events.jsonl`; renders a cohesive view with meta / events / prompt /
  out sections. `--json` for scripting, `--events-only` to skip body,
  `--lines N` to tail .out (default 30). Sets up V8 (replay) — same
  data assembly. 149 tests green (6 new e2e). Out-of-backlog QoL win,
  not in [v2] list.
- **2026-05-03** — V6 landed: driver plugin overlay loader.
  `engine/util/drivers.mjs` (resolveDriverPath / loadDriver / listDrivers
  / discoverDrivers). Three-layer precedence: project `.artel/drivers/`
  > user `~/.artel/drivers/` > platform. Contract validation (`args`
  required); throw helpful error on missing exports or unknown engine.
  `run.mjs`, `dispatch_lifecycle.mjs`, `probe.mjs` switched off
  hardcoded driver lists. probe shows `(project)` / `(user)` overlay
  markers. 143 tests green (12 new).
- **2026-05-03** — V10 landed: dispatch deltas + git context in telemetry.
  `engine/util/git.mjs` (gitContext + gitDelta + repoNameFromRemote);
  `dispatch_lifecycle` captures `git` pre-spawn and `delta` post-exit;
  fields flow into `.meta` and `dispatch.start/end` events. `status.mjs`
  RECENT shows `+N/-M` annotation. Non-git dirs / missing git tolerated
  (fields just absent). 131 tests green (20 new).
- **2026-05-03** — `artel probe` subcommand — engine readiness check.
  Each driver gains a `probe()` export returning
  `{ engine, binary, installed, version, authState, hint? }`. CLI iterates
  drivers and renders one line per engine plus actionable hint, exits 0
  when all ready or 1 otherwise. Auth heuristics: claude — recent jsonl
  in `~/.claude/projects/` (30d); codex — `$CODEX_HOME/auth.json` exists;
  copilot — `gh auth status` exits 0 + `gh-copilot` extension installed.
  `--json` mode for scripting. 111 tests green (5 new e2e).
- **2026-05-03** — Dashboard refresh (`status.mjs`): four density wins.
  (a) Header context line under the title — `cluster <short8> · <name>
  · branch <X> · N modified | clean` (cluster from `.artel/cluster.json`,
  branch+dirty count from git). (b) `RECENT` rows append per-dispatch
  duration `(42s)` / `(3m)` derived from `meta.dispatchedAt` ↔
  `meta.completedAt`. (c) `QUEUE` expands `PENDING` and `BLOCKED`
  sections with task names (was: counts only) — `BLOCKED` gets a yellow
  `!` marker. (d) `TOKENS` rows prefix per-engine auth-health marker
  (`✓` recent success / `⚠` recent auth-expired park / `?` unknown),
  derived from `.dispatches/*.meta` over the last 24h. 106 tests green
  (4 new e2e for the panel).
- **2026-05-03** — Bug fix: cross-namespace `model:` values crashed codex
  dispatches with API 400 on ChatGPT-account auth (`opus` forwarded
  verbatim to `-m`). Both codex and claude drivers now filter foreign
  namespaces in `meta.model` per MIGRATION.md §1's "silent ignore"
  contract — codex drops `opus|sonnet|haiku|claude-*`, claude drops
  `gpt-*|o\d|chatgpt-*|codex-*`. Legacy `codex-model:` / `copilot-model:`
  bypass the filter (engine-specific by definition). Copilot left
  unchanged (proxies both namespaces). 102 tests green (20 new — 11
  codex-namespace + 9 claude-namespace cases).
- **2026-05-03** — Owner TODO captured: V10 (dispatch deltas + git context in
  telemetry — `delta: { files_changed, lines_added, lines_removed }` +
  `git: { commit_sha, branch, repo_name }` on `dispatch.end` / `.meta`)
  and V11 (agent identity & truststore — dedicated git ident + SSH per
  agent/cluster, plus a credential-vault abstraction for tokens / OAuth /
  API keys).
- **2026-05-03** — Published `@antongolub/artel@0.0.1` to npm. CLI shape
  collapsed from five hyphenated bins to a single `artel <cmd>` dispatcher
  (`engine/cli/artel.mjs`). 82 tests green (5 new for dispatcher routing).
- **2026-05-03** — Architectural refactor sweep, post-MVP cleanup before
  public publish. Twelve themed blocks landed in one commit:
  1. README rewrite (research-frame) + LICENSE (MIT) + package.json
     publish-prep (bin / files / publishConfig / engines / keywords /
     prepublishOnly gate)
  2. Layered structure: `engine/{cli,core,drivers,util}/` — entry
     points, platform primitives, provider adapters, helpers split
  3. Native `node:util#parseArgs` + template-literal usage strings
     across run / spawn / init / checkpoint CLIs
  4. Util extraction: `util/frontmatter.mjs` (parser + legacy-key
     normaliser), `util/fs.mjs` (walkJsonl / readJsonl / mtimeMs),
     `util/ids.mjs` (uuidv7)
  5. Drivers refactored to use `util/fs`; duplicate `nonce` dropped
     (uuidv7 replaces it everywhere)
  6. `cluster.mjs` simplified — unused `clusterIdOf` + cached
     singleton dropped
  7. Role frontmatter metadata trio: `schema` / `version` /
     `updated_at` (mandatory in v1, ISO-8601 UTC)
  8. `PROTECTED_RESET_ROLES` set in core removed → per-role
     `protected_branch: true` frontmatter; platform names no specific
     roles
  9. Hardcoded role-name lists in status / state_gen replaced with
     runtime discovery from `agents/` + `drivers/`
  10. `state.md` and `status.mjs` decoupled — single source of truth
      principle. Both are independent projections over canonical
      inputs; neither feeds the other. `state.md` trimmed 368 → 227
      lines, narrative body moved out
  11. Skills layer: roles declare abstract `skills:` (file-edit /
      git-write / package-manager / test-runner / …); platform ships
      12 defaults under `skills/`; projects override in
      `.artel/skills/`. Stack swap (npm→bun) = one file edit, no role
      changes
  12. status.mjs delegates per-provider session-token aggregation to
      drivers — provider paths (`~/.claude`, `~/.codex`, `~/.copilot`)
      live in their drivers, not in the runner
  13. Frontmatter contracts: `engine/util/contract.mjs` with
      `validateRoleFrontmatter` (role-v1) and
      `validateSkillFrontmatter` (skill-v1). Validators enforce the
      schema/version/updated_at trio + type-specific required fields.
      Wired into `engine/cli/run.mjs` (role load) and
      `engine/util/skills.mjs` (skill load); files that fail
      validation are rejected before any side-effects.

  DESIGN.md §2 reformulated around single-source-of-truth + independent
  projections. §8 expanded to "Role file format" with sub-sections
  §8.2 (frontmatter contracts), §8.3 (skills), §8.4 (protected_branch).
  MIGRATION.md gains §12 (role metadata), §13 (protected_branch),
  §14 (skills).

  75 tests + typecheck green throughout (8 new contract tests).

- **2026-05-02** — C10 done. `MIGRATION.md` shipped — full consumer
  upgrade guide for all 9 MVP feature commits + test infra notes + v2
  follow-up index.
- **2026-05-02** — C9 done. status.mjs renders usage + retry annotations;
  state_gen.mjs surfaces cluster_id / cluster_name in frontmatter.
  67 tests green (3 new).
- **2026-05-02** — C8 done. Role dispatch policies (dispatchable /
  non-dispatchable frontmatter) + guard in lifecycle. Platform roles
  declared. 64 tests green (7 new).
- **2026-05-02** — C7 done. Sub-role checkpoint API shipped
  (`engine/checkpoint.mjs`) + role briefs updated. 57 tests green
  (4 new for checkpoint).
- **2026-05-02** — C6 done. Retry tracking via retry_of/retry_count/
  retry_reason fields. signal.backoff_required at threshold (default 3).
  53 tests green (5 new).
- **2026-05-02** — C5 done. Driver `parseUsage` hook + codex
  implementation (walks ~/.codex/sessions, last token_count event).
  Lifecycle merges into dispatch.end + .meta. 48 tests green (5 new).
- **2026-05-02** — C4 done. Event rename `claim`→`dispatch.start`,
  `release`→`dispatch.end`. Back-compat read in state_gen + status for
  one cycle. 43 tests green (2 new).
- **2026-05-02** — C3 done. Tracing fields wired through events / .meta /
  env propagation. dispatchLifecycle reads parent from env, emits
  dispatch_id/trace_id/parent_*. 41 tests green (4 new for tracing).
- **2026-05-02** — C2 done. Cluster identity bootstrap + schema baseline
  (`engine/{schema,cluster,init}.mjs`). All events now carry mandatory
  fields + reserved namespaces + fence_token=0. 37 tests green (16 new).
- **2026-05-02** — C0 + C1 done. Universal driver terms live; deprecation
  warnings in place; back-compat preserved for one cycle. 21 tests green
  (17 new driver-translation tests + 1 canonical-flag smoke).
- **2026-05-02** — MVP carve. Phase reshape under parent-project urgency.
  Phases 0–5 from prior plan compressed to C0–C10. Phase 6 + heavier
  refactors moved to `[v2]` with namespaces reserved. Defaults locked
  for Q1–Q4.
- **2026-05-02** — Initial plan draft. Phases 0–5 locked, Phase 6
  deferred with namespaces reserved. Open Q1–Q4 awaiting owner.
