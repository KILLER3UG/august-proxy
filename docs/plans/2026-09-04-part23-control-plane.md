> **Open items are tracked in `docs/ROADMAP.md`. This document is a record of the
> charter and the reasoning, not a task list** — the open items live in the
> roadmap; the reasoning that produced them lives here.
>
> **Corrected 2026-10-20 against the tree at `5cdae644`.** One of the five build
> items is **CLOSED**: the T-3 residual (cache-split aggregates on the Usage
> dashboard) shipped — `backend-py/app/routers/usage.py:66-67` sums
> `cache_hit_tokens` / `cache_miss_tokens` in `/stats` and returns
> `cacheHitTokens` / `cacheMissTokens` / `cacheHitRate` (`:167-169`); `/by-model`
> reads them too (`:232-233`, `:250-251`); and the dashboard renders the hit rate
> (`frontend/desktop/src/sections/workspace/WorkspaceUsageSection.tsx:81-84`).
> The "That gap is the whole residual" sentence in §1 was true when written and
> is false now.
>
> The four still open: T-2 (micro-compaction), T-4 (web-result TTL cache),
> B-1 (browser dialog handling) and B-2 (persistent browser profile) — all
> re-verified as absent from the tree, with their anchors below.
>
> **Before using any citation in this file:** `MAX_MANAGED_TOOL_ROUNDS` is
> **`0` (uncapped) at `backend-py/app/services/workbench/workbench.py:93`**, not
> "25 at :73"; `MAX_TOOL_RESULT_CHARS` is at
> `backend-py/app/services/workbench/loop/surface.py:32` (re-exported from
> `workbench.py:1307`), not `workbench.py:97`/`:361`/`:363`; `_spillToolResult`
> is at `backend-py/app/services/workbench/loop/prompt.py:268`; the browser
> console listener is at `backend-py/app/services/browser/session_manager.py:207`;
> and `_fetchUrlContent` is at
> `backend-py/app/services/tool_registrations/web_tools.py:333`.
>
> Earlier note (2026-09-27) — Still unbuilt, charter stands, anchors do not. No
> `microCompact`, no web result TTL cache, no browser dialog handler, no
> persistent profile, no cache-split aggregates. Before using a citation:
> `MAX_MANAGED_TOOL_ROUNDS` is now `0` (uncapped) at `workbench.py:81`, not "25
> at :73"; `MAX_TOOL_RESULT_CHARS` is at `workbench.py:363`, not `:361`/`:97`.

# Part 23 — Agent control plane: the slim build charter

Status: **CHARTER APPROVED 2026-09-04** per the OQ dossier
(`2026-09-04-oq-recommendations.md`, Part 22 §9b ruling). Build order below.
**Four of the five build items remain unimplemented; T-3-residual has since
shipped** (see §1). The research proposed ten items; three have already
shipped at `cb626b40` and are recorded as landed (§3), two are deferred with
recorded triggers (§4), and the rest remain to build (§1–§2). Every anchor below was
re-read against the current tree — where the dossier's cited line numbers had
drifted, the corrected range is used and flagged. Companions:
`2026-09-01-capability-research.md` (the source report, §1–§3) and
`2026-09-01-bot-mode.md` (Part 19, whose S-1 unattended rider gates B-2).

Scope in one sentence: **finish the control plane the research found "mostly
built"** — amortized context compaction, the cache-split read side, a web-result
cache, and two browser hardenings — without re-opening the items that already
landed.

Score tags carried from the research: **[num]** measured improvement,
**[rel]** reliability, **[feat]** capability.

---

## 1. Build items — token / context tier

### T-2 · Micro-compaction — [num] — size M

**What.** After each completed turn (idle, never mid-stream), if estimated
context exceeds a per-model **absolute-token** soft threshold, fold the single
oldest not-yet-absorbed exchange into the rolling summary — one exchange per
turn, amortized. Reuses the existing `context_compressor` summarizers
(`workbench/context_compressor.py:618` `compressMessages`, `:785` `_summarize`).
Opt-in brain-config `microCompact.enabled`, default **off** until measured
(Part 18 §6 gate discipline).

**Why it earns its place.** August's compaction today is threshold-triggered and
whole-context, so a long session pays one large visible stall. Amortizing keeps
the warm provider prefix and removes the stall from the hot path — long sessions
stay under budget without a compaction cliff.

