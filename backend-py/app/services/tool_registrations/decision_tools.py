"""`record_decision` — the counterfactual half of the decision ledger.

The mechanical writer in ``turn_close`` records what the loop did; it cannot
record what the loop *considered*. That is the part a trading journal is for:
the thesis, the alternatives that were rejected, and the confidence, so that
"was this a good call?" can be answered later against the decision's own stated
observable instead of against a model's opinion of itself.

One tool with a small, checkable contract:

* ``observable`` must be one the resolver can actually verify
  (:data:`app.services.decision_ledger.OBSERVABLES`). Anything else is accepted
  and labelled ``unscorable`` later — the row is still worth keeping, but it is
  never counted as verified.
* ``alternatives`` is capped and truncated: this is a ledger, not a transcript,
  and a tool result that dumps a thousand tokens of deliberation into the
  context is a worse trade than a shorter list.

Registered but NOT in ``HARNESS_CORE_TOOLS``: progressive disclosure can defer
it, so it costs no prompt tokens on a large tool surface.
"""

from __future__ import annotations

from app.json_narrowing import as_float, as_int, as_str
from app.services import decision_ledger, tool_registry

_MAX_ALTERNATIVES = 5
_MAX_ACTION_CHARS = 120
_MAX_WHY_CHARS = 160
_MAX_TEXT_CHARS = 400


def _current_session_id() -> str:
    """Best-effort; a row with no session is still a usable ledger row."""
    try:
        from app.services.workbench.context import currentSessionId

        return as_str(currentSessionId.get(), '')
    except Exception:  # noqa: BLE001
        return ''


def _clean_alternatives(raw: object) -> list[dict[str, object]]:
    if not isinstance(raw, list):
        return []
    out: list[dict[str, object]] = []
    for item in raw[:_MAX_ALTERNATIVES]:
        if isinstance(item, str):
            action, why = item, ''
        elif isinstance(item, dict):
            action = as_str(item.get('action') or item.get('name'), '')
            why = as_str(item.get('why_rejected') or item.get('why') or item.get('reason'), '')
        else:
            continue
        action = action.strip()[:_MAX_ACTION_CHARS]
        if not action:
            continue
        out.append({'action': action, 'why_rejected': why.strip()[:_MAX_WHY_CHARS]})
    return out


async def _record_decision(
    kind: str = 'answer',
    chosen: str = '',
    alternatives: list[object] | None = None,
    thesis: str = '',
    observable: str = '',
    confidence: float | None = None,
    horizon_turns: int | None = None,
) -> str:
    sessionId = _current_session_id()
    cleaned = _clean_alternatives(alternatives)
    result = decision_ledger.record_decision(
        session_id=sessionId,
        turn_id=None,
        kind=kind,
        chosen=as_str(chosen, ''),
        alternatives=cleaned,
        thesis=as_str(thesis, '')[:_MAX_TEXT_CHARS],
        observable=as_str(observable, ''),
        confidence=as_float(confidence, -1.0) if confidence is not None else None,
        horizon_turns=as_int(horizon_turns, 1) if horizon_turns is not None else None,
    )
    if not result.get('ok'):
        return f'Error: {result.get("error", "could not record the decision")}'
    bits = [f'Decision #{result.get("id")} recorded ({result.get("kind")})']
    conf = as_float(confidence, -1.0)
    if 0 <= conf <= 1:
        bits.append(f'confidence {conf:.2f}')
    if cleaned:
        bits.append(f'{len(cleaned)} alternative(s) kept')
    if as_str(observable, ''):
        bits.append(f'observable {as_str(observable, "")}')
    return '. '.join(bits) + '. The daily journal pass settles it; you do not need to follow up.'


def register() -> None:
    tool_registry.register(
        'record_decision',
        (
            'Log a decision you are about to commit to, with the alternatives you rejected, '
            'your confidence, and an observable that would prove it wrong. Use it when the '
            'choice is consequential and could go either way (an approach, a plan, a tool '
            'route, a refusal) — not for routine steps. observable: turn:finished | turn:ok | '
            'turn:no-error. A later pass scores it against what actually happened.'
        ),
        _record_decision,
        {
            'type': 'object',
            'properties': {
                'kind': {
                    'type': 'string',
                    'enum': [
                        'plan',
                        'tool_choice',
                        'answer',
                        'routing',
                        'memory',
                        'skill',
                        'refusal',
                    ],
                },
                'chosen': {'type': 'string', 'description': 'The action you are taking.'},
                'alternatives': {
                    'type': 'array',
                    'items': {
                        'type': 'object',
                        'properties': {
                            'action': {'type': 'string'},
                            'why_rejected': {'type': 'string'},
                        },
                        'required': ['action'],
                    },
                },
                'thesis': {'type': 'string', 'description': 'What you expect to be true.'},
                'observable': {
                    'type': 'string',
                    'enum': ['turn:finished', 'turn:ok', 'turn:no-error'],
                },
                'confidence': {'type': 'number', 'minimum': 0, 'maximum': 1},
                'horizon_turns': {'type': 'integer', 'minimum': 1, 'maximum': 14},
            },
            'required': ['chosen'],
        },
        keywords=['decision', 'journal', 'trade', 'thesis', 'confidence', 'alternatives'],
    )
