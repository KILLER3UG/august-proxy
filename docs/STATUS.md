# Status — the current round

Last updated: 2026-10-29 · App version: **0.18.25**

This is the committed handoff. Read it before starting work; update it at the
end of a round. Keep it to one page: what shipped, what is next, what is
waiting on the owner, and how to resume.

## This round — repository orientation

- `AGENTS.md` is a short contract (~120 lines) with a read-before-touching
  table; the detail moved to [`docs/agent/`](agent/README.md).
- Closed plans, dated audits, deep dives, release notes and archive trees were
  deleted. [`docs/DOCUMENTATION.md`](DOCUMENTATION.md) is the one index; git
  history keeps the removed documents.
- Added [`docs/PRODUCT.md`](PRODUCT.md), this file, and
  [`docs/specs/memory-and-skills.md`](specs/memory-and-skills.md).
- CI is one reusable workflow; the release job calls it; one gate command set
  is shared by CI, release and developers. See
  [`docs/agent/workflow.md`](agent/workflow.md).
- Branch, commit and staging rules are in `CONTRIBUTING.md`.

## Recently shipped before this round

- **0.18.25** — commands that cannot run are no longer offered; failures that
  change state say so; a new chat no longer asks permission for something that
  loses nothing.
- **0.18.24–0.18.21** — the installer always brings the app back; a locked
  payload aborts instead of copying over it; one teardown per click; More opens
  right, reasoning reveals in full.
- **Memory and skills** — the 18-item memory/skills spec is ~95% built. The
  current state and the remaining items are in
  [`docs/specs/memory-and-skills.md`](specs/memory-and-skills.md).

## Next, in order

1. **Memory and skills UX.** The backlog is in the spec: make recall legible,
   show a skill's trigger/usage/history, surface why a skill is hidden, and
   finish the remaining inspection surfaces. This is the owner's priority.
2. **Verify the update flow on a packaged NSIS install.** The matrix in
   [`UPDATE_VERIFICATION.md`](UPDATE_VERIFICATION.md) has never been run. The
   code path is implemented and negative-tested at the script level; the
   packaged install is the missing proof.
3. **The mobile companion.** The decision below is unresolved, and it changes
   the size of the work by an order of magnitude.
4. **Active plans** — the Signal Desk UI port, goal environments, and
   self-modification autonomy (see [`DOCUMENTATION.md`](DOCUMENTATION.md)
   §Active plans).

## Open owner decisions

| Decision | The question | Where it lands |
|---|---|---|
| Mobile: second client or second August | Does the phone drive the desktop install over the network, or run its own backend and brain? | `ROADMAP.md` §NEXT, mobile |
| Group across a turn boundary | Should a read, an answer, and another read be one activity line? | `ROADMAP.md`, chat surface |
| Apply an update without a restart | The download is automatic; should an idle app restart itself? | `ROADMAP.md`, update flow |
| `/mcp/harness` by default | It is closed unless external access is enabled; an outer agent needs the key | `ROADMAP.md` |
| Subagent memory reads | Subagents currently read and recall but never write; opening reads wider is a product ruling | `docs/specs/memory-and-skills.md` |

## Resume

```bash
npm run dev:desktop                 # the product
cd backend-py && uv run ruff check . && uv run mypy app/
npm run check -w frontend/desktop
npm run gates:all                   # the static gate set
npm run e2e:smoke                   # starts the real app against a throwaway data dir
```

The product goal is in [`PRODUCT.md`](PRODUCT.md); the contract is
[`AGENTS.md`](../AGENTS.md); the area guides are [`docs/agent/`](agent/README.md).
