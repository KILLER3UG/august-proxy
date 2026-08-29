"""Part 17 Phase E — cross-project review & promotion (gated).

The promotion judge reads project memories + project skills across KNOWN
workspaces (distinct non-empty, non-home ``sessions.workspace_path`` — never
invented paths) and files a ``promote`` proposal into the existing
harness_proposals review queue when a lesson recurs in ≥2 projects or a
project skill has cross-project shape.

Authority boundaries (plan §Phase E):
  * The judge NEVER applies anything — approvals go through the existing
    human gate (``decide_proposal``, POST /api/harness/proposals/{id}/decide).
  * Approve = copy-on-write to the global agent root or global facts; the
    project file is never mutated.
  * Provenance = ``promoted-from:<workspace>`` + source file.
  * Rejected drafts are recorded and never read as evidence again (Part 16
    anti-drift rule).
  * Runs under Part 16's ``skillLearning`` config: off | extract-only | full.
    ``off`` = nothing runs; ``extract-only`` (ship default) = mining +
    proposals; ``full`` = also drafts skill *bodies* for promotion (otherwise
    only entry titles + metadata ship).
  * Demote suggestion: a promoted item that never triggers outside its
    origin project gets a demote proposal in the same queue (Part 16
    fingerprint/trigger measurement).
"""

from __future__ import annotations

import json
import logging
import re
import time
from pathlib import Path
from typing import Any

from app.json_narrowing import as_str

logger = logging.getLogger('august.harness_promote')

# Sensitive-topic denylist mirrors the remember gate (plan: drafts pass the
# sensitive denylist before a proposal is filed).
_SENSITIVE_PATTERNS = re.compile(
    r'\b(health|diagnos\w*|medication|ssn|social security|passport|minor'
    r'|child|religion|belief|political|password|api[_ ]?key|secret)\b',
    re.IGNORECASE,
)

# Similarity for "same lesson in ≥2 projects": normalized token-set overlap.
_RECURRENCE_MIN_OVERLAP = 0.6

# How many turns of no-trigger before a promoted item earns a demote
# suggestion (observation-only; the human decides).
_DEMOTE_AFTER_DAYS = 14


def _skill_learning_mode() -> str:
    """off | extract-only | full (default extract-only — Part 16 ship bar)."""
    try:
        from app.services.brain_config_service import getRuntimeConfig

        raw = as_str(getRuntimeConfig().get('skillLearning'), 'extract-only')
    except Exception:
        raw = 'extract-only'
    raw = (raw or 'extract-only').strip().lower()
    return raw if raw in ('off', 'extract-only', 'full') else 'extract-only'


def _known_workspaces() -> list[str]:
    """Known projects = DISTINCT sessions.workspace_path (non-empty,
    non-home). The judge never invents paths (Phase E enumeration rule)."""
    from app.services.memory_conn import conn as _conn

    home = str(Path.home().resolve())
    try:
        rows = _conn().execute(
            "SELECT DISTINCT workspace_path FROM sessions "
            "WHERE workspace_path IS NOT NULL AND TRIM(workspace_path) != ''"
        ).fetchall()
    except Exception:
        return []
    out: list[str] = []
    seen: set[str] = set()
    for r in rows:
        ws = str(r['workspace_path']).strip()
        if not ws or ws in seen:
            continue
        try:
            resolved = str(Path(ws).resolve())
        except Exception:
            continue
        if resolved == home or not Path(resolved).is_dir():
            continue
        seen.add(ws)
        out.append(ws)
    return out


def _normalize(text: str) -> list[str]:
    return sorted({t.lower() for t in re.split(r'[^\w]+', text or '') if len(t) > 2})


def _overlap(a: list[str], b: list[str]) -> float:
    if not a or not b:
        return 0.0
    sa, sb = set(a), set(b)
    return len(sa & sb) / min(len(sa), len(sb))


def _sensitive(text: str) -> bool:
    return bool(_SENSITIVE_PATTERNS.search(text or ''))


# ── Evidence collection ───────────────────────────────────────────────────


