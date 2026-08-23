"""Harness self-improvement loop (IDEA.md flagship).

The model inspects its own harness through ``harness_introspect`` and files
structured improvement proposals through ``harness_propose``. Proposals are
NEVER applied directly by the model: they land as JSON files that a human (or
an approved deterministic applier) promotes via ``decide_proposal``.

Authority boundary (deliberate):
  * approvable kinds   -> brain_config patches, skill create/patch/delete,
                          tool-bucket reclassification suggestions recorded for
                          a human PR (bucket edits themselves stay human-owned)
  * human-only kinds   -> core loop code, sandbox policy, prompt builder,
                          verifier gate — ``harness_propose`` accepts them as
                          ``observation`` rows but nothing applies them.

Every state change routes through ``curation_ledger`` so the unified journal
stays the single source of "why did the harness change".
"""

from __future__ import annotations

import json
import time
import uuid
from pathlib import Path
from typing import Any

from app.json_narrowing import as_dict, as_int, as_list, as_str

# Kinds a deterministic applier may execute on approval.
APPROVABLE_KINDS = frozenset({'brain_config', 'skill_create', 'skill_patch', 'skill_delete'})
# Analysis-only kinds — always safe to store, never auto-applied.
OBSERVATION_KINDS = frozenset({'tool_bucket', 'tool_description', 'observation'})
VALID_KINDS = APPROVABLE_KINDS | OBSERVATION_KINDS


def _proposals_dir() -> Path:
    from app.config import settings

    d = Path(str(settings.dataDir)) / 'harness_proposals'
    d.mkdir(parents=True, exist_ok=True)
    return d


def build_introspection() -> dict[str, Any]:
    """Aggregate what the model cannot otherwise see about its own harness."""
    out: dict[str, Any] = {}

    # Tools: registered surface health.
    try:
        from app.services.tool_policy import prompt_bucket
        from app.services.tool_registry import listRaw

        tools = listRaw()
        buckets: dict[str, int] = {}
        long_descs: list[str] = []
        broken: list[str] = []
        for t in tools:
            name = as_str(t.get('name'), '')
            if not name:
                continue
            bucket = prompt_bucket(name)
            buckets[bucket] = buckets.get(bucket, 0) + 1
            desc_len = len(as_str(t.get('description'), ''))
            if desc_len > 300:
                long_descs.append(f'{name}({desc_len}ch)')
            handler = t.get('handler')
            schema = t.get('parameters')
            if not callable(handler) or not isinstance(schema, dict) or not schema:
                broken.append(name)
        out['tools'] = {
            'total': len(tools),
            'buckets': dict(sorted(buckets.items())),
            'descriptions_over_300ch': long_descs[:12],
            'broken_registrations': broken,
        }
    except Exception as exc:
        out['tools'] = {'error': str(exc)}

    # Skills: catalogue size + real usage telemetry.
    try:
        from app.services import skill_service

        catalogue = skill_service.catalogue()
        usage_rows: list[dict[str, Any]] = []
        try:
            from app.services.skills.curator import shared_curator

            usage_rows = [
                {'name': as_str(r.get('name'), ''), 'useCount': as_int(r.get('useCount'), 0)}
                for r in shared_curator().list_usage()
                if as_int(r.get('useCount'), 0) > 0
            ]
        except Exception:
            usage_rows = []
        evolving = sum(
            1 for s in catalogue if as_str(s.get('created_by'), '') in ('agent', 'auto-gen')
        )
        top_used = sorted(usage_rows, key=lambda r: -r['useCount'])[:8]
        out['skills'] = {
            'total': len(catalogue),
            'evolving': evolving,
            'ever_used': len(usage_rows),
            'top_used': top_used,
        }
    except Exception as exc:
        out['skills'] = {'error': str(exc)}

    # Memory stores at a glance.
    try:
        from app.services.memory_store import get_stats

        out['memory_stores'] = get_stats()
    except Exception as exc:
        out['memory_stores'] = {'error': str(exc)}

    # Brain config knobs currently in effect.
    try:
        from app.services.brain_config_service import getRuntimeConfig

        cfg = dict(getRuntimeConfig())
        secrets = {'apiKey', 'api_key'}
        out['brain_config'] = {k: v for k, v in sorted(cfg.items()) if k not in secrets}
    except Exception as exc:
        out['brain_config'] = {'error': str(exc)}

    # Latest golden-eval results (the measurement half of the loop).
    try:
        from app.services.harness_eval import list_eval_runs

        runs = list_eval_runs(limit=20)
        passed = sum(1 for r in runs if r.get('passed'))
        out['harness_evals'] = {
            'recent_runs': len(runs),
            'passed': passed,
            'passRate': round(passed / len(runs), 2) if runs else None,
            'scenarios': [as_str(r.get('scenario'), '') for r in runs[:10]],
        }
    except Exception as exc:
        out['harness_evals'] = {'error': str(exc)}

    # What other loops recently changed (cross-loop awareness).
    try:
        from app.services.memory import curation_ledger

        out['recent_curation'] = curation_ledger.recent(limit=10)
    except Exception:
        out['recent_curation'] = []

    # Open proposals (so the model does not re-propose duplicates).
    try:
        props = list_proposals()
        out['open_proposals'] = [
            {'id': p.get('id'), 'kind': p.get('kind'), 'status': p.get('status')}
            for p in props
            if p.get('status') == 'open'
        ][-20:]
    except Exception:
        out['open_proposals'] = []
    return out


