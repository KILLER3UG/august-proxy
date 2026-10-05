"""Item 14 — the rails on automatic skill evolution.

One question, answered for one proposal: may the reviewer's KEEP become a write
with no human in the loop? Everything that says no is *this* module's job, and
the reviewer's own verdict is not part of it — a KEEP is necessary, never
sufficient, which is why a proposal built from fetched content is held even when
the reviewer approved it.

Autonomy ships OFF (``skillAutonomy``), so with the shipped config every answer
here is ``autonomy-off``. The rails exist before the switch is worth turning on
so that arming it is a decision about a rate, not about safety.

Three properties this module keeps:

* **An allow-list, never a deny-list.** Only ``skill_create`` / ``skill_patch``
  may auto-apply. A kind added tomorrow is held by default; a deny-list would
  let it through.
* **Every refusal names itself.** ``rule`` is one of :data:`RULES` and
  ``reason`` is a sentence for the inbox. A silent skip is the failure mode this
  whole workstream exists to retire — thirteen judge failures hid for a month
  because nothing persisted *why*.
* **It is on the path, not beside it.** ``review_proposal`` asks before it
  decides, so a caller cannot read the answer and ignore it.
"""

from __future__ import annotations

import logging
import re
import time
from typing import Any

logger = logging.getLogger(__name__)

# ── Vocabulary ────────────────────────────────────────────────────────────

#: The only kinds an auto-apply may ever perform. Everything else — settings,
#: deletion, retirement, promotion, and every observation kind — is human-only.
AUTO_APPLIABLE_KINDS = frozenset({'skill_create', 'skill_patch'})

#: Everything the vocabulary allows that is not prose. Written out rather than
#: derived at import so a new kind is a deliberate edit here — and
#: test_harness_rails proves this set still covers `VALID_KINDS` minus the two
#: skill writes, which is the check that makes the derivation real.
HARD_KINDS = frozenset(
    {
        'skill_delete',
        'brain_config',
        'retire',
        'promote',
        'revert',
        'observation',
        'tool_bucket',
        'tool_description',
        'flow_map',
    }
)

#: Declared rule ids. A refusal whose rule is not in here is a bug, and
#: test_harness_rails.TestTheRuleNamesAreClosed fails on it.
RULES = frozenset(
    {
        'allowed',
        'autonomy-off',
        'hard-kind',
        'untrusted-evidence',
        'unsafe-content',
        'burn-in',
        'daily-limit',
        'same-skill-today',
        'unreadable-proposal',
    }
)

#: Episode kinds mined from the USER's own turns. ``tool_error`` is deliberately
#: absent: it is mined from tool output, which is the untrusted lane that the
#: injection-style proposals arrive through.
TRUSTED_EPISODE_KINDS = frozenset({'user_correction', 'user_rescue', 'abandoned_approach'})

# Content guards. Deliberately coarse: a false positive costs a human glance at
# the inbox, a false negative costs an unreviewed write to the agent's own
# instructions.
_SHELL_FENCE_RE = re.compile(
    r'```\s*(?:bash|sh|shell|zsh|fish|powershell|ps1|bat|cmd)\b', re.IGNORECASE
)
_SHELL_PROSE_RE = re.compile(
    r'\b(?:rm\s+-rf|sudo\s+|curl\s+-|wget\s+|Invoke-WebRequest|Set-MpPreference|chmod\s+777)\b',
    re.IGNORECASE,
)
_URL_RE = re.compile(r'\bhttps?://', re.IGNORECASE)
_CREDENTIAL_RE = re.compile(
    r'\b(?:api[ _-]?key|secret[ _-]?key|access[ _-]?token|password|authorization\s*:)\b',
    re.IGNORECASE,
)

# How far back to read the append-only ledger when counting today's auto-applies.
# The cap it is compared against is a small number, so a tail this deep cannot
# under-count in any realistic install.
_LEDGER_TAIL = 500


def autonomy_enabled() -> bool:
    """The one switch, read in one place.

    The pass and the rails both consult this, so "autonomy is off" cannot mean
    two slightly different things in two files — which is the exact shape of the
    `consolidation.py:546` defect that made `propose` a mode nobody ran.
    """
    return bool(_read_config().get('skillAutonomy'))


def _refuse(rule: str, reason: str) -> dict[str, Any]:
    return {'allowed': False, 'rule': rule, 'reason': reason}


def _read_config() -> dict[str, Any]:
    try:
        from app.services.brain_config_service import getRuntimeConfig

        return dict(getRuntimeConfig())
    except Exception:  # noqa: BLE001 -- a config that cannot be read has not said yes
        return {}


# ── The one entry point ───────────────────────────────────────────────────