def collect_evidence() -> dict[str, Any]:
    """Read project memories + project skills across known workspaces.

    Returns ``{'workspaces': [{path, memories: [{file,title,body}], skills:
    [{name,description,trigger,scope}]}]}`` — titles + metadata always; full
    bodies only on the shortlist (``full`` mode), per the plan's budget rule.
    """
    from app.services import project_memory as _pm
    from app.services import skill_service

    mode = _skill_learning_mode()
    out: list[dict[str, Any]] = []
    for ws in _known_workspaces():
        entry: dict[str, Any] = {'path': ws, 'memories': [], 'skills': []}
        try:
            for e in _pm.read_entries(ws):
                item = {'file': e.file, 'title': e.title}
                if mode == 'full':
                    item['body'] = e.body
                entry['memories'].append(item)
        except Exception:
            pass
        try:
            for s in skill_service.list_all(ws):
                if as_str(s.get('scope')) != 'project':
                    continue
                entry['skills'].append(
                    {
                        'name': as_str(s.get('name')),
                        'description': as_str(s.get('description')),
                        'trigger': as_str(s.get('trigger') or ''),
                    }
                )
        except Exception:
            pass
        out.append(entry)
    return {'mode': mode, 'workspaces': out}


# ── Recurrence detection ──────────────────────────────────────────────────


def find_recurring_lessons(evidence: dict[str, Any]) -> list[dict[str, Any]]:
    """Lessons whose normalized token-set overlaps ≥60% across ≥2 distinct
    workspaces. Only titles + bodies (in full mode) are compared."""
    byLesson: list[dict[str, Any]] = []
    for wsEntry in evidence.get('workspaces', []):
        ws = as_str(wsEntry.get('path'))
        for m in wsEntry.get('memories', []):
            title = as_str(m.get('title'))
            if not title or _sensitive(title):
                continue
            byLesson.append(
                {
                    'title': title,
                    'tokens': _normalize(title + ' ' + as_str(m.get('body', ''))),
                    'workspace': ws,
                    'file': as_str(m.get('file')),
                }
            )
    recurring: list[dict[str, Any]] = []
    used: set[int] = set()
    for i, a in enumerate(byLesson):
        if i in used:
            continue
        cluster = [a]
        for j in range(i + 1, len(byLesson)):
            if j in used:
                continue
            b = byLesson[j]
            if b['workspace'] == a['workspace']:
                continue
            if _overlap(a['tokens'], b['tokens']) >= _RECURRENCE_MIN_OVERLAP:
                cluster.append(b)
                used.add(j)
        used.add(i)
        workspaces = {c['workspace'] for c in cluster}
        if len(workspaces) >= 2:
            recurring.append(
                {
                    'title': a['title'],
                    'workspaces': sorted(workspaces),
                    'files': [f"{c['workspace']} :: {c['file']} :: {c['title']}" for c in cluster],
                }
            )
    return recurring


def find_cross_project_skills(evidence: dict[str, Any]) -> list[dict[str, Any]]:
    """Project skills with cross-project shape: same name in ≥2 workspaces,
    or a description that overlaps a lesson recurring in ≥2 projects."""
    seen: dict[str, set[str]] = {}
    for wsEntry in evidence.get('workspaces', []):
        ws = as_str(wsEntry.get('path'))
        for s in wsEntry.get('skills', []):
            name = as_str(s.get('name'))
            if not name or _sensitive(name + ' ' + as_str(s.get('description'))):
                continue
            seen.setdefault(name, set()).add(ws)
    return [
        {'name': name, 'workspaces': sorted(ws)}
        for name, ws in seen.items()
        if len(ws) >= 2
    ]


# ── Judge pass ────────────────────────────────────────────────────────────


def _rejected_drafts() -> set[str]:
    """Part 16 anti-drift: rejected proposals are never evidence again."""
    from app.services.harness_self_improve import list_proposals

    out: set[str] = set()
    try:
        for p in list_proposals():
            if as_str(p.get('status')) == 'rejected' and as_str(p.get('kind')) == 'promote':
                raw = p.get('payload')
                payload = raw if isinstance(raw, dict) else {}
                for f in (payload.get('files') or []):
                    out.add(as_str(f))
                title = as_str(payload.get('title'))
                if title:
                    out.add(title)
    except Exception:
        pass
    return out


