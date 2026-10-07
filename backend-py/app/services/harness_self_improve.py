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
from typing import Any, Callable

from app.json_narrowing import as_dict, as_int, as_list, as_str

# Module level on purpose: the reviewer pass must be replaceable by path in
# tests, and a lazy import inside the function would make that patching silently
# ineffective — the same class of green as item 8's guard.
from app.services.review_gate import resolve_independent_reviewer

# Kinds a deterministic applier may execute on approval.
# `retire` (audit P2#13) is a LIFECYCLE label, not a delete: approving it
# writes `status: retired` into the skill's frontmatter and leaves the file,
# its version history and its counters in place. It is approvable — and only
# approvable — because the scheduled passes can only ever file it.
APPROVABLE_KINDS = frozenset(
    {'brain_config', 'skill_create', 'skill_patch', 'skill_delete', 'retire'}
)
# Analysis-only kinds — always safe to store, never auto-applied.
OBSERVATION_KINDS = frozenset({'tool_bucket', 'tool_description', 'flow_map', 'observation'})
# Filed by the outcome ledger (harness_outcome) when a learning write measures
# as a regression, carrying that change's own rollback text. Human-only for the
# same reason the observations are: undoing what the harness learned is a call
# a person makes, so _apply_approved falls through to its "human-only" branch.
REVERT_KINDS = frozenset({'revert'})
# Cross-project promotion. Filed by harness_promote's judge
# pass (≥2-project bar); approved via the same human gate, applied
# copy-on-write by harness_promote.apply_promotion with provenance.
PROMOTION_KINDS = frozenset({'promote'})
VALID_KINDS = APPROVABLE_KINDS | OBSERVATION_KINDS | PROMOTION_KINDS | REVERT_KINDS

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
        from app.services.capabilities_prompt import _EVOLVING_CREATED_BY

        catalogue = skill_service.catalogue()
        evolving = sum(
            1 for s in catalogue if as_str(s.get('created_by'), '') in _EVOLVING_CREATED_BY
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

        stats = get_stats()
        # Get_stats counts ALL facts rows, but the model's own
        # list_facts / boot index only see active, unexpired, global-scope
        # facts — so introspect advertised "6 facts" while list_facts returned
        # 3. Report the count the model can actually read (raw kept as
        # facts_total for the human door).
        try:
            from app.services.memory_store import _conn

            row = _conn().execute(
                "SELECT COUNT(*) FROM facts WHERE (status IS NULL OR status='active') "
                "AND (expires_at IS NULL OR expires_at='' OR julianday(expires_at) > julianday('now')) "
                "AND (scope IS NULL OR scope='global')"
            ).fetchone()
            stats['facts_total'] = stats.get('facts')
            stats['facts'] = int(row[0]) if row else 0
        except Exception:
            pass
        out['memory_stores'] = stats
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

    # Fail skill-kind proposals at file time so the queue never holds
    # a live weapon — payload.name must pass the same validation the applier
    # (and skill CRUD) enforces.
    if kind in APPROVABLE_KINDS and kind != 'brain_config':
        p_name = as_str((payload or {}).get('name'), '').strip()
        from app.services.skill_service import SkillValidationError, _validateName

        try:
            _validateName(p_name)
        except SkillValidationError as exc:
            raise ValueError(f'invalid payload.name: {exc}') from exc

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


def decide_proposal(
    pid: str,
    decision: str,
    note: str = '',
    *,
    actor: str = 'human',
) -> dict[str, Any]:
    """Approve/reject/dismiss/reopen a proposal. Approval runs the deterministic applier.

    'reopen' is the batch-decision undo path and is deliberately restricted
    to rejected/dismissed rows — those decisions had no side effects, so
    flipping the status back is the whole undo. An applied proposal would
    need its patch reverted, which is a different operation (and refused
    here on purpose).
    """
    decision = decision.strip().lower()
    if decision not in ('approve', 'reject', 'dismiss', 'reopen'):
        raise ValueError("decision must be approve|reject|dismiss|reopen")
    row = get_proposal(pid)
    if row is None:
        raise ValueError(f'proposal {pid} not found')
    if decision == 'reopen':
        if row.get('status') not in ('rejected', 'dismissed'):
            raise ValueError(
                f"proposal {pid} is {row.get('status')} — only rejected/dismissed "
                'rows can be reopened (applied changes need a real revert)'
            )
        row['status'] = 'open'
        row['decidedAt'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
        if note.strip():
            row['decisionNote'] = note.strip()[:1000]
        path = _proposals_dir() / f'{pid}.json'
        path.write_text(json.dumps(row, indent=2, ensure_ascii=False), encoding='utf-8')
        _append_ledger({
            'at': row['decidedAt'],
            'actor': actor,
            'action': 'reopen_proposal',
            'target_key': pid,
            'kind': row.get('kind', ''),
        })
        return {'ok': True, 'decision': 'reopen', 'status': 'open'}
    if row.get('status') != 'open':
        raise ValueError(f"proposal {pid} already {row.get('status')}")

    applied: dict[str, Any] = {}
    if decision == 'approve':
        applied = _apply_approved(row)
        if applied.get('ok') and str(row.get('kind') or '') in APPROVABLE_KINDS | PROMOTION_KINDS:
            # P5 outcome ledger: book the side effect so the scheduled
            # measurement job can answer "did it help?" later. Best-effort —
            # a failed measurement row must never fail a live approval.
            from app.services.harness_outcome import record_proposal_outcome

            record_proposal_outcome({**row, 'applyResult': applied})

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
        'actor': actor,
        'action': f'{decision}_proposal',
        'target_key': pid,
        'kind': row.get('kind', ''),
        'detail': (json.dumps(applied)[:500] if applied else ''),
    })
    return row


