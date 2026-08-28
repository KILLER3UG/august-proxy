"""Harness self-improvement loop (0.17.0 rebuild).

The model inspects its own harness through ``harness_introspect`` and files
structured improvement proposals through ``harness_propose``. Proposals are
NEVER applied directly by the model: they land as JSON files that a human
promotes via ``decide_proposal`` (POST /api/harness/proposals/{id}/decide),
or that the deterministic applier executes after approval.

Authority boundary (deliberate):
  * approvable kinds   -> brain_config patches, skill create/patch/delete
                          (written straight into the agent skills dir)
  * observation kinds  -> tool_bucket / tool_description / flow_map /
                          observation — recorded for a human PR, never applied

Every decision is appended to ``data/harness_proposals/ledger.jsonl`` so the
journal stays the single source of "why did the harness change" (the old
curation-ledger sqlite table went away in the 0.16.x→0.17 refactor).

A scheduled off-hours pass (``scheduled_introspection_loop``) runs
``build_introspection`` hourly and AUTO-FILES an ``observation`` proposal when
mechanically-detectable findings exist (broken registrations, oversized
descriptions) — the loop eats its own dogfood without ever applying anything.
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
OBSERVATION_KINDS = frozenset({'tool_bucket', 'tool_description', 'flow_map', 'observation'})
VALID_KINDS = APPROVABLE_KINDS | OBSERVATION_KINDS

_MAX_PROPOSAL_FILES = 200


def _proposals_dir() -> Path:
    from app.config import settings

    d = Path(str(settings.dataDir)) / 'harness_proposals'
    d.mkdir(parents=True, exist_ok=True)
    return d


def _append_ledger(row: dict[str, Any]) -> None:
    """Append-one journal — survives even when sqlite-backed stores move."""
    try:
        p = _proposals_dir() / 'ledger.jsonl'
        with p.open('a', encoding='utf-8') as f:
            f.write(json.dumps(row, ensure_ascii=False) + '\n')
    except Exception:
        pass


def read_ledger(limit: int = 20) -> list[dict[str, Any]]:
    try:
        p = _proposals_dir() / 'ledger.jsonl'
        if not p.exists():
            return []
        lines = p.read_text(encoding='utf-8').strip().splitlines()
        out = []
        for line in lines[-limit:]:
            try:
                out.append(as_dict(json.loads(line)))
            except Exception:
                continue
        return out
    except Exception:
        return []


# ── Introspection ─────────────────────────────────────────────────────────


def _introspect_tools(out: dict[str, Any]) -> None:
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


def _introspect_skills(out: dict[str, Any]) -> None:
    try:
        from app.services import skill_service

        catalogue = skill_service.catalogue()
        evolving = sum(
            1 for s in catalogue if as_str(s.get('created_by'), '') in ('agent', 'auto-gen')
        )
        long_descs = [
            f"{as_str(s.get('name'))}({len(as_str(s.get('description'), ''))}ch)"
            for s in catalogue
            if len(as_str(s.get('description'), '')) > 300
        ]
        out['skills'] = {
            'total': len(catalogue),
            'evolving': evolving,
            'descriptions_over_300ch': long_descs[:12],
        }
    except Exception as exc:
        out['skills'] = {'error': str(exc)}


def _introspect_flow(out: dict[str, Any]) -> None:
    """Flow map: the loop anatomy the model otherwise cannot see."""
    flow: dict[str, Any] = {}
    try:
        from app.services.brain_config_service import getRuntimeConfig

        cfg = as_dict(getRuntimeConfig())
        flow['max_tool_rounds_per_turn'] = as_int(cfg.get('maxWorkbenchToolLoops'), 25)
        flow['auto_route_min_samples'] = as_int(cfg.get('autoRouteMinSamples'), 3)
        flow['max_agent_depth'] = as_int(cfg.get('maxAgentDepth'), 1)
    except Exception as exc:
        flow['config_error'] = str(exc)
    flow['turn_loop'] = (
        'prompt build → stream → managed tool rounds (update_state advances '
        'phase; stalled phase triggers reflection nudge then hard stop) → '
        'auto-compact at high pressure → final answer'
    )
    flow['phases'] = ['research', 'plan', 'implement', 'review', 'complete']
    flow['agent_modes'] = ['chat', 'agent', 'code', 'orchestrator']
    flow['guard_modes'] = ['ask', 'edit', 'plan', 'full']
    flow['auto_compact'] = 'high(≥80%) pressure after 2 turns, or <8000 tokens headroom'
    out['flow_map'] = flow


def _introspect_memory(out: dict[str, Any]) -> None:
    try:
        from app.services.memory_store.rest import get_stats

        out['memory_stores'] = get_stats()
    except Exception as exc:
        out['memory_stores'] = {'error': str(exc)}


def _introspect_brain_config(out: dict[str, Any]) -> None:
    try:
        from app.services.brain_config_service import getRuntimeConfig

        cfg = dict(getRuntimeConfig())
        secrets = {'apiKey', 'api_key'}
        out['brain_config'] = {k: v for k, v in sorted(cfg.items()) if k not in secrets}
    except Exception as exc:
        out['brain_config'] = {'error': str(exc)}


def _introspect_open_proposals(out: dict[str, Any]) -> None:
    try:
        props = list_proposals()
        out['open_proposals'] = [
            {'id': p.get('id'), 'kind': p.get('kind'), 'status': p.get('status')}
            for p in props
            if p.get('status') == 'open'
        ][-20:]
    except Exception:
        out['open_proposals'] = []


def build_introspection() -> dict[str, Any]:
    """Aggregate what the model cannot otherwise see about its own harness."""
    out: dict[str, Any] = {}
    _introspect_tools(out)
    _introspect_skills(out)
    _introspect_flow(out)
    _introspect_memory(out)
    _introspect_brain_config(out)
    out['recent_changes'] = read_ledger(limit=10)
    _introspect_open_proposals(out)
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
        lines.append(
            f"skills: {skills.get('total')} catalogued ({skills.get('evolving')} evolving)"
        )
        if skills.get('descriptions_over_300ch'):
            lines.append(f"  long descriptions (>300ch): {', '.join(as_list(skills['descriptions_over_300ch'], [])[:8])}")  # type: ignore[arg-type]
    flow = as_dict(data.get('flow_map'))
    if flow:
        phases = ','.join(str(p) for p in as_list(flow.get('phases'), []))
        modes = ','.join(str(m) for m in as_list(flow.get('agent_modes'), []))
        lines.append(
            f"flow: ≤{flow.get('max_tool_rounds_per_turn', '?')} tool rounds/turn · "
            f"phases {phases} · "
            f"modes {modes}"
        )
    stores = as_dict(data.get('memory_stores'))
    if stores:
        lines.append(
            f"memory stores (brain SQLite): {stores.get('memoryStore')} memory rows · "
            f"{stores.get('facts')} facts · {stores.get('sessions')} sessions"
        )
    open_props = as_list(data.get('open_proposals'), [])
    if open_props:
        lines.append(f"open proposals: {len(open_props)} (check before filing duplicates)")
    changes = as_list(data.get('recent_changes'), [])
    if changes:
        lines.append('recent harness changes:')
        for row in changes[-5:]:
            row_d = as_dict(row)
            lines.append(f"  - [{as_str(row_d.get('actor'))}] {as_str(row_d.get('action'))} {as_str(row_d.get('target_key'))}")
    lines.append(
        'Use harness_propose(problem, evidence, proposal, rollback, kind, expectedMetric?, payload?) '
        'to file an improvement. kind=brain_config|skill_* are appliable on user approval; '
        'tool_bucket|tool_description|flow_map|observation are recorded for human review.'
    )
    lines.append('</harness_introspection>')
    return '\n'.join(lines)


# ── Proposals ─────────────────────────────────────────────────────────────


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

    # Duplicate guard: same kind + near-same problem while a proposal is open.
    for existing in list_proposals():
        existing_problem = as_str(existing.get('problem'), '').strip()
        if (
            existing.get('status') == 'open'
            and existing.get('kind') == kind
            and (existing_problem.startswith(problem[:120]) or problem.startswith(existing_problem[:120]))
        ):
            raise ValueError('an open proposal with the same kind and problem already exists')

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
        'rollback': rollback[:2000],
        'expectedMetric': expected_metric.strip()[:500],
    }
    if payload:
        row['payload'] = payload

    # Prune oldest decided rows beyond the cap so the dir cannot grow forever.
    _prune_old_proposals()

    path = _proposals_dir() / f'{pid}.json'
    path.write_text(json.dumps(row, indent=2, ensure_ascii=False), encoding='utf-8')
    _append_ledger({
        'at': row['createdAt'],
        'actor': 'model',
        'action': 'file_proposal',
        'target_key': pid,
        'kind': kind,
    })
    try:
        from app.services.realtime_bus import emit_realtime

        emit_realtime('harness-proposal', proposalId=pid, kind=kind, problem=problem[:160])
    except Exception:
        pass
    return row


def _prune_old_proposals(keep: int = _MAX_PROPOSAL_FILES) -> None:
    try:
        d = _proposals_dir()
        files = sorted(
            (f for f in d.glob('prop_*.json')),
            key=lambda f: f.stat().st_mtime,
        )
        excess = len(files) - keep
        for f in files[:max(0, excess)]:
            try:
                row = json.loads(f.read_text(encoding='utf-8'))
                if row.get('status') == 'open':
                    continue  # never prune open proposals
            except Exception:
                pass
            f.unlink(missing_ok=True)
    except Exception:
        pass


def list_proposals(status: str = '') -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for p in sorted(_proposals_dir().glob('prop_*.json')):
        try:
            row = json.loads(p.read_text(encoding='utf-8'))
        except Exception:
            continue
        if status and row.get('status') != status:
            continue
        rows.append(row)
    rows.sort(key=lambda r: as_str(r.get('createdAt')), reverse=True)
    return rows


def get_proposal(pid: str) -> dict[str, Any] | None:
    path = _proposals_dir() / f'{pid}.json'
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

    _append_ledger({
        'at': row['decidedAt'],
        'actor': 'human',
        'action': f'{decision}_proposal',
        'target_key': pid,
        'kind': row.get('kind', ''),
        'detail': (json.dumps(applied)[:500] if applied else ''),
    })
    return row


def _skill_frontmatter(name: str, description: str, trigger: str) -> str:
    lines = ['---', f'name: {name}', f'description: "{description}"']
    if trigger:
        lines.append(f'trigger: {trigger}')
    lines += ['category: learned', 'created_by: harness-proposal', '---', '']
    return '\n'.join(lines)


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
            from app.services.skill_service import (
                _agentSkillsDir,
                _ensure_canonical_body,
                _validateDescription,
                _validateName,
            )

            _validateName(name)
            _validateDescription(description or 'Created from an approved harness proposal.')
            root = _agentSkillsDir()
            skill_dir = root / name
            md = skill_dir / 'SKILL.md'
            if kind == 'skill_patch' and not md.exists():
                return {'ok': False, 'error': f'skill {name!r} does not exist; use skill_create'}
            skill_dir.mkdir(parents=True, exist_ok=True)
            normalized = _ensure_canonical_body(
                body,
                name=name,
                description=description or 'Created from an approved harness proposal.',
                is_learned=True,
            )
            md.write_text(
                _skill_frontmatter(name, description or 'Created from an approved harness proposal.', trigger)
                + normalized,
                encoding='utf-8',
            )
            try:
                from app.services.skill_service import _bust_prompt_skills_cache

                _bust_prompt_skills_cache()
            except Exception:
                pass
            return {'ok': True, 'action': 'patched' if kind == 'skill_patch' else 'created', 'name': name}
        except ValueError as exc:
            return {'ok': False, 'error': str(exc)}
        except Exception as exc:
            return {'ok': False, 'error': str(exc)}

    if kind == 'skill_delete':
        name = as_str(payload.get('name'), '').strip()
        if not name:
            return {'ok': False, 'error': 'skill_delete proposals need payload.name'}
        try:
            import shutil

            from app.services.skill_service import _agentSkillsDir

            skill_dir = _agentSkillsDir() / name
            if not skill_dir.is_dir():
                return {'ok': False, 'error': f'skill {name!r} not found in agent skills'}
            shutil.rmtree(skill_dir)
            try:
                from app.services.skill_service import _bust_prompt_skills_cache

                _bust_prompt_skills_cache()
            except Exception:
                pass
            return {'ok': True, 'action': 'deleted', 'name': name}
        except Exception as exc:
            return {'ok': False, 'error': str(exc)}

    return {'ok': False, 'error': f'kind {kind!r} is human-only — nothing applies automatically'}


# ── Scheduled introspection ───────────────────────────────────────────────

_INTERVAL_S = 6 * 3600


async def scheduled_introspection_loop() -> None:
    """Off-hours harness introspection: auto-file observations, never apply.

    Runs immediately once (post-boot sweep), then every 6h. Only files a
    proposal when mechanical findings exist, and dedupes against open ones
    via save_proposal's duplicate guard.
    """
    import asyncio

    while True:
        try:
            filed = await asyncio.to_thread(_run_scheduled_pass)
            if filed:
                import logging

                logging.getLogger(__name__).info(
                    'harness introspection filed %d observation proposal(s)', filed
                )
        except Exception:
            import logging

            logging.getLogger(__name__).exception('scheduled introspection pass failed')
        await asyncio.sleep(_INTERVAL_S)


def _run_scheduled_pass() -> int:
    """One introspection sweep → 0..N observation proposals. Returns count."""
    data = build_introspection()
    findings: list[str] = []

    tools = as_dict(data.get('tools'))
    broken = as_list(tools.get('broken_registrations'), [])
    if broken:
        findings.append(f'broken tool registrations: {", ".join(as_list(broken)[:8])}')  # type: ignore[arg-type]
    long_tools = as_list(tools.get('descriptions_over_300ch'), [])
    if long_tools:
        findings.append(f'tool descriptions over 300ch: {", ".join(as_list(long_tools)[:8])}')  # type: ignore[arg-type]

    skills = as_dict(data.get('skills'))
    long_skills = as_list(skills.get('descriptions_over_300ch'), [])
    if long_skills:
        findings.append(f'skill descriptions over 300ch (weaken triggering): {", ".join(as_list(long_skills)[:8])}')  # type: ignore[arg-type]

    if not findings:
        return 0

    evidence = '\n'.join(f'- {f}' for f in findings)
    day = time.strftime('%Y%m%d')
    dup_id = f'observation_{day}'
    for existing in list_proposals(status='open'):
        if as_str(existing.get('id'), '').endswith(dup_id) or existing.get('dedupeKey') == dup_id:
            return 0
    try:
        row = save_proposal(
            problem='Scheduled harness introspection found mechanically-detectable issues.',
            evidence=evidence,
            proposal=(
                'Trim the listed descriptions to ≤300ch (triggering quality), and repair any '
                'broken registrations (missing handler/schema). These are code-side edits — '
                'human-owned; this proposal records the findings for the next maintenance PR.'
            ),
            rollback='Revert the description edits / registration fixes in the next commit.',
            kind='observation',
            expected_metric='registry audit reports zero >300ch descriptions; zero broken registrations',
            payload={'dedupeKey': dup_id},
        )
        # Stable dedupe key visible on the row itself.
        row_path = _proposals_dir() / f"{row['id']}.json"
        row['dedupeKey'] = dup_id
        row_path.write_text(json.dumps(row, indent=2, ensure_ascii=False), encoding='utf-8')
        return 1
    except ValueError:
        return 0  # duplicate open proposal — nothing to do
