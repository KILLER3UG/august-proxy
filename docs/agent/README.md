# Agent area guides

`AGENTS.md` is the contract every session reads. This directory holds the
detail behind it, one file per area, so a session about to touch a subsystem
can read that subsystem's rules without reading every other subsystem's
history.

Read the area file before changing code in it. The rules are binding in both
places: `AGENTS.md` states the non-negotiables, these files state the reasons,
the edge cases and the defects each rule exists to prevent.

| Area | File | Read before touching |
|---|---|---|
| How to work | [workflow.md](workflow.md) | gates, no-test policy, scratch rule, directory routing |
| Product surface | [product.md](product.md) | desktop shell, update flow, chat UI, Settings IA |
| Providers | [providers.md](providers.md) | base URLs, wire formats, upstream serialization, pricing |
| Upstream compatibility | [compatibility.md](compatibility.md) | provider/model/SDK workarounds and their removal gates |
| Harness | [harness.md](harness.md) | turn loop, budgets, self-correction, subagents, bots, context relief |
| Memory | [memory.md](memory.md) | facts store, recall lanes, write doors, backups |
| Skills | [skills.md](skills.md) | SKILL.md format, discovery, learning pipeline, review pass |
| Security | [security.md](security.md) | sandbox, hardline, listing/shell/write doors, secrets |
| Release | [release.md](release.md) | version sources, OpenAPI generation, tag flow, CI |

The user-facing goal and the UX we are building are in
[../PRODUCT.md](../PRODUCT.md). The current round and the open decisions are in
[../STATUS.md](../STATUS.md). The memory and skills specification is
[../specs/memory-and-skills.md](../specs/memory-and-skills.md).
