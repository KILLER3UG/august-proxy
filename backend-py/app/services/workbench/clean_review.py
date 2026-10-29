"""The clean-context review runner shared by review_change and review_step.

It owns the three-input contract (requirement, diff, real evidence), the
read-only reviewer launch, and parsing of the structured verdict. It never
edits files and never applies findings; the caller owns the decision.
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any

from app.json_narrowing import as_str

if TYPE_CHECKING:
    from app.services.workbench.sessions import WorkbenchSession

_MAX_INPUT_CHARS = 60_000

REVIEW_SCHEMA: dict[str, object] = {
    'type': 'object',
    'properties': {
        'verdict': {'type': 'string', 'enum': ['approve', 'request_changes']},
        'summary': {'type': 'string'},
        'findings': {
            'type': 'array',
            'items': {
                'type': 'object',
                'properties': {
                    'path': {'type': 'string'},
                    'line': {'type': 'integer'},
                    'severity': {
                        'type': 'string',
                        'enum': ['blocker', 'important', 'nit'],
                    },
                    'problem': {'type': 'string'},
                    'reason': {'type': 'string'},
                },
                'required': ['severity', 'problem', 'reason'],
            },
        },
    },
    'required': ['verdict', 'summary', 'findings'],
}


def _cap(text: str) -> str:
    value = text.strip()
    if len(value) <= _MAX_INPUT_CHARS:
        return value
    return value[:_MAX_INPUT_CHARS] + '\n[truncated — open the files for the rest]'


async def run_clean_review(
    session: 'WorkbenchSession',
    *,
    requirement: str,
    diff: str,
    test_evidence: str,
    focus: str = '',
) -> dict[str, Any]:
    from app.services.runtime_services import get_orchestrator
    from app.services.tools.spawn_subagents_tool import executeSpawnSubagents

    context = (
        f'Requirement:\n{_cap(requirement)}\n\n'
        f'Diff:\n```diff\n{_cap(diff)}\n```\n\n'
        f'Test/build evidence (the real commands and output, not a claim):\n'
        f'{_cap(test_evidence)}'
    )
    if focus.strip():
        context += f'\n\nFocus the review on:\n{_cap(focus)}'
    result = await executeSpawnSubagents(
        get_orchestrator(),
        session,
        [
            {
                'goal': (
                    'Independently review this change from a clean context. Follow the '
                    'independent-review procedure. Verify every finding against the real '
                    'code before filing it; do not edit files or run mutating commands. '
                    'Return the structured verdict.'
                ),
                'context': context,
                'skills': ['independent-review'],
                'capability': 'read_only',
                'effort': 'high',
                'yieldSchema': REVIEW_SCHEMA,
            }
        ],
        mode='auto',
        background=False,
    )
    verdict: dict[str, object] = {}
    for item in result.get('results') or []:
        if not isinstance(item, dict):
            continue
        raw = item.get('result')
        candidate = raw if isinstance(raw, dict) else None
        if candidate is None and isinstance(raw, str) and raw.strip():
            try:
                from app.services.workbench.json_salvage import salvage_json_object

                parsed = salvage_json_object(raw)
                candidate = parsed if isinstance(parsed, dict) else json.loads(raw)
            except Exception:  # noqa: BLE001 -- unparseable verdict is a failed review, not a crash
                candidate = None
        if isinstance(candidate, dict) and as_str(candidate.get('verdict')):
            verdict = candidate
            break
    return {'raw': result, 'verdict': verdict}