**Anchors (verified).** Token estimators + critical threshold
(`workbench/token_budget.py:24` `estimateTokens`, `:48` `getCriticalThreshold`,
`:65` `computeBudget`, threshold logic `:97-102`); hard result cap
`MAX_TOOL_RESULT_CHARS = 64 * 1024` (`backend-py/app/services/workbench/loop/surface.py:32`,
re-exported from `workbench.py:1307`); tool-round cap
**`MAX_MANAGED_TOOL_ROUNDS = 0` (uncapped) at `backend-py/app/services/workbench/workbench.py:93`**
— the "25" this paragraph used to quote is stale, and 0 is the shipped default (a cap is
opt-in via brain-config `maxWorkbenchToolLoops`). **Cache rule:** folding
touches only messages *before* the cache breakpoint, so the warm prefix survives
— the same invariant Part 18's cache-sentinel scenarios assert. **Guarantee:** a
small N-user-message tail is never folded.

### T-3-residual · Cache-split aggregates on the Usage dashboard — [rel] — size S — **CLOSED**

**What.** Add the prompt-cache split (cacheRead / cacheWrite) to the Usage
dashboard's existing day / hour / model shapes. **Capture, persist, per-session
read, and SSE already landed** — only the dashboard **aggregate read side**
remains.

**Verified state (as of 2026-09-04).** The split is written per event into `usage_events`
(`memory_store/rest.py:395-399`, columns `cache_hit_tokens` /
`cache_miss_tokens`); the per-session aggregate already SUMs them
(`rest.py:430`); providers capture both wire formats
(`workbench/providers.py:749-766`). But the four dashboard endpoints in
`routers/usage.py` — `/stats` (`get_usage_stats`, `:35-145`), `/heatmap`
(`:148-174`), `/by-model` (`:177-216`), `/by-day` (`:219-266`) — each SUM only
`input_tokens + output_tokens` (e.g. `:45,63,164,185,197,233`) and **none read
the cache columns**. That gap is the whole residual.

> **That gap is CLOSED — the sentence above was true on 2026-09-04 and is false
> now.** The dashboard aggregate read side sums and returns the cache columns:
>
> - `/stats` sums them — `backend-py/app/routers/usage.py:66-67`
>   (`COALESCE(SUM(cache_hit_tokens), 0) AS cache_hit`,
>   `COALESCE(SUM(cache_miss_tokens), 0) AS cache_miss`) — and returns
>   `cacheHitTokens` / `cacheMissTokens` / `cacheHitRate` (`:167-169`).
> - `/by-model` reads them too (`:232-233`, `:250-251`).
> - The dashboard renders it:
>   `frontend/desktop/src/sections/workspace/WorkspaceUsageSection.tsx:81-84`
>   reads `stats.cacheHitTokens` and `stats.cacheHitRate`.
>
> The reason the user cannot see the split in `totalTokens` is deliberate and
> is now stated in the code: cache reads are not billed like fresh input, so
> they never belong in `totalTokens` — but without them the page cannot explain
> a low cost. **Nothing here is an open item; do not rebuild it.**

**Why it earns its place.** Makes the 08-29 cache work visible where the user
already looks at usage; closes the sibling of the "no TTFT telemetry" gap.

**Anchor correction.** The dossier cited `usage.py:39-110`; the real aggregate
endpoint is `get_usage_stats` at `:35-145` (`:39-110` is the aggregation body
inside it). Cited as found.

### T-4 · Web-result TTL cache — [num] — size S

**What.** Short-TTL (e.g. 15 min) in-memory cache for `web_search` / fetch
results keyed by URL, so a session that revisits a page doesn't re-burn fetch +
tokens.

**Why it earns its place.** Repeated fetches stop re-paying tokens; the cache
sits behind the single fetch seam so it is one touch point, not a scatter.

**Anchor (verified).** The fetch function `_fetchUrlContent`
(`tool_registrations/web_tools.py:333` — the anchor has drifted from `:158`),
reached through the SSRF guard (`web_tools.py:121`); the cache wraps this seam.
Keyed by final URL after per-hop redirect resolution so a redirect target is
cached, not the entry URL. **Still open** — re-checked 2026-10-20: there is no
TTL cache in `web_tools.py`; the only `cache` hits in the file are prose in
`_fetchUrlContent`'s own docstring.

---

## 2. Build items — browser tier

### B-1 · Browser dialog handling — [rel] — size M

**What.** Auto-answer JS dialogs (`alert` / `confirm` / `prompt` /
`beforeunload`) under a configurable policy (accept / dismiss / ask), folded into
the snapshot output so the model sees what was dismissed.

