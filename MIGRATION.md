# Migration notes — MVP (C1–C10)

> Audience: consumer projects upgrading to the post-MVP artel engine.
> Scope: changes that may need consumer-side action. Internal refactors
> not requiring consumer changes are omitted.
>
> Strategy: ship MVP with **back-compat** for one cycle. Deprecation
> warnings flag legacy usage; remove after consumers migrate.

## TL;DR

| Change | Action required |
|---|---|
| Universal driver terms (`model` / `effort` / `sandbox` / `tools` / `permission-mode`) | Rename engine-specific frontmatter keys; back-compat for one cycle |
| Event rename `claim`/`release` → `dispatch.start`/`dispatch.end` | Read-side accepts both for one cycle; update any direct consumers |
| New `.artel/cluster.json` (auto-bootstrapped) | Add to `.gitignore` |
| New env vars (auto-set) | None |
| New role frontmatter keys (`dispatchable`/`non-dispatchable`) | Optional; default = `all` (back-compat) |
| Sub-role `checkpoint.mjs` API | Optional; opt-in via tool surface + role-brief paragraph |
| Event schema enrichment (mandatory fields) | None — additive on read |
| Role frontmatter metadata (`schema` / `version` / `updated_at`) | Add to each consumer role file (see §12) |

## 1. Universal driver terms (C1)

Runner CLI and role frontmatter speak universal terms; drivers translate.

**Frontmatter renames:**

| Legacy | Canonical |
|---|---|
| `codex-model` | `model` |
| `codex-effort` | `effort` |
| `copilot-model` | `model` |
| `copilot-tools` | `tools` |

Legacy keys are still read for one cycle and emit a deprecation warning
to stderr. Migrate when convenient.

**CLI flag rename:**

```diff
- node $ARTEL_HOME/engine/cli/spawn.mjs <role> <task> --codex-effort xhigh ...
+ node $ARTEL_HOME/engine/cli/spawn.mjs <role> <task> --effort xhigh ...
```

`--codex-effort` still works for one cycle (warns).

**New CLI flags** on `run.mjs` and `spawn.mjs`:

```
--model <name>             override model
--effort <level>           reasoning effort (codex)
--sandbox <mode>           read-only|workspace-write|full-access
--tools <list>             tool allowlist (comma-sep)
--permission-mode <mode>   permission mode (claude)
```

CLI override > role frontmatter > engine default. Drivers without an
analog for a key silently ignore (documented in driver header comments).

**Driver contract:**

Drivers now export `api_version` (currently `1`). Custom drivers should
declare it:

```js
export const id = '<engine>'
export const command = '<bin>'
export const api_version = 1
export function args (meta, promptParts, session) { ... }
export function parseUsage (outPath, sessionId) { ... }  // optional
```

## 2. Cluster identity (C2)

New file: **`.artel/cluster.json`**, auto-created on first dispatch by
`engine/core/cluster.mjs#ensureClusterIdentity` or via `engine/cli/init.mjs`:

```json
{
  "cluster_id": "01934f00-…UUID-v7…",
  "name": "<derived from project dir or --name>",
  "created_at": "2026-05-02T…",
  "schema": "cluster-v1"
}
```

**Action: add `.artel/cluster.json` to your `.gitignore`.** Each
developer / install gets its own cluster_id. Federation (when v2 lands)
relies on independent ids per cluster.

You can run the bootstrap explicitly:

```bash
node $ARTEL_HOME/engine/cli/init.mjs --name my-cluster
```

Idempotent — re-running prints the existing identity without changes.

## 3. Event schema baseline (C2)

Every event in `.artel/events.jsonl` now carries mandatory fields:

```
schema: "v1"
kind: "workload" | "infra" | "signal" | "control"
type: <e.g. "dispatch.start">
id: <UUID v7>
at: <ISO-8601 UTC>
cluster_id: <UUID v7>
instance_id: <UUID v7, per-process>
```

Workload events also carry `fence_token: 0` (reserved for v2 federation
claim enforcement; no current effect).

