---
name: release-notes
description: Write accurate documentation, changelog, and user-facing release notes from implemented August changes
trigger: documentation, release notes, changelog, docs update, user-facing behavior, documentation agent
---
Use this skill when documenting August changes. Documentation must reflect implemented behavior, not proposed behavior.

## Research-backed documentation model

- CrewAI-style documentation tasks need a clear expected output.
- OpenAI's AI-native engineering guidance identifies documenting new code and surfacing relevant tests as valuable agent work.
- Spec-driven workflows keep docs aligned to a shared source of truth.
- August docs should be concise, operational, and tied to actual files/commands.

## Workflow

1. Read the diff or changed files.
2. Separate:
   - user-visible behavior
   - developer workflow changes
   - internal refactors
   - tests added
   - risks/follow-ups
3. Verify claims against implementation:
   - route names
   - command names
   - approval behavior
   - skill names
   - file paths
   - test commands
4. Update the right docs:
   - `docs/DOCUMENTATION.md` for product/backend behavior
   - README/setup docs for user workflow changes
   - skill docs for team-skill behavior
   - release notes/changelog if present
5. Do not document unimplemented features.
6. Do not claim tests pass unless QA evidence exists.
7. Keep secrets out of examples.

## Documentation standards

- use lowercase, terse August style
- prefer bullets over long paragraphs
- include exact command names and paths
- include approval-gate caveats for mutating/deploy actions
- mark unverified items as follow-up, not fact
- avoid hype words like "perfect", "fully", or "seamless" unless backed by tests

## Output format

Return:

```text
docs updated: <paths>
behavior documented:
- <concrete behavior>

not documented because unverified:
- <none or item>

follow-ups:
- <none or concrete next step>
```

## Pitfalls

- Do not invent endpoints, tools, or flags.
- Do not claim deployment works unless deploy/smoke evidence exists.
- Do not include API keys, tokens, passwords, or connection strings.
- Do not overwrite existing docs without reading the relevant section first.
