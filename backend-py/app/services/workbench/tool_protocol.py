"""P0 tool-protocol hardening — the single normalization choke point.

Every tool result that enters model history passes through
:func:`normalize_tool_result`, and every tool-call round is closed by
:func:`reconcile_tool_results`. The two together are the *only* place the
workbench decides what a ``tool_result`` looks like, so the invariants hold
on every exit path instead of being re-derived at each of the ~15 call
sites that used to build one by hand:

* exactly one result per tool-call id, in the order the model asked;
* never zero (a dangling ``tool_use`` is a NON-retryable 400 on Anthropic
  and is silently mangled by OpenAI-compatible gateways — it bricks the
  next turn);
* never two (a duplicate result for one id breaks strict validators);
* never an orphan (a result whose id no ``tool_use`` claims);
* always a non-empty ``content`` string (Anthropic rejects a null or
  non-string ``tool_result.content``);
* never an empty id (``tool_use_id: ''`` is the same 400 as a missing one).

A synthetic result is honest about being synthetic: it says the call was
not executed and tells the model what to do next, so the loop can self-heal
instead of dead-ending.
"""

from __future__ import annotations

import json
import uuid
from collections.abc import Mapping, Sequence
from typing import Any

from app.json_narrowing import as_list, as_str

__all__ = [
    'SYNTHETIC_TOOL_RESULT_PREFIX',
    'ToolResultReconciliation',
    'canonical_tool_calls',
    'normalize_tool_result',
    'reconcile_tool_results',
    'synthetic_tool_result',
]

# Prefix for a result the harness invented rather than a tool returning one.
# Model-visible on purpose — the loop's whole self-heal story depends on the
# model recognising "this never ran" and issuing a fresh, smaller call.
SYNTHETIC_TOOL_RESULT_PREFIX = '[Tool result missing]'

# Cap on a non-string payload dumped into history. A tool returning a huge
# dict must not turn a missing-result receipt into a context bomb; the
# ordinary per-model result cap still applies downstream to real results.
_SYNTHETIC_DUMP_CHARS = 4000


def _dump(value: object) -> str:
    """Render an arbitrary tool payload as bounded model-visible text."""
    if isinstance(value, str):
        return value
    if value is None:
        return ''
    if isinstance(value, (list, tuple)):
        parts = []
        for item in value:
            if isinstance(item, dict) and item.get('type') == 'text':
                parts.append(as_str(item.get('text'), ''))
            else:
                parts.append(_dump(item))
        joined = '\n'.join(p for p in parts if p)
        if joined:
            return joined
    try:
        return json.dumps(value, default=str)
    except Exception:
        return repr(value)


def synthetic_tool_result(
    tool_use_id: str,
    tool_name: str = 'tool',
    reason: str = '',
) -> dict[str, object]:
    """A well-formed placeholder result for a call that produced none.

    The wording matters: the model must be able to tell "the harness never
    ran this" apart from "the tool ran and reported an error", because the
    correct recovery differs (re-issue the call vs. fix the arguments).
    """
    label = tool_name or 'tool'
    text = (
        f"{SYNTHETIC_TOOL_RESULT_PREFIX} '{label}' did not return a result. "
        'This call was NOT executed and its outcome is unknown — re-issue it '
        'once with valid arguments, and do NOT assume any earlier attempt ran.'
    )
    if reason:
        text += f' ({reason})'
    return {
        'role': 'tool',
        'tool_use_id': tool_use_id,
        'tool_call_id': tool_use_id,
        'content': text,
        'is_error': True,
        'synthetic': True,
    }