Existing events written by older code lack these fields but remain
readable — `state_gen.mjs` and `status.mjs` tolerate their absence.

**Reserved type prefixes** (validated, unknown rejected):
- `workload`: `dispatch.*`, `checkpoint`, `parked`, `unparked`,
  `escalation`, `review-result`, `superseded`, `owner-answer`,
  `queue_node.*`, `queue_edge.*`, `pipeline.*`, `pipeline_run.*`,
  legacy `claim` / `release`
- `infra`: `cluster.*`, `role.*`, `engine.*`, `model.*`, `policy.*`
- `signal`: `signal.*`
- `control`: `control.*`

If you emit custom events directly, ensure they fall under a reserved
prefix or extend `engine/core/schema.mjs#RESERVED_TYPE_PREFIXES`.

## 4. Tracing (C3)

New event fields:
```
dispatch_id          <UUID v7>     per execution
trace_id             <UUID v7>     root chain (= top-level dispatch_id)
parent_dispatch_id   <UUID v7?>    direct parent, only when nested
parent_role          <string?>     parent role name, only when nested
```

New env vars (set automatically by `dispatch_lifecycle` and propagated by
`run.mjs` to the engine CLI subprocess):
```
ARTEL_DISPATCH_ID
ARTEL_TRACE_ID
```

(plus existing `ARTEL_TASK`, `ARTEL_ROLE`, `ARTEL_TASK_ATTRS`.)

