# August Backend Harness Audit

**Date:** 2026-09-24
**Scope:** `backend-py/` — agent loop, memory, learning, skills, tools/sandbox, subagents, pricing, robustness.
**Method:** read-only source review. No files were modified; the test suite was not run. Every claim carries `file:line` evidence.
**Note on WIP:** the working tree has uncommitted user changes in `backend-py/app/providers/clients/base.py`, `app/routers/sessions.py`, `app/services/memory_schema.py`, `app/services/memory_store/*` and `app/services/sandbox/backends/container.py`. Findings that touch those files are flagged **[WIP]** and describe the current working-tree state.

---

## 1. The agent loop

### 1.1 Turn structure — SOLID

- **One-turn-per-session invariant is enforced at the service layer, not the router.** `sendWorkbenchMessageStream` takes an `asyncio.Lock` per session before entering the implementation (`workbench.py:2757-2760`), and callers that must not block pass `wait=False` to get a structured `SessionBusyError` (`workbench.py:91-96`, `2758-2759`). The comment at `workbench.py:81-87` is accurate: Bot DMs, room turns, routine respond-turns, automations and Live all call the service directly, and the lock is what actually serializes them.
- **Wire-format dispatch is built once per turn, not once per builder.** `workbench.py:3158-3170` builds only the format the resolved provider speaks, and the comment at `3155-3157` records the prior double-walk as a fixed cost.
- **Both fallback-chain and context-promotion switches rebuild the tool list for the new format.** `workbench.py:3810-3818` and `4123-4129` both re-derive `isAnthropic`/`isOpenai`/`isOpenaiResponses` and rebuild the missing defs — this is the multi-format-gateway invariant from `AGENTS.md:27-38` and it holds.
- **A mid-turn guard-mode flip rebuilds the tool surface and the system prompt.** `enter_plan_mode` is handled at `workbench.py:4599-4620`; the comment at `4601-4605` correctly identifies that the prompt advertised a tool surface (`submit_plan`) that was not there.

### 1.2 Tool-call parsing for BOTH wire formats — SOLID

- Anthropic path builds `assistantMsg` from `response['content']` and filters `tool_use` blocks (`workbench.py:4241-4246`); the OpenAI/Responses path reads `choices[0].message.tool_calls` and normalizes to the same `toolUses` list (`4247-4263`). Both then flow through one `for tu in toolUses` loop (`4511`), so guard checks, approval, malformed-JSON handling and cancellation cannot diverge by format.
- **Malformed JSON never executes as `{}`.** Both `_invalid_json` (OpenAI) and `_raw` (Anthropic stream aggregator) are detected at `workbench.py:4568-4569`; the call is diverted to a validation-error tool result and `continue`s without dispatch (`4570-4598`). The text-tool protocol applies the same rule through `json_salvage` returning `None` → `{'_raw': raw}` (`workbench.py:840-848`).
- **A length-stop generation fails ALL its tool calls unexecuted** (`workbench.py:4472-4513`), because half-parsed arguments would otherwise run truncated commands. This is the correct fail-all, not a partial.
- **A cancelled mid-round assistant message never persists with dangling tool calls, and its tool_results are dropped with them.** `workbench.py:5419-5453` — the assistant is stripped of `tool_use`/`tool_calls`, an emptied message is skipped entirely (`5437-5444`), and `currentMessages.extend(toolResults)` is gated on `not cancelledMidRound` (`5452-5453`). The comment at `5447-5451` names the exact failure (an orphaned `tool_result` produces a non-retryable Anthropic 400 that bricks the session). This is a well-defended path.

### 1.3 Retries — SOLID, with one attribution gap

- Retry classification is careful: quota/402 never retries (`workbench.py:548-552`), deterministic 400s with a `tool_use_id`/`schema` marker never retry (`553-556`), and the "already streamed tokens" gate (`_retryBlockedByPartialEmission`, `4033-4043`) prevents double-billing a partially-emitted completion. These are the right three carve-outs.
- **Weakness (P2): retry/fallback token spend is unattributed.** `resolvedModel` is rebound to the fallback/promotion model at `workbench.py:3805` and `4120`, and the *whole turn's* accumulated tokens are then priced and recorded against that final model — `turn_close.py:485-514` (`record_usage(model=resolvedModel, …)` and `session_cost_usd(model_id=resolvedModel, …)`). A turn that burned Opus retries before landing on DeepSeek reports only the DeepSeek rate, even though Opus billed every retry. The per-event `usage_events` path is *consistently* wrong here rather than inconsistently wrong, so the composer chip and the Usage page still agree — but both under-report real spend, and the session spend ceiling (`workbench.py:3621-3624`) under-counts after any fallback, which weakens it as a runaway-cost guard.

### 1.4 Round and tool budgets — WEAKNESS

- `MAX_MANAGED_TOOL_ROUNDS = 0` (`workbench.py:75`) is correct per `AGENTS.md:47-49` and the cap is honestly opt-in through `_managedToolLoopCap()` (`workbench.py:3591`, `3671-3681`).
- **Weakness (P1): a genuinely-progressing model has no backstop.** With the cap at 0, the only stops are: stall detection, the bounded self-heal retry budget, the length-continuation cap, cancel, error, or the model returning text. Stall detection requires the `(phase, step)` signature to be flat for 8 rounds *and* the round to be non-novel (`workbench.py:3685-3735`). A model that reads a *different* file every round is novel by the canonical-signature test (`_assistant_round_is_novel`, `270-326`) and never trips either the stall counter or the `(tool, target)` polling guard (`248-267`, which keys on the *first argument*). The polling guard catches one target hammered 6×; it cannot catch 200 distinct targets. The remaining guard is `session.costCeiling`, which **defaults to 0.0 = disabled** (`workbench/sessions.py:62`). A single turn can therefore run unbounded in both rounds and dollars with nothing intervening. This is a deliberate design trade (documented at `workbench.py:69-74`), but the trade currently has no floor.
- **Weakness (P2): the opt-in cap cannot be turned back off through the API.** `maxWorkbenchToolLoopsRange = (1, 500)` (`brain_config_service.py:66`) means a PUT cannot express the documented `0 = uncapped` value; a user who sets a cap has no supported way to return to the default without editing the config file.

### 1.5 Stall detection and the error taxonomy — SOLID

