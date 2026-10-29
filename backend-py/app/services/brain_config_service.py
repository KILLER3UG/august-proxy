"""
Brain Orchestrator settings-tab API service.

Reads/writes ``config.json → auxiliary.cognitive.orchestrator`` (snake_case
fields) and surfaces the camelCase ``BrainConfig`` shape the React
``BrainSettings`` page expects.

One-shot migration from legacy top-level ``brain_orchestrator`` is handled by
``cognitive_config.ensure_defaults``. Runtime readers never dual-read after
that migrate.

Response shapes (match the frontend types):

  GET  /api/brain/config
    → { source, config, defaults, sessionId?, session? }

  PUT  /api/brain/config      body: Partial<BrainConfig>
    → { ok, config, defaults }

  POST /api/brain/config/reset
    → { ok, config, defaults }

  GET  /api/brain/config/from-session?sessionId=…
    → { source, config, defaults, sessionId, session }

``source`` is one of ``"persisted" | "session" | "fallback"``.
"""

from __future__ import annotations

import time
from typing import cast

from app.config import settings
from app.json_narrowing import as_bool, as_int
from app.services import config_service
from app.services.cognitive_config import DEFAULT_FEATURES
from app.services.memory_store import record_config_audit
from app.services.workbench import workbench as workbenchSvc
from app.services.workbench.loop.guards import (
    RUNAWAY_NUDGE_ROUNDS,
    RUNAWAY_STOP_ROUNDS,
)
from app.services.workbench.subagent_fanout import (
    FANOUT_ROUND_BUDGET_DEFAULT,
    MAX_CHILDREN_PER_FANOUT_DEFAULT,
    SUBAGENT_CONCURRENCY_DEFAULT,
)
from app.type_aliases import BrainConfigDict

