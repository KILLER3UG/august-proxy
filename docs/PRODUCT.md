# Product: what August is, and what a good August feels like

## What August is

August is a **local AI gateway and agentic workbench**. It runs on the user's
machine, talks to whichever providers the user configures, and gives one
assistant the ability to read files, run commands, search, browse, remember and
learn — with the user's data staying local.

The product is the **Tauri desktop app** (`frontend/desktop/` + bundled
`backend-py/`). The same backend also exposes OpenAI- and
Anthropic-compatible HTTP APIs, so other clients can use the same providers,
tools and memory.

## Who it is for

One person, on their own machine, who:

- uses several providers and wants one place to switch between them;
- wants an agent that can actually operate the computer, not just chat;
- wants the assistant to remember them and get better at their recurring work;
- wants to see, edit and undo what it remembers and learns.

## The three pillars

1. **One gateway.** Every provider, every wire format, one local endpoint.
   Base URLs are used as pasted; models may override their wire format; model
   catalogs come from providers, never from a hardcoded list.
2. **A workbench that does work.** A streaming turn with a bounded tool loop,
   files, shell, browser, desktop automation, MCP, subagents and skills.
3. **A brain that persists.** A local SQLite memory store, recall lanes, a
   human-readable mirror, backups, and a learning loop that turns sessions into
   reviewable lessons and procedures.

## Principles

- **Local-first, user-owned.** The data directory holds the brain database,
  providers, sessions, backups and learned skills. Nothing leaves the machine
  except the model request the user asked for.
- **Desktop is the product.** `web-dist/` is a build artifact. Verify behavior
  in the desktop app.
- **One store of record.** No second memory database, no vector store, no graph
  store, no parallel history system. A view is derived, never authoritative.
- **Reversibility.** A delete goes to trash; a patch snapshots the old content;
  a memory edit records the previous value; a restore is staged and verified.
- **Honest surfaces.** Advertise only gestures that exist. A failure says so.
  A number that can change later is better omitted. A refusal names the rule.
- **Bounded autonomy.** Every turn, loop and Bot chain has an armed ceiling. The
  download is automatic; the restart is the user's click.
- **Provider-agnostic.** One model's quirks do not become the product's
  architecture. Per-model overrides exist; hardcoded model lists do not.
- **The model is not the authority on its own capabilities.** Permissions,
  tools and model routing are not writable by a model turn.

## The memory and skills experience we are building

This is the part of the product the owner cares most about, and the standard is
higher than "it works".

### Memory should feel like a visible notebook, not a black box

- **You can see what August remembers.** Settings → Memory is one flat
  chronological list across kinds, with filter chips, an add box, and a detail
  pane. No hidden tabs, no meters that imply a precision the store does not
  have.
- **You can see where it came from.** Every fact carries a machine-set source
  (the code path that wrote it), a subject type, a tag and an `updated` stamp.
  A fact that was edited shows **Previously:** the value it replaced.
- **You can undo it.** A chat write surfaces as a receipt; the write is
  rollback-snapshotted; deleting and restoring are real doors, not promises.
- **Recall is predictable.** Three lanes, each with a name:
  - **Profile** — always in, on every turn, inside a small budget. This is why
    August knows who you are without a keyword match.
  - **Delta** — facts written or updated since this chat opened, appended to
    the tail. A fact you just saved is visible on the next request.
  - **Recall** — BM25 over the facts table, gated by `memoryAutoInject` (armed
    by default; an explicit off is honoured). A fact dropped for budget is
    named, never silently lost.
- **The model follows the same rules you do.** It reads before it writes, it
  updates rather than duplicating, and it cannot write memory from a subagent.

### Skills should feel like procedures you can inspect, not prompts you cannot see

- **A skill is a procedure.** It has a trigger (the description), a body with
  canonical sections, and optional reference files. The Library lists them; a
  bad skill is skipped with a reason, not silently swallowed.
- **Discovery is layered and predictable.** Bot → project → agent → bundled,
  earlier wins; external roots are read-only; a category level is allowed; a
  malformed sibling never stops the others loading.
- **Mutation is reviewable and undoable.** Create/patch/delete go through
  proposals and approvals; a patch shows a diff; a replaced or removed pack
  skill lands in trash and can be restored.
- **Learning is reviewable.** The distiller drafts section fields; a draft that
  is not substantive enough becomes a memory lesson instead of a padded skill.
  The review pass is opt-in, scheduled, and has its own ledger row.
- **Installation is a decision, not a click-through.** A pack shows a preview
  and a content scan before it writes; local-folder import follows the same
  door.

### What good looks like, in one sentence

The user can open one place, see everything August remembers and has learned,
understand why each item exists, fix it in place, and trust that an update will
not lose it.

## Current state and next

- The shipped surfaces, the met/partial/open status and the UX backlog are in
  [`docs/specs/memory-and-skills.md`](specs/memory-and-skills.md).
- What shipped in the current round and what is next:
  [`docs/STATUS.md`](STATUS.md).
- The agent-facing rules are in [`docs/agent/memory.md`](agent/memory.md) and
  [`docs/agent/skills.md`](agent/skills.md).

## Non-goals

- No cloud sync of the brain, no account requirement.
- No vector store or graph store; the store is SQLite + BM25.
- No verifier gate that withholds answers.
- No second memory database, history table or skill store.
- No new left-rail Settings tab for a slice of an existing hub.