def _skill_frontmatter(
    name: str,
    description: str,
    trigger: str,
    origin: str = 'human',
    learnedFrom: list[str] | None = None,
    version: int = 1,
    supersedes: str = '',
    status: str = 'active',
    keywords: list[str] | None = None,
    disabled: bool = False,
) -> str:
    """Learned-skill frontmatter with Part 16 Phase D provenance:
    origin (human|distilled|amended), learned_from (episode ids), version,
    status, and the supersedes lineage stamp.

    ``status``, ``keywords`` and ``disabled`` are carried from the file this
    write replaces: this render REPLACES the whole frontmatter block, so a
    field the caller does not restate is gone. ``keywords`` is the P2#15
    search-keyword list, ``status`` the P2#13 lifecycle label, and ``disabled``
    the enablement flag — all properties of the skill, not of one proposal.
    Dropping the last one resurrects a retired skill."""
    lines = ['---', f'name: {name}', f'description: "{description}"']
    if trigger:
        lines.append(f'trigger: {trigger}')
    lines += [
        'category: learned',
        'created_by: harness-proposal',
        f'origin: {origin}',
        f'learned_from: {",".join(learnedFrom or [])}',
        f'version: {version}',
        f'status: {status or "active"}',
    ]
    # Enablement is a property of the SKILL, not of one proposal, and this
    # render replaces the whole block — omit it and an approved text patch on a
    # disabled/retired skill re-enables it with no signal.
    if disabled:
        lines.append('disabled: true')
    if supersedes:
        lines.append(f'supersedes: {supersedes}')
    rendered_keywords = render_keywords(keywords or [])
    if rendered_keywords:
        lines.append(f'keywords: {rendered_keywords}')
    lines += ['---', '']
    return '\n'.join(lines)


def _parse_frontmatter_from_md(text: str) -> dict[str, str]:
    """Minimal frontmatter reader for version bumps (no quote stripping
    needed — version is a bare integer)."""
    if not text.startswith('---'):
        return {}
    block = text[3:].split('---', 1)[0]
    out: dict[str, str] = {}
    for line in block.split('\n'):
        if ':' in line:
            key, _, val = line.partition(':')
            out[key.strip()] = val.strip()
    return out


def render_keywords(keywords: list[str]) -> str:
    """The frontmatter scalar for a search-keyword list.

    Delegates to ``skill_service`` rather than re-parsing the string here: the
    corpus reader in ``capabilities_prompt`` parses it back with the same
    helper, and a second parser is how a keyword list starts reading as one
    token named "a, b, c".
    """
    from app.services.skill_service import render_keywords as _render

    return _render(keywords)


# ── The applier registry (C4) ────────────────────────────────────────────
# Each handler takes the WHOLE proposal row and returns the result dict the
# decision journal records. They are plain functions, not methods, so a new
# kind is one function plus one dict entry.


def _apply_brain_config(row: dict[str, Any]) -> dict[str, Any]:
    payload = as_dict(row.get('payload'))
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