boolKeys: tuple[str, ...] = (
    'enabled',
    'skillRelevanceMatch',
    'skillKeywordExpansion',
    'memoryEnabled',
    'modelMemoryRead',
    'memoryAutoInject',
    'memoryReview',
    'modelMemoryWrites',
    'memorySensitiveTopics',
    'subagentWorktreeIsolation',
    'cameraAccess',
    'consolidationModelSummarize',
    'memoryRetireEnabled',
    'skillArchiveEnabled',
    'skillAutonomy',
    'skillAutonomyShadow',
    'projectMemory',
    'projectSkills',
    'fileMemory',
    'externalSkillRoots',
    'contextReliefRotate',
    # Whether `record_decision` is promoted into the CORE tool set
    # (`workbench._coreToolNames` reads it). It had a fieldTable entry and a
    # reader, but was missing from `boolKeys` — so `allowedKeys` excluded it
    # and `validatePatch` rejected every PUT naming it, which made the switch
    # impossible to move. The same shape as the `budgetSoftUsd` mistake the
    # comment above records.
    'decisionJournal',
)
numKeys: tuple[str, ...] = (
    'maxAgentDepth',
    'maxWorkbenchToolLoops',
    # Turn budget ladder (P1#12) + usage retention: all four carry a fieldTable
    # entry but were missing here, so `allowedKeys` excluded them and every PUT
    # naming one was rejected — the ladder could not be armed through the API.
    'budgetSoftUsd',
    'budgetSoftTokens',
    'budgetWallClockSec',
    'usageRetentionDays',
    'autoRouteMinSamples',
    'consolidationIntervalHours',
    'introspectionIntervalHours',
    'refineIntervalHours',
    'reviewerIntervalHours',
    'reviewIntervalHours',
    'outcomeIntervalHours',
    # The decision journal's cadence. It had a fieldTable entry (24 = daily)
    # and the runtime reads it (learning_scheduler._journal_job), but it was
    # missing from numKeys, so `allowedKeys` excluded it and validatePatch
    # rejected every PUT naming it — the cadence was settable only by hand-
    # editing config.json, and the Settings UI could not express it at all.
    'journalIntervalHours',
    'outcomeWindowDays',
    'escalationBudgetPerDay',
    'autoApplyPerDay',
    'autonomyBurnInCount',
    'episodicRetentionDays',
    'memoryRetireDays',
    'profileRetireDays',
    'skillArchiveDays',
    'subagentMaxConcurrent',
    'subagentMaxIterations',
    'subagentMaxDepth',
    'subagentMaxChildrenPerTurn',
    'subagentFanoutRoundBudget',
    # Runaway backstop: a turn whose calls vary forever (a DIFFERENT
    # tool_describe / brain_query / search every round) never trips the stall
    # counter, because argument novelty resets it by design. These two are the
    # only bound on that shape, and they count WORLD DELTA alone. Both default
    # to OFF (absent/0), and both must be settable through this table or the
    # feature AGENTS.md documents is unreachable: loop/guards.py reads the
    # camelCase keys off the config, and a key absent from fieldTable is both
    # rejected by validatePatch and dropped by _snakeToCamel, so a hand-edited
    # config.json value was discarded before the guard could see it.
    'runawayNudgeRounds',
    'runawayStopRounds',
    # Bot-to-Bot unattended ceiling (bot_mode/dm.py): absent/0 means OFF, the
    # same convention as the two keys above, and it must be listed here or a PUT
    # naming it is rejected and the guard is unreachable through the API.
    'maxUnattendedTurns',
    # M-9 store budget: how many active facts the store may hold before the
    # consolidation pass curates it back down. 0 = no budget (the shipped
    # state — see the fieldTable entry for why the default is 0 and not 1500).
    'factBudget',
    # M-7 negative recall signal: the constants of the disuse penalty. All
    # three are the ranker's, and the ranker reads them from this config, so
    # they are settable here rather than hardcoded in the scorer.
    'memoryDisuseWeight',
    'memoryDisuseCap',
    'memoryDisuseRescue',
)
floatKeys: tuple[str, ...] = ('flagRateCap', 'memoryDisuseWeight')
strKeys: tuple[str, ...] = (
    'titleModel',
    'skillLearning',
    'skillLearningJudgeModel',
    'autonomyKinds',
)
allowedKeys: frozenset[str] = frozenset(boolKeys + numKeys + floatKeys + strKeys)
maxAgentDepthRange = (1, 5)
# The tool-round cap. 0 = unlimited is the SHIPPED DEFAULT (the old 25-round
# cap killed long legitimate runs), and the Settings panel's "Turn everything
# off" writes 0 — so 0 must be a VALID value here. The range started at 1,
# which made the disarming write fail validation: the panel's primary control
# 400'd for every user who had ever set a cap, and the default itself was
# unrepresentable. Same rule as the runaway keys and maxUnattendedTurns: a
# control that cannot express its own default is a broken control.
maxWorkbenchLoopsRange = (0, 500)
minSamplesRange = (1, 20)
consolidationIntervalRange = (1, 168)
# The decision journal's cadence: hourly at the floor, weekly at the ceiling.
journalIntervalRange = (1, 168)
escalationBudgetRange = (0, 50)
flagRateCapRange = (0.0, 0.5)
# Subagent delegation limits (Settings → Subagents panel, routers/subagent.py)
subagentMaxConcurrentRange = (1, 30)
subagentMaxIterationsRange = (5, 200)
subagentMaxDepthRange = (1, 5)
# Fan-out bounds (app/services/workbench/subagent_fanout.py). The accepted
# RANGE is deliberately wider than what the runtime APPLIES: the panel speaks
# of intent, the runtime keeps a desktop-safe ceiling. maxConcurrent may be
# saved up to 30 but the process pool is clamped to
# SUBAGENT_CONCURRENCY_CEILING (8) by resolve_subagent_concurrency, and the
# applied number — plus what was asked for — is what the subagentFanout
# telemetry reports, so the divergence is observable rather than silent.
subagentMaxChildrenPerTurnRange = (1, 24)
subagentFanoutRoundBudgetRange = (0, 2000)
# Turn budget ladder bounds (P1#12). 0 is the OFF sentinel and must stay
# writable or an armed ladder could never be disarmed — the loop reads every
# arm through max(0, ...) and treats 0 as "this rung is not armed"
# (loop/recovery.py:_turnBudget). The ceilings are deliberately far above any
# real turn: a soft budget that can never be reached is a silently dead knob,
# and the ladder only DEGRADES a turn, it never truncates work.
budgetSoftUsdRange = (0, 10_000)
budgetSoftTokensRange = (0, 50_000_000)
budgetWallClockSecRange = (0, 86_400)  # 24h
# Runaway-backstop thresholds. 0 = disarmed; an ABSENT key is armed (the guard
# falls back to the shipped constants), because the opt-in default was the
# condition that let an argument-varying turn run forever. The guard itself
# clamps nudge into [0, stop-1] (loop/guards.py:_runawayBudget), so a nudge at or
# past the stop is not rejected here — it is normalized at read, and the UI
# shows the resolved pair.
runawayRoundsRange = (0, 100_000)
# Bot-to-Bot unattended ceiling (see `_unattendedRun` in bot_mode/dm.py). 0 is
# the OFF sentinel and must stay writable so an armed ceiling can be disarmed;
# the ceiling on the top end is a chat length nobody should be running
# unattended, not a bound anyone would tune.
unattendedTurnsRange = (0, 500)
# Mirrors the clamp in consolidation._sweep_usage (`max(30, min(3650, days))`)
# exactly, so the API door cannot accept a value the sweep then silently
# rewrites behind the caller's back.
usageRetentionDaysRange = (30, 3650)
# M-9 store budget: how many ACTIVE facts the store may hold before the
# consolidation pass curates it back down. 0 = no budget, and 0 must stay
# writable so an armed budget can always be disarmed. The ceiling is far above
# any real store: a budget nobody could reach is a silently dead knob.
factBudgetRange = (0, 100_000)
# M-7 disuse penalty: the weight of ONE unused injection, the ceiling on the
# penalty, and how many quotes rescue one injection. All three are the
# ranker's, so they are config rather than constants in the scorer. The
# weight is a FLOAT (0.01 per unused injection), so it cannot ride the
# numeric range branch — it has its own float range below.
memoryDisuseCapRange = (0, 500)
memoryDisuseRescueRange = (0, 20)
memoryDisuseWeightRange = (0.0, 1.0)
fieldTable: tuple[tuple[str, str, object, str], ...] = (
    ('enabled', 'enabled', DEFAULT_FEATURES.get('enabled', True), 'bool'),
    # The agent-jobs flag is gone: the registry job ledger is an in-memory
    # capped dict now; no feature flag ever gated it (and keeping the key in
    # allowedKeys without a field mapping made a PUT containing it KeyError).
    # Per-turn skill relevance gating (Tier-1 compact index + Tier-3
    # <relevant_skills>). Default on; AUGUST_SKILL_RELEVANCE=0 also forces off.
    ('skillRelevanceMatch', 'skill_relevance_match', True, 'bool'),
    # Search-keyword expansion (audit P2#15): ask a cheap model for 5-10
    # search keywords when a skill is WRITTEN, store them in frontmatter, and
    # rank on them. Default OFF — it costs a model call on the write path, and
    # best-effort failure just leaves the skill as it was pre-P2#15.
    ('skillKeywordExpansion', 'skill_keyword_expansion', False, 'bool'),
    ('maxAgentDepth', 'max_agent_depth', DEFAULT_FEATURES.get('max_agent_depth', 4), 'num'),
    # Tool-round cap: ARMED by default at the workbench module's constant. It
    # used to ship at 0 (unlimited) — which, with the budget ladder also off and
    # the runaway backstop disarmed, meant a turn had no bound at all. 0 still
    # means "unlimited" and stays writable; the shipped default is what a fresh
    # install gets without opening Settings.
    ('maxWorkbenchToolLoops', 'max_workbench_tool_loops', workbenchSvc.MAX_MANAGED_TOOL_ROUNDS, 'num'),
    # Turn budget ladder (audit P1#12): soft per-turn ceilings, each DISABLED by
    # default (0 = off). Unlike the tool-round cap these do not cut a turn off —
    # a breach degrades it in steps (bare surface → compaction → one tool-free
    # answer) and the turn then ends as turn_end{reason: 'budget'}. Set any one
    # in Settings → Brain to arm that arm; spend is priced by cost_estimator
    # (the single pricing source), so budgetSoftUsd follows per-model pricing.
    ('budgetSoftUsd', 'budget_soft_usd', 0, 'num'),
    ('budgetSoftTokens', 'budget_soft_tokens', 0, 'num'),
    ('budgetWallClockSec', 'budget_wall_clock_sec', 0, 'num'),
    # Runaway backstop thresholds. These are the EFFECTIVE defaults, not
    # sentinels: the guard arms itself when the key is absent, so a default of
    # None made Settings render "off" for a backstop that was actually counting
    # rounds. Registered as the shipped constants, the panel shows what the loop
    # will do, and 0 stays the way to disarm it. loop/guards.py keeps its own
    # absent-key fallback so a hand-edited or older store cannot lose the bound.
    ('runawayNudgeRounds', 'runaway_nudge_rounds', RUNAWAY_NUDGE_ROUNDS, 'num'),
    ('runawayStopRounds', 'runaway_stop_rounds', RUNAWAY_STOP_ROUNDS, 'num'),
    # Same absent-means-OFF rule: a default of 0 here would be indistinguishable
    # from an operator disarming the ceiling, and `_snakeToCamel` would hand the
    # guard a configured-looking number.
    ('maxUnattendedTurns', 'max_unattended_turns', None, 'num'),
    # Evidence-driven routing introspection: `autoRoute` /
    # `autoRouteMinWinRate` / `autoRouteWinGap` are REMOVED — no turn-loop
    # reader ever existed (the "auto-routing" claim was corrected in Part 25
    # Phase 4) and the frontend opt-in ghost is deleted with them.
    # `autoRouteMinSamples` stays: harness_self_improve prints it in the
    # flow map.
    ('autoRouteMinSamples', 'auto_route_min_samples', 3, 'num'),
    # Memory read gate: when off, the facts-recall tool (brain_query/memory_search
    # over the facts store) is not offered. Default on so the model can pull
    # memory ON DEMAND. Per-turn auto-injection is a SEPARATE flag below.
    ('memoryEnabled', 'memory_enabled', True, 'bool'),
    ('modelMemoryRead', 'model_memory_read', True, 'bool'),
    # Auto-inject gate: when on, the "Relevant memory:" section of facts relevant to the
    # latest turn is appended every turn (plus the names-only index in the
    # system prompt).
    # ARMED BY DEFAULT (was OFF). The OFF default was a trust decision, not a
    # measured one: the write door that feeds it, `memoryIsJunk`, refuses 0 of 14
    # durable rules and catches 5 of 5 junk cases, so the content reaching this
    # lane is already filtered. Cost is real and bounded — the block is capped by
    # _BLOCK_CHAR_CAP and the profile lane by _PROFILE_CHAR_CAP.
    # modelMemoryRead must stay on for the read tool to be available either way.
    ('memoryAutoInject', 'memory_auto_inject', True, 'bool'),
    # Memory write door: the `remember` tool is offered to the model only while
    # this is on; sensitive-topic facts additionally need memorySensitiveTopics.
    ('modelMemoryWrites', 'model_memory_writes', True, 'bool'),
    ('memorySensitiveTopics', 'memory_sensitive_topics', False, 'bool'),
    # Camera capture: the camera_snapshot / camera_list_devices tools are
    # gated behind this; when off the tools return a policy error. Frames
    # captured during a call are transient by default — never persisted to
    # disk beyond the call lifetime, and never written to memory stores.
    ('cameraAccess', 'camera_access', False, 'bool'),
    # M4 consolidation v2: one scheduled job; cadence in hours,
    # and the Q5 model-assisted merge summarization flag (default off — each
    # merge costs one cheap-model call).
    ('consolidationIntervalHours', 'consolidation_interval_hours', 24, 'num'),
    # P2 unified learning scheduler: the introspection job's cadence, was a
    # hardcoded 6h in scheduled_introspection_loop; now config like the rest.
    ('introspectionIntervalHours', 'introspection_interval_hours', 6, 'num'),
    # The refine pass's own cadence (it rides the scheduler, not
    # consolidation, since the P5 batch); and the outcome-measurement job's
    # cadence + pre/post episode window.
    ('refineIntervalHours', 'refine_interval_hours', 24, 'num'),
    # The reviewer job's own cadence (learning_scheduler._reviewer_job). Six
    # hours because that is how often introspection files what it reviews.
    ('reviewerIntervalHours', 'reviewer_interval_hours', 6, 'num'),
    # The conversation-review job's cadence (learning_scheduler._review_job) and
    # its gate. Daily because it reads one session per pass and a longer interval
    # would leave whole days of conversation unread.
    ('reviewIntervalHours', 'review_interval_hours', 24, 'num'),
    # ARMED BY DEFAULT (was OFF). This is the only positive trigger in the
    # learning loop — every other pass starts from something going wrong — so
    # with it off, a session that went well was never read by anything. It costs
    # one model call per pass over one session. Memory verdicts write straight
    # to the store; skill verdicts go through the reviewer + rails, which apply
    # low-risk creates/patches without a human and hold only the rest.
    ('memoryReview', 'memory_review', True, 'bool'),
    # Second context-relief route (rotate onto a fresh handoff note instead of
    # stacking another summary). Off: it re-anchors what the provider cache sees
    # mid-chat, so it is armed deliberately, per install.
    ('contextReliefRotate', 'context_relief_rotate', False, 'bool'),
    ('outcomeIntervalHours', 'outcome_interval_hours', 72, 'num'),
    ('outcomeWindowDays', 'outcome_window_days', 14, 'num'),
    # The decision journal (learning_scheduler._journal_job): resolve open
    # ledger rows against the turn verdicts that already exist, then summarize
    # the day. Daily because a decision's own horizon is measured in turns and
    # days, not hours — and because the digest is what a human reads.
    ('journalIntervalHours', 'journal_interval_hours', 24, 'num'),
    # 053: whether `record_decision` is promoted into the CORE tool set (the
    # tools every turn sees regardless of progressive disclosure). Default off:
    # a tool definition is prompt bytes, so this changes what a provider sees
    # and moves the prefix cache. Off still logs the MECHANICAL half — one row
    # per turn, no model call — so the ledger is complete either way.
    ('decisionJournal', 'decision_journal', False, 'bool'),
    ('consolidationModelSummarize', 'consolidation_model_summarize', False, 'bool'),
    # M-4: episodic_timeline retention window in days — the sweep
    # in consolidation._sweep_episodic prunes rows older than this.
    ('episodicRetentionDays', 'episodic_retention_days', 90, 'num'),
    # M-9 store budget: the ceiling on ACTIVE facts. 0 = no budget.
    #
    # The plan proposed a default of 1500; the shipped default is 0 (no
    # budget) on purpose. This pass ARCHIVES the facts it curates away, and
    # archiving a user's memories on the day they upgrade — with no way to
    # see it happen and no setting having been chosen — is a destructive
    # default in a codebase whose rule is that anything which removes what
    # the user owns is opt-in (the OQ5 retirement pass is propose-only for
    # the same reason). A budget that is OFF until someone sets it is a
    # switch; a budget that starts curating is a decision the user never
    # made. 0 also has to stay writable so an armed budget can be disarmed.
    ('factBudget', 'fact_budget', 0, 'num'),
    # M-7 negative recall signal: a fact that is injected again and again
    # and never quoted is a stale-but-plausible entry holding rank. These
    # three are the penalty's constants — weight (how much one unused
    # injection costs), cap (the ceiling on that penalty) and rescue (how
    # many quotes forgive one injection). The weight is a float because it
    # is a fraction of a score, not a count.
    ('memoryDisuseWeight', 'memory_disuse_weight', 0.01, 'float'),
    ('memoryDisuseCap', 'memory_disuse_cap', 50, 'num'),
    ('memoryDisuseRescue', 'memory_disuse_rescue', 3, 'num'),
    # Usage events are durable analytics, but not a second transcript store.
    # Keep a generous default and let operators shorten it for long-lived
    # installs; the consolidation pass owns the sweep.
    ('usageRetentionDays', 'usage_retention_days', 365, 'num'),
    # OQ5 (Part 21, 2026-09-04), widened 2026-10-10: propose-only retirement for
    # durable memories of ANY kind. A fact untouched for its window AND never
    # quoted (use_count 0) is proposed for retirement — the scan flips nothing,
    # a human decides, so it rides the scheduled pass safely.
    #
    # The scan used to filter `kind = 'preference'`, which left `profile` — the
    # lane injected into EVERY turn regardless of the auto-inject gate —
    # permanently unretirable. Thirteen stale test fixtures were still costing
    # ~1.8 KB per turn two weeks after being written. `profile` gets its own,
    # tighter window because its cost is paid every turn, not on a match.
    # 180 d harmonizes with the 30 d usage-decay half-life / 90 d episodic /
    # 30 d automation-run windows.
    ('memoryRetireEnabled', 'memory_retire_enabled', True, 'bool'),
    ('memoryRetireDays', 'memory_retire_days', 180, 'num'),
    ('profileRetireDays', 'profile_retire_days', 45, 'num'),
    # The archive half of the skill lifecycle (2026-10-10). A skill that has
    # been RETIRED and has stayed quiet — no usage inside the window AND no
    # write to its SKILL.md since — is proposed for a trash MOVE, reversible
    # through the delete trash's own restore route. Propose-only, so it rides
    # the consolidation job like the retire pass above it rides it; the switch
    # is here because the two windows answer different questions and an
    # operator who wants the label without the move can have exactly that.
    # 60 d sits beyond the 30 d retire window on purpose: retiring is the
    # first answer to "nobody wants this", and archiving is the answer to
    # "nobody has wanted it since".
    ('skillArchiveEnabled', 'skill_archive_enabled', True, 'bool'),
    ('skillArchiveDays', 'skill_archive_days', 60, 'num'),
    # M7 item 3: optional cheap model for session titling. Empty string =
    # fall back to the turn's own model (existing behavior).
    ('titleModel', 'title_model', '', 'str'),
    # Part 16/17 skillLearning: off = no promotion judge; extract-only = no
    # skill drafting; full = drafts skill bodies. Governs
    # harness_promote.run_promotion_pass.
    # 'propose' is the shipped default: the distiller drafts and files a
    # proposal, and with skillAutonomy on the independent reviewer applies it
    # through the rails in the same background pass. 'off' still stops the
    # pass before a verdict is applied.
    ('externalSkillRoots', 'external_skill_roots', '', 'str'),
    ('skillLearning', 'skill_learning', 'propose', 'str'),
    # Dedicated judge model for the episode distiller
    # (empty = fall back to the background-review memory model, then the
    # titler resolver order — keyless gateways keep working).
    ('skillLearningJudgeModel', 'skill_learning_judge_model', '', 'str'),
    # Item 14 — the autonomy switch. ON is the shipped default: a learned
    # skill write is the same trust class as a memory write (which has always
    # been direct), and the reference harnesses put no human between the agent
    # and its own skill store. The rails are the automatic gate; destructive
    # kinds (delete, retire, archive, config) stay human-only in harness_rails.
    # `harness_rails.autonomy_enabled()` is the only reader, so "off" cannot
    # mean two things in two files.
    ('skillAutonomy', 'skill_autonomy', True, 'bool'),
    # Shadow mode: the reviewer decides and the run records what it WOULD have
    # written, with no write at all. It is a rehearsal of the decision, never a
    # way to perform one — `skillAutonomy` remains the master, and the rails are
    # consulted before the shadow answer is given.
    ('skillAutonomyShadow', 'skill_autonomy_shadow', False, 'bool'),
    # Which kinds the switch actually automates, selected WITHIN the code's
    # allow-list. Both low-risk skill writes: creating a skill is the whole
    # point of the learning loop, and patching one is the smaller step.
    ('autonomyKinds', 'autonomy_kinds', 'skill_create,skill_patch', 'str'),
    ('autoApplyPerDay', 'auto_apply_per_day', 2, 'num'),
    # Burn-in counts PRIOR auto-applies from the ledger. A fresh install has
    # none, so a positive value would hold every proposal forever (human
    # approvals are deliberately not recorded as auto-applies). 0 = off; set it
    # only on an install that already has an auto-apply history to watch.
    ('autonomyBurnInCount', 'autonomy_burn_in_count', 0, 'num'),
    # Part 16 cost gates: tier-2 escalations per day and the max fraction of
    # scored episodes flagged to tier 2 (episode_miner.flag_top_slice).
    ('escalationBudgetPerDay', 'escalation_budget_per_day', 2, 'num'),
    ('flagRateCap', 'flag_rate_cap', 0.05, 'float'),
    # Per-project memory md files + auto-project write door.
    # Off = session_tools' remember/forget stay global-only and workbench
    # stops injecting the <project_memory> block.
    ('projectMemory', 'project_memory', True, 'bool'),
    # ZCode-parity file memory (2026-09-12): new project facts write as one
    # file per fact with YAML frontmatter (name/description/type) and the
    # workspace keeps a generated MEMORY-INDEX.md index injected at session start.
    # Off = everything stays in memory.md sections (pre-0.18 behaviour).
    ('fileMemory', 'file_memory', True, 'bool'),
    # Workspace-scoped skills root (.aug/skills shadowing
    # bundled + agent skills). Off = catalogue falls back to agent+bundled.
    ('projectSkills', 'project_skills', True, 'bool'),
    # Global subagent delegation limits (Settings → Subagents). These are the
    # fallback the spawn path uses when a session has no per-session override
    # in its workbench metadata — the settings panel posts them with no
    # session id (routers/subagent.py GET/POST /config).
    # The concurrency default is the PROCESS-WIDE worker pool size, not just a
    # per-session wish: it used to be 5 hardcoded in runtime_services, which
    # made this setting dead above 5. 4 keeps real parallelism for a wave of
    # independent lanes while costing one fewer live transcript on a machine
    # that is also running the IDE and the Tauri shell.
    ('subagentMaxConcurrent', 'subagent_max_concurrent', SUBAGENT_CONCURRENCY_DEFAULT, 'num'),
    ('subagentMaxIterations', 'subagent_max_iterations', 50, 'num'),
    ('subagentMaxDepth', 'subagent_max_depth', 1, 'num'),
    # How many sub-agents ONE turn may request. Over the cap is a loud
    # [Proxy Self-Heal] rejection of the whole dispatch, never a silent
    # truncation (subagent_fanout.children_cap_message).
    ('subagentMaxChildrenPerTurn', 'subagent_max_children_per_turn', MAX_CHILDREN_PER_FANOUT_DEFAULT, 'num'),
    # Aggregate work per fan-out: tool rounds across ALL children of one
    # dispatch. 0 disables the bound (opt-out); the default is a real ceiling
    # so N children cannot collectively do N times the work.
    ('subagentFanoutRoundBudget', 'subagent_fanout_round_budget', FANOUT_ROUND_BUDGET_DEFAULT, 'num'),
    ('subagentWorktreeIsolation', 'subagent_worktree_isolation', False, 'bool'),
)
snakeToCamel: dict[str, str] = {snake: camel for camel, snake, _d, _k in fieldTable}
camelToSnake: dict[str, str] = {camel: snake for camel, snake, _d, _k in fieldTable}
fieldKind: dict[str, str] = {camel: kind for camel, _s, _d, kind in fieldTable}