- The stall detector is better than its description: canonical sorted-key argument identity (`workbench.py:219-230`), a separate `(tool, target)` polling guard (`237-267`), a novelty definition that reads both wire shapes (`270-326`), and a reset of `stallMessageSent` on a phase/step advance (`3695-3699`) so a second distinct stall streak gets its own nudge. The nudge fires at 8 stalled rounds and hard-stops 2 later (`3707-3735`).
- The 8-family taxonomy (`workbench.py:135-144`) is first-match-wins and coarse by design, and it is genuinely advisory — it appends a reminder and emits a warning, never ends the turn (`3740-3765`). The advice strings (`147-156`) tell the model what to change rather than to retry. Every reminder carries `_REMINDER_FOOTER` (`160-163`) so the model does not file the harness's own voice into durable memory.
- **Weakness (P2): the family tally is family-blind across tools.** `_recent_error_families` (`190-199`) counts by family only, not by `(family, tool)`, so three `not_found` results from three unrelated reads in the last 6 tool results trip the "same problem" steer (`3740-3743`) even though they are three different problems. The nudge then tells the model "repeating the call unchanged will fail unchanged" about calls it was not repeating.

### 1.6 Compaction and prompt-cache stability — MOSTLY SOLID, one cache-stability regression

- Cache discipline is deliberate and visible: the memory/skills/state/nudge tail is patched onto the **last user message**, never the system prompt, precisely so the provider prefix stays stable (`workbench.py:3322-3326`), and tail patches are stripped before every persist (`durability.py:47-63`, consumed at `turn_close.py:392-396`). The comment at `workbench.py:3326-3332` explicitly corrects an earlier false claim that the tail was never persisted — good self-correction.
- The system prompt carries volatile session state *out* of it (`workbench.py:3482-3484`), and the profile lane renders inside the `<memory>` block so it cannot destabilize the prefix.
- **Weakness (P1, cache stability + unbounded growth): the progressive-disclosure path mutates a module-global tool definition.** `model_tools.py:72` declares `_BRIDGEToolDefs` as a module-level list. `assembleToolDefs` builds a "short catalog" hint and writes it back **in place** (`model_tools.py:196-204`): it reads the *current* description — which already contains the previous hint — appends a fresh ` Available (short): …` string, and assigns `_BRIDGEToolDefs[i] = patched`. The function is called once per turn per wire format (`workbench.py:1786-1791` and `2026-2035`), so the `tool_search` description grows monotonically for the lifetime of the process, and session A's tool inventory leaks into session B's prompt. Because `_estimateToolTokens` (`model_tools.py:104-108`) counts description length, the growth is self-amplifying: once the inflated bridge defs push `totalTokens >= thresholdTokens`, the assembly drops all auto-loaded skills (`model_tools.py:181-183`) and trims preloaded tools to 3 (`184-187`) — so progressive disclosure silently degrades the longer the app runs. This is the single most concrete prompt-cache-stability defect found. See Improvement 1.
- Compaction itself is reasonable: pressure tiers, a lock, an archive-before-summarize, landmark pins for `update_state` transitions and failing verification receipts (`workbench.py:3260-3282`), and a token-budgeted verbatim tail with user-turn replay (`3273-3281`).

### 1.7 Stop reasons and telemetry — SOLID

- `_finalTurnEndReason` (`workbench.py:202-216`) is a single authority for the `finished + cancelled → interrupted` and `finished + errored → error` overrides, and it is used for BOTH the SSE `turn_end` event (`5563-5574`) and the persisted row (`5517-5519`) — the two cannot disagree, which is the stated design goal.
- `turn_close.turnTelemetry` writes `end_reason` / `malformed_tool_args` / `surface_downgraded` as NULL-not-zero when unmeasured (`turn_close.py:92-108`, `281-320`), matching `AGENTS.md:63-65`. The edit-verify streak and guardrail digest are read back from their own authorities rather than inferred (`turn_close.py:119-131`, `293-320`). This is the right discipline.
- **Weakness (P2): the whole post-loop block is unguarded.** `await _tc.emitStopHook(...)`, `_tc.turnTelemetry(...)` and `_tc.scheduleAutoTitle(...)` run after the loop (`workbench.py:5490`, `5503`, `5576`). `turnTelemetry` and `scheduleAutoTitle` each have their own internal try/except, but the call at `5503` is not itself wrapped — a raise there would skip `persistAndClose` entirely and lose the turn's final assistant message. Low probability (the callee is defensive), but the ordering makes it a single point of loss.

### 1.8 Malformed-JSON self-heal and surface downgrade — SOLID

- `parseFailures` accumulates **across** rounds, not per round (`workbench.py:3562-3564`, reset only at `5354-5355` on a clean round) — the comment correctly notes that a per-round reset meant repeated malformed calls never triggered the downgrade.
- The downgrade at `workbench.py:5384-5404` rebuilds BOTH wire lists against `_BARE_TOOL_ALLOW` **and** rebuilds the system prompt (the comment at `5392-5393` identifies that the old code left the prompt advertising tools that no longer existed), and auto-restores after `_DOWNGRADE_RECOVERY_ROUNDS` clean rounds (`5356-5378`). This is a genuinely reversible degradation rather than a ratchet.

---

## 2. Memory system

### 2.1 Write path and the write door — SOLID, with a real scope bug

- `save_fact` refuses `project:<path>` at the door with an explanation of why the row would be unreadable (`memory_store/rest.py:91-98`) — exactly the `AGENTS.md:105-108` invariant, and the reasoning is recorded rather than just enforced.
- The scope-home rules are strict and well-documented: a key has exactly one home, a bot may not overwrite a global row, and a write from a foreign non-global scope raises (`rest.py:100-125`).
- The UPSERT preserves `created_at`, `use_count` and `scope`, and revives a retired row on re-remember (`rest.py:130-158`, rationale at `79-81`). An update with no `kind` does not downgrade a lesson to a plain fact (`127-129`).
- **Weakness (P1): `allow_scope_override=True` does not move scope — it silently overwrites a foreign-scoped row's value.** The docstring says callers that "legitimately move/merge rows across scopes (consolidation)" pass this flag (`rest.py:74-77`), but the `ON CONFLICT … DO UPDATE SET` clause (`rest.py:134-145`) never assigns `scope`. So a consolidation merge that "moves" a `bot:<id>` fact into a global row overwrites the global row's **value** while the row keeps its `global` home — the original shared value is destroyed with no scope change to signal it. This is the inverse of the protection at `rest.py:110-125`, enabled by the very flag documented as the sanctioned escape hatch.
- **Weakness (P2): the scope check is a TOCTOU.** `get_fact(factKey)` then `conn.execute(upsert)` then `commit` (`rest.py:101-158`) runs with no `BEGIN IMMEDIATE`. Two threads can both pass the guard and both write. The brain DB uses thread-local connections (`memory_conn.py:112-122`) with WAL + `busy_timeout=10000` (`memory_conn.py:52-54`), so this is a real multi-thread race, not a theoretical one — the learning scheduler (`learning_scheduler.py:301`), curator runs (`curator.py:48`) and the turn loop all write concurrently. The window is narrow (one SELECT) and the damage is bounded (last writer wins on the same value shape), which is why this is P2 rather than P1.

