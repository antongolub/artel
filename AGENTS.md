# Agents and protocol

## Cooperative principle

**Bus factor 1 is the failure mode.** Each agent has a *primary lane* —
what they are best at — but every lane is shared. Any work that ends up
gated on a single agent is a future stall. When work overlaps, prefer
to finish than to hand off; hand-offs are opportunistic, not
territorial.

## Topology

```
                  ┌──────────┐                  ┌──────────────────┐
                  │  HUMAN   │ ── observes ───► │  status.mjs      │
                  └────┬─────┘                  │   --watch        │
                       │ chat (single session)  └────────┬─────────┘
                       ▼                                 │ reads
                ┌──────────────┐                         ▼
                │  DISPATCHER  │              QUEUE.md / branches /
                │  me — PM     │              JOURNAL.md / sessions
                │  routine +   │
                │  shielding   │
                └─┬──────────┬─┘
        escalate  │          │  direct dispatch
        strategy  │          │  (one-shot subprocesses)
                  ▼          ▼
        ┌──────────────┐    ┌────────────────────────┐
        │ ORCHESTRATOR │    │       SUB-ROLES        │
        │  tech lead   │ ─► │   architect            │
        │  persistent  │    │   implementer + codex  │
        │   session    │    │   cold-reader          │
        └──────────────┘    │   adversary            │
                            │   maintainer           │
                            └────────────────────────┘
```

**Read it as.** The owner talks only to the **Dispatcher** (this chat) — single interface. The Dispatcher handles routine — status, queue moves, direct sub-role dispatch — without touching the Orchestrator. The **Orchestrator** is a *persistent* Claude session (not respawned per task) and is escalated only for strategy / coordination / integration; it can also dispatch sub-roles when planning. **Sub-roles** are *one-shot* subprocesses per [`agents/<role>.md`](./agents/), plus Codex as an external CLI for implementation. The owner observes via [`engine/cli/status.mjs --watch`](./engine/cli/status.mjs) in parallel — that's where movements surface (queue, branches, tokens).

## Cast

### Owner — vision / scope / accept-reject

- Owns: direction, priorities, taste, gating of architectural shifts.
- Commits to: validating direction, answering "why are we doing this"
  questions, accepting or rejecting proposals.
- Does NOT commit to: minutiae (we research those), implementing code,
  full code review of every change.
- Style: terse, decisive, expects compactness. When they give a one-liner
  redirection, treat it as load-bearing.

Project-specific domain context (industries the owner has worked in, prior
art the owner has authored, etc.) belongs in the consumer project's own
`.artel/AGENTS.md` augmentation or `.artel/PROJECT.md`, not here.

### Claude

- **Primary lane:** spec, ADRs, design discussions, multi-file
  coherence, cross-cutting refactors, code review. Also handles
  research duties (WebSearch / WebFetch) until Perplexity returns.
- **Secondary lanes:** implementation (production code, tests, fixture
  generation, debugging), running and iterating against tests.
- **Picks up:** anything idle and within reach. If Codex is busy or
  blocked, Claude implements directly. Spec is not Claude's monopoly
  either — Codex contributes spec clarifications within its scope.

### Codex

- **Primary lane:** implementation — production code, tests,
  mechanical refactors at scale, running test suites, iterating
  against failures.
- **Secondary lanes:** spec edits within scope (clarifying a row or
  cell while writing the code that satisfies it), proposing minor
  refactors, raising Open questions when impl reveals genuine
  ambiguity (do not silently improvise).
- **Picks up:** well-specified implementation tasks. Free to propose
  spec fixes alongside the code that motivated them.

### Perplexity — researcher (deferred)

On hold: no official CLI, third-party wrappers are unstable. When a
durable invocation path exists, Perplexity takes the research lane
back from Claude. Until then research notes in the project's
`.artel/research/` are produced by Claude.

## Dispatching roles

The interactive Claude session is the **orchestrator**. Three ways to invoke a sub-role:

- **In-thread switch** — recast for one beat, return. Cheapest; sanity-checks and quick critiques.
- **Task tool** — spawn from inside the session via the `Agent` tool. The subagent has no project context unless the brief carries it. Use for parallelism, or when distance from authoring bias is the point.
- **CLI dispatcher** — `node $ARTEL_HOME/engine/cli/run.mjs <role> "..."` shells out a separate `claude -p` process with the role's pre-approved tool surface. Use when the permission scope is load-bearing (no per-action grant prompts), or when orchestrator context isn't useful.
- **Spawn wrapper** — `node $ARTEL_HOME/engine/cli/spawn.mjs <role> <task> ...` adds task sidecars / branch precreate around `run.mjs` and enforces a per-dispatch wall-clock timeout (default 30m, override via `--timeout-ms` or `ARTEL_DISPATCH_TIMEOUT_MS`; timed-out runs release with disposition `timeout`).