def _defaultsCamel() -> BrainConfigDict:
    """Return the full defaults dict in camelCase (matches ``BrainConfig``)."""
    raw: dict[str, object] = {}
    for camel, _snake, default, _kind in fieldTable:
        raw[camel] = default
    return cast(BrainConfigDict, raw)


def getDefaults() -> BrainConfigDict:
    """Public accessor — returns the camelCase defaults the frontend renders."""
    return _defaultsCamel()


def getDelegationLimits() -> dict[str, object]:
    """Global subagent delegation limits (Settings → Subagents), already
    clamped to the ranges the orchestrator enforces. One source
    of truth shared by the /api/subagents/config router and the spawn path
    (subagent_orchestrator) for sessions without a per-session override.

    ``maxConcurrent`` is the SAVED intent (up to 30). What the runtime applies
    is ``min(this, SUBAGENT_CONCURRENCY_CEILING)`` — resolved in exactly one
    place, ``subagent_fanout.resolve_subagent_concurrency``, which also reports
    the applied number next to the requested one so a fan-out audit can see the
    ceiling bound a run. Do not clamp a second time here or the two answers can
    drift.
    """
    cfg = getRuntimeConfig()
    return {
        'maxConcurrent': max(
            1,
            min(30, as_int(cfg.get('subagentMaxConcurrent'), SUBAGENT_CONCURRENCY_DEFAULT) or SUBAGENT_CONCURRENCY_DEFAULT),
        ),
        'maxIterations': max(5, min(200, as_int(cfg.get('subagentMaxIterations'), 50) or 50)),
        'maxDepth': max(1, min(5, as_int(cfg.get('subagentMaxDepth'), 1) or 1)),
        'maxChildrenPerTurn': max(
            1,
            min(
                subagentMaxChildrenPerTurnRange[1],
                as_int(cfg.get('subagentMaxChildrenPerTurn'), MAX_CHILDREN_PER_FANOUT_DEFAULT)
                or MAX_CHILDREN_PER_FANOUT_DEFAULT,
            ),
        ),
        # 0 is a value here (the opt-out), not an absence — `value or default`
        # would silently re-enable the bound on a configured 0.
        'fanoutRoundBudget': max(
            0,
            min(
                subagentFanoutRoundBudgetRange[1],
                as_int(cfg.get('subagentFanoutRoundBudget'), FANOUT_ROUND_BUDGET_DEFAULT),
            ),
        ),
        'worktreeIsolation': as_bool(cfg.get('subagentWorktreeIsolation'), False),
    }


