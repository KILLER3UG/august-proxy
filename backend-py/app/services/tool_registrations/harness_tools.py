"""Harness self-inspection + proposal tools.

Registered into the tool registry so the MODEL can call them:
  * harness_introspect — read-only aggregation of harness state
  * harness_propose    — files a structured improvement proposal (never applied)

The applier runs only behind the human decide endpoint (routers/harness.py).
"""

from __future__ import annotations

from app.json_narrowing import as_dict, as_str
from app.services import tool_registry


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
    return (
        f"Proposal {row['id']} filed (kind={row['kind']}, status=open). "
        'A human approves or rejects it — nothing is applied automatically.'
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
        'File a harness-improvement proposal for human review. Args: problem, evidence, proposal, '
        'rollback, kind (brain_config|skill_create|skill_patch|skill_delete|tool_bucket|tool_description|'
        'flow_map|observation|promote), expectedMetric?, payload?. You apply nothing — approval runs a '
        'deterministic applier. (promote proposals are judge-filed by the scheduled cross-project pass; '
        'a model-filed promote payload is still human-gated before anything applies.)',
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
