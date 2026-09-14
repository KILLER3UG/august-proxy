# Harness friction findings — 2026-09-15 (verified audit)

Context: these were reported as model-experienced friction during a
push-and-audit session (wb_20260914_145731_c58119), then **each claim was
verified against the code** before being kept, dropped, or reclassified.
Repo state at verification: `master` @ `79e2ee12`, clean tree. Running app:
installed production build (`diagnose_proxy` → data dir under
`%APPDATA%\com.august.proxy`), i.e. the AppData backend copy, not this
checkout — relevant to item 7.

Severity ordering: 1–3 cost a turn or an answer every session; 4–6 cost
context/tokens; 7–9 are notes for the release process and for whoever
follows up.

---

## Implementation status — same day

All nine were implemented in `backend-py` (+ one frontend schema, one build
script, one doc guard). Corrections to this audit found while implementing are
listed at the end — four of my own claims needed amending.

| # | Disposition | Where |
|---|-------------|-------|
| 1 | Implemented — per-segment head-verb scoping, quote-aware splitter, `/c:"x"` switch form, denial text | `fallback.py` (`_split_shell_segments`, `_scan_path_tokens`, `_TEXT_EMITTER_HEADS`), `paths.py:199`, `file_tools.py` (`_denial_tail`) |
| 2 | Implemented — nearest-package-root resolution, file-scoped pytest, uv-aware, aggregator-root rejection, provenance in every receipt | `edit_verification.py` (`package_root_for`, `detect_commands`, `load_verify_config`, `_cd_prefix`, `_file_arg`) |
| 3 | Implemented — bounded (×2) "continue exactly where you stopped" self-heal, visible warning, `length` reason when exhausted | `workbench.py` no-tool break path |
| 4 | Implemented — CONNECT/could-not-connect detection appends the `network: true` hint | `file_tools.py` (`_NETWORK_FAILURE_RE`, `_network_hint`) |
| 5 | Implemented — NUL-byte binary sniff, gitignore-aware dir skip, dot-dir skip (keep `.github`), source-only signatures, test dirs out of signatures, per-dir cap with "… N more", git-tracked-first ordering | `code_map.py` |
| 6 | Implemented — AGENTS.md corrected to `0 = uncapped`; stale code comments fixed; new `scripts/check-docs-sync.mjs` + `npm run check:docs` | `AGENTS.md`, `workbench.py:782`, `scripts/check-docs-sync.mjs` |
| 7 | Implemented — build stamps `sourceSha`/`sourceBranch`/`appVersion` into `backend-runtime.json`; `app/lib/build_info.py` resolves runtime source; `diagnose_proxy` leads with `Runtime code: <sha> (installer-stamp\|git-checkout)` | `prepare-desktop-backend.mjs`, `app/lib/build_info.py`, `system_tools.py` |
| 8 | Implemented — `turn_end {reason, rounds, error}` emitted before `done` on every turn; reasons `finished/length/cap/stall-stop/error/interrupted/awaiting-input`; FE zod schema added | `workbench.py` finally + break sites, `emit_types.py`, `schemas/workbench.ts` |
| 9 | Implemented — `diagnos\w*` narrowed to health-shaped forms; refusals now quote the matched trigger | `sensitive_topics.py` (`sensitiveMemoryReason`), `session_tools.py` |

Tests: `tests/test_harness_fixes_2026_09_15.py` (33 new) +
`TestLengthStoppedFinalText` / `TestTurnEndReason` in
`tests/test_workbench_tool_loop.py`; 8 transcriptions in
`tests/test_edit_verification_t1.py` updated to the new intended receipts.

### Corrections to this audit

- **#2's recommended fix was not available.** `.aug/` is gitignored by design
  ("AUG.md plan/todo persistence — local, never commit"), so committing
  `.aug/verify.json` would never reach another clone. The fix therefore had to
  make auto-detection correct on its own; `.aug/verify.json` stays the local
  escape hatch, now also honoured per package (`backend-py/.aug/verify.json`).