_RUNTIME_TTL_S = 2.0
_runtime_cache: tuple[float, BrainConfigDict] | None = None


def getRuntimeConfig() -> BrainConfigDict:
    """Merged camelCase config for runtime readers (the routing consult).

    No session/source wrappers — just the effective values, defaults
    filled in. Memoized on a 2s TTL: this is called 5–7× per turn from the
    tool-surface and prompt paths, and each uncached call walked the whole
    cognitive tree (ensure_defaults + dict copies). Writes clear the cache,
    so a PUT is reflected immediately.
    """
    global _runtime_cache
    now = time.monotonic()
    cached = _runtime_cache
    if cached is not None and now - cached[0] < _RUNTIME_TTL_S:
        return cached[1]
    merged = _snakeToCamel(_loadPersisted())
    _runtime_cache = (now, merged)
    return merged


def _loadPersisted() -> dict[str, object]:
    """Read ``auxiliary.cognitive.orchestrator`` (snake_case). Always fresh."""
    from app.services.cognitive_config import ensure_defaults, get_cognitive

    ensure_defaults()
    tree = get_cognitive()
    val = tree.get('orchestrator')
    return dict(val) if isinstance(val, dict) else {}


def bustRuntimeCache() -> None:
    """Drop the 2s memo.

    The cache records nothing about WHERE the values came from, so a process
    that changes the data directory underneath it — a test fixture, a profile
    swap — keeps answering from the previous install's config until the TTL
    expires. A switch read through `getRuntimeConfig` can therefore be a switch
    some other context turned on. Writers clear it; whoever changes the ground
    under it must too.
    """
    global _runtime_cache
    _runtime_cache = None