def format_introspection(data: dict[str, Any]) -> str:
    """Compact text rendering for the model (bounded, no JSON dump)."""
    lines: list[str] = ['<harness_introspection>']
    tools = as_dict(data.get('tools'))
    if tools and 'total' in tools:
        lines.append(
            f"tools: {tools.get('total')} registered"
            + (f" — broken: {tools['broken_registrations']}" if tools.get('broken_registrations') else ' — none broken')
        )
        if tools.get('descriptions_over_300ch'):
            lines.append(f"  long descriptions (>300ch): {', '.join(as_list(tools['descriptions_over_300ch'], [])[:8])}")  # type: ignore[arg-type]
    skills = as_dict(data.get('skills'))
    if skills and 'total' in skills:
        top_used = as_list(skills.get('top_used'), [])
        tops = ', '.join(
            f"{as_str(as_dict(r).get('name'))}×{as_int(as_dict(r).get('useCount'), 0)}"
            for r in top_used
        )
        lines.append(
            f"skills: {skills.get('total')} catalogued ({skills.get('evolving')} evolving), "
            f"{skills.get('ever_used')} ever used; top: {tops}"
        )
    evals = as_dict(data.get('harness_evals'))
    if evals and 'passRate' in evals:
        lines.append(f"harness evals: {evals.get('passed')}/{evals.get('recent_runs')} passing (rate {evals.get('passRate')})")
    stores = as_dict(data.get('memory_stores'))
    if stores:
        lines.append(f"memory stores: memoryStore={stores.get('memoryStore')} facts={stores.get('facts')} sessions={stores.get('sessions')}")
    open_props = as_list(data.get('open_proposals'), [])
    if open_props:
        lines.append(f"open proposals: {len(open_props)} (check before filing duplicates)")
    curation = as_list(data.get('recent_curation'), [])
    if curation:
        lines.append('recent harness changes:')
        for row in curation[-5:]:
            row_d = as_dict(row)
            lines.append(f"  - [{as_str(row_d.get('actor'))}] {as_str(row_d.get('action'))} {as_str(row_d.get('target_key'))}")
    lines.append(
        'Use harness_propose(problem, evidence, proposal, expectedMetric, rollback, kind, payload) '
        'to file an improvement. kind=brain_config|skill_* are appliable on user approval; '
        'tool_bucket|tool_description|observation are recorded for human review.'
    )
    lines.append('</harness_introspection>')
    return '\n'.join(lines)


def save_proposal(
    *,
    problem: str,
    evidence: str,
    proposal: str,
    rollback: str,
    kind: str,
    expected_metric: str = '',
    payload: dict[str, Any] | None = None,
    session_id: str = '',
) -> dict[str, Any]:
    """Validate + persist one improvement proposal. Returns the stored row."""
    problem = problem.strip()
    evidence = evidence.strip()
    proposal_text = proposal.strip()
    rollback = rollback.strip()
    kind = kind.strip().lower()
    if not problem or not evidence or not proposal_text:
        raise ValueError('problem, evidence, and proposal are required')
    if not rollback:
        raise ValueError('rollback is required — every proposal must say how to undo it')
    if kind not in VALID_KINDS:
        raise ValueError(f'unknown kind {kind!r}; use one of {sorted(VALID_KINDS)}')

    pid = f'prop_{time.strftime("%Y%m%d")}_{uuid.uuid4().hex[:8]}'
    row: dict[str, Any] = {
        'id': pid,
        'createdAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        'sessionId': session_id,
        'kind': kind,
        'status': 'open',
        'problem': problem[:2000],
        'evidence': evidence[:4000],
        'proposal': proposal_text[:4000],
        'expectedMetric': expected_metric.strip()[:500],
        'rollback': rollback[:1000],
        'payload': as_dict(payload) if payload else {},
    }
    path = _proposals_dir() / f'{pid}.json'
    path.write_text(json.dumps(row, indent=2, ensure_ascii=False), encoding='utf-8')

    try:
        from app.services.brain_event_bus import emitBrainEvent

        emitBrainEvent(
            category='self_improvement',
            layer='harness.proposal',
            summary=f"Harness proposal filed [{kind}]: {problem[:80]}",
            meta={'type': 'harnessProposal', 'id': pid, 'kind': kind},
        )
    except Exception:
        pass
    return row


def list_proposals(limit: int = 50) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    try:
        paths = sorted(_proposals_dir().glob('prop_*.json'), reverse=True)[: max(1, min(limit, 200))]
        for p in paths:
            try:
                rows.append(json.loads(p.read_text(encoding='utf-8')))
            except Exception:
                continue
    except Exception:
        pass
    return rows


