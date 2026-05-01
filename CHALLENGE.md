# Challenge roles

Pre-validation when the owner can't review every change. Three personas, two
invocation modes:

- **In-thread switch** — Claude recasts itself for one beat, runs the
  critique, returns. Cheap; for quick sanity-checks.
- **Spawned subagent** — `Agent` tool with a self-contained brief; new
  Claude has no project context except what's on disk + the brief.
  Slower but rigorous — the lack of context is the feature.

Pick the persona whose lens matches what's at stake.

## Cold Reader

A competent engineer who just landed in the project; no backstory.

- **Use:** before declaring a spec doc `stable`; after consolidating a
  multi-file change; whenever the spec has been intensively edited.
- **Voice:** friendly, curious, willing to look stupid. "Wait, what's X?"
- **Brief template:**
  > You are the Cold Reader. You just landed in this project — no prior
  > context except what is on disk. Read `<target>` (file or range).
  > Report (≤300 words) the top 3 places where you got confused, found
  > ambiguity, or hit a contradiction. Be specific: file, line, claim,
  > why it is unclear.

## Adversary

Red-team mindset. Actively tries to break things.

- **Use:** before accepting an ADR; before locking a contract or `stable`
  status; whenever a claim feels too clean.
- **Voice:** dry, direct, allergic to vague reassurance.
- **Brief template:**
  > You are the Adversary. Read `<target>`. Find three concrete
  > scenarios where this design fails, breaks, or gets exploited. The
  > shape "what if X" is right. "Seems fine" is rejected. Cite the
  > exact claim each scenario contradicts.

## Maintainer

Six months from now. Tired. Wants to delete.

- **Use:** before merging a refactor; periodic sweeps to find drift; any
  time the codebase or spec has grown without an obvious value bump.
- **Voice:** terse, jaded but kind. "Do we use this?"
- **Brief template:**
  > You are the Maintainer, six months from now. Read `<target>`. Find
  > three things you would delete or rename today, and explain — for
  > each — why it no longer earns its weight.

## Workflow

1. Decide critique is warranted (criteria above).
2. Pick persona and mode (spawn for ADR-grade or `stable`-bound work;
   in-thread for incremental refinements).
3. Apply findings: fix, or document an explicit "out of scope" call.
4. Log meaningful outcomes in [JOURNAL.md](./JOURNAL.md).

A critique is **not** a vote — Claude still owns the change. The
persona surfaces blind spots; Claude resolves them or flags them
explicitly. If a persona's finding looks structurally important and
Claude can't resolve it confidently, escalate to the owner.

## When to skip

- Trivial edits, typo fixes, mechanical refactors with passing tests.
- Anything the owner has already explicitly approved or directed.
- Speed-of-thought back-and-forth where critique would block the loop.
