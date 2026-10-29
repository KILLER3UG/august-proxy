"""Stall/novelty guards for the managed tool loop (P1#11 split, first slice).

Moved from workbench.py: the stall constants, canonical (sorted-key)
argument identity, the (tool, target) polling-target key, world-delta
recording, the recent error-family tally, and the shared turn-end
verdict — plus ``_bulk_paths_from_args`` (a pure args-walker this module
shares with the exec layer). workbench.py re-exports every name here
under its original name, so the loop body, subagent.py and the tests all
keep resolving them on the workbench module.

One-way import rule: nothing under loop/ imports workbench.py.
"""

from __future__ import annotations

import json
import logging

from app.json_narrowing import as_dict, as_int, as_list, as_str
from app.services.error_families import classify_family as _error_family
from app.services.workbench.tool_protocol import tool_result_failed

logger = logging.getLogger('workbench')

# Stall detection: if the session's execution phase/step has not advanced for
# this many consecutive rounds (and the turn is already deep), stop and ask
# the model to reflect instead of letting it spin on repeated tool calls.
MAX_STALLED_ROUNDS = 8
# 12 + 8 (nudge at 20, hard-stop 22) nearly consumed the default
# 25-round cap before stall protection engaged. Fire the check from round 8:
# nudge at 16, hard-stop at 18 — real self-correction room stays.
MIN_ROUNDS_BEFORE_STALL_CHECK = 8


# A round that keeps hammering one (tool, target) past this many calls is not
# progress however its arguments are spelled — re-reading one file at shifting
# offsets, or re-running one probe with a jittered flag, is a polling loop.
_POLL_TARGET_REPEATS = 6


_ERROR_FAMILY_WINDOW = 6


# ── Runaway backstop (roadmap item #1, 2026-09-27) ───────────────────────────
# The flat round cap (MAX_MANAGED_TOOL_ROUNDS, 150) and this backstop are
# separate bounds. The cap counts model dispatches and ends with a tool-free
# summary round; the backstop counts rounds that moved nothing, because the
# stall counter above resets on argument novelty and on world delta — a model
# that calls a DIFFERENT tool with DIFFERENT arguments every round is
# permanently "novel", never stalls, and can spend the whole cap without
# achieving anything. That is the hole this backstop exists for: the nudges
# exist, but the thing they cannot detect is the thing most worth detecting.
#
# These two thresholds are counted on WORLD DELTA ALONE, which neither novelty
# nor self-report can fake: a round moved the world only if the turn touched a
# path it had not touched before, or a (tool, target) that was failing with a
# known family now returns clean.
RUNAWAY_NUDGE_ROUNDS = 25
RUNAWAY_STOP_ROUNDS = 40

#: What an ABSENT key means. This guard used to be opt-in, and the result was
#: the bug it was written for: a turn that varied its arguments every round was
#: permanently novel, so the stall counter never fired, the round cap was 0, and
#: the only thing that ended it was the context window. An install that never
#: opened Settings had no bound at all. Armed-by-default is the safe direction —
#: 25 rounds is far past any real step of work, and every leg of it is reversible
#: by writing 0.
RUNAWAY_ARMED_BY_DEFAULT = True


def _runawayBudget() -> tuple[int, int]:
    """(nudge at, hard-stop at) for the runaway backstop. 0/0 = off.

    Brain-config keys ``runawayNudgeRounds`` / ``runawayStopRounds``. An ABSENT
    key now means the shipped constants, not off; ``0`` means off and must stay
    writable, because an armed ceiling that cannot be disarmed is a lockout.
    A configured nudge of 0 means "hard stop with no warning", which is a
    different thing from absent and is honoured as such.

    The other three arms of this rule each ended a turn the user did not expect:
    the flat round cap is armed separately at 150 rounds and only fires after a
    tool-free summary round, and the budget ladder remains opt-in because it
    degrades an answer that is merely expensive.

    A read failure falls back to the shipped constants, and says so at warning:
    silently disarming the only bound on a turn is how the loop came back.
    """
    try:
        from app.services.brain_config_service import getRuntimeConfig

        cfg = getRuntimeConfig()
        stop_raw = cfg.get('runawayStopRounds')
        nudge_raw = cfg.get('runawayNudgeRounds')
    except Exception:  # noqa: BLE001 -- an unreadable store must not disarm the bound
        logger.warning('runaway budget read failed; backstop stays armed at the shipped defaults', exc_info=True)
        stop_raw = None
        nudge_raw = None

    if stop_raw is None:
        if not RUNAWAY_ARMED_BY_DEFAULT:
            return 0, 0
        stop = RUNAWAY_STOP_ROUNDS
    else:
        stop = as_int(stop_raw, RUNAWAY_STOP_ROUNDS)
        if stop <= 0:
            return 0, 0
    nudge = RUNAWAY_NUDGE_ROUNDS if nudge_raw is None else as_int(nudge_raw, RUNAWAY_NUDGE_ROUNDS)
    nudge = min(max(0, nudge), stop - 1)
    # A nudge at or past the stop would fire in the same round.
    return (nudge, stop)


