"""Harness self-inspection + proposal tools.

Registered into the tool registry so the MODEL can call them:
  * harness_introspect — read-only aggregation of harness state
  * harness_propose    — files a structured improvement proposal (never applied)

A skill create/patch is applied by the independent reviewer through the rails in
`harness_rails` (autonomy is on by default); every other kind — settings, deletes,
retirements, promotions — waits behind the human decide endpoint.
"""

from __future__ import annotations

import logging
from typing import Any

from app.json_narrowing import as_dict, as_str
from app.services import tool_registry

logger = logging.getLogger(__name__)


def _review_after_filing(future: Any) -> None:
    """Name a detached reviewer failure; never let it vanish silently."""
    exc = future.exception()
    if exc is not None:
        logger.debug('auto-review after harness_propose failed: %s', exc)


async def _introspect() -> str:
    from app.services.harness_self_improve import build_introspection, format_introspection

    return format_introspection(build_introspection())


async def _propose(**kwargs: object) -> str:
    from app.services.harness_self_improve import save_proposal
    from app.services.workbench.context import currentSessionId

    payload = kwargs.get('payload')
    try:
        row = save_proposal(
            problem=as_str(kwargs.get('problem'), ''),
            evidence=as_str(kwargs.get('evidence'), ''),
            proposal=as_str(kwargs.get('proposal'), ''),
            rollback=as_str(kwargs.get('rollback'), ''),
            kind=as_str(kwargs.get('kind'), 'observation'),
            expected_metric=as_str(kwargs.get('expectedMetric'), ''),
            payload=as_dict(payload) if isinstance(payload, dict) else None,
            session_id=currentSessionId.get(),
        )
    except ValueError as exc:
        return f'Error: {exc}'
    except Exception as exc:  # noqa: BLE001
        return f'Error: filing proposal failed: {exc}'
    # A skill write the user just asked for must not wait for the reviewer tick.
    # Detached on purpose: the turn answers now, and the same rails — not this
    # tool — decide whether it lands.
    if as_str(row.get('kind'), '') in ('skill_create', 'skill_patch'):
        try:
            import asyncio

            from app.services.harness_rails import autonomy_enabled
            from app.services.harness_self_improve import run_reviewer_pass

            if autonomy_enabled():
                future = asyncio.get_running_loop().run_in_executor(None, run_reviewer_pass)
                future.add_done_callback(_review_after_filing)
        except Exception as exc:  # noqa: BLE001 — the proposal is already filed
            logger.debug('auto-review scheduling failed: %s', exc)
    return (
        f"Proposal {row['id']} filed (kind={row['kind']}, status=open). "
        'Low-risk skill creates/patches are applied automatically after an '
        'independent review and the safety rails; destructive or config changes '
        'wait for the user.'
    )


def register() -> None:
    tool_registry.register(
        'harness_introspect',
        "Inspect your own agent harness: registered tool surface health, skill "
        'catalogue stats, turn-loop flow map (round budgets, phases, modes), '
        'memory-store sizes, active config knobs, recent harness changes, and '
        'open improvement proposals. Read-only.',
        _introspect,
        {'type': 'object', 'properties': {}},
        keywords=['harness', 'introspection', 'self-improvement'],
    )
    tool_registry.register(
        'harness_propose',
        'File a harness-improvement proposal. Args: problem, evidence, proposal, '
        'rollback, kind (brain_config|skill_create|skill_patch|skill_delete|tool_bucket|tool_description|'
        'flow_map|observation|promote), expectedMetric?, payload?. Low-risk skill creates/patches are '
        'applied automatically after an independent review and the safety rails; destructive or config '
        'changes wait for the user. You apply nothing — a deterministic applier runs after review. '
        '(promote proposals are judge-filed by the scheduled cross-project pass; a model-filed promote '
        'payload is still held for the user before anything applies.)',
        _propose,
        {
            'type': 'object',
            'properties': {
                'problem': {'type': 'string', 'description': 'What is wrong, concretely.'},
                'evidence': {'type': 'string', 'description': 'Observations that prove it (counts, names, traces).'},
                'proposal': {'type': 'string', 'description': 'The exact change to make.'},
                'rollback': {'type': 'string', 'description': 'How to undo it.'},
                'kind': {'type': 'string', 'description': 'One of the listed proposal kinds.'},
                'expectedMetric': {'type': 'string', 'description': 'Which eval/metric should improve.'},
                'payload': {
                    'type': 'object',
                    'description': 'Machine-readable payload. brain_config needs {"patch": {...}}; skill kinds need name/body/description.',
                },
            },
            'required': ['problem', 'evidence', 'proposal', 'rollback', 'kind'],
        },
        keywords=['harness', 'proposal', 'self-improvement'],
    )
