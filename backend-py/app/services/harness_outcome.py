"""P5 — the outcome ledger: close the self-improvement loop with a number.

Every side-effecting learning write (an approved harness proposal, a KEPT
refine entry) records one ``harness_outcome`` row: what it expected, and the
episode statistics *before* it landed. A scheduled job later measures the same
shape *after* it landed and stores a verdict (improved / flat / regressed /
insufficient). This is SkillsBench's paired-evaluation protocol at proposal
scale — the harness's own evals — and it replaces the status quo where
``expectedOutcome`` was written and never checked.

Episode-derived stats are the measurement surface because that is what the
harness actually changes for the user: how often sessions recover from
failures, how often the targeted failure fingerprint recurs. Rates use
resolved=1.0, rescued=0.5 weighting, matching the distiller's rubric.
Nothing here touches a live turn; all writes are best-effort and never raise
into the caller that records them (a lost measurement row must not fail an
otherwise-successful approval).

A ``regressed`` verdict also FILES a ``revert`` proposal carrying the
regressing change's own rollback text (audit P1#9) — the loop used to record
that a change hurt and then leave the undo to be rediscovered by hand. Filing
is where it stops: the proposal waits in the same human queue as every other.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta, timezone
from typing import Any

from app.json_narrowing import as_dict, as_int, as_str
from app.services.best_effort import best_effort
from app.services.memory_conn import commit as brain_commit

logger = logging.getLogger(__name__)

# Measurement window: how many days of episodes before/after the write.
_DEFAULT_WINDOW_DAYS = 14
# Below this many episodes on either side, the comparison says
# 'insufficient' rather than pretending to measure.
_MIN_EPISODES = 3
# Verdict hysteresis: small swings are noise on tiny samples.
_IMPROVE_EPS = 0.05

# SQLite-compatible format (space form; julianday parses it unambiguously).
_TS = '%Y-%m-%d %H:%M:%S'


def _conn():
    from app.services.memory_conn import conn

    return conn()


def _ensure_schema() -> None:
    """Migration 042 creates the table at schema init; cover contexts that
    touch the ledger before a full init (tests, scripts)."""
    conn = _conn()
    conn.execute(
        'CREATE TABLE IF NOT EXISTS harness_outcome ('
        '  id INTEGER PRIMARY KEY AUTOINCREMENT,'
        '  key TEXT NOT NULL UNIQUE,'
        '  source TEXT NOT NULL,'
        "  kind TEXT NOT NULL DEFAULT '',"
        "  target TEXT NOT NULL DEFAULT '',"
        "  fingerprint TEXT NOT NULL DEFAULT '',"
        '  applied_at TEXT NOT NULL,'
        "  expected TEXT NOT NULL DEFAULT '',"
        '  measured_at TEXT,'
        '  window_d INTEGER,'
        '  before_json TEXT,'
        '  after_json TEXT,'
        '  verdict TEXT)'
    )
    conn.execute(
        'CREATE INDEX IF NOT EXISTS idx_harness_outcome_pending '
        'ON harness_outcome(measured_at, applied_at)'
    )
    brain_commit(conn)


def _window_days() -> int:
    try:
        from app.services.brain_config_service import getRuntimeConfig

        raw = as_int(getRuntimeConfig().get('outcomeWindowDays', _DEFAULT_WINDOW_DAYS), _DEFAULT_WINDOW_DAYS)
    except Exception:
        raw = _DEFAULT_WINDOW_DAYS
    return max(3, min(90, raw))


def _utc(dt: datetime) -> datetime:
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def episode_stats(since: datetime, until: datetime, fingerprint: str = '') -> dict[str, Any]:
    """Episode outcome stats for a window; optionally the recurrence count of
    one failure fingerprint inside it.

    Recurrence is counted from ``failure_fingerprints.first_seen/last_seen``
    overlap with the window plus episode rows — an episode-based count is the
    honest one (a fingerprint table row aggregates lifetime), so we count
    episodes carrying the fingerprint.
    """
    conn = _conn()
    since_s, until_s = since.strftime(_TS), until.strftime(_TS)
    rows = conn.execute(
        "SELECT outcome, COUNT(*) AS n FROM episodes "
        'WHERE julianday(created_at) >= julianday(?) AND julianday(created_at) < julianday(?) '
        'GROUP BY outcome',
        (since_s, until_s),
    ).fetchall()
    counts = {str(r['outcome']): int(r['n']) for r in rows}
    total = sum(counts.values())
    resolved = counts.get('resolved', 0) + 0.5 * counts.get('rescued', 0)
    out: dict[str, Any] = {
        'episodes': total,
        'resolvedRate': round(resolved / total, 4) if total else None,
        'window': [since_s, until_s],
    }
    if fingerprint:
        fp = conn.execute(
            'SELECT COUNT(*) AS n FROM episodes '
            'WHERE fingerprint_id = ? '
            'AND julianday(created_at) >= julianday(?) AND julianday(created_at) < julianday(?)',
            (fingerprint, since_s, until_s),
        ).fetchone()
        out['fingerprintRecurrence'] = int(fp['n']) if fp else 0
    return out


def record(
    source: str,
    key: str,
    kind: str,
    target: str,
    expected: str,
    fingerprint: str = '',
) -> None:
    """Book one side-effecting learning write with its BEFORE stats.

    Idempotent on ``key`` (INSERT OR IGNORE): re-approving/replaying never
    double-books. Never raises — a failed outcome row must not fail the
    approval it is annotating.
    """
    try:
        days = _window_days()
        now = _utc(datetime.now(timezone.utc))
        before = episode_stats(now - timedelta(days=days), now, fingerprint)
        _ensure_schema()
        conn = _conn()
        conn.execute(
            'INSERT OR IGNORE INTO harness_outcome '
            '(key, source, kind, target, fingerprint, applied_at, expected, before_json) '
            'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            (
                key,
                source,
                kind,
                target,
                (fingerprint or '')[:300],
                now.strftime(_TS),
                (expected or '')[:1000],
                json.dumps(before, ensure_ascii=False),
            ),
        )
        brain_commit(conn)
    except Exception:
        logger.debug('harness_outcome record failed (%s %s)', source, key, exc_info=True)


def record_proposal_outcome(row: dict[str, Any]) -> None:
    """Called from decide_proposal when a proposal actually applied."""
    payload = as_dict(row.get('payload'))
    kind = as_str(row.get('kind'), '')
    target = as_str(payload.get('name') or payload.get('target') or '')
    if kind == 'brain_config':
        target = ','.join(sorted(as_dict(payload.get('patch')).keys())) or 'config'
    fingerprint = as_str(payload.get('fingerprint'), '')
    record(
        source='proposal',
        key=f'proposal:{row.get("id")}',
        kind=kind,
        target=target[:200],
        expected=as_str(row.get('expectedMetric'), '') or as_str(row.get('proposal'), ''),
        fingerprint=fingerprint,
    )


def record_refine_outcome(applied_item: dict[str, Any], refine_id: str) -> None:
    """Called for each KEPT applied edit (the batch that survived review).

    Takes an entry from auto_refine's applied list — already flattened
    (op/id/kind/version/expectedOutcome). Deletes are still outcome-worthy:
    removing a wrong note is a change too.
    """
    record(
        source='refine',
        key=f"refine:{refine_id}:{applied_item.get('id')}:{applied_item.get('version')}",
        kind=as_str(applied_item.get('kind'), ''),
        target=f"{as_str(applied_item.get('op'), '')} {as_str(applied_item.get('id'), '')}",
        expected=as_str(applied_item.get('expectedOutcome'), ''),
    )


def measure_pending() -> dict[str, Any]:
    """Job body: classify due outcome rows whose after-window has elapsed.

    Only rows older than the full window are measured (the after-stats need a
    complete window), and only once (measured_at stamps the row). Returns a
    compact summary for the learning-job ledger.
    """
    days = _window_days()
    now = _utc(datetime.now(timezone.utc))
    _ensure_schema()
    conn = _conn()
    cutoff = (now - timedelta(days=days)).strftime(_TS)
    rows = conn.execute(
        'SELECT id, key, source, kind, target, fingerprint, applied_at, expected, before_json '
        'FROM harness_outcome WHERE measured_at IS NULL AND applied_at <= ? '
        'ORDER BY applied_at LIMIT 50',
        (cutoff,),
    ).fetchall()
    verdicts = {'improved': 0, 'flat': 0, 'regressed': 0, 'insufficient': 0}
    for r in rows:
        applied = as_str(r['applied_at'], '')
        try:
            applied_dt = _utc(datetime.strptime(applied, _TS))
        except ValueError:
            verdicts['insufficient'] += 1
            continue
        fingerprint = as_str(r['fingerprint'], '')
        try:
            before = json.loads(as_str(r['before_json'], '{}'))
        except Exception:
            before = {}
        after = episode_stats(applied_dt, applied_dt + timedelta(days=days), fingerprint)
        verdict = _classify(before, after, targeted=bool(fingerprint))
        conn.execute(
            'UPDATE harness_outcome SET measured_at = ?, window_d = ?, after_json = ?, verdict = ? '
            'WHERE id = ?',
            (now.strftime(_TS), days, json.dumps(after, ensure_ascii=False), verdict, r['id']),
        )
        verdicts[verdict] += 1
        if verdict == 'regressed':
            with best_effort('learning.revert-proposal'):
                _file_revert_proposal(r, before, after, days)
    brain_commit(conn)
    return {'measured': len(rows), **{f'v_{k}': v for k, v in verdicts.items()}}


def _source_change(key: str) -> tuple[str, str]:
    """(what the change was, how to undo it) for the row an outcome booked.

    Prefers the source's OWN rollback text over anything invented here — a
    revert proposal is only as good as the undo the author wrote for it.
    Returns empty strings when the source is no longer on file.
    """
    from app.services import harness_self_improve as hsi

    parts = key.split(':')
    if parts[0] == 'proposal' and len(parts) > 1:
        src = hsi.get_proposal(parts[1]) or {}
        rollback = as_str(src.get('rollback'), '').strip()
        if rollback:
            return as_str(src.get('proposal'), '').strip() or f'proposal {parts[1]}', rollback
    elif parts[0] == 'refine' and len(parts) > 2:
        # A refine entry is append-only and its own undo is by entry id, which
        # restores the previous version. There is no separate rollback string.
        return f'refine entry {parts[2]}', f'refine: undo entry {parts[2]} (restores its previous version)'
    return '', ''


def _file_revert_proposal(r: Any, before: dict[str, Any], after: dict[str, Any], days: int) -> None:
    """Answer a measured regression: undo it if it is ours, else ask a human.

    A 'regressed' verdict is the ledger's one unambiguous negative signal: the
    change it booked measurably hurt. Undoing a change a HUMAN approved is not a
    call the machine may make on its own, so this only *files* — carrying the
    source's own rollback text and a payload link back to this outcome row. The
    one exception is probation: a change the rails applied themselves, still
    addressable to the snapshot they took, is put back through item 13's restore
    path and nothing is filed.

    Never raises (the caller's best_effort site is the backstop).
    """
    from app.services import harness_self_improve as hsi

    key = as_str(r['key'], '')
    source = as_str(r['source'], '')
    kind = as_str(r['kind'], '')
    target = as_str(r['target'], '') or key
    change, rollback = _source_change(key)
    if not rollback:
        # The source row is gone (pruned proposal file). Say so rather than
        # inventing an undo we cannot stand behind.
        rollback = (
            f'undo the {kind} change on {target} by hand — the original rollback text is '
            'no longer on file'
        )
    subject = change or f'the {kind} change on {target}'
    # Probation first. If this regression is a change the rails applied by
    # themselves and the version is still addressable, putting it back is the
    # whole answer — filing a "revert it?" proposal after the fact would ask the
    # human to approve something already done. Anything else (a human's apply,
    # autonomy off, a file someone edited since) returns None and the proposal
    # path below stands exactly as it was.
    from app.services.harness_rails import probation_revert

    if probation_revert(source, key, kind, target) is not None:
        return
    problem = f'Measured regression — revert {subject}?'
    evidence = json.dumps(
        {'verdict': 'regressed', 'windowDays': days, 'before': before, 'after': after},
        ensure_ascii=False,
    )
    proposal = (
        f'Revert the change booked as outcome {key} (source={source}, kind={kind}, '
        f'target={target}). The measurement job classified it regressed over a '
        f'{days}-day window. Undoing it is a human decision: this proposal only '
        'carries the evidence and the rollback the original author wrote.'
    )
    hsi.save_proposal(
        problem=problem,
        evidence=evidence,
        proposal=proposal,
        rollback=rollback,
        kind='revert',
        expected_metric='resolved rate recovers toward the pre-change window',
        payload={
            'outcomeId': r['id'],
            'outcomeKey': key,
            'source': source,
            'changeKind': kind,
            'target': target,
            'windowDays': days,
            'before': before,
            'after': after,
        },
    )


def _classify(before: dict[str, Any], after: dict[str, Any], targeted: bool = False) -> str:
    bEps = as_int(before.get('episodes'), 0)
    aEps = as_int(after.get('episodes'), 0)
    if targeted and 'fingerprintRecurrence' in before and 'fingerprintRecurrence' in after:
        # A targeted change (skill for a specific fingerprint) reads on the
        # recurrence directly — meaningful on any sample size: zero recurrence
        # after a non-zero before window is improvement, any recurrence in the
        # after window is regression (the skill's whole job is to stop it).
        if after['fingerprintRecurrence'] == 0 and before['fingerprintRecurrence'] > 0:
            return 'improved'
        if after['fingerprintRecurrence'] > 0:
            return 'regressed'
        return 'flat'
    if bEps < _MIN_EPISODES or aEps < _MIN_EPISODES:
        return 'insufficient'
    bRate = before.get('resolvedRate')
    aRate = after.get('resolvedRate')
    if bRate is None or aRate is None:
        return 'insufficient'
    if aRate >= bRate + _IMPROVE_EPS:
        return 'improved'
    if aRate <= bRate - _IMPROVE_EPS:
        return 'regressed'
    return 'flat'


def outcome_report(limit: int = 30) -> dict[str, Any]:
    """Rows for the Learning panel / curator endpoint (newest first)."""
    conn = _conn()
    rows = conn.execute(
        'SELECT key, source, kind, target, applied_at, expected, measured_at, verdict, '
        'before_json, after_json FROM harness_outcome ORDER BY id DESC LIMIT ?',
        (int(limit),),
    ).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        for jf in ('before_json', 'after_json'):
            try:
                d[jf] = json.loads(str(d.get(jf) or '{}'))
            except Exception:
                d[jf] = {}
        out.append(d)
    pending = conn.execute(
        'SELECT COUNT(*) AS n FROM harness_outcome WHERE measured_at IS NULL'
    ).fetchone()
    return {'rows': out, 'pending': int(pending['n']) if pending else 0}
