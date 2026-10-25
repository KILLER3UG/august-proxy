# Skill authoring standard

How August skills are structured, and the format every new skill — bundled,
agent-authored, or learned — should follow. The standard is a merge of the
Claude/Anthropic SKILL.md convention (the description is the trigger; the body
loads after it) with the Hermes section shape (When to Use / Procedure /
Pitfalls / Verification) and Hermes frontmatter (`version`, `platforms`,
`metadata.hermes`).

## Layout

```
skill-name/
├── SKILL.md          (required: YAML frontmatter + markdown body)
├── scripts/          (executable helpers — deterministic work)
├── references/       (long docs, read only when SKILL.md points at them)
├── templates/        (starter files the agent fills in)
└── assets/           (images, fonts, data used BY the output)
```

Only `SKILL.md` is required. Sibling folders are load-bearing, not decorative:
`load_skill` ends its output with a bounded listing of every file in the skill
directory, so a reader can see what exists before paying to open it. The
canonical `## Reference files` section is where the body says WHEN to open each
one. L2 reads exactly one file with `load_skill(name, file="references/x.md")`:
the path is relative to the skill directory, and absolute paths, `..` (after
URL-decoding) and symlink escapes are refused.

## Frontmatter

```yaml
---
name: your-skill-name
description: What it does, in one or two sentences. Use it when the user mentions [trigger phrase], [trigger phrase], or wants [task]; do not use it for [out-of-scope case].
version: 1.0.0
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [tag1, tag2]
    related_skills: [other-skill]
---
```

| Field | Required | Notes |
|-------|----------|-------|
| `name` | yes | Lowercase letters, digits, hyphens; max 64 chars. The id. |
| `description` | yes | **The trigger.** ≤ 1024 chars. See below. |
| `trigger` | optional | Legacy short phrase; still matched, but the description is authoritative. |
| `category` | optional | Grouping label (`harness`, `engineering`, `learning`, `artifacts`, …). |
| `version` | recommended | Hermes-style; learned skills bump one per approved patch. |
| `platforms` | optional | Keep the bracketed-list string form (`[linux, macos]`). |
| `metadata.hermes.*` | optional | `tags`, `related_skills`, `requires_tools`, `requires_toolsets`, `fallback_for_tools`, `fallback_for_toolsets`. Unknown frontmatter round-trips through every patch, so the block survives edits. |

### Gating

A skill can be hidden from the catalogue, the Settings list and `load_skill`
without deleting it:

- `platforms: [linux, macos, windows]` hides it on any other OS.
- `requires_tools` / `requires_toolsets` hide it when a named tool is not
  registered. This repo has no separate toolset registry, so both read tool
  names.
- `fallback_for_tools` / `fallback_for_toolsets` hide it when the primary tool
  IS available (a fallback is only for its absence).

A hidden skill still exists on disk; `list_all` sees it, and the reason is
returned by `load_skill`.

### The description is the trigger (why the cap is 1024)

A future agent sees **only** `name` + `description` before it decides to load a
skill — that pair is what the skills index renders and what the per-turn BM25
matcher scores. So the description does two jobs: what the skill does, and
when to fire it (including when NOT to). Be specific to the point of being
pushy; a trigger the description omits is a trigger the skill never fires on.

```
# Too thin — fires on everything or nothing:
description: Handle Quartus problems.

# Right shape — capability + triggers + an exclusion:
description: Recover from a Quartus compile failure. Use when the user asks
about a failed build, timing closure, or the fitter report; do not use it for
an FPGA bitstream flash.
```

The 1024-char ceiling is finite because the description rides the BM25 corpus
and the index packs whole entries against a byte budget (over-long entries are
dropped with a named overflow warning, not silently truncated). The marketing
word denylist (`powerful`, `seamless`, `robust`, `advanced`, `intuitive`, …)
applies to the description as everywhere else.

## Body

Learned / agent-authored skills are **normalized by code**
(`skill_service._ensure_canonical_body`): every section lands in this order,
missing required ones are filled with a template placeholder, and anything else
the author wrote is kept as extra sections.