- **#2's root cause was two-layered.** Wrong package root was only half of it:
  even at the right root, the detected pytest command was whole-suite
  (`python -m pytest -q -x`), which in this repo takes ~10 min and would still
  have timed out. File scoping is the part that actually stops the stall.
- **#1's third repro is by design, not a false positive.** `dir` on an AppData
  path outside the workspace is correctly blocked: `paths.py:79-88` records an
  explicit ruling that the viewer carve-out is the `logs` subdirectory ONLY,
  because `providers.json` (API keys) and the brain SQLite live beside it.
  Read scope was deliberately NOT widened.
- **#6's premise was wrong.** `check-version-sync.mjs` is an npm script, not a
  pre-commit hook — `.pre-commit-config.yaml` runs ruff only. The new
  `check:docs` follows the same (manual/script) pattern rather than the claim.
- **New bug found while doing #7:** `app/version.py` walked four `.parent`
  steps from `app/version.py`, landing one directory ABOVE the repo root, so it
  never found the checkout's `package.json` and `/api/health` reported the
  `0.1.0` fallback while the app was on 0.18.10. A model calling
  `diagnose_proxy` was told a false version. Fixed, and the packaged path now
  reads the staged `appVersion`.
- **#7's "zero hits" needed precision:** the CamelCase string `ToolSearch` does
  exist in-tree as the internal handler *function* `handleToolSearch`
  (`tool_bridges.py:42`, referenced at `:180`). It is never a tool name or
  prompt text; the registered names are snake_case.
- **#8's cancel path needed a second look:** a mid-round cancel strips the
  dangling tool calls and falls through the plain-text break, never reaching
  the top-of-round cancel check, so the reason is resolved at the single
  terminal point rather than only at break sites.
- **#7's alternative was rejected on purpose.** The audit offered "diagnose_proxy
  output **or** the system prompt". The SHA went into `diagnose_proxy` only:
  the system prompt must stay byte-stable across turns (the 2026-08-29
  prompt-cache bust was exactly a per-turn value in that block), and a
  session-start SHA would re-introduce it. The event log already persists
  every emitted event, so `turn_end` is queryable without a UI change; the
  desktop does not render it (noted in the schema).
- **#4's hint is deliberately narrow.** `unable to access` was removed from the
  trigger list after writing the tests: git emits it for local failures too
  (missing config, bad repo), and a wrong hint costs the model a wrong round —
  the exact waste the hint exists to prevent.
- **#1's emitter list is deliberately short.** `set` and `export` were dropped
  from the text-emitter exemption while writing the tests: `set /p x=<path>`
  reads a file through an input redirect, which the token scan used to catch
  and the redirect scan does not (it matches `>` and `tee` only). Any redirect
  or command substitution in a segment cancels its exemption.
- **The `frontend/desktop/src-tauri/resources/backend-py/` tree is a build
  artifact** (only its `README.md` is tracked), so fixes do not need a second
  copy maintained there — but an *installed* app keeps the old behaviour until
  it is rebuilt, which is exactly what #7 now makes visible.

---

## 1. Soft-preflight path scan blocks non-path text (confirmed, high)

**Symptom (live reproductions from this session):**

```text
echo before c:/d after                  → Blocked: path outside workspace blocked: c:/d
dir /b "C:\Users\...\backend-runtime"   → blocked (token: the quoted path)
cd /d ... && dir "%APPDATA%\...\logs"   → blocked (viewer exemption lost after `cd` head)
findstr /c:"ToolSearch" file            → Blocked: path outside workspace blocked: /c:"ToolSearch"
```

Yet `echo "a/b"`, `echo x --flag=y`, and `cd /d C:\... && echo "two"` pass —
so behavior looks arbitrary to the model, and the message nudges toward
"Switch the sandbox control to Full access", which is the wrong repair for
an `echo`.