def _apply_skill_write(row: dict[str, Any]) -> dict[str, Any]:
    """``skill_create`` / ``skill_patch`` — one handler, because the two
    differ only in whether an existing file must be there first."""
    kind = as_str(row.get('kind'), '')
    payload = as_dict(row.get('payload'))
    name = as_str(payload.get('name'), '').strip()
    body = as_str(payload.get('body'), '')
    description = as_str(payload.get('description'), '')
    trigger = as_str(payload.get('trigger'), '')
    supersedes = as_str(payload.get('supersedes'), '').strip()
    origin = as_str(payload.get('origin'), '') or 'human'
    learnedFrom = payload.get('episodeIds') or payload.get('learned_from') or []
    if not name:
        return {'ok': False, 'error': 'skill proposals need payload.name'}
    if kind == 'skill_patch' and not body.strip():
        # A body-less patch would render _ensure_canonical_body's
        # all-placeholder text over the real SKILL.md on approval. Refuse.
        return {'ok': False, 'error': 'skill_patch proposals need payload.body'}
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
        # Part 16 Phase D step 2: learned-skill provenance. version bumps
        # per approved patch; status starts active (stale/retired via
        # later proposals); supersedes stamps the lineage.
        version = 1
        prior: dict[str, str] = {}
        if kind == 'skill_patch' and md.exists():
            # Read the frontmatter this write replaces. The version bump
            # needs it, and so does carrying over the fields the proposal
            # itself is silent about.
            try:
                prior = _parse_frontmatter_from_md(md.read_text('utf-8'))
                version = int(prior.get('version') or 1) + 1
            except Exception:
                version = 2
        # Which skill this one replaced, who wrote it, what it triggers on
        # and which episodes it came from are properties of the SKILL, not
        # of one proposal — a v3 patch that restates none of them must not
        # erase them. (The trigger is what per-turn relevance matching
        # reads, so losing it silently retires the skill from recall.)
        supersedes = supersedes or as_str(prior.get('supersedes'), '').strip()
        trigger = trigger or as_str(prior.get('trigger'), '').strip()
        if not payload.get('origin'):
            origin = as_str(prior.get('origin'), '') or origin
        if not learnedFrom:
            learnedFrom = [
                x.strip()
                for x in as_str(prior.get('learned_from'), '').split(',')
                if x.strip()
            ]
        # A retired skill that gets a new body is back in service — an
        # approved patch is the explicit act of reviving it.
        status = as_str(prior.get('status'), '') or 'active'
        # `disabled` is the one field whose loss is INVISIBLE and functional:
        # setEnabled writes exactly `disabled: true`, supersession retires a v1
        # with it, and _parseSkill keys enablement off it — so a patch that
        # restated nothing would silently put a retired skill back into
        # <capabilities>, <relevant_skills> and the intake line. The render
        # below REPLACES the whole frontmatter block, so carry it explicitly.
        disabled = as_str(prior.get('disabled'), '').strip().lower() in ('true', '1', 'yes')
        try:
            from app.services.skill_service import parse_keywords

            # The drafter's own tags first: a create has no prior file to read,
            # and re-asking a model for keywords the judge already supplied is a
            # second call for a worse answer. Then the file this write replaces.
            keywords = parse_keywords(payload.get('keywords', '')) or parse_keywords(
                prior.get('keywords', '')
            )
        except Exception:
            keywords = []
        if not keywords:
            try:
                from app.services.skill_service import (
                    expand_keywords_best_effort,
                    keyword_expansion_enabled,
                )

                if keyword_expansion_enabled():
                    keywords = expand_keywords_best_effort(
                        name,
                        description or 'Created from an approved harness proposal.',
                        normalized,
                        trigger,
                    )
            except Exception:
                # Keyword expansion is metadata, never a reason to fail an
                # approval a human already granted.
                keywords = []
        frontmatter = _skill_frontmatter(
            name,
            description or 'Created from an approved harness proposal.',
            trigger,
            origin=origin if origin in ('human', 'distilled', 'amended') else 'human',
            learnedFrom=[str(x) for x in learnedFrom] if isinstance(learnedFrom, list) else [],
            version=version,
            supersedes=supersedes,
            status=status,
            keywords=keywords,
            disabled=disabled,
        )
        content = frontmatter + normalized
        # P2#13: preserve the file this write replaces before it lands.
        from app.services.skill_versions import snapshot_before_write

        snapshotTs = snapshot_before_write(
            skill_dir,
            content,
            actor='distiller',
            rationale=f'approved {kind} for {name!r}',
        )
        md.write_text(content, encoding='utf-8')
        # Part 16 Phase D step 2 supersession: an approved v2 disables
        # the v1 it supersedes in the SAME write — no double injection.
        supersededResult = ''
        if supersedes and supersedes != name:
            try:
                from app.services.skill_service import setEnabled

                setEnabled(supersedes, enabled=False)
                supersededResult = f'; disabled {supersedes!r}'
            except Exception as exc:
                supersededResult = f'; failed to disable {supersedes!r}: {exc}'
        try:
            from app.services.skill_service import _bust_prompt_skills_cache

            _bust_prompt_skills_cache()
        except Exception:
            pass
        return {
            'ok': True,
            'action': 'patched' if kind == 'skill_patch' else 'created',
            'name': name,
            'version': version,
            'status': status,
            'superseded': supersededResult,
            # The snapshot this write took. Auto-apply records it so probation can
            # name the exact bytes to put back; '' when there was nothing to
            # snapshot (a create), which is probation's signal to ask a human.
            'snapshotTs': snapshotTs,
        }
    except ValueError as exc:
        return {'ok': False, 'error': str(exc)}
    except Exception as exc:
        return {'ok': False, 'error': str(exc)}


