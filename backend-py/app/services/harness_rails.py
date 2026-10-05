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

import hashlib
import logging
import re
import time
from pathlib import Path
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
        'shadow-mode',
        'hard-kind',
        'untrusted-evidence',
        'unsafe-content',
        'probation-cooldown',
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


def shadow_enabled() -> bool:
    """Rehearse the decision, perform none of it.

    Read only AFTER the rails have allowed the write, so a shadow answer means
    "this proposal cleared every rail and would have been written" — never
    "somebody's browsing history was allowed to edit the agent".
    """
    cfg = _read_config()
    return bool(cfg.get('skillAutonomy')) and bool(cfg.get('skillAutonomyShadow'))


# How long a reverted finding stays barred. Longer than the measurement window
# on purpose (default 14 days): the measurement that condemned it took that
# long to arrive, and a cooldown shorter than the window would expire roughly
# when the evidence was produced.
PROBATION_COOLDOWN_DAYS = 30

#: A finding's identity: the skill plus the failure it claims to fix. The
#: distiller's fingerprint is the better key when it has one, because it is the
#: same string across re-filings while the evidence prose shifts with the
#: episode window.
def finding_key(row: dict[str, Any] | None) -> str:
    if not isinstance(row, dict):
        return ''
    payload = row.get('payload')
    payload = payload if isinstance(payload, dict) else {}
    skill = str(payload.get('name') or '').strip().lower()
    marker = str(payload.get('fingerprint') or '').strip().lower()
    if not marker:
        marker = ' '.join(str(row.get('problem') or '').lower().split())
    if not skill and not marker:
        return ''
    return hashlib.sha256(f'{skill}|{marker}'.encode('utf-8')).hexdigest()[:16]


def _on_cooldown(key: str) -> bool:
    """Has THIS finding already been measured harmful and reverted?

    Without this, probation only puts the bytes back: the same distiller verdict
    re-files, clears the daily rail the next morning, and re-applies the change
    the ledger already proved was a regression.
    """
    if not key:
        return False  # an empty key matches nothing — old rows must not bar all writes
    cutoff = time.strftime(
        '%Y-%m-%dT%H:%M:%SZ', time.gmtime(time.time() - PROBATION_COOLDOWN_DAYS * 86400)
    )
    from app.services.harness_self_improve import read_ledger

    for r in read_ledger(limit=_LEDGER_TAIL):
        if r.get('action') != 'probation_revert':
            continue
        if str(r.get('finding_key') or '') != key:
            continue
        if str(r.get('at') or '') >= cutoff:
            return True
    return False


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

    key = finding_key(row)
    if _on_cooldown(key):
        return _refuse(
            'probation-cooldown',
            f'this exact finding was already applied and reverted within '
            f'{PROBATION_COOLDOWN_DAYS} days — it stays a human decision',
        )

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


def record_auto_apply(
    pid: str, skill: str, versionTs: str = '', findingKey: str = ''
) -> None:
    """Append the auto-apply to the proposal ledger — the one store for it.

    Written by the decide path after a successful automatic apply, and read back
    by the rate, per-skill and burn-in rules and by probation. It is a ledger row
    and not a new table because the ledger already answers "who did what, when",
    and a second history is a second thing that can disagree with the first.

    ``versionTs`` is the snapshot the apply took. Without it a regression has
    nothing addressable to put back, and probation would have to guess at "the
    previous version" after somebody else has written one.
    """
    from app.services.harness_self_improve import _append_ledger

    _append_ledger({
        'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        'actor': 'reviewer',
        'action': 'auto_apply',
        'target_key': str(pid),
        'skill': str(skill or '')[:120],
        'version_ts': str(versionTs or '')[:32],
        'finding_key': str(findingKey or '')[:32],
    })


# ── Probation ─────────────────────────────────────────────────────────────


def probation_revert(
    source: str, key: str, kind: str, target: str
) -> dict[str, Any] | None:
    """Put back a change the rails themselves applied, if it can be named.

    Called by the measurement job on a 'regressed' verdict, BEFORE it files the
    human's revert proposal. Returning a receipt means the undo happened and no
    proposal is filed; returning ``None`` means this is not ours to undo and the
    caller's existing behavior stands, unchanged.

    Not the proposal applier: `test_harness_revert_proposal.py` pins that
    approving a `revert` proposal must never silently revert, and that still
    holds — this is the job that measured the harm restoring bytes it took,
    through item 13's single restore path.
    """
    if source != 'proposal' or kind not in AUTO_APPLIABLE_KINDS:
        return None
    pid = key.split(':', 1)[1] if ':' in key else ''
    row = next(
        (
            r
            for r in reversed(_auto_apply_rows())
            if str(r.get('target_key') or '') == pid
        ),
        None,
    )
    if row is None:
        return None  # a human applied it — the undo is a human's too
    if not autonomy_enabled():
        return None  # off means the machine writes nothing, even to put things back
    skill = str(row.get('skill') or '') or str(target or '')
    ts = str(row.get('version_ts') or '')
    if not skill or not ts:
        return None  # nothing addressable; the proposal carries the honest text

    from app.services import skill_service, skill_versions

    try:
        resolved = skill_service.get(skill)
        versions = skill_versions.list_versions(Path(str((resolved or {}).get('path') or '')).parent)
    except (OSError, ValueError):
        return None
    if not versions or str(versions[0].get('ts') or '') != ts:
        # Our snapshot is no longer the newest version: someone edited the skill
        # since. Restoring would delete their work to undo our mistake.
        return None

    try:
        skill_service.restoreVersion(skill, ts)
    except Exception:  # noqa: BLE001 -- a refused restore falls back to the human, not a crash
        logger.debug('probation restore refused', exc_info=True)
        return None

    from app.services.harness_self_improve import _append_ledger

    _append_ledger({
        'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        'actor': 'reviewer',
        'action': 'probation_revert',
        'target_key': pid,
        'skill': skill[:120],
        'version_ts': ts[:32],
        'finding_key': str(row.get('finding_key') or '')[:32],
        'reason': 'measured as a regression while on probation',
    })
    return {'reverted': True, 'skill': skill, 'versionTs': ts}


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


# The history surface (item 14's readable auto-change list). The ledger rows are
# the record; this is the only reader that joins an apply to its revert and
# shapes them for settings — newest first, one entry per change the machine made.
def auto_apply_history(limit: int = 50) -> list[dict[str, Any]]:
    from app.services.harness_self_improve import read_ledger

    rows = read_ledger(limit=_LEDGER_TAIL)
    reverted = {
        str(r.get('target_key') or '')
        for r in rows
        if r.get('action') == 'probation_revert'
    }
    out: list[dict[str, Any]] = []
    for r in reversed(rows):
        if r.get('action') != 'auto_apply':
            continue
        pid = str(r.get('target_key') or '')
        out.append(
            {
                'at': str(r.get('at') or ''),
                'proposalId': pid,
                'skill': str(r.get('skill') or ''),
                'versionTs': str(r.get('version_ts') or ''),
                'reverted': pid in reverted,
            }
        )
        if len(out) >= max(1, int(limit)):
            break
    return out