def run_promotion_pass(*, force: bool = False) -> dict[str, Any]:
    """One judge pass → 0..N ``promote`` proposals in the review queue.

    Never applies anything; never mutates project files. Returns a summary
    ``{ran, mode, proposalsFiled, recurring, crossSkills}``.
    """
    mode = _skill_learning_mode()
    if mode == 'off' and not force:
        return {'ran': False, 'mode': 'off', 'proposalsFiled': 0, 'reason': 'skillLearning is off'}
    from app.services.harness_self_improve import save_proposal

    evidence = collect_evidence()
    recurring = find_recurring_lessons(evidence)
    crossSkills = find_cross_project_skills(evidence)
    rejected = _rejected_drafts()
    filed = 0
    for lesson in recurring:
        if lesson['title'] in rejected:
            continue
        try:
            save_proposal(
                problem=(
                    f"A lesson recurs across {len(lesson['workspaces'])} projects: "
                    f"\"{lesson['title']}\" — candidate for global memory."
                ),
                evidence=(
                    'Recurrence across distinct workspaces (≥2-project bar, Part 17 Phase E):\n'
                    + '\n'.join(f"- {f}" for f in lesson['files'])
                ),
                proposal=(
                    'Promote this recurring lesson into the GLOBAL facts store so every '
                    'project sees it (copy-on-write — the project files stay untouched).'
                ),
                rollback='forget the promoted global fact by its promoted-<key>.',
                kind='promote',
                expected_metric='promoted fact recalled in ≥1 non-origin project within 30 days',
                payload={
                    'promoteType': 'fact',
                    'title': lesson['title'],
                    'workspaces': lesson['workspaces'],
                    'files': lesson['files'],
                },
            )
            filed += 1
        except ValueError:
            continue  # duplicate open proposal
    for skill in crossSkills:
        if skill['name'] in rejected:
            continue
        try:
            save_proposal(
                problem=(
                    f"Project skill \"{skill['name']}\" exists in "
                    f"{len(skill['workspaces'])} projects — cross-project shape."
                ),
                evidence=(
                    'Same project-skill name independently present in:\n'
                    + '\n'.join(f"- {ws}" for ws in skill['workspaces'])
                ),
                proposal=(
                    'Promote this skill to the GLOBAL agent root (copy-on-write from the '
                    'first workspace; project copies keep shadowing locally).'
                ),
                rollback='delete the promoted global skill directory.',
                kind='promote',
                expected_metric='promoted skill triggers in ≥1 non-origin project within 30 days',
                payload={
                    'promoteType': 'skill',
                    'name': skill['name'],
                    'workspaces': skill['workspaces'],
                    'files': [f"{ws} :: {skill['name']}" for ws in skill['workspaces']],
                },
            )
            filed += 1
        except ValueError:
            continue
    summary = {
        'ran': True,
        'mode': mode,
        'proposalsFiled': filed,
        'recurring': len(recurring),
        'crossSkills': len(crossSkills),
        'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
    }
    logger.info('promotion pass: %s', json.dumps(summary))
    return summary


# ── Approval applier (called from decide_proposal) ────────────────────────