def _savePersisted(snakeCfg: dict[str, object]) -> None:
    """Replace ``auxiliary.cognitive.orchestrator``; drop legacy top-level key."""
    global _runtime_cache
    _runtime_cache = None
    from app.services.cognitive_config import ensure_defaults

    ensure_defaults()
    cfg = config_service.getConfig()
    aux = cfg.get('auxiliary')
    if not isinstance(aux, dict):
        aux = {}
        cfg['auxiliary'] = aux
    cognitive = aux.get('cognitive')
    if not isinstance(cognitive, dict):
        cognitive = {}
        aux['cognitive'] = cognitive
    cognitive['orchestrator'] = dict(snakeCfg)
    cfg.pop('brain_orchestrator', None)
    config_service.saveConfig(cfg)
    settings.reload()


def _snakeToCamel(snakeCfg: dict[str, object]) -> BrainConfigDict:
    """Translate a snake_case persisted dict into the camelCase response shape."""
    out = _defaultsCamel()
    for snakeKey, value in snakeCfg.items():
        camelKey = snakeToCamel.get(snakeKey)
        if camelKey is None:
            continue
        cast(dict, out)[camelKey] = value
    # The 2026-10-10 retirement expansion replaced the preference-only knobs
    # with memory-wide names. Preserve existing installs' explicit opt-outs
    # and custom windows until the next config save migrates them naturally.
    legacyAliases = {
        'preference_retire_enabled': ('memory_retire_enabled', 'memoryRetireEnabled'),
        'preference_retire_days': ('memory_retire_days', 'memoryRetireDays'),
    }
    for legacy, (currentSnake, currentCamel) in legacyAliases.items():
        if currentSnake not in snakeCfg and legacy in snakeCfg:
            cast(dict, out)[currentCamel] = snakeCfg[legacy]
    return out


