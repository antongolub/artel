# Collaboration

This directory holds the **coordination architecture** for the multi-agent
work on this project. It is **gitignored** — coordination state is
contributor-private and mutates faster than the spec.

The spec (`spec/`) is the durable, shipped artefact. `collab/` is the
workshop floor: scratch, queues, journals, hand-offs.

## Files

- [AGENTS.md](./AGENTS.md) — cast, role lanes, communication protocol.
- [CHALLENGE.md](./CHALLENGE.md) — self-critique personas (Cold Reader,
  Adversary, Maintainer) — used when the owner can't review every change.
- [QUEUE.md](./QUEUE.md) — flat shared backlog grouped by status.
- [JOURNAL.md](./JOURNAL.md) — append-only log of significant events.
- `research/` — research notes with citations, one file per topic.
  Currently produced by Claude; Perplexity-driven once a stable CLI exists.
- `handoffs/` — long-form briefings when QUEUE entries are not enough
  (rare; prefer QUEUE).

Only `AGENTS.md` is mandatory reading on session start. Everything else
is consulted as needed.