def _apply_skill_delete(row: dict[str, Any]) -> dict[str, Any]:
    payload = as_dict(row.get('payload'))
    name = as_str(payload.get('name'), '').strip()
    if not name:
        return {'ok': False, 'error': 'skill_delete proposals need payload.name'}
    try:
        import shutil

        from app.services.skill_service import _agentSkillsDir, _validateName

        _validateName(name)  # §9 F-2: same guard as create/patch — no traversal past the agent root
        skill_dir = _agentSkillsDir() / name
        # SKILL.md, not the directory, is the skill. A bundled skill that
        # has simply been loaded leaves a usage-only folder in the agent
        # root; rmtree on that "succeeds" a delete of a skill that is still
        # installed, which is the worst kind of green proposal.
        if not (skill_dir / 'SKILL.md').is_file():
            return {'ok': False, 'error': f'skill {name!r} not found in agent skills'}
        shutil.rmtree(skill_dir)
        try:
            from app.services.skill_service import _bust_prompt_skills_cache

            _bust_prompt_skills_cache()
        except Exception:
            pass
        # A retired fingerprint's clock stops here — mark it so
        # the resolution pass never re-suggests what a human retired.
        fp = as_str(payload.get('fingerprint'), '')
        if fp:
            try:
                from app.services.episode_miner import set_fingerprint_status

                set_fingerprint_status(fp, 'retired')
            except Exception:
                pass
        return {'ok': True, 'action': 'deleted', 'name': name}
    except Exception as exc:
        return {'ok': False, 'error': str(exc)}


def _apply_skill_retire(row: dict[str, Any]) -> dict[str, Any]:
    """``retire`` — write ``status: retired``. Non-destructive and reversible.

    Retirement here is a LABEL, never a delete: the SKILL.md, its version
    history and its usage sidecar all stay on disk, and approving a later
    patch sets the status back to ``active``. Reaching this handler already
    required a human to approve the proposal — nothing in the scheduled pass
    can call it, which is why the pass only ever files.
    """
    payload = as_dict(row.get('payload'))
    name = as_str(payload.get('name'), '').strip()
    if not name:
        return {'ok': False, 'error': 'retire proposals need payload.name'}
    try:
        from app.services.skill_service import _agentSkillsDir, _validateName, setStatus

        _validateName(name)
        if not (_agentSkillsDir() / name / 'SKILL.md').is_file():
            return {'ok': False, 'error': f'skill {name!r} not found in agent skills'}
        setStatus(
            name,
            'retired',
            actor='curator',
            rationale=as_str(payload.get('rationale'), '') or f'retire proposal approved for {name!r}',
        )
        return {'ok': True, 'action': 'retired', 'name': name, 'status': 'retired'}
    except Exception as exc:
        return {'ok': False, 'error': str(exc)}


def _apply_promote(row: dict[str, Any]) -> dict[str, Any]:
    # Copy-on-write promotion (global fact or global
    # skill with provenance) — the deterministic applier lives in
    # harness_promote so the enumeration/judge code stays separate.
    from app.services.harness_promote import apply_promotion

    return apply_promotion(as_dict(row.get('payload')))


# The applier registry (C4). One entry per kind a human approval can execute;
# ``_apply_approved`` is the dispatcher and nothing else. Adding a kind is a
# dict entry plus a handler, so a new branch can no longer be buried in the
# middle of a 180-line if-chain where the dispatch order is the only
# documentation.
_APPROVERS: dict[str, Callable[[dict[str, Any]], dict[str, Any]]] = {
    'brain_config': _apply_brain_config,
    'skill_create': _apply_skill_write,
    'skill_patch': _apply_skill_write,
    'skill_delete': _apply_skill_delete,
    'retire': _apply_skill_retire,
    'promote': _apply_promote,
}


