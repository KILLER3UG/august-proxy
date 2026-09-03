# OQ Recommendations Dossier — all open questions across the four 2026-09-01 plans

**Date:** 2026-09-04 · **Method:** four read-only research subagents (one per plan), each verifying options against the working tree at `cb626b40` + the installed Hermes reference (`%LOCALAPPDATA%\hermes\hermes-agent`), with file:line evidence per verdict. No code was changed.
**How to use this doc:** every OQ has a VERDICT (the recommended choice), a cost, a key risk, and a DEFAULT-IF-UNANSWERED (what ships if nobody ever confirms — always the safe/reversible option). Reply "approved as recommended" (or strike individual lines) and the gated work unblocks. Rulings land by appending a ruling record to each plan's OQ section.

---

## Part 19 — Bot Mode (gates Phases C, D, E)

| OQ | Verdict | Cost | Default-if-unanswered |
|---|---|---|---|
| **OQ1** Bots vs Agents section | **Complete the replace**: retire the Settings Agents tab (`AgentsAutomationSection.tsx:62` still mounts `Agents.tsx`) once the Bots rail shows effective permissions (move the display from `Agents.tsx:93,153`). Backend already committed — `roster.py:51-54` `_is_bot` always True. | S–M | Status quo (rail primary, legacy tab stays) |
| **OQ2** Bot = agent record | **Settled — confirmed.** uiMeta on the registry record; canonical chat via `metadata.canonicalBotChat` (`roster.py:198-203`). No action. | — | Moot (shipped) |
| **OQ3** Room round caps | **Fixed 3 rounds / 10 messages**, server-enforced in the Phase D driver, with one `max_rounds`/`max_messages` seam for later configurability. Hermes ships exactly these constants (`group-chat.ts:1204-1213`). | S | Fixed 3/10 |
| **OQ4** DM wake latency | **Wake the sender**: reply completion spawns one headless turn in the sender's Bot Chat (cap 1/DM + in-flight guard against ping-pong). Reference-verified (`gateway/run.py:26245-26290`); August's bridge + SSE primitives exist (`roster.py:268-302`, `sessions.py:748`). | M | Append-only + unread dot (strictly safe) |
| **OQ5** Bot memory scope | **Bot-scoped via Part 21 M-2**: `facts.scope` column, `'global'` default, retrieval = global ∪ this-Bot. Additive/reversible; skills follow via one `('bot', …)` root in `_skillRoots`. **Gates Phase E.** | M | Bot-scoped (as specced) |
| **OQ6** Voice replies | **Defer.** Hermes has no bot voice at all; click-to-speak already ships (`MessageBubble.tsx:267-279`). Auto-TTS on unattended routine wakes = desktop talks to an empty room. | S (defer) | Defer |
| **OQ7** User-profile scope | **GLOBAL.** One human, one machine; per-Bot user profiles = silent preference drift. Zero code either way. | S (doc) | Global (status quo) |
| **OQ8** Mention UX | **Annotation-only** (reference-exact): `@bot` appends an identification note; the current agent decides whether to call `message_agent`. One auditable send path; never pipe user text verbatim into another Bot. | S | Annotation-only |