def auto_apply_allowed(row: dict[str, Any] | None) -> dict[str, Any]:
    """May this proposal be written without a human? Never raises."""
    if not isinstance(row, dict) or not row:
        return _refuse('unreadable-proposal', 'the proposal record could not be read')

    cfg = _read_config()
    if not cfg.get('skillAutonomy'):
        return _refuse(
            'autonomy-off',
            'autonomous apply is off in settings, so this stays a human decision',
        )

    kind = str(row.get('kind') or '').strip().lower()
    if kind not in AUTO_APPLIABLE_KINDS:
        return _refuse(
            'hard-kind',
            f'{kind or "unnamed"} is a hard-limit category — always decided by a human',
        )

    rawPayload = row.get('payload')
    payload: dict[str, Any] = rawPayload if isinstance(rawPayload, dict) else {}

    provenance = _evidence_check(row, payload)
    if provenance:
        return provenance

    content = _content_check(payload)
    if content:
        return content

    # Burn-in first: it is the rule that watches the machinery on behalf of the
    # rate limits, so it must not be able to hide behind them.
    applied = _auto_apply_rows()
    burnIn = _int(cfg.get('autonomyBurnInCount'), 5)
    if burnIn > 0 and len(applied) < burnIn:
        return _refuse(
            'burn-in',
            f'burn-in is watching the first {burnIn} clean changes '
            f'({len(applied)} recorded) — this one waits in the inbox',
        )

    perDay = _int(cfg.get('autoApplyPerDay'), 2)
    today = [r for r in applied if str(r.get('at') or '').startswith(_today())]
    if len(today) >= max(0, perDay):
        return _refuse(
            'daily-limit',
            f'{len(today)} of {perDay} auto-applies already used today',
        )

    skill = str(payload.get('name') or '').strip()
    if skill and any(
        str(r.get('at') or '').startswith(_today()) and str(r.get('skill') or '') == skill
        for r in applied
    ):
        return _refuse(
            'same-skill-today',
            f'skill {skill!r} already took one auto-change today — one per skill per day',
        )

    return {'allowed': True, 'rule': 'allowed', 'reason': ''}


# ── The rules, one function each ─────────────────────────────────────────


def _evidence_check(row: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any] | None:
    """Evidence must be the user's own words, not something the agent read.

    Two independent doors, because the prose and the citation can disagree: a
    proposal that quotes a fetched page is untrusted even if it cites a real
    correction episode, and a proposal citing no episode at all has nothing
    behind it.
    """
    evidence = str(row.get('evidence') or '')
    if _URL_RE.search(evidence):
        return _refuse(
            'untrusted-evidence',
            'the evidence quotes a fetchable URL, so it may be content the agent read '
            'rather than something the user said',
        )

    ids = [i for i in _episode_ids(payload) if isinstance(i, int) and i > 0]
    if not ids:
        return _refuse(
            'untrusted-evidence',
            'no episode is cited, so there is nothing to trace this change back to',
        )
    kinds = _episode_kinds(ids)
    trusted = sorted(set(kinds) & set(TRUSTED_EPISODE_KINDS))
    if not trusted:
        return _refuse(
            'untrusted-evidence',
            f'cited episodes are {sorted(set(kinds)) or "unreadable"} — mined from tool '
            'output, not from the user',
        )
    return None


def _content_check(payload: dict[str, Any]) -> dict[str, Any] | None:
    body = str(payload.get('body') or '')
    if not body:
        return _refuse('unsafe-content', 'the proposal carries no skill body to inspect')
    if _SHELL_FENCE_RE.search(body) or _SHELL_PROSE_RE.search(body):
        return _refuse(
            'unsafe-content', 'the skill body contains a shell command or a script block'
        )
    if _URL_RE.search(body):
        return _refuse(
            'unsafe-content', 'the skill body contains a URL the agent could be told to fetch'
        )
    if _CREDENTIAL_RE.search(body):
        return _refuse(
            'unsafe-content', 'the skill body talks about keys, tokens or credentials'
        )
    return None


# ── The record ────────────────────────────────────────────────────────────


def record_auto_apply(pid: str, skill: str) -> None:
    """Append the auto-apply to the proposal ledger — the one store for it.

    Written by the decide path after a successful automatic apply, and read back
    by the rate, per-skill and burn-in rules. It is a ledger row and not a new
    table because the ledger already answers "who did what, when", and a second
    history is a second thing that can disagree with the first.
    """
    from app.services.harness_self_improve import _append_ledger

    _append_ledger({
        'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        'actor': 'reviewer',
        'action': 'auto_apply',
        'target_key': str(pid),
        'skill': str(skill or '')[:120],
    })


def _auto_apply_rows() -> list[dict[str, Any]]:
    from app.services.harness_self_improve import read_ledger

    return [r for r in read_ledger(limit=_LEDGER_TAIL) if r.get('action') == 'auto_apply']


# ── Reads over the episode store ─────────────────────────────────────────


def _episode_ids(payload: dict[str, Any]) -> list[Any]:
    raw = payload.get('episodeIds')
    if isinstance(raw, (list, tuple)):
        return list(raw)
    single = payload.get('episodeId')
    if isinstance(single, int):
        return [single]
    return []


def _episode_kinds(ids: list[int]) -> list[str]:
    """The kinds behind these episodes, quarantined rows excluded.

    Item 5 left 41 invented episodes in the table with their ids intact. An
    episode marked as mined-nothing must not be able to vouch for a change.
    """
    try:
        from app.services.memory_conn import conn

        placeholders = ','.join('?' for _ in ids)
        rows = conn().execute(
            f'SELECT kind FROM episodes WHERE id IN ({placeholders}) AND quarantined = 0',
            tuple(ids),
        ).fetchall()
    except Exception:  # noqa: BLE001 -- unreadable episodes must refuse, not crash
        logger.debug('rails episode lookup failed', exc_info=True)
        return []
    return [str(r['kind'] if not isinstance(r, tuple) else r[0]) for r in rows]


def _today() -> str:
    return time.strftime('%Y-%m-%d', time.gmtime())


def _int(value: Any, default: int) -> int:
    """``0`` is a real answer here (it means "no limit" or "no burn-in"), so a
    falsy test cannot stand in for an absent one."""
    if value is None:
        return default
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


# Kept for the history surface (item 14's readable auto-change list): the rows
# are the record, and this is the only reader that filters them by intent.
def auto_apply_history(limit: int = 50) -> list[dict[str, Any]]:
    rows = _auto_apply_rows()
    return rows[-max(1, int(limit)):][::-1]