def review_proposal(
    pid: str,
    verdict: object,
    *,
    reviewer_client: object | None = None,
    reviewer_model: str = '',
    note: str = '',
) -> dict[str, Any]:
    """The independent reviewer's ONE action: decide, never edit.

    ``verdict`` is what the model answered. Only two answers act — ``KEEP``
    approves, ``DISCARD`` rejects — and both go through :func:`decide_proposal`,
    which is the only path from a proposal to a live change (``_APPROVERS``
    lives under it and is unreachable from here). The reviewer therefore cannot
    do anything a human could not do from the inbox.

    Everything else fails CLOSED and leaves the proposal sitting in the inbox:

    * no independent reviewer (``reviewer_client`` is None — same model, no
      provider, unreachable, timeout). A verdict that arrived without a reviewer
      behind it is not evidence.
    * an empty, unrecognised or non-string answer. "Maybe" is not a rejection;
      guessing which side it leaned would let a broken model approve work.
    * the reviewer failing or throwing while deciding.

    Fail-closed here is the whole safety argument: an unusable reviewer can
    slow autonomy down, never push it forward.
    """
    row = get_proposal(pid)
    if row is None:
        raise ValueError(f'proposal {pid} not found')

    if reviewer_client is None:
        return {
            'ok': False,
            'decision': None,
            'leftInInbox': True,
            'reason': (
                'no independent reviewer — same-model judging is inert and an '
                'unreachable reviewer is not evidence; left in the inbox'
            ),
        }

    text = str(verdict or '').strip().upper()
    if text not in ('KEEP', 'DISCARD'):
        return {
            'ok': False,
            'decision': None,
            'leftInInbox': True,
            'reason': (
                f'reviewer answer {str(verdict)[:80]!r} is not KEEP or DISCARD — '
                'left in the inbox rather than guessed at'
            ),
        }

    decision = 'approve' if text == 'KEEP' else 'reject'

    if decision == 'approve':
        # A KEEP is necessary, never sufficient: item 14's rails sit ON this
        # path, so a reviewer cannot reach a write that a human would be
        # refused. Reading the answer and ignoring it is not available to a
        # caller — there is no other route from a verdict to decide_proposal.
        from app.services.harness_rails import (
            rail_trace,
            record_shadow_decision,
            shadow_enabled,
        )

        # The trace is computed once and used for both the log and the decision,
        # so a shadow record can never describe a different ordering than the
        # one that decided the real answer.
        trace = rail_trace(row)
        held = next(
            (t for t in trace if not t['passed']),
            None,
        )
        if shadow_enabled():
            record_shadow_decision(row, text, trace)
        if held is not None:
            return {
                'ok': False,
                'decision': None,
                'leftInInbox': True,
                'reason': f'reviewer said {text}, held by the rails: {held.get("reason")}',
                'rule': str(held.get('rule') or ''),
            }
        if shadow_enabled():
            # Checked after the rails, so this means "every rail allowed it"
            # rather than "a write happened". Nothing is decided, so nothing is
            # spent: the daily budget and the probation record stay untouched.
            return {
                'ok': False,
                'decision': None,
                'leftInInbox': True,
                'wouldApply': True,
                'rule': 'shadow-mode',
                'reason': f'reviewer said {text} and every rail allowed it; '
                          'shadow mode is on, so nothing was written',
            }

    try:
        result = decide_proposal(
            pid,
            decision,
            note.strip() or (f'reviewed by {reviewer_model}' if reviewer_model else 'reviewed'),
            actor='reviewer',
        )
    except Exception as exc:
        return {
            'ok': False,
            'decision': None,
            'leftInInbox': True,
            'reason': f'decision could not be recorded: {type(exc).__name__}: {exc}',
        }
    # `decide_proposal` answers with the proposal row, which carries `status`
    # and no `ok` — so "the decision landed" is read off the status. The field
    # used to be `bool(result.get('ok'))`, which is False for every decision
    # this function ever made; the contract is pinned now by
    # test_review_proposal_path.test_a_keep_verdict_reports_that_the_write_landed.
    status = str(result.get('status') or '')
    applied = decision == 'approve' and status == 'applied'
    if applied:
        # Only an AUTOMATIC apply spends the daily budget or starts probation.
        # A human approving in the inbox is not what the rails ration, so it is
        # deliberately not recorded here.
        from app.services.harness_rails import finding_key, record_auto_apply

        versionTs = str(as_dict(result.get('applyResult')).get('snapshotTs') or '')
        skillName = str(as_dict(row.get('payload')).get('name') or '')
        record_auto_apply(
            pid,
            skillName,
            versionTs,
            finding_key(row),
            str(as_dict(result.get('applyResult')).get('action') or ''),
        )
        # Item 15's chip. The event names the version to put back, so the
        # announcement can offer a real undo rather than only a sentence, and it
        # carries `queryKeys` so the realtime bridge's existing forward-compatible
        # default case refreshes the history read — a change made by the 6-hour
        # job then reaches a window that was already open.
        from app.services.realtime_bus import emit_realtime

        emit_realtime(
            'skill-evolved',
            skill=skillName,
            proposalId=pid,
            versionTs=versionTs,
            queryKeys=['harness-auto-history'],
        )

    return {
        'ok': status in ('applied', 'rejected'),
        'decision': decision,
        'leftInInbox': False,
        'reason': f'reviewer said {text}',
        'applied': applied,
        'status': status,
        'result': result,
    }