### 2.2 Recall: BM25, FTS and the profile lane — SOLID

- The BM25 corpus is cached per scope, usage is deliberately kept **out** of the cached corpus and fetched per query for the candidate set (`fact_retrieval.py:66-70`, `141-146`, `262-285`). This is the right call: `touch_fact_usage` then needs no invalidation (`rest.py:192-196`) and the per-turn full-corpus rebuild cliff is gone.
- Invalidation has correct blast radius: a `global` write clears every scope corpus because every union contains global; a scoped write only drops its own (`fact_retrieval.py:73-95`). `delete_fact` clears everything (`rest.py:280-283`) and the TTL sweep clears too (`consolidation.py:106-112`) — the comment at `104-105` names the exact failure this prevents.
- The **always-on profile lane** is implemented exactly as `AGENTS.md:101-104` describes: same cached corpus, same visibility rules, no query, 600-char budget that is deliberately well under half the 1600-char block cap so it cannot starve keyword recall (`fact_retrieval.py:48-54`, `465-529`). It renders first inside `build_memory_block` (`595`, `654-655`) and is injected on the off-gate path through `build_profile_memory_block` (`532-548`, called from `workbench.py:3461`).
- **Budget honesty is real.** Dropped facts are NAMED in a `recall partial:` line rather than vanishing (`fact_retrieval.py:417-443`, `668-675`), the receipt gets reserved budget and re-packs the lane so the receipt itself fits (`507-525`, `644-652`), and `_fit_lines` keeps rank order so a later short line never jumps ahead of a dropped stronger one (`390-414`).
- FTS5 exists for `memory_store` and `messages` with sync triggers (`memory_schema.py:27-31`, `99-104`, `143-176`), and the `messages_fts_au` trigger is correctly narrowed to `UPDATE OF content, session_id, role` so a `blocks_json`-only update does not churn the index (`memory_schema.py:168-176`).
- **Weakness (P2): the episodic FTS/index half is deliberately closed as won't-build.** `consolidation.py:116-126` keeps the table (readers do LIKE) but ships no FTS mirror or triggers, with the OQ4 rationale recorded. This is a sound decision, not a defect — noted so it is not mistaken for a gap.

### 2.3 Where memory can silently drift or be lost

- **Drift: cache staleness across processes.** `_caches` and the lock are module-globals in a single process (`fact_retrieval.py:66-70`). There is one backend process, so this holds today; it is noted only as a constraint on any future second process.
- **Drift: `_load_index` swallows its own build failure.** On an exception it sets `rows, corpus = [], []` and caches that empty index (`fact_retrieval.py:193-199`). A transient SQLite lock at boot therefore caches an **empty** corpus that persists until the next write invalidates it — recall silently returns nothing for the rest of that window, and because the failure is `logging.debug` it is invisible at default log level.
- **Loss: `allow_scope_override` value overwrite** (§2.1) — the one genuine memory-loss path found.
- **Loss: the TTL sweep is DELETE, not retire.** `_expire_facts` hard-deletes rows past `expires_at` (`consolidation.py:91-113`). A fact whose `expires_at` was written by a model with a bad date is gone with no `.pre-restore`-style undo, unlike the preference-retire path which is correctly propose-only (`consolidation.py:184-196`).

### 2.4 Backup, integrity and restore — SOLID

This is the strongest subsystem in the backend.
- Online copies through SQLite's backup API against a read-only handle, so no write lock on the live file (`brain_backup.py:139-165`), and `ensure_current_backup` is deliberately *not* wired into the migration snapshot because that runs inside an open write transaction and `backup()` needs a read lock (`391-399`).
- **Every copy is verified before it is trusted**, with two independent gates: `PRAGMA integrity_check` (`60-66`) *and* `_content_reason` (`69-96`), which exists specifically because a zero-byte file is a well-formed SQLite image that reports `ok` — the docstring at `69-76` names that failure precisely.
- A failed backup removes only the *unverified* husk and never a good copy (`brain_backup.py:180-183`, `197-207`).
- Restore is **staged and applied at next launch**, exactly per `AGENTS.md:113-128`: the marker is a file (`34`), `apply_pending_restore` runs before any connection exists (`main.py:184-185`, correctly ordered before `memory_store.init()`), the swap is staged beside the live file and published with `os.replace` (`brain_backup.py:349-353`), and the `.pre-restore` copy carries its `-wal`/`-shm` sidecars so uncheckpointed memory survives (`344-348`).
- The name regex is a strict shape and the comment explains why it must accept every name `create_backup` can write (`brain_backup.py:36-41`) — a copy that lists as restorable but fails to restore is correctly treated as the worse outcome.
- Schema-version refusal reuses the migration runner's own discovery, so there is no second version constant (`brain_backup.py:107-117`, `267-273`).
- **Weakness (P2): `ensure_current_backup` will skip on a fresh-but-corrupt newest copy.** It takes `list_backups()[0]` — sorted by name, so the newest — and returns `skipped` purely on age (`brain_backup.py:400-409`), without checking `healthy`. If the newest backup is corrupt and <12h old, no good copy is taken and the corrupt one stays at the head of the list.
- **Weakness (P2): the restore response is `ok: True` even when a post-swap step failed.** The design is deliberate and documented (`brain_backup.py:362-364` — re-running would destroy the only copy of what was replaced) and it correctly downgrades cleanup problems to a `warning` key (`364-388`). This is right; it is listed so a reader does not mistake the `warning` for an error.

### 2.5 Concurrent writes

- WAL + `busy_timeout=10000` + `foreign_keys=ON` as defaults, with `synchronous` deliberately left at SQLite's FULL and NORMAL/OFF gated behind an explicit env opt-in (`memory_conn.py:35-75`). The docstring states the power-loss trade-off rather than hiding it.
- Per-turn telemetry commits are debounced to ≤2s on loop threads only, with the flush running on the **owning** thread because `check_same_thread` is on (`deferred_writes.py:1-20`, `30-40`). The 10s max-hold prevents indefinite postponement (`deferred_writes.py:40-42`).
- `_begin_txn` settles an already-open transaction before issuing its own `BEGIN`, with an accurate explanation of the `deferred_writes` interaction (`memory_store/sessions.py:14-30`).
- **Weakness (P1): the primary workbench save path rewrites the entire message table on every flush.** `save_workbench_session_sot` does `DELETE FROM messages WHERE session_id = ?` followed by a full re-`INSERT` (`memory_store/sessions.py:281`, `329-334`). That is O(N) per save, and it fires the `messages_fts_ad`/`messages_fts_ai` trigger pairs for every row (`memory_schema.py:159-166`) — so FTS delete+insert churn scales with transcript length × save frequency. The barrier fires three times per round (`workbench.py:3861`, `4852`, `5473`) and rounds are uncapped by default (§1.4), so a long session pays this repeatedly. The dirty-set optimization in the snapshot writer (`workbench/sessions.py:604-608`, `_dirty_sids`) correctly limits *which sessions* are saved but does nothing for transcript length. Migration 048's client-row re-attachment work (`sessions.py:146-196`, `304-323`) makes the rewrite more correct, not cheaper.