| # | Section | Required | Contents |
|---|---------|----------|----------|
| 1 | `# Title` (H1) | yes | Human title; the skill's own H1 wins over the humanised name. |
| 2 | `## When to Use` | yes | Concrete situations, close to what a user actually says. |
| 3 | `## When NOT to Use` | recommended | The exclusions that stop the skill firing on everything. |
| 4 | `## Prerequisites` | recommended | Tools, files, environment state needed first. |
| 5 | `## How to Run` | yes | The load → follow → verify envelope (auto-rendered). |
| 6 | `## Quick Reference` | optional | Table of flags / paths / constants. |
| 7 | `## Procedure` | yes (bar) | Ordered steps; commands verbatim. **The substance bar counts ≥ 2 steps.** |
| 8 | `## Output format` | optional | Exact shape of a good result — a template or field list. |
| 9 | `## Examples` | optional | Input/Output pairs a reader can pattern-matched. |
| 10 | `## Pitfalls` | yes (bar) | Failures actually observed, each with what fixed it. |
| 11 | `## Verification` | yes (bar) | How to prove it worked. |
| 12 | `## Reference files` | optional | `path` + the situation that opens it. |

The four bar-raising sections are When to Use, Procedure, Pitfalls and
Verification — a draft missing any of them is filed as a memory *lesson*
instead of a skill, because a rule wearing skill headings is worse than no
skill. Bundled (hand-written) skills pass through the normalizer untouched:
the canonical set is a contract for machine-authored skills, and a curated
prose skill keeps its structure.

## Size and authoring warnings

The hard body cap is 100,000 characters: a larger SKILL.md is skipped at
discovery and refused at every write door, with the reason logged. A body over
~200 lines, or a description with no "Use when" trigger, is a **warning**, not a
block — the authoring result carries `warnings` so a human can fix it. Long
material belongs in `references/`, not the body.

## Install / import

A local folder, a GitHub repo/subdir, an https `.zip`, or a raw `.md` URL is
fetched and **previewed** first. A raw URL also fetches the `references/`,
`scripts/`, `templates/` and `assets/` paths its body names (same origin, ≤20
files), with missing ones reported as warnings: the response names every skill, its file count
and size, and any content-scan finding, and nothing is written. Installing
requires a second call with `confirm: true`. Shell, URL and credential text in a
skill body refuses the install; a memory-instruction phrase is reported as a
warning. Scripts are copied, never executed. Install targets collide-check
against existing skills and never overwrite a directory the pack does not own.

## How learned skills are produced

1. `skill_distiller` judges a flagged episode (or a good-session review pass)
   with `_JUDGE_SYSTEM`, which drafts the structured fields — `when_to_use`,
   `steps`, `pitfalls`, `verification`, `output_format`, `examples`,
   `reference_files`, …
2. `renderSkillBody` renders those fields into the canonical body — sections
   the model did not supply are **omitted, never padded**.
3. `bodySubstance` measures the draft *before* normalization: placeholders do
   not count as content, so a one-line rule cannot pass as a skill.
4. A draft that clears the bar files a `skill_create` / `skill_patch`
   proposal. A human approves it in the **Review queue inside Settings → Skills**
   (retirements live in Settings → Memory) — **learning stays
   human-gated**; nothing here activates autonomously.
5. Approval writes the normalized SKILL.md (with provenance: `version`,
   `origin`, `learned_from`, `supersedes`, `status`).

## Parsing guarantees

- Frontmatter is a hand-rolled flat/nested parser: scalar keys, bracketed list
  strings, and one nested block per indent level (that is what `metadata:` is).
  Leaf values stay strings so a parse → render round-trip is byte-identical.
- Unknown frontmatter keys survive every patch (they are re-emitted after the
  known keys).
- Body headings are matched case-insensitively, with casual aliases
  (`Steps` → `Procedure`, `Gotchas` → `Pitfalls`, `References` → `Reference
  files`, …). An unrecognized heading is kept as an extra section, never
  dropped.