def _camelPatchToSnake(patch: dict[str, object]) -> dict[str, object]:
    """Translate a camelCase patch (from the React form) into the snake_case
    dict we persist. Validation happens in :func:`validatePatch` first."""
    out: dict[str, object] = {}
    for camelKey, value in patch.items():
        snakeKey = camelToSnake[camelKey]
        out[snakeKey] = value
    return out


def validatePatch(patch: object) -> tuple[bool, str]:
    """Return (ok, error_message). Reject non-dicts, unknown keys, wrong types
    or out-of-range numeric values."""
    if not isinstance(patch, dict):
        return (False, 'body must be a JSON object')
    for key, value in patch.items():
        if key not in allowedKeys:
            return (False, f'unknown field: {key!r} (expected one of {sorted(allowedKeys)})')
        kind = fieldKind[key]
        if kind == 'bool':
            if not isinstance(value, bool):
                return (False, f'{key!r} must be a boolean (got {type(value).__name__})')
        elif kind == 'str':
            if not isinstance(value, str):
                return (False, f'{key!r} must be a string (got {type(value).__name__})')
            if len(value) > 120:
                return (False, f'{key!r} must be at most 120 chars (got {len(value)})')
            if key == 'skillLearning' and value not in ('off', 'extract-only', 'propose', 'full'):
                return (
                    False,
                    f'{key!r} must be off | extract-only | propose | full (got {value!r})',
                )
            if key == 'autonomyKinds':
                # Validated against the code's ceiling, and unknown names are
                # REFUSED rather than dropped: a typo that silently armed nothing
                # would read as "autonomy is broken", and a value that could name
                # skill_delete would turn a preference into an escalation.
                from app.services.harness_rails import AUTO_APPLIABLE_KINDS

                wanted = [k.strip().lower() for k in value.split(',') if k.strip()]
                bad = [k for k in wanted if k not in AUTO_APPLIABLE_KINDS]
                if bad:
                    return (
                        False,
                        f'{key!r} accepts only {sorted(AUTO_APPLIABLE_KINDS)} (got {bad})',
                    )
        elif kind == 'float':
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                return (False, f'{key!r} must be a number (got {type(value).__name__})')
            if key == 'memoryDisuseWeight':
                lo, hi = memoryDisuseWeightRange
            else:
                lo, hi = flagRateCapRange
            if value < lo or value > hi:
                return (False, f'{key!r} must be between {lo} and {hi} (got {value})')
        else:
            if isinstance(value, bool) or not isinstance(value, int):
                return (False, f'{key!r} must be an integer (got {type(value).__name__})')
            if key == 'maxAgentDepth':
                lo, hi = maxAgentDepthRange
            elif key == 'maxWorkbenchToolLoops':
                # 0 = uncapped is the shipped default and the value the
                # Settings panel writes for "Turn everything off", so the
                # disarming write must be valid. (The fallback range below
                # used to start at 1, which made it invalid.)
                lo, hi = maxWorkbenchLoopsRange
            elif key == 'autoRouteMinSamples':
                lo, hi = minSamplesRange
            elif key == 'consolidationIntervalHours' or key == 'introspectionIntervalHours':
                lo, hi = consolidationIntervalRange
            elif key in ('refineIntervalHours', 'outcomeIntervalHours', 'reviewerIntervalHours', 'reviewIntervalHours'):
                lo, hi = consolidationIntervalRange
            elif key == 'journalIntervalHours':
                lo, hi = journalIntervalRange
            elif key == 'outcomeWindowDays':
                lo, hi = (3, 90)
            elif key == 'escalationBudgetPerDay':
                lo, hi = escalationBudgetRange
            elif key == 'autoApplyPerDay':
                # 0 is writable on purpose: a zero budget is how the daily rail
                # is disarmed without disarming the switch itself.
                lo, hi = (0, 50)
            elif key == 'autonomyBurnInCount':
                # 0 disables burn-in (the plan's documented escape), and the
                # ceiling keeps "first N clean changes" a real window.
                lo, hi = (0, 100)
            elif key == 'subagentMaxConcurrent':
                lo, hi = subagentMaxConcurrentRange
            elif key == 'subagentMaxIterations':
                lo, hi = subagentMaxIterationsRange
            elif key == 'subagentMaxDepth':
                lo, hi = subagentMaxDepthRange
            elif key == 'subagentMaxChildrenPerTurn':
                lo, hi = subagentMaxChildrenPerTurnRange
            elif key == 'subagentFanoutRoundBudget':
                # 0 is legal and means "no aggregate bound" — the one opt-out
                # in this family. Read by subagent_fanout.charge_fanout_round.
                lo, hi = subagentFanoutRoundBudgetRange
            elif key == 'budgetSoftUsd':
                lo, hi = budgetSoftUsdRange
            elif key == 'budgetSoftTokens':
                lo, hi = budgetSoftTokensRange
            elif key == 'budgetWallClockSec':
                lo, hi = budgetWallClockSecRange
            elif key == 'usageRetentionDays':
                lo, hi = usageRetentionDaysRange
            elif key in ('runawayNudgeRounds', 'runawayStopRounds'):
                # 0 is the OFF sentinel and must stay writable or an armed
                # backstop could never be disarmed. The ceiling is far above
                # any real turn for the same reason the budget rungs are: a
                # bound that can never be reached is a silently dead knob.
                lo, hi = runawayRoundsRange
            elif key == 'maxUnattendedTurns':
                # The fallback range below starts at 1, which would make the
                # disarming write (0) invalid — the exact bug the runaway keys
                # above were added to avoid.
                lo, hi = unattendedTurnsRange
            elif key == 'factBudget':
                # 0 = no budget, and it must be writable so an armed budget
                # can be disarmed.
                lo, hi = factBudgetRange
            elif key == 'memoryDisuseCap':
                lo, hi = memoryDisuseCapRange
            elif key == 'memoryDisuseRescue':
                lo, hi = memoryDisuseRescueRange
            else:
                lo, hi = maxWorkbenchLoopsRange
            if value < lo or value > hi:
                return (False, f'{key!r} must be between {lo} and {hi} (got {value})')
    return (True, '')