### 2.6 Episodic timeline compaction — SOLID

- Retention is config-driven, clamped to `[1, 3650]` days, and parses with `julianday` rather than string compare so a mixed-format column cannot mis-order the cutoff day (`consolidation.py:116-148`, rationale at `94-97` in the sibling sweep).

---

## 3. Learning / self-improvement

### 3.1 What actually runs today — SOLID

- **One scheduler, one ledger, one due-ness path.** `learning_scheduler` registers four jobs — `introspection` (6h), `consolidation` (24h), `refine` (24h), `outcome` (72h) — each with a `learning_job_run` row, cadence re-read from brain-config every tick, and a bounded ledger (`learning_scheduler.py:261-264`, `88-95`). Due-ness is computed from the last *finished* row so a running job never double-fires (`171-183`), and the first boot is always due (`175`).
- `run_job` never raises — failures land in the ledger as `status='error'` (`learning_scheduler.py:270-296`) — and `run_job_async` wraps the blocking bodies in `asyncio.to_thread` so the event loop is never held (`299-301`). The scheduler loop itself runs jobs serially, explicitly because the passes share the brain DB (`304-318`).
- The scheduler is started with a retained handle and cancelled at shutdown (`main.py:244-249`, `255-258`).
- **The refine pass was correctly promoted out of consolidation** into its own job with its own cadence and ledger row (`learning_scheduler.py:238-258`); the stale call site in `_skill_learning_pass` was removed and the comment says so (`consolidation.py:517-520`).
- The **episode miner → flag → judge chain runs on the consolidation cadence without manual clicks** (`consolidation.py:487-516`), and the comment at `505-508` correctly names the failure it fixes: a fingerprint that recurs between manual `/api/curator/run` calls would never re-flag.
- `flag_top_slice` has a genuine cost gate — `int(len * cap)` rounded to 0 for any pass with <20 unscored episodes meant typical desktop installs never escalated anything (`episode_miner.py:626-631`; the comment records this as a fixed bug).
- **Everything is suggestion-only.** Demotions, revisions and retirements are proposals a human approves; nothing auto-deletes (`episode_miner.py:787-794`, `875-903`), and `_file_suggestion` dedupes on `(fingerprint, action, target)` including rejected drafts so a daily pass does not stack duplicates (`875-891`).

### 3.2 What is gated off — and what is dead

- `skillLearning` defaults to `'extract-only'` (`brain_config_service.py:166-170`): mining + promotion proposals run, full skill-body drafting is opt-in, `'off'` returns 409 on the curator route (`curator.py:34-35`).
- `consolidationModelSummarize` defaults **False** — each merge otherwise costs a model call (`brain_config_service.py:124`).
- `autoRefine` gates the refine job, which returns `{'status': 'disabled'}` when off (`learning_scheduler.py:248-250`).
- `preferenceRetireEnabled` defaults True but the pass is **propose-only by construction** (`consolidation.py:184-196`) — correct.
- Dead / removed, and correctly so: the `autoRoute` / `autoRouteMinWinRate` / `autoRouteMinWinRate` keys are gone and the reason is recorded at `brain_config_service.py:100-104`; the verifier gate is absent as `AGENTS.md:40-43` states.
- **Weakness (P2): `usageRetentionDays` is read but not settable.** `consolidation._sweep_usage` reads `getRuntimeConfig().get('usageRetentionDays', 365)` (`consolidation.py:161-162`), but the key is in neither `numKeys` nor `fieldTable` (`brain_config_service.py:43-59`, `72-186`), so it is filtered out of `allowedKeys` and cannot be changed through the Brain settings API — only by hand-editing config.

### 3.3 Where the learning loop is weakest

- **Weakness (P1): the loop is propose-heavy and apply-light by construction, and nothing surfaces the backlog.** Every stage files a proposal and a human decides. That is the correct default (nothing auto-deletes), but the audit found no path that *measures backlog age* — `scheduler_status()` reports per-job last-run and next-due (`learning_scheduler.py:324-360`) and `curatorReport` reports counters (`curator.py:130-153`), but neither reports "N open proposals, oldest M days". A learning loop whose output silently accumulates un-reviewed proposals is indistinguishable, to the user, from a learning loop that is not running. The ledger proves the jobs *ran*; nothing proves anything was *acted on*.
- **Weakness (P2): `run_resolution_check` string-compares a mixed-format column.** `stale = lastSeen < cutoff` (`episode_miner.py:812`) compares an ISO `last_seen` (written at `episode_miner.py:332`) against an ISO cutoff (`799`) — those two agree, so this specific comparison is safe. It is listed because `prune_old_episodes` at `episode_miner.py:697` makes the *same-shaped mistake the miner explicitly fixed at `655-657`*: an ISO cutoff compared against a `datetime('now')` space-separated `created_at`, where `' '` (0x20) sorts before `'T'` (0x54) and prunes part of the cutoff day. Low impact (90-day retention, off by ≤1 day) but it is an inconsistency inside one file that already documents the correct pattern.
- **Weakness (P2): `set_fingerprint_status` has asymmetric guards that are easy to misread.** `retired` is unconditional; every other status requires `status = 'open'` (`episode_miner.py:862-871`). The docstring explains the intent (a draft must not resurrect a resolved fingerprint) and the code matches it — recorded here because the asymmetry is invisible at the call site.

---

## 4. Skills

### 4.1 Install tree, parsing and validation — SOLID

- Name and description validation is real, not advisory: a lowercase dotted/hyphenated pattern plus a length cap, and a marketing-word denylist (`skill_service.py:213-231`). `_parseSkill` returns `None` for a file with no frontmatter block or an empty body (`235-241`), so a malformed SKILL.md silently vanishes from every catalogue rather than rendering half-parsed.
- Unrecognized frontmatter keys round-trip through `meta` instead of being dropped on the next write (`skill_service.py:246-257`, rationale at `257`). The curator report reads `status` out of `meta` after a top-level read proved always-empty (`curator.py:71-76`) — a real fix recorded in place.
- Entries failing the name rule are skipped at discovery with a log line, so leftover `pending-*` staging dirs never reach a catalogue or prompt (`skill_service.py:292-299`).
- The catalogue memo keys on **per-SKILL.md mtimes**, not just the root dir mtime, because a root-dir mtime misses an in-place edit (`skill_service.py:107-117`) — the comment names that exact reason.
- `_parse_frontmatter_block` strips a matching quote pair so literal quotes never ride into the index (`skill_service.py:266-282`).