**Verified gap — STILL OPEN, re-checked 2026-10-20.** `services/browser/session_manager.py:207`
registers **only** a console listener — `page.on('console', _onConsole)` (the anchor
has drifted from `:96`; `_onConsole` is defined at `:201-205`). There is **no**
`page.on('dialog', …)` handler anywhere in `backend-py/app/services/browser/` —
a grep for `dialog` across that package returns **zero** hits — so an unhandled
modal stalls the page and the turn. The dossier's "`:96` has only a console
listener" claim was confirmed exact; it is still exact, at a new line number.

**Why it earns its place.** A modal blocks the whole session today; this is the
cheapest reliability fix in the browser family.

**Anchor.** Add the dialog listener beside the console one at
`session_manager.py:207`; fold the dismissed-dialog note into the snapshot text
(`services/browser/snapshot.py`, surfaced through `handlers.py`).

### B-2 · Persistent browser profile — [feat] — size M

**What.** Opt-in per-Bot (or global) browser data dir so logins survive across
turns and OAuth sites become automatable — behind explicit consent, with a
visible "browsing as you" state and an approval-gated close flow.

**Ordering — lands AFTER the S-1 unattended rider (now landed 2026-09-04).**
Unattended contexts (routines, Bot DMs, group turns) get the **isolated** profile
only; the persistent profile is never mounted into a remote or unattended
execution context. Cookies are credentials.

**Why it earns its place.** Logins survive; the OAuth-site automation that was
previously out of reach becomes possible, with the credential exposure bounded by
the consent + isolation rule.

**Anchor (verified).** The ephemeral triple to replace is
`session_manager.py:177-198` (`launcher.launch(..., headless=True)` →
`browser.new_context(...)` → `context.new_page()`; the anchor has drifted from
`:80-88`); a persistent context substitutes for `new_context`. The
consent / approval gate reuses the S-1 headless policy that now consults
`session.headless` (Part 22 §9e, landed). **Still open** — re-checked
2026-10-20: there is no `user_data_dir` / `launch_persistent_context` anywhere
in `backend-py/app/services/browser/`, so the browser still runs headless with
a fresh context and **logins do not survive**.

---

## 3. Dropped as already landed (cb626b40)

Recorded so they are not re-chartered. All three verified present in the tree:

- **T-1 · Spillover tier** — `_spillToolResult` at
  `backend-py/app/services/workbench/loop/prompt.py:268` (it has moved out of
  `workbench.py`, which now only re-exports it at `:478`); over-cap results spill to
  `.aug/spill` (`SPILL_FILE_DIR` `loop/prompt.py:235`, relpath `spill_file_relpath`
  `:238`) with a head/tail preview + path, replacing the silent 64 KiB truncation.
- **D-1 · Missed-steer preservation** — `_collectMissedSteer` at
  `backend-py/app/services/subagent_orchestrator.py:865`, surfaced on the completion entry as
  `missedSteer` (`:1073,1077`).
- **D-2 · Stop → partial result** — `_partial_from_transcript` at
  `backend-py/app/services/subagent_orchestrator.py:878`, folded into `handle.result` with a
  `stopped` marker by `terminate` (`:914`). (Dossier cited `:617-641`; the
  function has since moved — cited as found.)

---

## 4. Deferred with recorded triggers

- **D-4 · Delegation ledger** — **Trigger:** fires only if Bot Mode routines
  (Part 19 Phase B) make async delegation common enough that undelivered
  completions are actually lost across restarts. Until then the in-memory
  orchestrator plus the Part 19 `bot_dm` shape suffice; a SQLite ledger would be
  speculative schema.
- **B-3 · `browser_vision` fallback** — **Trigger:** only if B-1 + B-2 prove
  insufficient in dogfooding on canvas-heavy pages the DOM snapshot cannot crack.
  Shape is screenshot → existing vision path → click-at-coordinates; do not build
  it pre-emptively.

---

## 5. Open questions

**None blocking** — the charter is approved (Part 22 §9b). Recorded,
non-blocking build-order notes (decide at implementation; none gate the charter):

- **T-2 threshold calibration** — the per-model absolute-token soft threshold and
  the never-folded tail size N are set against the `token_budget` estimators at
  build time; the feature ships default-off regardless, so calibration does not
  block landing.
- **T-3-residual presentation** — whether the dashboard shows cache hit-rate as a
  separate card or folded into the existing totals is a cosmetic UI call; the
  read-side SUM is the same either way. **MOOT — this item shipped.** The
  shipped form is a separate cached-token line beside the totals
  (`WorkspaceUsageSection.tsx:81-84`), not a fold into `totalTokens`.
- **B-2 profile granularity** — per-Bot directory vs one global dir; the S-1
  isolation rule (unattended → isolated profile only) holds under both, so it is
  settled when the consent UI is specced, not now.