def _sessionInfo(sessionId: str | None = None) -> dict[str, object] | None:
    """Return ``{id, task}`` for the most-recent workbench session, or ``None``
    when none exist. ``task`` is mapped from ``WorkbenchSession.goal`` because
    the dataclass has no ``task`` field (see workbench.py:41-69)."""
    try:
        sessions = workbenchSvc.listWorkbenchSessions() or []
    except Exception:
        return None
    if not sessions:
        return None
    target: dict[str, object] | None = None
    if sessionId:
        for s in sessions:
            if s.get('id') == sessionId:
                target = s
                break
    if target is None:
        target = sessions[0]
    if not target:
        return None
    return {'id': target.get('id', ''), 'task': target.get('goal') or None}


def _resolveSource(*, forceSession: bool = False) -> str:
    """Return the ``source`` tag for the current settings view.

    * ``forceSession=True`` is set by ``/config/from-session`` — the
      caller has explicitly asked for a session-derived view, so we always
      return ``"session"`` (the original UI banner was session-conditional).
    * Otherwise: ``"persisted"`` when overrides exist, ``"fallback"`` when
      nothing is configured and there's no recent session, ``"session"``
      when there's a recent session but no overrides (so the React banner
      "Defaults pulled from your last chat session" still shows).
    """
    if forceSession:
        return 'session'
    if _loadPersisted():
        return 'persisted'
    if _sessionInfo() is not None:
        return 'session'
    return 'fallback'