Top-level dispatch (Anton's chat → spawn.mjs) sees no parent in env.
Nested dispatches (a sub-role's engine CLI shells out to spawn.mjs again)
inherit env and record the parent.

**No consumer action.** Reconstruct trace trees by grouping events by
`trace_id`, ordering by `id` (UUID v7 = lexicographic time-prefix).

## 5. Event rename (C4)

| Legacy | Canonical |
|---|---|
| `claim` | `dispatch.start` |
| `release` | `dispatch.end` |

New events emit canonical names. Read side (`status.mjs` / `state_gen.mjs`)
accepts both for one cycle. Existing events.jsonl remains valid.

If your tooling reads `events.jsonl` directly and filters by `type`, add
the canonical name to your filters.

## 6. Driver usage capture (C5)

Drivers now optionally export `parseUsage(outPath, sessionId)`:

```js
export function parseUsage (outPath, sessionId) {
  // Returns { tokens_in, tokens_out, cache_read, cache_creation,
  //           model, cost_usd } | null
}
```

`dispatch_lifecycle` calls it post-exit. Result is merged into:
- `dispatch.end` event payload (`usage` key)
- `<task>.meta` sidecar (`usage` key)

**Implementations:**
- `codex`: walks `~/.codex/sessions/`, finds rollout file by id, reads
  last `token_count` event. `cost_usd` is null (codex doesn't expose).
  Override sessions dir via `ARTEL_CODEX_SESSIONS_DIR`.
- `claude`: returns null. Wiring `--output-format json` deferred to v2.
- `copilot`: returns null. CLI has no per-dispatch surface.

**No consumer action.** When usage data is available, it appears
automatically in events / meta / `status.mjs` annotations.

## 7. Retry tracking (C6)

New fields on `dispatch.start`:
```
retry_of      <UUID v7?>   prev dispatch_id this attempt retries
retry_count   <number?>    0 = first; +1 if same engine+model as prev
retry_reason  <string?>    derived from prev dispatch.end disposition
```

CLI: `spawn.mjs --retry-of <prev_dispatch_id>`.

Counter rule: same engine + same effective model as the previous attempt
→ increment. Different → reset to 0 (new chain).

When `retry_count >= backoffThreshold` (default 3), a
`signal.backoff_required` event is emitted (`kind: signal`). Subscribe
to surface backoff prompts to the orchestrator/dispatcher.

`backoffThreshold` is configurable per `dispatchLifecycle` call (no CLI
flag yet).

## 8. Sub-role checkpoint API (C7)

New CLI: `engine/cli/checkpoint.mjs`. Sub-roles call it between phases of
their work:

```bash
node $ARTEL_HOME/engine/cli/checkpoint.mjs \
  --completed "<what just finished>" \
  --next "<what comes next>" \
  [--artefact <path>] [--notes "..."]
```

Reads task / role / dispatch_id / trace_id from `ARTEL_*` env (set
automatically by `run.mjs`). Appends a `checkpoint` event.

**Action: add to relevant role files.**

1. Tool surface (if not already covered by `Bash(node *)`):
   ```
   tools: …, Bash(node *engine/cli/checkpoint.mjs*)
   ```
   `implementer` / `dispatcher` / `orchestrator` are already covered by
   `Bash(node *)`. `architect` adds the narrow entry. `cold-reader` /
   `adversary` / `maintainer` are one-shot critique roles — checkpoint
   not applicable.

2. Body paragraph in role brief — see `agents/implementer.md` and
   `agents/architect.md` in the platform repo for examples.

## 9. Role dispatch policies (C8)

New frontmatter keys:
```yaml
dispatchable: all | none | <comma-list>     # allowlist; default 'all'
non-dispatchable: <comma-list>               # denylist on top
```

`dispatch_lifecycle` reads parent role from `ARTEL_ROLE` env, looks up
parent's frontmatter, and rejects nested dispatches that violate policy.
Top-level dispatch (no env) skips check.

**Default = `all`** (back-compat). Existing role files without the key
behave as before.

**Recommended explicit policies** (matching platform agents/):
- `dispatcher`: `dispatchable: all`
- `orchestrator`: `dispatchable: all` + `non-dispatchable: orchestrator`
- leaf roles (`implementer` / `architect` / `cold-reader` / `adversary`
  / `maintainer`): `dispatchable: none`

If your project has custom roles that should not spawn anything, add
`dispatchable: none` to lock them down.

## 10. Status / state_gen surface (C9)

`engine/cli/status.mjs` `RECENT` panel now annotates each row with token
usage `[<in>/<out>t]` (when meta has usage) and retry indicator `r<N>`
(when retry_count > 0).

`engine/cli/state_gen.mjs` frontmatter adds `cluster_id` + `cluster_name`
read from `.artel/cluster.json`.

**No consumer action.** Pass-through of new fields into existing
artefacts.

## 11. Test infrastructure expectations

The platform ships:
- `package.json` scripts: `test` (vitest), `typecheck` (tsc --noEmit)
- `tsconfig.json` with `allowJs` + bundler resolution
- `vitest.config.ts` with `test/**/*.test.ts` glob

Consumer projects typically maintain their own test infra. The
`engine/test/` directory inside the platform is platform-internal and
should not be vendored into consumer repos.

## 12. Role frontmatter metadata

Each `agents/<role>.md` now declares schema + version + last-updated date
in its frontmatter:

```yaml
schema: role-v1                          # frontmatter schema version
version: 1                               # role content version, bumped on edit
updated_at: 2026-05-03T00:00:00.000Z     # ISO-8601 UTC timestamp of last edit
```

**Action: add these three fields to each consumer role file**, then
bump `version` and refresh `updated_at` whenever you edit the body or
frontmatter.

Tooling uses these fields to detect drift between platform-shipped and
consumer-overlayed roles, surface stale roles in dashboards, and gate
v2 schema migrations. Unknown frontmatter keys remain ignored, so
adding the trio is non-breaking.

## Open follow-ups (post-MVP)

Tracked in `PLAN.md` as `[v2]`:
- Repository abstraction + non-fs backends (sqlite / postgres / git /
  http)
- Queue graph model (typed edges, projection-based status)
- Pipeline registry + engine
- Capability manifest + federation transports
- Real claim/lease + fence_token enforcement
- Driver `api_version` + plug-in overlay loader (`.local/drivers/`,
  project `.artel/drivers/`)
- Infra reconcile pass + availability events
- Replay tooling (`engine/replay.mjs`)
- Mid-run heartbeats from lifecycle

Schema reservations are already in place — v2 features will land without
schema migrations.