def _toolResultText(msg: dict[str, object]) -> str:
    content = msg.get('content')
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return '\n'.join(
            as_str(b.get('text'), '')
            for b in content
            if isinstance(b, dict) and as_str(b.get('type'), '') == 'text'
        )
    return ''


def _recent_error_families(
    messages: list[dict[str, object]], window: int = _ERROR_FAMILY_WINDOW
) -> dict[str, int]:
    """Family tally over the last ``window`` tool results of this turn."""
    counts: dict[str, int] = {}
    for msg in [m for m in messages if as_str(m.get('role'), '') == 'tool'][-window:]:
        family = _error_family(_toolResultText(as_dict(msg, {})))
        if family:
            counts[family] = counts.get(family, 0) + 1
    return counts


def _finalTurnEndReason(reason: str, *, errored: bool, cancelledNow: bool) -> str:
    """The one rule that turns a loop reason into the verdict a turn ends with.

    Shared by the ``turn_end`` event and the telemetry row, which is written a
    few statements earlier: duplicating the two overrides there would let the
    transcript and the ledger disagree about how a turn ended.
    """
    if reason == 'finished' and cancelledNow:
        # A mid-round cancel drops the dangling tool calls and falls through the
        # plain-text break, so the loop never reaches the top-of-round cancel
        # check that would have tagged it.
        return 'interrupted'
    if errored and reason == 'finished':
        return 'error'
    return reason


def _canonicalArgs(args: dict[str, object]) -> str:
    """Order-insensitive identity for one call's arguments.

    Key insertion order is a transport accident: the same command spelled
    ``{command, timeout}`` once and ``{timeout, command}`` the next used to look
    like two different actions, so a model re-running one failing command with
    reordered keys reset the stall counter forever.
    """
    try:
        return json.dumps(args, sort_keys=True, ensure_ascii=False, default=str)[:200]
    except (TypeError, ValueError):
        return str(sorted(args.items(), key=lambda kv: str(kv[0])))[:200]


def _toolSig(name: str, args: dict[str, object]) -> tuple[str, str]:
    return (name, _canonicalArgs(args))


def _toolTarget(name: str, args: dict[str, object]) -> tuple[str, str]:
    """(tool, its first argument) — the "same target" key for polling loops.

    Full-argument identity alone would call it progress when a model re-reads
    one file at shifting offsets or re-runs one probe 20 times with a jittered
    flag. The target key catches that the *subject* never changed.
    """
    primary = next(iter(args.values()), None) if args else None
    return (name, str(primary)[:120])


def _recordWorldDelta(
    toolName: str,
    args: dict[str, object],
    result: object,
    *,
    world_paths: set[str],
    family_by_target: dict[tuple[str, str], str],
    clean_targets: set[tuple[str, str]],
) -> bool:
    """World-delta evidence for the stall detector (audit D4).

    The stall counter used to trust two self-reports: the model's own
    ``update_state`` phase/step and argument novelty on the assistant surface.
    Both can be gamed or genuinely flat while nothing in the world moves. This
    records what the turn actually did to the world, per executed call:

    * a path the turn had not touched before (read or written) — collected
      from the call's args via ``_bulk_paths_from_args``;
    * a (tool, target) that came back CLEAN for the first time this turn;
    * a (tool, target) that was failing with a known error family and now
      returns a clean result — the shell telling you the truth.

    A FAILED call earns none of that, and that is the point. The first version
    credited a new path BEFORE looking at the receipt, so naming forty paths that
    do not exist — a ``read_file`` on a guess, a ``run_command`` whose ``cd``
    misses — was forty rounds of "progress", and the backstop could never arm
    against the very loop it exists for. The request ceiling still bounds that
    model; this flag is only allowed to mean *the world is different now*. It
    also credits a first clean result, because the alternative was a false stop:
    a shell-debugging or search-only turn that keeps learning something new has
    no path to show for it, and used to be cut off at 40 rounds with a message
    claiming nothing had been read.

    Returns True when THIS call moved the world; the caller ORs it into the
    round's flag, and the stall check treats a world-delta round as progress
    even when phase/step is flat and the surface is argument-stale.
    """
    target = _toolTarget(toolName, args or {})
    text = result if isinstance(result, str) else ''
    family = _error_family(text) if text else ''
    # TWO predicates, unioned, because each sees a failure the other misses:
    # `tool_result_failed` reads the receipt vocabulary (prefixes, `Exit code:`,
    # a JSON `ok: false`), while `_error_family` reads the eight-family taxonomy
    # the steering uses. Live probe: a missing-file receipt is `not_found` to the
    # family classifier and nothing to the receipt vocabulary, so crediting its
    # path made 121 rounds of guessing at filenames look like 121 rounds of
    # progress and no bound fired at all.
    failed = tool_result_failed(text) if text else False
    failed = failed or bool(family)
    delta = False
    if not failed:
        try:
            collected = list(_bulk_paths_from_args(args or {}))
            # _bulk_paths_from_args only walks list-valued keys; the single-file
            # tools (read_file, write_file, edit_lines, …) carry a scalar
            # path/file_path — the most common touch there is.
            for key in ('path', 'filePath', 'file_path', 'directory'):
                val = as_str((args or {}).get(key), '')
                if val:
                    collected.append(val)
            for path in collected:
                if path and path not in world_paths:
                    world_paths.add(path)
                    delta = True
        except Exception:  # noqa: BLE001 -- moved verbatim from workbench.py BLE001 baseline
            logger.debug('world-delta path collection failed', exc_info=True)
        if target not in clean_targets:
            clean_targets.add(target)
            delta = True
    if not text:
        return delta
    if family:
        family_by_target[target] = family
    elif target in family_by_target and not failed:
        del family_by_target[target]
        delta = True
    return delta


