# Agents and protocol

## Cooperative principle

**Bus factor 1 is the failure mode.** Each agent has a *primary lane* —
what they are best at — but every lane is shared. When work overlaps,
prefer to finish than to hand off; hand-offs are opportunistic, not
territorial.

## Topology

```
                ┌──────────┐               ┌──────────────────┐
                │  HUMAN   │ ─ observes ─► │  status.mjs      │
                └────┬─────┘               │   --watch        │
                     │ chat                └─────────┬────────┘
                     ▼                               │ reads
              ┌──────────────┐                       ▼
              │  DISPATCHER  │            QUEUE.md / branches /
              │  routine PM  │            JOURNAL.md / sessions
              └─┬──────────┬─┘
       escalate │          │ direct dispatch
                ▼          ▼
       ┌──────────────┐   ┌────────────────────────┐
       │ ORCHESTRATOR │   │  SUB-ROLES (1-shot)    │
       │  persistent  │─► │   architect            │
       │   session    │   │   implementer          │
       └──────────────┘   │   cold-reader          │
                          │   adversary            │
                          │   maintainer           │
                          └────────────────────────┘

Drivers: claude / codex / copilot (per-role frontmatter).
```

Owner talks only to the **Dispatcher** (this chat) — single interface.
Dispatcher handles routine — status, queue moves, direct sub-role
dispatch — without touching the Orchestrator. **Orchestrator** is a
persistent session (any driver — claude / codex / copilot — set per
cluster), escalated for strategy / coordination / integration.
**Sub-roles** are one-shot subprocesses dispatched through driver CLIs;
a new driver is ≈ 50 lines. Owner observes via
[`status.mjs --watch`](./engine/cli/status.mjs).

## Cast

- **Owner** — direction, priorities, taste, gates architectural shifts.
  Does not commit to minutiae or full code review. Style: terse,
  decisive — one-liner redirections are load-bearing.
- **Claude** — primary lane: spec, ADRs, multi-file coherence, review,
  research. Secondary: anything idle and within reach.
- **Codex** — primary lane: implementation, mechanical refactors at
  scale, test iteration. Secondary: spec edits within scope; raises
  Open questions when impl reveals genuine ambiguity.
- **Copilot** — implementation alternative. Useful for parallelism,
  when Codex is queued, or for distance-from-authoring-bias review.

Project-specific role overrides go in the consumer project's own
`.artel/AGENTS.md` augmentation, not here.

## Dispatching roles

Four ways to invoke a sub-role:

- **In-thread switch** — recast for one beat, return. Cheapest.
- **Task tool** — spawn from inside the session. No project context
  unless the brief carries it.
- **CLI dispatcher** — `node $ARTEL_HOME/engine/cli/run.mjs <role>`
  shells a separate driver process with the role's pre-approved tool
  surface.
- **Spawn wrapper** — `spawn.mjs` adds task sidecars / branch precreate
  and a per-dispatch wall-clock timeout (default 30m, override via
  `--timeout-ms` or `ARTEL_DISPATCH_TIMEOUT_MS`).

Roles live at [`agents/<role>.md`](./agents/) — frontmatter declares
engine / model / tools / permission-mode; body is the system prompt.
List with `run.mjs --list`.

## Protocol

- **QUEUE.md** — flat shared backlog grouped by status (`For Owner` /
  `In progress` / `Pending` / `Blocked` / `Recently done`). Lane tags
  (`[spec]`, `[impl]`, `[research]`, `[review]`, `[infra]`) are *fit
  hints*, not assignments. Claim by moving to `In progress` with a
  branch slug; completion moves to `Recently done`. Orchestrator sweeps
  to JOURNAL during integration.
- **JOURNAL.md** — significant events (decisions, failed attempts,
  surprises, scope shifts). Append-only, newest at top.
- **Spec / code** — through the project's normal homes, never `.artel/`.
  This directory holds *coordination*, not artefacts.
- **ADRs** — in the project's ADR home. Architectural only, not for
  tooling/operations choices.
- **Conflicts** — Claude reconciles by default; escalate substantive
  conflicts to the owner.
- **Stalled session pickup** — read AGENTS.md, scan JOURNAL top, look
  at QUEUE for what's open.

## Branching and integration

**Only the owner commits to `master`.** Agents carry work onto master's
working tree (uncommitted) and ping when ready. Every write to master's
history is reviewed and accepted by a human — bus-factor invariant
applied to the merge boundary.

- **Agent branches** — `<agent>/<short-topic-slug>`. Imperative,
  descriptive.
- **Submission flow:**
  1. Agent finishes on its branch, marks QUEUE entry `done`.
  2. Claude `git checkout master`, `git merge --squash <branch>` (stages
     diff without committing). Repeat per ready branch; resolve
     conflicts in the working tree.
  3. `npm test` + `npm run typecheck`.
  4. Ping owner: "ready to commit". Owner runs `git commit` — owns
     message and granularity (one combined commit, or separate per
     branch — their call).
  5. After commit, Claude deletes the agent branch.
- **Force-push** allowed on agent branches; never on master.
- **After commit**, agents start fresh branches — do not continue on
  the integrated branch.
- **Stale agent branches** (no activity for several sessions) pruned by
  Claude during integration sweeps.

## Self-challenge

When the owner is unavailable, Claude pre-validates non-trivial changes
via one of the personas in [CHALLENGE.md](./CHALLENGE.md) — Cold Reader
(spec clarity), Adversary (correctness / attack surface), Maintainer
(deadweight). In-thread switch (cheap) or spawned subagent (rigorous;
no project context = the point).

**Verification before "ready to commit" is mandatory** for:

- generated artefacts (fixtures, codegen, derived data)
- spec docs moving to `preview` or `stable`
- ADRs flipping from `proposed` to `accepted`
- multi-file refactors touching ≥ 5 files

A spawned subagent in the appropriate persona must run before pinging.
Findings fold into the change or get explicit rejection notes. Pinging
with unverified work in these classes is a protocol violation —
verification cannot be the owner's steady-state job.

## Invariants

- **Bus factor > 1** for every active lane. If a lane drifts to single-
  agent ownership beyond a session or two, restructure to share.
- **Spec is the source of truth.** Code that diverges = bug. Spec that
  contradicts validated reality = bug fixed by spec change.
- **Append-only ADRs. Append-only JOURNAL. Mutable QUEUE.**
- **Compactness in everything written here.** Match the project's
  conventions.