REVIEW_SYSTEM = (
    'You review a proposed change to this agent\'s own skills. Reply on ONE line '
    'starting with exactly KEEP or DISCARD, then a short reason. KEEP only if the '
    'change is justified by the evidence given, durable rather than a one-off, '
    'non-redundant, and likely to improve future turns. If you are unsure, DISCARD. '
    'You cannot propose changes yourself.'
)


def review_summary(row: dict[str, Any]) -> str:
    """The one line the inbox shows beside a proposal.

    Empty when the proposal was never reviewed, so the UI can omit the row
    entirely rather than render an empty line.
    """
    review = row.get('review')
    if not isinstance(review, dict) or not review:
        return ''
    verdict = as_str(review.get('verdict'), 'unavailable')
    reason = as_str(review.get('reason'), '').strip()
    if verdict == 'unavailable':
        return f'Reviewer unavailable — {reason}'.rstrip(' —')
    return f'Reviewer: {verdict.lower()}' + (f' — {reason}' if reason else '')


def _write_review(row: dict[str, Any], review: dict[str, Any]) -> None:
    row['review'] = review
    row['reviewedAt'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
    path = _proposals_dir() / f"{as_str(row.get('id'), '')}.json"
    try:
        path.write_text(json.dumps(row, indent=2, ensure_ascii=False), encoding='utf-8')
    except Exception:
        # This module logs via logging.getLogger(__name__) at call sites; there is
        # no module-level logger to reach for.
        import logging

        logging.getLogger(__name__).debug('proposal review write failed', exc_info=True)


def _ask_reviewer_blocking(
    client: Any, row: dict[str, Any], producer_model: str
) -> tuple[str, str]:
    """One reviewer call, from either loop shape.

    Mirrors ``skill_distiller._run_batch`` for the reason that file already
    documents: a bare ``asyncio.run`` RAISES inside a running loop, and the only
    outcome this call can report is a verdict or an 'unavailable' stamped on the
    proposal. So an in-loop caller — a route that awaited the job body without
    the scheduler's thread hop — would stamp EVERY open proposal 'Reviewer
    unavailable' for a cause that has nothing to do with the reviewer, which is
    the thirteen-invisible-judge-failures mistake all over again. Off-loop
    callers get a worker thread owning a fresh loop.

    The scheduled path is unaffected: ``learning_scheduler.run_job_async``
    already runs the job body in a thread, where there is no running loop.
    """
    import asyncio

    timeout_s = 60

    async def go() -> tuple[str, str]:
        return await asyncio.wait_for(
            _ask_reviewer(client, row, producer_model), timeout=timeout_s
        )

    try:
        asyncio.get_running_loop()
    except RuntimeError:
        pass
    else:
        return _ask_reviewer_off_loop(go, timeout_s)

    try:
        return asyncio.run(go())
    except asyncio.TimeoutError:
        return 'unavailable', f'timeout: reviewer did not answer within {timeout_s}s'
    except Exception as exc:
        return 'unavailable', f'{type(exc).__name__}: {str(exc)[:150]}'


def _ask_reviewer_off_loop(go: Any, timeout_s: int) -> tuple[str, str]:
    """Run one reviewer call on a worker thread with a loop of its own."""
    import asyncio
    import threading

    box: dict[str, Any] = {}

    def worker() -> None:
        try:
            box['result'] = asyncio.run(go())
        except asyncio.TimeoutError:
            box['result'] = ('unavailable', f'timeout: reviewer did not answer within {timeout_s}s')
        except Exception as exc:
            box['result'] = ('unavailable', f'{type(exc).__name__}: {str(exc)[:150]}')

    thread = threading.Thread(target=worker, daemon=True, name='august-reviewer-call')
    thread.start()
    thread.join(timeout_s + 15)
    if thread.is_alive():
        # Still holding a socket on its own loop. Naming that beats silence.
        return 'unavailable', 'reviewer worker outlived its grace window'
    result = box.get('result')
    if isinstance(result, tuple) and len(result) == 2:
        return str(result[0]), str(result[1])
    return 'unavailable', 'reviewer call returned no verdict'


# What may be trimmed off a verdict line: ASCII hyphen, EN dash and EM dash
# spelled as escapes. A literal list containing only the en dash is what made
# a model's `KEEP — reason` arrive as `— reason`, so the inbox line read
# `Reviewer: keep — — reason`. Same class as the correction detector's
# apostrophe bug (item 4): the punctuation a phone or a model emits is not the
# punctuation a source file happens to contain.
_VERDICT_PUNCT = ' -–—:.'


async def _ask_reviewer(
    client: Any, row: dict[str, Any], producer_model: str
) -> tuple[str, str]:
    """One advisory verdict for one proposal. Returns (verdict, reason).

    The reviewer is given the proposal and its evidence and nothing else — in
    particular not the proposer's reasoning, so it cannot rubber-stamp an
    argument it has already been handed.
    """
    prompt = [
        {'role': 'system', 'content': REVIEW_SYSTEM},
        {
            'role': 'user',
            'content': (
                f'Problem:\n{as_str(row.get("problem"))[:1000]}\n\n'
                f'Evidence:\n{as_str(row.get("evidence"))[:2000]}\n\n'
                f'Proposed change:\n{as_str(row.get("proposal"))[:1000]}\n\n'
                f'Rollback:\n{as_str(row.get("rollback"))[:400]}\n\n'
                f'Produced by model: {producer_model or "unknown"}\n\n'
                'Keep this change?'
            ),
        },
    ]
    raw = await client(prompt)
    text = str(raw or '').strip()
    head = text.splitlines()[0].strip() if text else ''
    upper = head.upper()
    # The verdict must be UNAMBIGUOUS: exactly one of the two words on the line,
    # and it must lead. "KEEP DISCARD" is a model that could not decide, and
    # reading it as KEEP is the one mistake this whole gate exists to prevent —
    # so ambiguity fails closed rather than resolving to the permissive reading.
    words = {w for w in upper.split() if w.strip(_VERDICT_PUNCT) in ('KEEP', 'DISCARD')}
    first = upper.split()[0].strip(_VERDICT_PUNCT) if upper.split() else ''
    if len(words) == 1 and first in ('KEEP', 'DISCARD'):
        reason = head[len(first) :].strip(_VERDICT_PUNCT) or text[len(head) :].strip()[:200]
        return first, reason[:200]
    return 'unavailable', f'answer was not an unambiguous KEEP or DISCARD: {head[:80]!r}'


def run_reviewer_pass(limit: int = 5, dry_run: bool = False) -> dict[str, Any]:
    """Run the independent reviewer over open skill proposals.

    With autonomy off — the shipped state — this records a one-line verdict on
    each proposal and never calls :func:`decide_proposal`; every proposal stays
    open for the human. With `skillAutonomy` on, a usable verdict is handed to
    :func:`review_proposal`, which is where item 14's rails stand, so a KEEP
    becomes a write only for a proposal a human would also have been allowed to
    auto-apply. `applied` counts those writes; `held` counts verdicts the rails
    kept in the inbox.

    Every unusable reviewer is recorded as 'unavailable' with its cause, because
    a silent skip is how thirteen judge failures hid for a month. An
    'unavailable' row is retried by the next pass — the gate refused before any
    call was made, so the retry is free and a real verdict must be able to
    replace it. A KEEP/DISCARD row is terminal.
    """
    reviewed = 0
    unavailable = 0
    applied = 0
    held = 0
    would_apply = 0
    from app.services.harness_rails import autonomy_enabled

    autonomyOn = autonomy_enabled()
    for row in list_proposals(status='open'):
        if reviewed >= max(1, int(limit)):
            break
        kind = as_str(row.get('kind'), '')
        if kind not in ('skill_create', 'skill_patch'):
            continue  # observations and reverts are human-only by design
        if isinstance(row.get('review'), dict) and row['review']:
            if as_str(row['review'].get('verdict'), '') == 'unavailable':
                pass  # a refusal is not a verdict — retry once a reviewer exists
            else:
                continue  # already reviewed — never burn a second call
        producer_model = as_str(as_dict(row.get('payload')).get('producedBy'), '')
        client, refusal = resolve_independent_reviewer(producer_model, _reviewModelHint())
        if client is None:
            _write_review(
                row,
                {
                    'verdict': 'unavailable',
                    'reason': refusal or 'no independent reviewer',
                    'model': '',
                    'advisory': True,
                },
            )
            unavailable += 1
            reviewed += 1
            if dry_run:
                continue
            continue
        if dry_run:
            reviewed += 1
            continue
        verdict, reason = _ask_reviewer_blocking(client, row, producer_model)
        review = {
            'verdict': verdict,
            'reason': reason,
            'model': _reviewModelHint(),
            'advisory': True,
        }
        # The switch is read here, not left to the rails, so that autonomy OFF
        # means the pass NEVER calls decide_proposal — its shipped advisory
        # contract. With it ON, the verdict goes through review_proposal, which
        # is where the rails stand for every other caller too.
        if not dry_run and verdict in ('KEEP', 'DISCARD') and autonomyOn:
            acted = review_proposal(
                str(as_str(row.get('id'), '')),
                verdict,
                reviewer_client=client,
                reviewer_model=as_str(review.get('model'), ''),
                note=reason,
            )
            # decide_proposal rewrote this file; re-read it before adding the
            # review line or the stale in-memory row would undo the decision.
            row = get_proposal(str(as_str(row.get('id'), ''))) or row
            review['advisory'] = not acted.get('applied')
            if acted.get('applied'):
                applied += 1
            elif acted.get('wouldApply'):
                # Shadow mode: the decision is real, the write is not. Recorded
                # so a human can read what autonomy would have done before
                # arming it, rather than inferring it from an empty inbox.
                would_apply += 1
                review['wouldApply'] = True
            elif acted.get('leftInInbox'):
                held += 1
                review['heldBy'] = str(acted.get('rule') or '')
        _write_review(row, review)
        reviewed += 1
    return {
        'reviewed': reviewed,
        'unavailable': unavailable,
        'applied': applied,
        'held': held,
        'wouldApply': would_apply,
    }


def _reviewModelHint() -> str:
    """The configured reviewer model, if any — the hint for the gate."""
    try:
        from app.services.brain_config_service import getRuntimeConfig

        return as_str(getRuntimeConfig().get('skillLearningJudgeModel', ''), '').strip()
    except Exception:
        return ''


def _apply_approved(row: dict[str, Any]) -> dict[str, Any]:
    """Deterministic applier — the ONLY path from proposal to live change.

    A pure dispatcher over :data:`_APPROVERS`. A kind with no handler is not
    an error to swallow: the observation/revert kinds are registered as
    valid on purpose and are human-only by design, and an unregistered kind
    is a caller bug worth naming.
    """
    kind = as_str(row.get('kind'), '')
    handler = _APPROVERS.get(kind)
    if handler is None:
        if kind in OBSERVATION_KINDS | REVERT_KINDS:
            return {
                'ok': False,
                'error': f'kind {kind!r} is human-only — nothing applies automatically',
            }
        return {
            'ok': False,
            'error': (
                f'kind {kind!r} has no applier; known appliable kinds are '
                f'{sorted(_APPROVERS)}'
            ),
        }
    return handler(row)


# ── Scheduled introspection ───────────────────────────────────────────────
# P2: the 6h poller is gone — the cadence lives in learning_scheduler
# (config key `introspectionIntervalHours`), and the job body is the pair
# of pass functions below.


async def scheduled_introspection_loop() -> None:
    """DEPRECATED shim (P2): the introspection cadence is one job in
    ``learning_scheduler`` now; the scheduler is the only starter. Kept so
    external imports keep resolving for one release — running it just runs
    the unified loop.

    The pass body lives in ``_run_scheduled_pass`` /
    ``_run_scheduled_promotion_pass`` (file observations + promote
    proposals, never apply).
    """
    import logging

    logging.getLogger(__name__).warning(
        'scheduled_introspection_loop is deprecated — learning_scheduler owns the cadence'
    )
    from app.services.learning_scheduler import scheduler_loop

    await scheduler_loop()


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


def _run_scheduled_promotion_pass() -> int:
    """Promotion judge on the same scheduled cadence.

    Returns the number of ``promote`` proposals filed (0 when skillLearning
    is off or nothing recurs across ≥2 projects). Never applies anything.
    """
    try:
        from app.services.harness_promote import run_promotion_pass

        summary = run_promotion_pass()
        return int(summary.get('proposalsFiled') or 0)
    except Exception:
        return 0
