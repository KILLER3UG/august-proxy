---
name: nessa-docs
description: Build or maintain a browsable system map and high-level statecharts in a project's docs/state Markdown, grounded in its current source. Use when documenting services, user flows, lifecycle decisions, or preparing a project for the Nessa Docs browser. Does not bundle or start the separate renderer.
category: engineering
version: 1.0.0
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [documentation, system-map, statechart, mermaid, architecture]
    related_skills: []
---

# Nessa Docs

In August, write the documents into the **documented workspace's**
`docs/state/`. The renderer is a separate Node application from
[nessalabs/nessa-docs](https://github.com/nessalabs/nessa-docs); this skill only
authors the Markdown contract and does not install or launch it unless the user
asks.

Help a newcomer understand what a project does, which part owns each step,
and why an action succeeds or fails. Write the documentation in the user's
repository. Nessa Docs renders it; it does not run the modeled system.

Read [the file format](references/format.md) before authoring files. That
reference owns the metadata and diagram-binding contract. The skill is usable
without the website and does not require other skills or a particular agent.

## Find the real behavior

Read the project's working instructions, entry points and existing feature
documentation. Follow the code and relevant tests for the behavior you describe.
For a full-project request, inventory the services, their responsibilities,
important user goals and stateful entities before writing. For a narrow request,
update the existing owning page rather than generating another atlas.

Distinguish implemented behavior, examples, proposals and things you could not
verify. Reading a test is evidence of its intent, not a claim that it passed.
Name concrete gaps, their effect, and the evidence still needed. Do not invent
a lifecycle for immutable values or claim external behavior you could not inspect.
An immutable record can still have an explicit status. In that case a chart may
describe the returned status changes; say that calls return a new value and name
who saves it, rather than implying the original value changes in place.

## Retain the source checkpoint

Record `sourceRevision` in each state page reviewed, following the
[file format](references/format.md#source-review-checkpoint). Use the documented
repository's exact committed source revision, obtained with `git rev-parse HEAD`
(or the exact base checked when source and docs share a working branch). A dirty
implementation is not represented by HEAD alone: commit the source first or keep
the prior checkpoint and describe the uncommitted scope explicitly.

Read the existing checkpoint before refreshing a page. Compare the relevant
source changes since that revision, then trace the current owning code and tests;
a diff alone is not proof the explanation is correct. Advance only pages whose
behavior was reviewed. Do not stamp an entire atlas after a partial audit, inherit
a root revision onto children, substitute the renderer's commit, or imply a
checkpoint is executed test evidence. Leave unknown historical checkpoints
absent until verified. Record review scope, validation and exclusions in prose.

## Organize the map

Put the system entry in `docs/state/README.md`. For larger projects, group
services under `services/`, with an owning README and useful feature and flow
pages beneath it. Shared libraries can use the same hierarchy. Keep
cross-service explanations with the owner of that interaction and link the
other owners.

Let readers move from the system map to a relevant user goal and its state or
decision explanation. Larger projects can add service and feature levels between
them. Stable IDs and `parent` metadata connect those levels. A document
can serve several user goals without duplicating its lifecycle. Keep one useful
flow index when a feature needs one. Retain unrelated project documentation; replacing it
requires the user's request and preserved evidence links.

Scale the hierarchy to the project. A small module may need only an overview
and one lifecycle page. Add service or feature indexes when they group useful
choices; do not create a chain of pages with just one destination each. Keep
closely related decisions together when separate pages would add navigation
without helping the reader.

## Choose the diagram

- A component map shows parts that exist together. Its arrows describe their
  relationships, not a sequence of exclusive states.
- A statechart follows one entity or operation. Name its owner, entry, meaningful
  states, events, conditions and important refusal or uncertain outcomes.
- A small sequence explains who hands work to whom and in what order. Use it
  when it makes an explanation easier to follow, not on every page.
- A contract page explains a value or rule that has no runtime lifecycle.

Apply [Harel's statechart ideas](https://www.state-machine.com/doc/Harel87.pdf)
where the actual system supports them. Nested states refine an outer state;
shared outer transitions avoid repetition. Concurrent regions describe facts
that coexist, with explicit coordination. History means returning to a prior
configuration; say what is remembered, where, and for how long. Mermaid supports
only part of this notation. Do not promise resume or persistence from a history
symbol, or completion or erasure from a final marker alone.

Keep accepted work, performed effects, acknowledgements and completed cleanup
distinct when the code does. Do not force independent lifecycles into one large
application state. Avoid a box for every function or field. Use
`event [condition] / action` on state arrows when those parts matter.

## Write for the first reader

Open each page and clickable explanation with plain English. Say what happens,
what allows or prevents the next step, and what the reader can expect afterward.
A state or arrow may be the first thing the person reads. Explain its condition
without requiring the rest of the page. Add a small example or sequence when it
helps. Keep important failure and uncertainty visible in the short explanation.

Use short sentences and ordinary verbs. No em dashes, slogans, filler or invented
jargon. Keep function names, exact error types and test-name lists out of the
opening explanation. Add a few useful source links for readers who want the
implementation; the complete source list belongs in frontmatter. Do not replace
a wall of prose with a wall of boxes.

Use `diagramLinks` for drill-down into another page and `diagramDetails` for an
explanation in the owning Markdown. The browser marks available depth with a +.
Full detail shows authored content; it does not launch agents or write files.

## Check and open

Check stable IDs, parents, relative links, headings, Mermaid syntax and diagram
targets. If the local Nessa Docs checkout is available, run its catalog check:

```sh
npm run --silent validate:docs -- --project /absolute/project/path
```

Run it from the renderer checkout, not the documented project. It prints JSON
and returns a nonzero exit code for an invalid catalog. Open the project in the
app to inspect charts and Settings → Health when a browser is available. Without
a browser, report that visual appearance and interaction were not checked.
A syntactically valid chart still needs a behavior check against its source.
Report exclusions.

To open the project, start the separate renderer with `npm start` after its
dependencies and build are ready, then use Open project with the absolute project
folder. A configured start can use
`NESSA_DOCS_PROJECT=/absolute/project/path npm start`. If the renderer is not
installed, direct the user to [nessalabs/nessa-docs](https://github.com/nessalabs/nessa-docs)
and its setup instructions. Do not imply that installing this skill also installs
or starts the app, or that a Codex extension is already available.

## Source and licence

Adapted from [`nessalabs/nessa-docs`](https://github.com/nessalabs/nessa-docs)
at commit `c0bc0627611b100ab71a96cc6fe2fb65f1a014d8` (MIT). The upstream
licence is retained in `LICENSE` beside this file. The format reference in
`references/format.md` is the upstream authoring contract; the local renderer
is not part of August.