Roles live at [`agents/<role>.md`](./agents/) — frontmatter declares `tools`, `permission-mode`, `model`; body is the system prompt. Adding a role = adding a file. List with `node $ARTEL_HOME/engine/cli/run.mjs --list`.

The Cooperative principle still applies: don't bounce for the sake of bouncing. Dispatch when the other surface helps — finish in-session otherwise.

## Protocol

- **State of work** lives in [QUEUE.md](./QUEUE.md) as a flat shared
  backlog grouped by status (`For Owner` / `In progress` / `Pending` /
  `Blocked` / `Recently done`) — no per-agent sections. Lane tags
  (`[spec]`, `[impl]`, `[research]`, `[review]`, `[infra]`) are *fit
  hints*, not assignments — Cooperative principle. Each agent claims by
  moving an entry to `In progress` with its branch slug; completion
  moves it to `Recently done`. Orchestrator sweeps `Recently done` to
  JOURNAL during integration (target buffer: last 1–2 entries).
- **Hand-offs are opportunistic.** If Claude finishes a task that
  technically falls in Codex's primary lane, that's fine — no
  bouncing for the sake of bouncing. Hand off when the *other* agent's
  strengths actually help (volume, parallelism, distance from
  authoring bias).
- **Significant events** (decisions, failed attempts, surprises, scope
  shifts) append to [JOURNAL.md](./JOURNAL.md), newest at top.
- **Spec / code changes** go through the project's normal homes (its
  spec / source directories), never through `.artel/`. This directory
  holds *coordination*, not artefacts.
- **Decisions that warrant ADRs** go in the project's ADR home (e.g.
  `spec/decisions/` or whatever convention the project uses). ADRs are
  for *architectural* decisions affecting the problem domain — not for
  tooling/operations choices.
- **Conflicting changes** between agents: Claude reconciles by default
  (architect role); escalate to the owner if substantive.
- **Long-stalled session pickup:** read AGENTS.md, scan JOURNAL top,
  then look at QUEUE for what's open.

## Branching and integration

**Only the owner commits to `master`.** Claude carries the work *onto*
master's working tree (uncommitted) and calls the owner when it's time.
This is the bus-factor invariant applied to the merge boundary: every
write to master's history is reviewed and accepted by a human.

- **Agent work** lives on branches named `<agent>/<short-topic-slug>` —
  `claude/spec-refine`, `codex/yarn-classic-parser`. Slugs imperative
  and descriptive.
- **Claude owns transfer to master:** cherry-picks, rebases, squashes
  and conflict resolution land in master's *working tree*, never as
  commits on master.
- **Submission flow:**
  1. Agent finishes work on its branch and marks the QUEUE entry
     `done`.
  2. Claude:
     - `git checkout master`
     - brings the agent branch's changes onto master's working tree:
       typically `git merge --squash <branch>` (stages the diff without
       creating a commit). For multiple ready branches, repeat per
       branch and resolve conflicts in the working tree.
     - runs `npm test` + `npm run typecheck`.
  3. Claude pings the owner: "ready to commit" — the owner runs `git commit`.
     the owner owns message and granularity (one combined commit, or
     separate per branch — their call).
  4. After the owner commits, Claude deletes the agent branch (or archives
     if useful for history).
- **Force-push** is allowed on agent branches (rebases require it).
  Master is never force-pushed.
- **After the owner commits**, agents pull master and start fresh branches
  for the next topic. They do not continue on the integrated branch.
- **Stale agent branches** (no activity for several sessions) are
  pruned by Claude during integration sweeps.

## Self-challenge

When the owner is unavailable, Claude pre-validates non-trivial changes via
one of the personas in [CHALLENGE.md](./CHALLENGE.md) — Cold Reader
(spec clarity), Adversary (correctness / attack surface), or
Maintainer (deadweight). Two modes: in-thread switch (cheap) or
spawned subagent (rigorous; no project context = the point).

**Verification before "ready to commit" is mandatory** for these
artefact classes:

- generated artefacts (fixtures, codegen output, derived data)
- spec docs moving to `preview` or `stable`
- ADRs about to flip from `proposed` to `accepted`
- multi-file refactors that touch ≥ 5 files

For these, Claude **must** run a spawned subagent in the appropriate
persona before pinging the owner. The subagent's findings either fold
into the change or get explicit rejection notes. Pinging the owner with
unverified work in these classes is a protocol violation —
verification cannot be the owner's job in steady state, that's the bus-
factor invariant collapsing onto the owner.

## Invariants

- **Bus factor > 1** for every active lane. If a lane drifts to single-
  agent ownership for more than a session or two, restructure the work
  to share it again.
- Spec is the source of truth. Code that diverges from the spec is a
  bug. Spec that contradicts validated reality is a bug fixed by spec
  change.
- Append-only ADRs. Append-only JOURNAL. The QUEUE is mutable.
- Compactness in everything written here — match the project's
  conventions (typically a `CONVENTIONS.md` or similar under the
  project's spec directory).