**Gates unlocked:** Phase C ← OQ4+OQ8 (both ready); Phase D ← OQ3 + Part 22 G-1/G-2; Phase E ← M-2 (OQ5's mechanism).

## Part 20 — Messaging gateway (gates Phases 1–6)

| OQ | Verdict | Cost | Default-if-unanswered |
|---|---|---|---|
| **OQ1** v1 platforms | **Telegram only.** Only unconditionally-registered adapter (`routers/gateway.py:27-38`); Slack/Discord need the optional `[gateway]` extra; polish is per-platform ×N. | S | Telegram only |
| **OQ2** Transport | **Long-polling default**, webhook opt-in when `baseUrl` set — already the shipped behavior (`telegram.py:102-162`). Hardening note: the poll loop hard-stops after 5 consecutive failures (`telegram.py:159-161`); adopt Hermes's resilient-restart pattern if that bites. | S (none) | Polling (status quo) |
| **OQ3** Group policy | **mentionOnly** — respond only to @mention / reply-to-bot / slash command. Matches Phase 0's fail-closed posture (`pairing.py:224-236` already ignores strangers in groups). | M | mentionOnly |
| **OQ4** Guard mode | **`full` in paired-owner DMs** (the allowlist IS the authz boundary) + Phase 6 `reduced` toolSurface + plan-mode in groups. **Never `ask` until remote approval cards exist** — desktop-only `ApprovalBanner` prompts would soft-lock remote turns (`workbench.py:5490-5499`). Cheap hardening: stamp `neverAsk` approval metadata on gateway sessions. | S (+M neverAsk) | full-in-DMs + reduced; groups plan |
| **OQ5** Voice replies | **`/tts` per-chat opt-in**, persisted per chat id; mp3-as-document first, Ogg/Opus when ffmpeg present (`live_speech.py:122` returns mp3 / 501-unconfigured). | S–M | `/tts` opt-in |

## Part 21 — Memory enhancements (gates M-2 → Bot Phase E)

| OQ | Verdict | Cost | Default-if-unanswered |
|---|---|---|---|
| **OQ1** auto_memories | **Discard-after-export + retire the table** — NOT migrate. Production's 7 rows are all stale `conv_summary_wb_*` junk; no live writer exists; the table already 404s through `_BRAINStores` (`brain.py:499-501`). Migrating would seed BM25 with noise. | M | Keep both (status quo) |
| **OQ2** episodic_timeline | **Retention-only** (the 90-day sweep already shipped) — **close M-4's FTS half as won't-build** (LIKE over ≤hundreds of rows is instant; two readers never rank). Keep the table while `brain_index_snippet` reads it (`brain.py:596-606`). | S | Retention-only (running behavior) |
| **OQ3** Contradiction UX | **`contested` status + UI resolve** (keep A / keep B / merge), detection limited to today's same-title-different-body case (`consolidation.py:229-261`). Converts silent supersede into a reviewable badge. | M | Keep silent supersede |
| **OQ4** Embeddings | **Commit to no vectors, reserve nothing.** Decisive precedent: production has an orphaned `vector_entries` table (12 rows, **zero code references**) — reserved schema that outlived its feature. Adding later is purely additive. | S | No table |
| **OQ5** Preference retire | **180 d untouched + never quoted, propose-only** via a `proposals` row (non-destructive by construction). Harmonizes with 30d decay half-life / 90d episodic / 30d runs. | S | 180 d propose-only |
| **OQ6** Notepad door | **Keep the landed dedicated `job_notes` tool** (`routines.py:180-231`, session-gated) — never route through `remember` (would pollute the BM25 corpus). Landed; needs only the ruling recorded. | $0 | Keep as landed |
| **OQ7** Continuity default | **Keep opt-in (`continuity: false` default)** — landed (`automations.py:65`, `automation_memory.py:307-310`). Monitor jobs re-run every few minutes and would double-pay the 2 KiB tail. | $0 | Keep as landed |

**Plan corrections surfaced by research:** (1) MemorySection's "episodic_timeline has no live writer" comment is stale — it writes per turn (`workbench.py:4827,4847`). (2) OQ1's original "migrate" recommendation would import 7 worthless rows — the retire half is the real value.

## Part 22 §9 — charter/sequencing asks (a–e)

| Ask | Verdict | Cost | Key fact |
|---|---|---|---|
| **(a)** Part 21 amendments | **M-11: landed — acknowledge, no ruling needed. M-12: approve, land together with S-2** (shared corpus write path; one migration, not two). | S–M | No `source` stamp on episodes/turn_outcomes yet (`turn_outcomes.py:101-122`) |
| **(b)** Charter Part 23 | **Charter SLIM: T-2 micro-compaction, T-3-residual (usage.py cache-split aggregates), T-4 web TTL cache, B-1 browser dialogs, B-2 persistent profile; drop T-1/D-1/D-2 (LANDED at cb626b40 — `_spillToolResult`, `_collectMissedSteer`, `_partial_from_transcript`); defer D-4 delegation ledger + B-3 vision** with recorded triggers. B-2 lands after S-1. | S charter; ~M/item | 3 of the original 10 items already shipped |
| **(c)** Charter Part 24 | **Charter with auth-code + PKCE as the resolved flow** (mirror the Google auth layer — loopback callback `service_connections.py:595-609`, refresh rotation `:571-573`), device-code recorded as a non-goal headless fallback. MS caveat: `offline_access` mandatory; refresh tokens rotate; redirect must be `http://localhost` variant. | OQ S; build L | No MS code exists; Tauri always has a browser |
| **(d)** G-1/G-2 amendment | **Adopt into the Phase D charter text NOW** (Phase D unbuilt — `bot_mode/` has only roster+routines). Review rounds count against the 3-round cap; escalation reuses the `@user` badge. | S (text now; build rides D) | Amending post-build = reworking round accounting |
| **(e)** S-1 as Phase B gate | **Approve S-1 completion as a rider, not a gate** (Phase B already shipped). Concretely: `_approval_never_ask` (`workbench.py:5429-5446`) must consult `session.headless` — it never does today, and `setDaemonContext` has zero callers, so routines run with interactive ask policy; add blocked-step ledger rows + Bot Chat notice; extend denial to the mutation-gate path. **Do this before any Phase C/D surface.** | M | Wire headless (one line, reversible) + ledger rows |

---

## Cross-plan sequencing (updated by research)

1. **S-1 rider** (Part 22e) — highest urgency: Bot routines ship today with an unattended-policy hole.
2. **M-2 scope column** (Part 21 OQ5) — unblocks Bot Phase E; additive migration.
3. **Part 19 Phases C → D → E** with the verdicts above (C needs OQ4+OQ8; D needs OQ3+G-1/G-2; E needs M-2).
4. **Part 23 slim charter** → then build T-2/T-3-res/T-4/B-1/B-2.
5. **Part 24 charter** (auth-code resolved) after Phase B dogfood; S-2+S-4 ride with ingestion surfaces.

## TL;DR

- **22 of 25 OQs have a clear evidence-backed verdict; 3 are already settled in code** (19-OQ2, 21-OQ6, 21-OQ7 — just record them).
- **Highest-urgency find:** S-1's unattended hole is real and live — `_approval_never_ask` never reads `session.headless`, so Bot routines run with interactive policy today.
- **Cheapest unblocks:** G-1/G-2 amendment is plan-text-only; OQ6/OQ7/M-11 need zero code; Part 23 slims by 3 items because they already landed.
- **Biggest reversibility guardrails honored:** every DEFAULT-IF-UNANSWERED is the safe option (append-only wake, retention-only episodic, no vector table, polling, mentionOnly).