def normalize_tool_result(
    raw: object,
    *,
    tool_use_id: str = '',
    tool_name: str = 'tool',
) -> dict[str, object]:
    """Coerce one collected result into a well-formed ``tool`` message.

    This is the choke point. Callers hand it whatever a tool path produced —
    a bare string, a dict from the parallel stage, ``None`` from a tool that
    returned nothing, an object with a list-of-blocks content — and get back
    a message that is safe to append to model history on every wire format.
    """
    msg: Mapping[str, Any] = raw if isinstance(raw, Mapping) else {}
    callId = as_str(msg.get('tool_use_id'), '') or as_str(msg.get('tool_call_id'), '') or tool_use_id
    if not callId:
        # A result with no identity cannot be matched to its call; mint one
        # so the block is at least addressable rather than silently dropped.
        callId = f'toolu_{uuid.uuid4().hex[:16]}'
    content = msg.get('content') if 'content' in msg else (None if isinstance(raw, Mapping) else raw)
    fabricated = False
    if isinstance(content, str) and content.strip():
        text = content
    else:
        # Empty / null / non-text content still owes the model a receipt —
        # an empty tool_result.content is rejected upstream, and a raw dict
        # or block list is not valid content on either wire format.
        dumped = _dump(content) if not isinstance(content, str) else ''
        fabricated = not dumped.strip()
        text = as_str(synthetic_tool_result(callId, tool_name)['content'], '') if fabricated else dumped
        if len(text) > _SYNTHETIC_DUMP_CHARS:
            text = text[:_SYNTHETIC_DUMP_CHARS] + '\n[... non-text tool payload truncated ...]'
    out: dict[str, object] = {
        'role': 'tool',
        'tool_use_id': callId,
        # OpenAI-shaped consumers read `tool_call_id`; carrying both keeps a
        # mixed-format history readable without a second translation pass.
        'tool_call_id': callId,
        'content': text,
    }
    for flag in ('is_error', 'synthetic'):
        if flag in msg:
            out[flag] = msg[flag]
    if fabricated:
        # The receipt was invented because the tool produced nothing, so it
        # must read as a failure to the model and to any UI status mapping.
        out['is_error'] = True
        out['synthetic'] = True
    elif not text.strip() and 'is_error' not in out:
        out['is_error'] = True
    return out


class ToolResultReconciliation:
    """Outcome of closing one tool-call round.

    ``results`` is the exactly-one-per-call list to append to history;
    ``synthesized`` / ``dropped`` are the ids that needed repair, kept for
    the warning the loop emits and for tests.
    """

    __slots__ = ('dropped', 'results', 'synthesized')

    def __init__(
        self,
        results: list[dict[str, object]],
        synthesized: list[str],
        dropped: list[str],
    ) -> None:
        self.results = results
        self.synthesized = synthesized
        self.dropped = dropped


def reconcile_tool_results(
    calls: Sequence[tuple[str, str]],
    results: Sequence[object],
) -> ToolResultReconciliation:
    """Close a tool-call round with exactly one result per call.

    ``calls`` is the ordered ``(tool_use_id, tool_name)`` list the round
    actually dispatched, as seen by the assistant message. Anything the
    round failed to produce a result for is replaced by a synthetic one;
    results for ids the round never claimed are dropped rather than
    persisted (an orphan result is the same fatal 400 as a missing one).

    Duplicates collapse to the first result — a tool that somehow reported
    twice must not produce two blocks for one ``tool_use``.
    """
    byId: dict[str, dict[str, object]] = {}
    orphans: list[str] = []
    for raw in results:
        normalized = normalize_tool_result(raw)
        callId = as_str(normalized.get('tool_use_id'), '')
        if callId in byId:
            continue
        byId[callId] = normalized

    claimed = {cid for cid, _ in calls if cid}
    for callId in list(byId):
        if callId not in claimed:
            orphans.append(callId)
            del byId[callId]

    out: list[dict[str, object]] = []
    synthesized: list[str] = []
    for callId, name in calls:
        if not callId:
            continue
        existing = byId.get(callId)
        if existing is None:
            existing = synthetic_tool_result(callId, name)
            synthesized.append(callId)
        out.append(normalize_tool_result(existing, tool_use_id=callId, tool_name=name))
    return ToolResultReconciliation(out, synthesized, orphans)


def canonical_tool_calls(
    tool_uses: Sequence[Mapping[str, Any]],
    assistant_msg: Mapping[str, Any],
    *,
    is_anthropic: bool,
) -> list[tuple[str, str]]:
    """The round's ordered ``(tool_use_id, tool_name)`` pairs, ids repaired.

    A model that emits a ``tool_use`` without an ``id`` (or an OpenAI call
    with ``id: null``) produces a block no ``tool_result`` can reference —
    the next request is malformed however well the tool ran. The synthesized
    id is written back into BOTH the call and the matching block in the
    assistant message, so the two always name the same call. This is the
    identity list :func:`reconcile_tool_results` closes the round against.
    """
    content = assistant_msg.get('content')
    if is_anthropic and isinstance(content, list):
        blocks: list[Any] = [b for b in content if isinstance(b, dict) and b.get('type') == 'tool_use']
    else:
        blocks = as_list(assistant_msg.get('tool_calls'), [])
    out: list[tuple[str, str]] = []
    for index, call in enumerate(tool_uses):
        name = as_str(call.get('name'), '')
        callId = as_str(call.get('id'), '')
        if not callId:
            callId = f'toolu_{uuid.uuid4().hex[:16]}'
            if isinstance(call, dict):
                call['id'] = callId
        if index < len(blocks) and isinstance(blocks[index], dict) and not as_str(blocks[index].get('id'), ''):
            blocks[index]['id'] = callId
        if callId:
            out.append((callId, name))
    return out