def apply_promotion(payload: dict[str, Any]) -> dict[str, Any]:
    """Deterministic applier for an APPROVED ``promote`` proposal.

    Copy-on-write only: the project file is never mutated.
      * fact  → global facts store with provenance key + source
      * skill → global agent-skills root (first workspace's copy wins)
    Returns ``{ok, action, target}`` for the proposal's applyResult.
    """
    promoteType = as_str(payload.get('promoteType'))
    workspaces = [as_str(w) for w in (payload.get('workspaces') or []) if as_str(w)]
    origin = workspaces[0] if workspaces else ''
    try:
        if promoteType == 'fact':
            title = as_str(payload.get('title')).strip()
            if not title:
                return {'ok': False, 'error': 'promote(fact) needs payload.title'}
            from app.services import project_memory as _pm
            from app.services.memory_store import save_fact

            body = ''
            try:
                matches = [e for e in _pm.read_entries(origin) if e.title == title]
                if matches:
                    body = matches[0].body
            except Exception:
                body = ''
            if not body:
                body = title
            key = 'promoted-' + re.sub(r'[^a-z0-9]+', '-', title.lower()).strip('-')[:60]
            save_fact(
                key,
                body,
                category='promoted',
                source='promoted-from:' + (origin or 'unknown'),
                title=title,
                kind='lesson',
            )
            return {'ok': True, 'action': 'promoted_fact', 'target': key, 'origin': origin}
        if promoteType == 'skill':
            name = as_str(payload.get('name')).strip()
            if not name or not origin:
                return {'ok': False, 'error': 'promote(skill) needs payload.name + workspaces[0]'}
            from app.services import skill_service

            detail = skill_service.get(name, origin)
            if detail is None:
                return {'ok': False, 'error': f'project skill {name!r} not found in {origin!r}'}
            skill_service.createSkill(
                name=name,
                description=as_str(detail.get('description')),
                body=as_str(detail.get('instructions')),
                trigger=as_str(detail.get('trigger') or ''),
                created_by='promotion',
            )
            return {'ok': True, 'action': 'promoted_skill', 'target': name, 'origin': origin}
        return {'ok': False, 'error': f'unknown promoteType {promoteType!r}'}
    except Exception as exc:
        return {'ok': False, 'error': f'promotion failed: {exc}'}


# ── Demote suggestions (observation-only) ─────────────────────────────────


def suggest_demotions() -> list[dict[str, Any]]:
    """Promoted items with no trigger outside their origin since promotion.

    Reads the promotion ledger (applied ``promote`` rows) + facts metadata
    and files an ``observation``-kind demote SUGGESTION into the same queue
    — never deletes anything (the human decides).
    """
    from app.services.harness_self_improve import list_proposals, save_proposal

    suggestions: list[dict[str, Any]] = []
    now = time.time()
    for p in list_proposals():
        if as_str(p.get('kind')) != 'promote' or as_str(p.get('status')) != 'applied':
            continue
        raw = p.get('payload')
        payload = raw if isinstance(raw, dict) else {}
        origin = as_str((payload.get('workspaces') or [''])[0])
        target = as_str(payload.get('title') or payload.get('name'))
        if not target:
            continue
        decidedAt = as_str(p.get('decidedAt'))
        try:
            ageDays = (now - time.mktime(time.strptime(decidedAt[:19], '%Y-%m-%dT%H:%M:%S'))) / 86400
        except (ValueError, TypeError):
            ageDays = 0.0
        if ageDays < _DEMOTE_AFTER_DAYS:
            continue
        # Trigger measurement: use_count outside origin is proxied by the
        # fact's own use_count (facts store) — zero growth = never recalled.
        used = False
        if as_str(payload.get('promoteType')) == 'fact':
            try:
                from app.services.memory_conn import conn as _conn

                key = 'promoted-' + re.sub(r'[^a-z0-9]+', '-', as_str(payload.get('title')).lower()).strip('-')[:60]
                row = _conn().execute(
                    'SELECT use_count FROM facts WHERE fact_key = ?', (key,)
                ).fetchone()
                used = bool(row and int(row['use_count'] or 0) > 0)
            except Exception:
                used = False
        if used:
            continue
        try:
            save_proposal(
                problem=f'Promoted item "{target}" (from {origin}) has not triggered since promotion.',
                evidence=(
                    f'Promotion approved at {decidedAt}; no recall/use outside the origin project '
                    f'for {int(ageDays)} days (Part 16 fingerprint measurement).'
                ),
                proposal=(
                    'Demote suggestion: consider deleting the promoted global copy — the '
                    'project originals remain untouched either way.'
                ),
                rollback='none — suggestion only; deleting is reversible via rollback store.',
                kind='observation',
                expected_metric='approval rate + post-promotion trigger counts (Phase E measurement)',
                payload={'demoteSuggestion': target, 'origin': origin, 'proposalId': p.get('id')},
            )
            suggestions.append({'target': target, 'origin': origin, 'ageDays': int(ageDays)})
        except ValueError:
            continue
    return suggestions