def get_proposal(pid: str) -> dict[str, Any] | None:
    path = _proposals_dir() / f'{Path(pid).name}.json'
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except Exception:
        return None


def decide_proposal(pid: str, decision: str, note: str = '') -> dict[str, Any]:
    """Approve/reject/dismiss a proposal. Approval runs the deterministic applier."""
    decision = decision.strip().lower()
    if decision not in ('approve', 'reject', 'dismiss'):
        raise ValueError("decision must be approve|reject|dismiss")
    row = get_proposal(pid)
    if row is None:
        raise ValueError(f'proposal {pid} not found')
    if row.get('status') != 'open':
        raise ValueError(f"proposal {pid} already {row.get('status')}")

    applied: dict[str, Any] = {}
    if decision == 'approve':
        applied = _apply_approved(row)

    row['status'] = (
        'applied' if decision == 'approve' and applied.get('ok') else
        'apply_failed' if decision == 'approve' else
        'rejected'
    )
    row['decidedAt'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
    if note.strip():
        row['decisionNote'] = note.strip()[:1000]
    if applied:
        row['applyResult'] = applied
    path = _proposals_dir() / f'{pid}.json'
    path.write_text(json.dumps(row, indent=2, ensure_ascii=False), encoding='utf-8')

    try:
        from app.services.memory import curation_ledger

        curation_ledger.record(
            actor='harness_self_improve',
            action=f'{decision}_proposal',
            target_kind='harness_proposal',
            target_key=row.get('kind', ''),
            reason=(note or row.get('problem', ''))[:200],
            detail=json.dumps(applied)[:2000] if applied else '',
        )
    except Exception:
        pass
    return row


def _apply_approved(row: dict[str, Any]) -> dict[str, Any]:
    """Deterministic applier — the ONLY path from proposal to live change."""
    kind = as_str(row.get('kind'), '')
    payload = as_dict(row.get('payload'))
    if kind == 'brain_config':
        patch = payload.get('patch')
        if not isinstance(patch, dict):
            return {'ok': False, 'error': 'brain_config proposals need payload.patch (object)'}
        try:
            from app.services.brain_config_service import saveBrainConfig, validatePatch

            ok, err = validatePatch(patch)
            if not ok:
                return {'ok': False, 'error': f'config validation failed: {err}'}
            ok2, err2, _cfg = saveBrainConfig(patch)
            return {'ok': bool(ok2), 'error': err2}
        except Exception as exc:
            return {'ok': False, 'error': str(exc)}
    if kind in ('skill_create', 'skill_patch'):
        name = as_str(payload.get('name'), '').strip()
        body = as_str(payload.get('body'), '')
        description = as_str(payload.get('description'), '')
        trigger = as_str(payload.get('trigger'), '')
        if not name:
            return {'ok': False, 'error': 'skill proposals need payload.name'}
        try:
            from app.services import skill_service

            if kind == 'skill_patch':
                skill_service.patchSkill(
                    name,
                    body=body or None,
                    description=description or None,
                    trigger=trigger or None,
                )
                return {'ok': True, 'action': 'patched', 'name': name}
            skill_service.createSkill(
                name,
                description=description or 'Created from an approved harness proposal.',
                body=body,
                trigger=trigger,
            )
            return {'ok': True, 'action': 'created', 'name': name}
        except Exception as exc:
            return {'ok': False, 'error': str(exc)}
    if kind == 'skill_delete':
        name = as_str(payload.get('name'), '').strip()
        if not name:
            return {'ok': False, 'error': 'skill_delete needs payload.name'}
        try:
            from app.services import skill_service

            skill_service.deleteSkill(name)
            return {'ok': True, 'action': 'deleted', 'name': name}
        except Exception as exc:
            return {'ok': False, 'error': str(exc)}
    return {'ok': False, 'error': f'kind {kind!r} is human-only; file it as observation'}


# ── Tool handlers (async, string-in/string-out like every registered tool) ──

async def _harnessIntrospect() -> str:
    return format_introspection(build_introspection())


async def _harnessPropose(
    problem: str = '',
    evidence: str = '',
    proposal: str = '',
    rollback: str = '',
    kind: str = 'observation',
    expectedMetric: str = '',
    payload: dict[str, Any] | None = None,
    **_extra: object,
) -> str:
    """File one improvement proposal for human review."""
    session_id = ''
    try:
        from app.services.workbench.context import currentSessionId as _curSession

        session_id = _curSession.get() or ''
    except Exception:
        session_id = ''
    try:
        row = save_proposal(
            problem=problem,
            evidence=evidence,
            proposal=proposal,
            rollback=rollback,
            kind=kind,
            expected_metric=expectedMetric,
            payload=payload,
            session_id=session_id,
        )
    except ValueError as exc:
        return f'Error: {exc}'
    return (
        f"Proposal {row['id']} filed (kind={row['kind']}, status=open). "
        'It is queued for human review — do not assume it is applied. '
        'Track it in Settings → Insights or GET /api/brain/harness/proposals.'
    )
