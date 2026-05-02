# collab — agent platform

A reusable multi-agent coordination layer: role definitions + dispatch
engine that consumer projects share across repos.

## Two-level model

The platform is split into a **shared platform** and a **per-project
runtime**. They live in different places.

### Platform side (this repo)

- `AGENTS.md` — cast, role lanes, communication protocol (canon).
- `CHALLENGE.md` — self-critique personas (Cold Reader, Adversary,
  Maintainer).
- `agents/<role>.md` — role definitions. Frontmatter declares
  `tools` / `permission-mode` / `model` / `engine` / `persistent` /
  `codex-effort`; body is the system prompt prepended on engines
  without a native system slot (codex/copilot).
- `engine/` — dispatcher CLI. `run.mjs` (role dispatcher), `spawn.mjs`
  (high-level wrapper with branch precreate, meta lifecycle, timeout
  watchdog), `dispatch_lifecycle.mjs` (encapsulated lifecycle),
  `dispatch_api.mjs` (meta sidecar API), `parked.mjs` (failure-mode
  detector), `state_gen.mjs` (state.md generator), `status.mjs`
  (terminal dashboard), `drivers/{claude,codex,copilot}.mjs`.
- `test/` — engine integration tests (vitest).

### Per-project runtime (consumer's `.collab/`)

Each consumer project keeps its own runtime under `.collab/`
(typically gitignored — runtime mutates faster than the codebase):

- `.collab/QUEUE.md` — current backlog grouped by status.
- `.collab/JOURNAL.md` — append-only log of significant events.
- `.collab/state.md` — generated coordination snapshot.
- `.collab/dispatcher_state.json` — dispatcher live state.
- `.collab/events.jsonl` — append-only transactional log
  (claim/release/checkpoint/parked/...).
- `.collab/.dispatches/<task>.{prompt,out,meta}` — per-task artefacts
  from `spawn.mjs`.
- `.collab/.sessions/<role>.<engine>.id` — persistent-role session ids.
- `.collab/research/`, `.collab/handoffs/` — long-form notes when
  QUEUE entries aren't enough.
- `.collab/AGENTS.md` *(optional augmentation)* — project-specific
  cast detail (industries, prior art, domain context). The platform's
  `AGENTS.md` is canon; the project's augmentation layers on top.

## How they bind

The engine self-locates platform paths via its own file location
(`PLATFORM_DIR = dirname(import.meta.url)/..`). Project paths come
from `process.env.COLLAB_PROJECT_DIR` (or `process.cwd()` if unset);
the engine reads/writes `${PROJECT_DIR}/.collab/...` for runtime
artefacts.

Dispatch invocation pattern from a consumer project:

```bash
# from <consumer-project>/
node $COLLAB_HOME/engine/run.mjs --list
node $COLLAB_HOME/engine/spawn.mjs <role> <task-slug> --engine codex -p "..."
node $COLLAB_HOME/engine/status.mjs --watch
```

`$COLLAB_HOME` points at this platform repo on disk (e.g.
`~/projects/.../collab`). Set it once per shell or per consumer
project.

## Bootstrap a consumer project

(Out of scope for now — `collab init` helper is a follow-up. Manual
bootstrap: `mkdir .collab` and create `QUEUE.md` / `JOURNAL.md` with
the section headers from this repo's docs; add `.collab/` to the
consumer's `.gitignore`.)

## Reading order on session start

`AGENTS.md` is mandatory. Everything else is consulted as needed.