**Mechanism:** `backend-py/app/services/sandbox/backends/fallback.py:315-319`
scans **every** shell token through `_shell_tokens_for_scan` (line 79; includes
whole quoted spans) into `path_looks_outside_workspace` →
`_one_points_outside` (`backend-py/app/services/sandbox/paths.py:192-219`),
which resolves each candidate against the workspace root. The Windows-flag
exemption (`paths.py:199`) covers only `/X` (single letter), not `/c:"..."` or
bare `/`. The read-only-viewer exemption (`fallback.py:316` `viewerRead =
first in _READ_ONLY_VIEWER_HEADS`) checks only the **first word of the whole
command**, so `cd X && dir <outside>` loses it, and `echo`/`findstr` patterns
are scanned as paths.

**Worth implementing:** yes — the containment check itself stays (redirect
scan and absolute-path scan are legitimately valuable); the fix is scoping.

**Fix sketch:**
- Treat the head token's verb per segment: only file-touching heads
  (interpreters, `cp/mv/rm/dir/type/cat/...`) get path-arg scanning; pure
  text emitters (`echo`, and `findstr` pattern args / `/c:` literals) are
  exempt from the *token* scan (keep the redirect scan).
- Make `viewerRead` per-segment (compute from the segment's head, not the
  command's first word).
- Extend the flag exemption on Windows to `/c:"..."`-style findstr switches.
- When blocking, name the triggering token AND the safer rewrite (e.g.
  "quote-free form: cd /d X && dir logs"), instead of suggesting Full access.

**Test hooks:** `backend-py/tests/test_sandbox_policy.py` +
`test_part27_fixes.py` already cover `soft_preflight`; add the four
reproductions above as expectations (blocked → allowed).

## 2. Post-edit verification gate runs the WRONG suite for the workspace (confirmed, high)

**Symptom (live):** a one-line edit to `backend-py/app/.../paths.py` triggered
`tests (npm test --silent)` at the repo root → 180 s timeout →
`[verification inconclusive]` → test gate PAUSED for the rest of the session.
Net effect in this repo: post-edit verification never actually verifies, and
costs 3 minutes the first time.

**Mechanism:** `edit_verification.py:68-121 detect_commands` looks only at
`<workspace>/pyproject.toml` / `<workspace>/package.json` — the workspace
ROOT. This repo's root `package.json` has `"test": "npm run test:verify"`
(chains full backend pytest + frontend vitest) and the root has no pytest
config, so the gate always picks the monorepo-wide suite. `AGENTS.md`
documents the per-area commands (`cd backend-py && uv run pytest -q`); the
gate knows nothing of that.

**Fix sketch:** resolve the command from the **edited file's nearest package
root** (walk up from `{file}` to the first `pyproject.toml`/`package.json`),
and/or scope default: `pytest -q {file}` / `npm test --silent -w <pkg>`.
`.aug/verify.json` (missing in this repo today) exists as the manual
override — recommend committing one with the AGENTS.md commands:

```json
{ "lintCmd": "ruff check backend-py\\{file}",
  "testCmd": "cd backend-py && uv run pytest -q {file}" }
```

**Also:** `_run_gate_command` correctly reports timeout as inconclusive
(good); but the `testPaused` latch means one mis-detection disables the gate
session-wide — a wrong-suite detection and a genuinely slow suite are
indistinguishable in the receipt.

## 3. No continuation for length-stopped FINAL TEXT (confirmed, high — user-visible)

**Symptom (live, twice):** assistant answers ended mid-word
("...the single UI fix in the composer: **Compose") and were delivered as
final. The user saw a broken message; the harness detected nothing.

**Mechanism:** `workbench.py` — the tool-carrying `max_tokens` case is
handled (`4024-4060`, fail-all + "Do NOT stop — retry"), and thinking-only
truncation is surfaced (`3928-3954`). But a round with `stop_reason ∈
('max_tokens','length')`, non-empty `textContent`, and **no** tool calls hits
the plain break path (`4007-4018`): the text is appended as the final answer
and the turn ends silently.

**Fix sketch:** on that exact triple, instead of `break`, append the partial
assistant message, inject a bounded self-heal user turn ("Continue exactly
where you stopped — your last message was cut off mid-sentence."), and
continue (max ~2 continuations; mark the turn when exhausted). The
infrastructure precedent exists a few lines below (`_selfHealRetries`,
`toolRound -= 1`).

## 4. Sandbox `git push` fails as opaque CONNECT 403 (confirmed, medium)

**Symptom (live):** `git push origin master` in sandbox mode →
`fatal: unable to access ...: CONNECT tunnel failed, response 403`
(exit 128), no mention of the `network: true` flag; same command with
`network: true` succeeded immediately.

**Mechanism:** `git` is not in `NETWORK_COMMAND_PREFIXES`
(`policy.py:24-45`), so there's no soft preflight denial; the command runs
against the egress proxy (`egress.py`), which rejects the CONNECT, and the raw
git error is all the model sees. A model that doesn't know the flag concludes
"credentials broken" and debugs git — several wasted rounds.

**Fix sketch:** in the `run_command` result post-processing (tool_registrations
file_tools path), when sandboxed + `network=False` + output matches
`CONNECT tunnel failed|could not connect|failed to connect to` from
git/curl-like commands, append: `Remote operation blocked by sandbox:
retry with network: true (per-command flag)`. Alternative: preflight git
subcommands `push|pull|fetch|ls-remote` with the same hint. No security
posture change — the hint doesn't grant anything.

## 5. Workspace code-map is noise-dominated; source dirs invisible (confirmed, medium)

**Symptom (live):** the injected map's 90-line tree budget was consumed by
`.mypy_cache/`, `.pytest_cache/`, `.ruff_cache/`, `.zcode/plans/`, `.aug/`,
`.opencode/`, `web-dist/` (minified JS), and its "Signatures" block bled
**binary SQLite content** into the system prompt (`SQLite format 3    ...`
junk lines). `backend-py/`, `frontend/`, `scripts/`, `docs/` subtrees never
appeared — I spent a `list_directory` call (per session) to learn the repo
shape the map is supposed to convey.

**Mechanism:** `code_map.py:25-26` `_SKIP_DIRS` omits every dot-cache/build
dir above; `_SKIP_EXTS` omits `.db/.key/.coverage/.sqlite/.jsonl`; and
`_signature_lines` opens files with `errors='replace'` so binaries pass the
"has readable lines" bar (they even become the *largest-files* signature
pick, being large). `data/` (gitignored) also appears via depth-2 walk.

**Fix sketch:**
- Skip files whose first 1024 bytes contain NUL (binary) — one check in
  `_signature_lines`/collector.
- Add `.mypy_cache`, `.pytest_cache`, `.ruff_cache`, `.out`, `target`,
  `web-dist`, `data`, and generic dot-dir skipping at depth ≥ 1 (keep
  `.github`).
- Respect `.gitignore` top-level entries cheaply (the repo's own
  `.gitignore:2/.15/.29` already names most of the noise).
- Sort the tree so git-tracked dirs come first (one `git ls-files` probe,
  cached 120 s like the rest).

**Test hooks:** `tests/test_code_map_bootstrap.py` (esp.
`testSkipsNoiseDirsAndBinaries`, which currently pins only node_modules/png).

## 6. AUG.md directive drift (confirmed, medium — prompt hygiene)

`AGENTS.md`/AUG.md asserts `MAX_MANAGED_TOOL_ROUNDS` "defaults to 25";
`workbench.py:75` = **0** (unlimited by default since 2026-09-07 commit
`38944632`), with the 25 only as an unreachable fallback when the brain-config
key is absent. The notes also spend paragraphs disavowing removed features
(verifier gate, old auto-route) and reference 0.12.55-era behavior while the
app is at 0.18.10. A model plans rounds against a limit that doesn't exist.

**Fix sketch:** make version/limit claims in AUG.md generated or checked —
the repo already runs `scripts/check-version-sync.mjs` as a pre-commit hook;
extend the same idea: grep-style assertions ("any number in AUG.md that
duplicates a code constant must match"). Otherwise: strip historical
disclaimers from the standing prompt, they belong in CHANGELOG.

## 7. NOT a repo bug: `ToolSearch`/`select:` prompt text — installed-runtime drift (reclassified)

My context carried a system-reminder saying the real tool is `ToolSearch`
with a `select:` parameter. Searched exhaustively: **zero hits in this
checkout and its entire history** (`git grep -S "select: <tool_name>"`,
`git log -S "not currently visible"` across all branches). The checkout
registers `tool_search`/`tool_describe`/`tool_call` with exactly the
descriptions in my tool list
(`tool_bridges.py:173-215`, `model_tools.py:65-99`). The only in-tree
CamelCase occurrence is the internal handler *function* name
`handleToolSearch` (`tool_bridges.py:42`, referenced at `:180`) — never a
tool name or prompt string. Since the running app is
the **AppData-installed backend** (`diagnose_proxy`: mode=production,
`backend-runtime` copy), the phrase comes from a runtime newer/different
than master. Action items (release process, not code):
- surface a `runtime git SHA vs checkout SHA` line in `diagnose_proxy`
  output or the system prompt (the memory-policy note about "desktop releases
  must include backend changes" suggests this class of drift is known);
- make that drift observable instead of diagnosable-by-archaeology:
  `git grep`-ing history for one prompt sentence took 4 rounds.

## 8. "Stuck after ~13 commands" — root cause NOT reproducible from master; needs instrumentation (open)

Ruled out with code evidence:
- **Round cap:** `workbench.py:75` default 0 = disabled; if set, it emits a
  visible `Tool loop exceeded maxWorkbenchToolLoops (N)` error (3322-3331).
- **Stall nudge/stop:** `MIN_ROUNDS_BEFORE_STALL_CHECK=8`,
  `MAX_STALLED_ROUNDS=8` → nudge ≈ round 16, stop ≈ 18, both emit visible
  events (3357-3383); neither matches "13" and both are loud.
- **Truncation fail-all:** emits `[Validation Error] ... retry` receipts
  (4032-4060) — visible, not silent.
- **Malformed-JSON downgrade:** emits self-heal + warning (visible).

Remaining plausible candidates (each matches "model appears frozen"):
(a) the **verification gate** blocking the edit result up to 180 s on a
timeout (item 2 — hit for real this session); (b) **mid-turn auto-compaction**
(`context_compressor.py` trigger 0.80×window — 13 commands of tool spam in a
small window plausibly crosses it); (c) **provider stream interrupt + retry
backoff** (`_modelRetryDelayMs`, 804-810). The event log exists but is
hardline-protected from sandbox reads, and the messages store batches
timestamps — I could not time-diagnose the stuck turn from the sandbox.

**Fix sketch (the valuable one):** emit a per-turn `turn_end {reason}` event
(`finished | length | cap | stall-stop | error | interrupted | compaction`)
in the event log + debug view. Then this class of user report ("stopped at N
commands") becomes one query instead of a code audit.

## 9. `remember` refused the friction-report note twice — sensitive-filter false positive (confirmed, low)

Saving this audit's summary via `remember` returned `refused: this looks like
a sensitive topic (health, ID numbers, minors, beliefs)` twice (long
technical details; then a short neutral version). Both attempts are ordinary
engineering text; nothing in them is health/ID/minors content. Per tool
contract "do not retry", so the durable note was **not** saved — the finding
only survives in this file and the chat.

**Fix sketch:** make the refusal explainable: the classifier should surface
what triggered (token/phrase) in the refusal message, and technical words
like "harness/sandbox/diagnose" content should not route to the health
bucket. Until then, friction audits should write to a repo file (this one)
rather than memory.

---

### What was already good (kept as-is; no action)

- fileHash read→write chain and stale-edit rejection — worked.
- Exit-code receipts in `run_command` — worked.
- Narration-vs-action self-heal and `[Validation Error] ... Do NOT stop` —
  never misfired this session.
- Sandbox spill-truncation of a 1.9M-char `findstr` blast (my own mistake)
  into a head/tail + spill file — exactly the right behavior.
- Timeout-as-inconclusive (not failure) in the gate receipt — correct call.
