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
| V2 | Queue graph model | `[v2]` | Flat sections in `QUEUE.md` cover parent project's flow. |
| V3 | Pipeline registry + engine | `[v2]` | Orchestrator does flow-routing in-LLM today. Formalisation post-MVP. |
| V4 | Capability manifest + federation | `[v2]` | Parent project is single-cluster. |
| V5 | Real claim/lease + fence enforcement | `[v2]` | Federation-only. Field reserved in C2; enforcement follows. |
| V6 | **Driver plugin overlay loader** | `[done]` | `engine/util/drivers.mjs` resolves `<engineId>.mjs` across three layers (project `.artel/drivers/` → user `~/.artel/drivers/` → platform). `loadDriver` validates the contract (`args` required); `discoverDrivers` returns `{id, source, module}` for every visible engine. `run.mjs` and `dispatch_lifecycle.mjs` use the loader; `probe.mjs` discovers all drivers dynamically and shows `(project)` / `(user)` overlay markers. `api_version` already exported by all in-tree drivers (since C5). 143 tests green (12 new — 8 unit on loader + 3 overlay e2e + 1 driver-list assertion). |
| V7 | Infra reconcile pass + availability events | `[v2]` | `cluster.heartbeat` ships in C2; `role.*` / `engine.*` lifecycle events when needed. |
| V8 | **Replay tooling** | `[done]` | `artel replay <task | dispatch-id>` re-runs a past dispatch on the same or a different engine. Resolves target by slug (most-recent meta) or UUID v7 dispatch_id; pulls role + prompt from `.meta` and `.prompt` sidecars; spawns a new dispatch with auto-generated slug `<orig>-replay-<short>` and `--retry-of <orig-id>` so the chain reconstructs from events.jsonl. Flags: `--engine`, `--model`, `--task` (override slug), `--effort`, `--sandbox`, `--tools`, `--permission-mode`, `--timeout-ms`. Errors helpfully when target / prompt missing. 162 tests green (6 new e2e). |
| V9 | **Mid-run heartbeats from lifecycle** | `[done]` | Lifecycle emits a `heartbeat` event every `ARTEL_HEARTBEAT_INTERVAL_MS` (default 60s) until the child exits or settles, plus updates `.meta.lastHeartbeatAt` + `.meta.pidAlive`. `0` disables. `heartbeat` added to reserved workload types in schema. `interval.unref()` so a stuck heartbeat can never keep node alive past settle. Status RUNNING gets a `hb Ns ago` annotation coloured by freshness (green ≤90s, yellow ≤5m, red older). 176 tests green (5 new — 4 unit + 1 status e2e). |
| V10 | **Dispatch deltas + git context in telemetry** | `[done]` | `engine/util/git.mjs` exposes `gitContext` + `gitDelta`. Lifecycle calls `gitContext` pre-`markRunning` (captures `commit_sha` / `branch` / `repo_name` — origin URL parsed; SSH + HTTPS; falls back to project basename). Calls `gitDelta(commit_sha)` post-exit (working-tree diff via `git diff --shortstat <sha>` covers committed + uncommitted, tracked-only). Both flow into `dispatch.start` / `dispatch.end` event payloads + `.meta` sidecar. `status.mjs` RECENT row gets `+N/-M` delta annotation when present. Tolerates non-git dirs / git-not-on-PATH. 131 tests green (20 new — 11 git unit + 1 spawn e2e + 1 status e2e + existing). |
| V11 | **Agent identity (truststore v1)** | `[done]` | `.artel/trust/identities.json` registers named git identities (`name` / `email` / optional `ssh_key`). Roles declare `identity: <name>` in frontmatter; `--identity` CLI overrides per-dispatch; `ARTEL_IDENTITY` env exposed to the child. Lifecycle injects `GIT_AUTHOR_*` / `GIT_COMMITTER_*` / `GIT_SSH_COMMAND` (path shell-quoted, `IdentitiesOnly=yes`). Unknown name fails dispatch with `Known: ...` list. `artel trust list` is read-only inspector (`--json`). Credentials axis (tokens / API keys via parallel `credentials.json`) deferred to V11.2. SSH key generation deferred — user provides path. 195 tests green (19 new — 12 unit + 7 e2e). |

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