def getBrainConfigForSettings(*, sessionId: str | None = None) -> dict[str, object]:
    """Shape returned to the React ``useQuery(['brain-config'])`` call.

    Always includes the full default set so the UI can render a meaningful
    diff in the "Use chat defaults" / "Reset" buttons.
    """
    persistedSnake = _loadPersisted()
    source = _resolveSource()
    sess = _sessionInfo(sessionId)
    return {
        'source': source,
        'config': _snakeToCamel(persistedSnake),
        'defaults': _defaultsCamel(),
        'sessionId': sess['id'] if sess else None,
        'session': sess,
    }


def saveBrainConfig(patch: dict[str, object]) -> tuple[bool, str, BrainConfigDict]:
    """Apply a partial camelCase patch. Returns (ok, error_message, merged)."""
    ok, err = validatePatch(patch)
    if not ok:
        return (False, err, _snakeToCamel(_loadPersisted()))
    currentSnake = _loadPersisted()
    before = dict(currentSnake)
    snakePatch = _camelPatchToSnake(patch)
    mergedSnake = {**currentSnake, **snakePatch}
    _savePersisted(mergedSnake)
    record_config_audit('brain', 'update', 'user', before=before, after=dict(mergedSnake))
    return (True, '', _snakeToCamel(mergedSnake))


def resetBrainConfig() -> tuple[bool, BrainConfigDict]:
    """Drop the persisted override entirely. Returns (ok, defaults_camel)."""
    before = _loadPersisted()
    _savePersisted({})
    record_config_audit('brain', 'reset', 'user', before=before, after={})
    return (True, _defaultsCamel())


def getBrainConfigFromSession(sessionId: str) -> dict[str, object]:
    """Return the brain config tagged ``source='session'`` for the requested
    session. Falls back to the most-recent session when ``sessionId`` is
    unknown (matches the lenient lookup in :func:`_sessionInfo`)."""
    sess = _sessionInfo(sessionId) or _sessionInfo()
    if not sess:
        return getBrainConfigForSettings()
    persistedSnake = _loadPersisted()
    return {
        'source': 'session',
        'config': _snakeToCamel(persistedSnake),
        'defaults': _defaultsCamel(),
        'sessionId': sess['id'],
        'session': sess,
    }