def _pollingTarget(
    targetUses: dict[tuple[str, str], int] | None,
    sig: tuple[str, str],
    args: dict[str, object],
) -> bool:
    """True once this (tool, target) has been hammered past the poll budget."""
    if targetUses is None:
        return False
    return targetUses.get(_toolTarget(sig[0], args), 0) >= _POLL_TARGET_REPEATS


def _countTarget(
    targetUses: dict[tuple[str, str], int] | None,
    sig: tuple[str, str],
    args: dict[str, object],
) -> None:
    if targetUses is None:
        return
    key = _toolTarget(sig[0], args)
    targetUses[key] = targetUses.get(key, 0) + 1


def _assistant_round_is_novel(
    messages: list[dict[str, object]],
    seenToolSigs: set[tuple[str, str]],
    targetUses: dict[tuple[str, str], int] | None = None,
) -> bool:
    """Did the most recent assistant round do genuinely new work?

    The phase/step stall signature punishes deep investigation exactly as
    hard as real spinning: many ``search_files``/``read_file`` calls on
    *different* files never advance phase/step. Treat a round as progress
    when it emitted user-visible text or called a tool with a
    canonical (name, arguments) signature not already seen this turn — the
    nudge then fires only on genuine repetition (same command re-run, no
    prose). When ``targetUses`` is supplied, a round that keeps hammering the
    same (tool, target) past ``_POLL_TARGET_REPEATS`` is not progress either,
    however its arguments are spelled.
    Handles both wire shapes: Anthropic content blocks and OpenAI
    ``tool_calls``.
    """
    last = next(
        (m for m in reversed(messages) if as_str(m.get('role'), '') == 'assistant'),
        None,
    )
    if last is None:
        return False
    novel = False
    content = last.get('content')
    if isinstance(content, str):
        novel = bool(content.strip())
    elif isinstance(content, list):
        for block in content:
            if not isinstance(block, dict):
                continue
            btype = as_str(block.get('type'), '')
            if btype == 'text' and as_str(block.get('text'), '').strip():
                novel = True
            elif btype == 'tool_use':
                args = as_dict(block.get('input'), {})
                sig = _toolSig(as_str(block.get('name'), ''), args)
                if sig not in seenToolSigs and not _pollingTarget(targetUses, sig, args):
                    novel = True
                seenToolSigs.add(sig)
                _countTarget(targetUses, sig, args)
    toolCalls = as_list(last.get('tool_calls'), [])
    for call in toolCalls:
        fn = as_dict(as_dict(call).get('function'), {})
        argsRaw = as_str(fn.get('arguments'), '')
        try:
            args = as_dict(json.loads(argsRaw), {}) if argsRaw else {}
        except (json.JSONDecodeError, TypeError):
            args = {}
        sig = _toolSig(as_str(fn.get('name'), ''), args)
        if sig not in seenToolSigs and not _pollingTarget(targetUses, sig, args):
            novel = True
        seenToolSigs.add(sig)
        _countTarget(targetUses, sig, args)
    return novel


# Shared with loop/exec.py (mutation grant keys / previews) and re-exported by
# workbench.py; lives here so _recordWorldDelta can call it without importing
# workbench (loop/ is one-way).

def _bulk_paths_from_args(args: dict[str, object]) -> list[str]:
    """Collect path-like identifiers from bulk tool args for grants/previews."""
    paths: list[str] = []
    for key in ('paths', 'sessionIds', 'daemonIds', 'urls', 'names'):
        raw = args.get(key)
        if isinstance(raw, list):
            paths.extend(str(x).strip() for x in raw if str(x).strip())
    files = args.get('files') or args.get('renames') or args.get('items')
    if isinstance(files, list):
        for entry in files:
            if not isinstance(entry, dict):
                continue
            p = (
                as_str(entry.get('path'))
                or as_str(entry.get('sessionId'))
                or as_str(entry.get('filePath'))
                or as_str(entry.get('url'))
                or as_str(entry.get('name'))
            )
            if p:
                paths.append(p)
    # Deduplicate, keep order
    seen: set[str] = set()
    out: list[str] = []
    for p in paths:
        if p in seen:
            continue
        seen.add(p)
        out.append(p)
    return out