### 4.2 Usage counters — SOLID

- The usage sidecar is `<dataDir>/skills/<name>/.usage.json` and never sits in the install tree (`skill_service.py:1001-1013`), matching `AGENTS.md:108-111`. Legacy in-tree sidecars are found and migrated, choosing the highest-count copy (`1026-1099`) — so a counter is not silently reset by the move.

### 4.3 Progressive disclosure — see §1.6

The disclosure *algorithm* is well-built (core/deferrable split, BM25 pre-load against the model's real window, budget-driven trimming with a floor of 3 preloaded tools, and an inline short-catalog hint to avoid a round-trip). The implementation of the hint is the defect: it mutates module state.

### 4.4 Weakness

- **Weakness (P2): the distiller's judge is a background model call on a 24h cadence with no per-run budget beyond the flag rate cap.** `flagTopSlice` gates escalation count (`episode_miner.py:594-603`) but `run_distiller_pass` is invoked once per flagged episode inside the consolidation job (`consolidation.py:512-516`). With `escalationBudgetPerDay` default 2 that is bounded, so this is a note rather than a finding.

---

## 5. Tools and sandbox

### 5.1 Tool definitions and capability profiles — SOLID

- Both wire builders run the same BM25-budgeted progressive disclosure against the session model's **real** context window, not a global default (`workbench.py:1776-1788`, `1998-2028`). The OpenAI path correctly shims defs into Anthropic shape for ranking and maps the selected names back to the original OpenAI-format defs (`2011-2035`) — so ranking and wire shape cannot drift.
- **Cache-stability ordering is deliberate:** bare-essential tools sort first in both builders, so a self-heal downgrade to the bare set yields a *prefix* of the full list and the Anthropic prompt-cache breakpoint on the tools array stays valid; `maxTools` truncation also cuts non-essential first (`workbench.py:1759-1767`, `1981-1984`).
- Capability profiles (`full`/`reduced`/`bare`/`text`, `maxTools`, `maxToolResultChars`) are read from the provider config and honored by **both** tool-definition paths and by result truncation (`workbench.py:1865-1948`), matching `AGENTS.md:72-74`. The profile lookup is memoized on a 5s TTL with an explicit justification (`1865-1873`).
- `_BARE_TOOL_ALLOW` ships memory CRUD as a set with the reason inline (`workbench.py:1843-1851`) — the `AGENTS.md:130-135` invariant, and the comment explains the failure mode (a write door with no way to read or correct).
- `AUGUST_CORE_TOOLS` is consistent with that (`tools/model_tools.py:20-48`).

### 5.2 Result truncation and spill — SOLID

- `_truncateToolOutput` is a bounded head+tail cut with a single-line-overrun guard that degrades to a hard cut rather than returning near-empty (`workbench.py:670-708`) — the docstring names the field incident that motivated it.
- **Spill only happens when the result is retrievable.** `_spillToolResult` takes a `retrievable` flag and returns `None` when the offered surface has no reader, falling through to honest truncation (`workbench.py:759-801`, rationale at `769-774`) — a receipt naming a path the model cannot open is worse than truncation, and the code says so.
- The sequence number is claimed **before** the write so two oversized results in one batch cannot overwrite each other (`workbench.py:781-786`).
- SSE and history use separate caps: 100 KB for the UI (`workbench.py:5213-5223`) and the per-model cap for what the model sees next turn (`5303-5332`) — correct separation.

### 5.3 Sandbox backends and egress

- **Backend selection probes at most every 30s** and puts container first because it is strictly stronger (`backends/__init__.py:16-33`); `invalidate_backend_cache()` exists for env flips (`54-57`).
- **Hardline protected-path rules run before every backend and before the Full Access short-circuit** (`backends/__init__.py:70-80`) — credential material cannot be written even in Full Access, which is the right invariant (`hardline.py:1-22`).
- The egress proxy is honest about its own scope: it constrains HTTP-client traffic only, raw sockets to hard-coded IPs bypass it, and the docstring says to pair it with the container tier's `--network none` (`egress.py:1-14`). `NO_PROXY` is set for loopback because the model routinely talks to local dev servers it spawned (`egress.py:209-211`).
- **Weakness (P1, WIP): the container backend runs with Docker's default capability set.** `build_docker_argv` (`sandbox/backends/container.py:87-122`) sets `--rm`, a workspace bind-mount, `--memory`, `--cpus` and `--network none` as appropriate — but there is **no** `--cap-drop`, no `--security-opt no-new-privileges`, no `--user`, no `--pids-limit`, and no read-only rootfs or tmpfs `/tmp`. A process inside the container keeps Docker's default capabilities and root uid. Since the container tier is the one backend advertised as "real OS-level isolation" and the only one that can actually enforce `network: false` (per `egress.py:10-14`), its isolation is materially weaker than the docstring at `container.py:1-7` implies. Mitigation is cheap and standard: five flags.
- **Weakness (P2, WIP): the container-abort cleanup is a fire-and-forget task with no handle.** `container.py:161-176` schedules `docker kill` via `asyncio.create_task(...)` and discards the handle — the kill may never run if the loop tears down first, which is precisely when an orphaned container matters. The `except (OSError, Exception)` on line `175` is also redundant (`Exception` subsumes `OSError`).
- **Weakness (P2, WIP): the first containerized command blocks on an image pull.** `build_docker_argv` emits the bare image name (`container.py:120-121`) with no `--pull` policy and no pre-warm; `probe()` only checks that the daemon answers (`43-78`), not that the image is local. The pull happens inside the tool timeout with no progress output, so the first `run_command` on a fresh machine can look like a hang.
- **Weakness (P2): the egress proxy relay has no idle timeout.** `_relay_connect` / `_relay_plain` pump until either side closes (`egress.py:111-147`), with no `wait_for` on the gather. For the shared deny-all proxy this is unreachable (everything is refused before relay, `egress.py:62-64`, `75-81`), but any caller constructing an allow-set proxy can leak a relay task per idle tunnel. `_handle` and `_pump` both correctly avoid the `wait_closed()` hang (`104-109`, `160-163`).

### 5.4 Permission policy — SOLID

- Two independent axes with the sandbox as ground truth for capability and the approval module for intent, and the docstring states which is which (`workbench/permissions.py:1-29`).
- **Fail-closed everywhere it matters:** a missing, throwing or absent answerer resolves to DENY (`permissions.py:19-22`), and unattended/headless runs use a never-ask stance so nothing can hang (`22-24`).
- Chained-command handling is correct: operators invalidate simple first-token classification for the benign categories, so `ls && rm -rf /` cannot classify as `read` (`permissions.py:45-52`), while destructive/network scans look at every segment.
- Approval grants are one-shot and the answerer may only return a closed outcome enum (`permissions.py:17-19`).
- Read-before-edit is a real gate with a distinct error code and a version-pin/forget-on-mutation discipline (`workbench.py:5155-5172`).

### 5.5 Weaknesses

- **Weakness (P2): shell is excluded from the central mutating classifier.** `run_command` bypasses `is_mutating` and relies on the soft/OS preflight (`workbench.py:6306-6311`). The comment is explicit that this is deliberate — the sandbox still enforces it — but it means the read-only *sandbox mode* gate is materially weaker for shell than for every file tool, and the model only learns that from a blocked result.

---

## 6. Subagent orchestration

### 6.1 Config, caps, depth — SOLID

- Per-session `maxConcurrent` / `maxIterations` / `maxDepth` / `worktreeIsolation` are read from workbench metadata with the global brain-config as fallback, and the orchestrator keeps **per-session semaphores** so a session set to 2 does not get 5 (`subagent_orchestrator.py:324-341`, `378-390`). The comment at `326-328` records the bug that caused it.
- The worker pool has a hard cap of 5 with a per-session gate in front of it (`subagent_orchestrator.py:7`, `747-759`), and a timeout waiting for a slot surfaces as an error rather than a hang (`759`).
- The depth cap is enforced against `max(depth, definedDepth)` with the runtime depth threaded through a **ContextVar**, not an attribute on the shared session (`subagent.py:304-329`). The comment at `315-322` names the exact race the old `setattr(session, 'subagent_depth', …)` had across concurrent workers, and the token is restored in a `finally`.
- **Both spawn tool spellings are excluded from children** (`subagent.py:35-42`) — the comment records that a singular-only filter allowed unbounded recursion plus semaphore-slot deadlock.
- Recurring-task sub-agents bypass the orchestrator pool entirely and are bounded by a dedicated 3-slot semaphore (`workbench.py:79-80`, `2965-2978`), with the task handle registered **at creation** rather than from inside the coroutine so a delete landing before the first await cannot orphan it (`2999-3010`). That is a subtle race, correctly closed.

### 6.2 Memory and tool restrictions — SOLID

- Sub-agents get the same memory corpus, scope and gate as the parent, including the always-on profile lane (`subagent.py:208-236`), and the whole write/CRUD surface — not just `remember` — is blocked (`subagent.py:48-57`). The comment records that listing only `remember` was a gap found in review. This matches `AGENTS.md:141-142`.
- `_toolAllowed` defers to the agent registry for persisted agents but allows everything for synthetic fallbacks (`subagent.py:199-206`) — a synthetic agent is a role label, not a permission grant, and the permissive branch is only reachable because the caller could not find a real agent.

### 6.3 `yieldSchema` — SOLID

- `yield_schema` makes the worker return a single JSON object that is validated and returned parsed when it matches (`subagent.py:269-272`, `1257-1286`), defaulting to the episode schema when a workstream requires one (`607-608`).
- `_renderYieldSchema` sorts keys so the embedded block is byte-identical for the same logical schema (`subagent.py:161-172`) — the stated reason is prefix-cache stability, which is the right reason.

### 6.4 Weakness

- **Weakness (P2): `_MAXAgentDepth` is a module constant while `maxAgentDepth` is a user setting.** The depth cap the sub-agent enforces comes from `agent_registry._MAXAgentDepth` (`subagent.py:22`, `307`), not from `getDelegationLimits()['maxDepth']` (`brain_config_service.py:212-217`) that the orchestrator uses to *reject* a spawn. Two authorities for the same concept; if a user lowers `maxAgentDepth` in Settings the spawn is refused at the orchestrator (good), but if they raise it above the registry constant, the sub-agent's own check still hard-stops at the lower value. The two never diverge dangerously, but the setting cannot be fully honored.

---

## 7. Usage, pricing and billing

### 7.1 SOLID

- **`cost_estimator.price_for_model` is genuinely the only pricing source.** Four consumers — the composer chip, the spend ceiling (`workbench/state_blocks.py:272-287`), the session usage endpoint (`memory_store/rest.py:573-591`), and the request logger (`logger.py:201-210`, `301-309`) — all route through it. The flat 3.0/15.0 computation that used to live in `logger.get_stats` is gone and the comment at `logger.py:196-200` records why. The `AGENTS.md:75-89` invariant holds.
- **0.0 is treated as a price, not an absence.** `parse_stored_price` returns `0.0` for a real zero and `None` only for unset/bool/negative/NaN/infinite (`cost_estimator.py:91-110`), and `price_for_model` branches on `is not None` throughout (`175-209`). No `or default` anywhere on this path.
- **Half-set pricing is honestly labelled.** A model with only one of the two prices set falls back to the table for the other and reports `estimated=True` for the pair (`cost_estimator.py:198-206`) — a half-guess is not presented as exact.
- `estimated` propagates correctly: a single guessed price in a mixed-model session makes the whole sum a guess, and one exact price cannot make the others exact (`memory_store/rest.py:587-590`).
- The cache-hit discount is arithmetically consistent with the loop's three provider cache shapes. For Anthropic, `input_tokens` excludes cache read/creation so `miss = input + creation` (`workbench.py:4213-4215`); for OpenAI-compatible, `cached_tokens` is a *subset* of `input_tokens` so `miss = input − cached` (`4227-4228`, `4230-4234`). `session_cost_estimate` then bills `cache_miss + 0.1 × cache_hit` (`cost_estimator.py:221-224`) — correct for both. The OpenAI cached-token discount being modelled as Anthropic's 10% is documented as a deliberate approximation landing inside `estimated` (`cost_estimator.py:24-28`).
- Price-index caching is stamped on `(mtime_ns, size)` so an external edit propagates immediately, and `saveProvidersStore` calls `invalidate_price_cache()` (`config_service.py:88`) — no stale-price window.
- The one-true-source discipline on model fields is honored where it matters for pricing: `_modelCapabilityProfile` reads `tool_surface`/`max_tools`/`max_tool_result_chars` through `getProvidersAsModels()` (`workbench.py:1889-1898`), i.e. through the typed rebuild, not a raw dict.

### 7.2 Weaknesses

- **Weakness (P2): the usage endpoint's per-event cost loop is unbounded.** `get_usage` fetches **all** `usage_events` rows for the session with no LIMIT (`memory_store/rest.py:576-579`), while the `events` list two dozen lines above is capped at 500 (`562`). For a session with thousands of turns this is a full scan plus one `price_for_model` call per row on every request to `/api/usage/session`. `AGENTS.md:86-87` describes this as "up to 500 events"; the cost loop has no such bound.
- **Weakness (P2): a half-set env override is silently mixed.** Setting only `AUGUST_PRICE_IN_PER_M` makes the output rate fall back to `_DEFAULT_OUT_PER_M` (3.0/15.0) and the result is reported as `estimated=False, source='env'` (`cost_estimator.py:183-191`). A partial override is therefore presented as an exact flat price.
- **Weakness (P2, see §1.3): retry/fallback spend is unattributed across the whole turn.**

---

## 8. Backend robustness

### 8.1 SOLID

- **Boot ordering is correct and the restore invariant holds.** `apply_pending_restore()` runs immediately before `memory_store.init()` (`main.py:184-185`), i.e. before any connection can exist — the exact requirement in `AGENTS.md:117-124`. `ensure_current_backup` is fired as a background thread after boot (`main.py:189`).
- **Shutdown is a genuine ordered drain**, not a best-effort scatter: learning scheduler cancel → log hub → cognitive services → runtime services → `flush_pending_saves()` (with the comment that the daemon timer dies with the process) → `flush_thread_pending()` (debounced telemetry commits, on the loop thread because that is the owning thread of the deferred connections) → `event_log.flush(timeout=10)` → `daemon_manager.shutdownAll()` (`main.py:255-321`). Each is independently guarded.
- **The durability barrier is fail-closed at all three sites.** Model dispatch (`workbench.py:3861-3872`), tool side effect (`4852-4871`), step boundary (`5473-5490`) — each aborts the turn rather than continuing to mutate state that is not durably recorded, and each emits a typed `durability_flush_failed` event so the client is not left hanging. The rationale (losing trajectory state is worse than stopping) is at `durability.py:12-13`.
- **Tool re-dispatch after an exception is correctly guarded.** `_run_regular` re-runs a tool **only** when `result is None` (never started); a tool that raised *after* dispatch is logged and not re-run (`workbench.py:5137-5146`), because a partial apply followed by an unrelated tracker exception would run a mutating tool twice. This is a rare and correct piece of care.
- **Cancellation is handled where it matters.** 22 explicit `except asyncio.CancelledError` sites; the recurring-task sub-agent re-raises rather than swallowing so `executeSubAgent`'s own branch marks the job row (`workbench.py:2978-2982`); the tool stage re-raises (`5342-5343`); the beat/heartbeat tasks cancel in `finally` (`5077-5084`, `5122-5128`).
- **The migration runner is solid.** Idempotent per-version tracking, a failure ledger with a 3-attempt retry budget so a transient lock error does not become a permanent schema hole (`migrations.py:62-111`), a loud ERROR once the budget is spent (`227-238`), continued-on-failure so one broken `ALTER` does not block the chain (`248-252`), and `_is_already_applied_error` (`50-59`) which exists specifically to neutralize the double-ownership between versioned `.sql` migrations and `ensure_column` fast paths — recording the version as applied instead of blacklisting it with a misleading "schema is missing" error. The pre-migration snapshot is deliberately a file copy after a PASSIVE checkpoint rather than the backup API, because the boot path must never block on a busy database (`130-167`). Brain backup then reuses `_discover_migrations` for its version ceiling, so there is no second version constant.
- **A crashed tool returns an error result instead of killing the round** — a crashed tool must not cancel its parallel siblings under `gather` or take the turn with it (`chat_stages.py:55-66`).

### 8.2 Weaknesses

- **Weakness (P1): the durability barrier blocks the event loop.** `flush_session_barrier` is a synchronous function calling `save_workbench_session_sot` (`durability.py:66-96`), and it is invoked directly from inside the async turn loop at three points (`workbench.py:3861`, `4852`, `5473`) with no `to_thread`. Combined with the O(N) delete-and-reinsert of §2.5, every barrier is a synchronous full-transcript SQLite rewrite on the loop that also serves SSE. On a long session this is measurable latency added to each round, multiplied by an uncapped round count.
- **Weakness (P2): 45 `asyncio.create_task` fire-and-forget sites, several with no retained handle.** `turn_close.py:367` schedules `maybe_promote_failure_lesson` and discards the handle; a raise inside it surfaces as "Task exception was never retrieved" and, per the asyncio docs, an unreferenced task can be garbage-collected mid-flight. Most of the 45 are one-shot best-effort side effects where that is an acceptable trade — the specific one worth fixing is the failure-lesson promotion, since it is the only one that performs model work.
- **Weakness (P2: the learning-scheduler task is cancelled but never awaited.** `main.py:255-258` calls `_ls.cancel()` with no `await`, so the cancellation is not observed and the task's possible exception is never retrieved. Minor because the job body runs in `asyncio.to_thread` and cannot itself be cancelled.
- **Weakness (P2: a failed migration leaves a partially-applied version unrecorded.** `conn.executescript(sql)` (`migrations.py:190`) commits each statement as it goes; if statement 3 of 5 fails, statements 1–2 are committed but the version is not recorded, so the next boot re-runs the whole script. This is inherent to `executescript` and the migrations are written idempotently, so the practical risk is low — recorded for completeness.
- **Weakness (P2: `_capability_profile_cache` and the sandbox probe caches are module-global with no lock.** `workbench.py:1861-1862`, `sandbox/backends/__init__.py:12-13`, `sandbox/backends/container.py:30-31`. Benign today (single-threaded event loop, TTL-bounded, idempotent rebuild), but they would need a lock before any second thread or worker process reads them.

---

# Ranked improvement list

Ordered by (impact × confidence) ÷ effort.

| # | Sev | Item | Effort | Risk | Evidence |
|---|-----|------|--------|------|----------|
| 1 | **P1** | **Stop mutating `_BRIDGEToolDefs` in `assembleToolDefs`.** Build a per-call copy of the bridge defs before appending the short-catalog hint. Today the module-global `tool_search` description grows every turn, leaks one session's tool inventory into every other session, breaks prompt-cache stability for a core tool, and self-amplifies into dropping auto-loaded skills and trimming preloaded tools to 3. | S | Low — pure refactor, same output for the first call | `tools/model_tools.py:72`, `196-204`, `104-108`, `181-187`; callers `workbench.py:1786-1791`, `2026-2035` |
| 2 | **P1** | **Add a hard container-isolation flag set**: `--cap-drop=ALL`, `--security-opt=no-new-privileges`, `--user` (non-root), `--pids-limit`, read-only rootfs + tmpfs `/tmp`. The container tier is the only backend that can actually enforce `network:false` and is advertised as "real OS-level isolation", but currently runs with Docker's default capabilities as root. | S | Medium — `--user` and read-only rootfs can break builds that write outside `/workspace`; roll out behind the existing env opt-in first | `sandbox/backends/container.py:87-122`, `1-7` |
| 3 | **P1** | **Move the durability barrier off the event loop** (`await asyncio.to_thread(...)`) and/or make `save_workbench_session_sot` incremental (upsert by `(session_id, id)` / diff) instead of `DELETE`+re-insert of the whole transcript. Three synchronous O(N) full-transcript SQLite rewrites per round, with FTS trigger churn, on the loop that serves SSE — with rounds uncapped by default. | M | Medium — barrier ordering is a correctness invariant; `to_thread` changes the thread on which the thread-local connection is used, which interacts with `deferred_writes` | `workbench/durability.py:66-96`; call sites `workbench.py:3861`, `4852`, `5473`; rewrite `memory_store/sessions.py:281`, `329-334`; FTS triggers `memory_schema.py:159-166` |
| 4 | **P1** | **Fix `allow_scope_override` semantics.** Either make the UPSERT actually assign `scope` (and document the move), or rename the flag to reflect that it only waives the *check* and forbid consolidation from using it. As written, a "scope move" overwrites a global row's value while the row keeps its `global` home — the one genuine memory-loss path found. | S | Medium — touches consolidation merges; needs a data audit of existing cross-scope rows first | `memory_store/rest.py:74-77` vs `134-145`; guard at `100-125` |
| 5 | **P1** | **Add a floor to the runaway guard.** `MAX_MANAGED_TOOL_ROUNDS=0` plus a disabled-by-default `costCeiling` leaves a model that reads a *different* file each round unbounded in both rounds and dollars — novelty and the `(tool,target)` polling guard both miss it. Suggest a very high absolute-round backstop that emits a distinct `turn_end` reason, independent of the opt-in cap. | S | Low — a backstop that high almost never fires; needs a new stop-reason value | `workbench.py:75`, `3685-3735`, `270-326`, `248-267`; `workbench/sessions.py:62` |
| 6 | **P1** | **Attribute retry/fallback spend to the model that billed it.** Accumulate per-(round, model) token totals rather than one turn-wide total, and price each bucket with the model that produced it. Today Opus retries before a DeepSeek fallback are billed at the DeepSeek rate everywhere — composer chip, usage page and the spend ceiling alike. | M | Medium — changes the shape of `TurnTotals` and the `usage_events` write; needs a migration for a per-event model that is already correct | `workbench.py:3805`, `4120`, `4199-4200`; `turn_close.py:485-514`; `memory_store/rest.py:573-591` |
| 7 | **P2** | **Surface learning-proposal backlog age** (open count + oldest age) in `scheduler_status()` / `curatorReport`. The ledger proves jobs ran; nothing proves anything was acted on, so a propose-only learning loop that has silently backed up is indistinguishable from one that is working. | S | Low — additive read-only fields | `learning_scheduler.py:324-360`; `routers/curator.py:130-153`; propose-only by design `episode_miner.py:787-794` |
| 8 | **P2** | **Retain the `docker kill` handle** on container abort and drop the redundant `except (OSError, Exception)`. Also consider a pre-warm/pull check in `probe()` so the first containerized command is not a silent multi-minute image pull. | S | Low | `sandbox/backends/container.py:161-176`, `43-78`, `120-121` |
| 9 | **P2** | **Add `usageRetentionDays` to `numKeys` + `fieldTable`** so the sweep retention the code already honours is actually settable, and **allow `0` for `maxWorkbenchToolLoops`** so the documented "uncapped" default can be restored through the API after a cap is set. | S | Low | `consolidation.py:161-162` vs `brain_config_service.py:43-59`, `72-186`; `brain_config_service.py:66` |
| 10 | **P2** | **Bound the per-event cost loop** in `get_usage` (match the 500-row bound the events list already uses) and **do not cache an empty BM25 index on a transient build failure** — raise the failure to `logger.warning` and skip caching. | S | Low | `memory_store/rest.py:576-579` vs `562`; `fact_retrieval.py:193-199` |
| 11 | **P2** | **Small correctness/consistency pass**: bound the egress relay with `asyncio.wait_for`; make the error-family tally `(family, tool)` rather than family-only; make `prune_old_episodes` use `julianday` like its sibling sweep; make the half-set env price override report `estimated=True`; await the learning-scheduler cancel. | S | Low, all five are contained | `egress.py:111-147`; `workbench.py:190-199`; `episode_miner.py:697` vs `655-657`; `cost_estimator.py:183-191`; `main.py:255-258` |
| 12 | **P2** | **Close the write-door TOCTOU** — wrap the `get_fact` scope check and the upsert in one `BEGIN IMMEDIATE`, and make `allow_scope_override` and the write-door scope check share a single transaction. Also make the fact TTL sweep retire-then-purge rather than hard-delete, matching the preference-retire design. | M | Medium — touches the hottest memory write path; `BEGIN IMMEDIATE` under WAL serializes writers, which is the point, but raises `SQLITE_BUSY` risk under the existing 10s busy_timeout | `memory_store/rest.py:100-158`; `memory_conn.py:52-54`, `112-122`; compare `consolidation.py:184-196` |
| 13 | **P2** | **Wrap the post-loop block** (`emitStopHook` / `turnTelemetry` / `scheduleAutoTitle`) in a try so a raise in any of them cannot skip `persistAndClose` and lose the turn's final assistant message. **Retain the handle** for the failure-lesson promotion task. | S | Low | `workbench.py:5490`, `5503`, `5576`; `turn_close.py:367` |
| 14 | **P2** | **Reconcile the two sub-agent depth authorities** — have `executeSubAgent` consult the same `getDelegationLimits()['maxDepth']` the orchestrator uses, so raising the setting is actually honored instead of being clamped by `agent_registry._MAXAgentDepth`. | S | Low | `subagent.py:22`, `307`; `subagent_orchestrator.py:468`; `brain_config_service.py:212-217` |
| 15 | **P2** | **Make `ensure_current_backup` health-aware** (skip on age only when the newest copy is `healthy`) and **stop the container probe cache / capability-profile cache from being unsynchronised module globals** (lock or move to a lock-free TTL holder) ahead of any future worker process. | S | Low | `brain_backup.py:400-409`; `workbench.py:1861-1862`; `sandbox/backends/__init__.py:12-13`; `sandbox/backends/container.py:30-31` |
