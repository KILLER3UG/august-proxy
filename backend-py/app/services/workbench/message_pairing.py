"""Deterministic repair of tool-call pairing at the provider boundary.

A history where a `tool_use` block has no result, or a result has no call, is a
400 from every provider — and because the workbench persists the projection it
just sent, one orphan does not fail one turn, it fails every later turn until a
session is deleted. The loop guards and the stuck-request ladder already exist
for the pathological case, but they *react*: the first repairable request still
fails, and the escalation costs the user two refused turns before it flattens
anything.

This normalises the list before it goes out, so the shape a provider refuses is
a shape that never leaves the process:

* a call with no result gets a synthetic error result in place, saying exactly
  what happened — the model can then re-issue rather than see a silent hole;
* a result whose call is gone is dropped, because there is nothing to attach it
  to and a stray tool message is the half the provider actually rejects;
* the pass is idempotent, so calling it on every round of a turn cannot
  accumulate markers.

Deliberately NOT applied to the `/v1` proxy adapters: those are a pass-through
of what a client sent, and quietly rewriting a third party's request body is a
different contract than fixing the workbench's own history.
"""

from __future__ import annotations

from typing import cast

from app.json_narrowing import as_dict, as_list, as_str

#: The text a model sees where a call never produced a result. It names the
#: cause, because "no result" read as a tool failure invites a retry of the tool
#: rather than of the pairing.
ORPHAN_RESULT_TEXT = (
    '[August] This tool call has no recorded result: the turn that issued it '
    'ended before the result was persisted. Do not assume it ran — re-issue it '
    'if the effect is still needed.'
)


def _call_ids(msg: dict[str, object]) -> list[tuple[str, str]]:
    """(id, tool name) for every tool call an assistant message declares."""
    out: list[tuple[str, str]] = []
    content = msg.get('content')
    if isinstance(content, list):
        for block in content:
            if isinstance(block, dict) and as_str(block.get('type')) == 'tool_use':
                cid = as_str(block.get('id'))
                if cid:
                    out.append((cid, as_str(block.get('name'))))
    for call in as_list(msg.get('tool_calls'), []):
        if not isinstance(call, dict):
            continue
        cid = as_str(call.get('id'))
        if not cid:
            continue
        fn = as_dict(call.get('function'), {})
        out.append((cid, as_str(fn.get('name'))))
    return out


def _result_id(msg: dict[str, object]) -> str:
    """The call id a message answers, or '' when it answers nothing."""
    role = as_str(msg.get('role'))
    if role == 'tool':
        return as_str(msg.get('tool_use_id') or msg.get('tool_call_id'))
    if role == 'user':
        content = msg.get('content')
        if isinstance(content, list):
            for block in content:
                if isinstance(block, dict) and as_str(block.get('type')) == 'tool_result':
                    rid = as_str(block.get('tool_use_id'))
                    if rid:
                        return rid
    return ''


def repair_tool_pairing(messages: list[dict[str, object]]) -> tuple[list[dict[str, object]], int, int]:
    """Return (repaired messages, synthesized results, dropped results).

    The input list is never mutated: a repaired copy is built, so the caller's
    own `session.messages` stays the record of what the user actually had.
    """
    if not messages:
        return messages, 0, 0

    answered: set[str] = set()
    for msg in messages:
        if isinstance(msg, dict):
            rid = _result_id(msg)
            if rid:
                answered.add(rid)
    called: set[str] = set()
    for msg in messages:
        if isinstance(msg, dict):
            called.update(cid for cid, _name in _call_ids(msg))

    out: list[dict[str, object]] = []
    dropped = 0
    synthesized = 0
    for msg in messages:
        if not isinstance(msg, dict):
            out.append(msg)
            continue
        rid = _result_id(msg)
        if rid and rid not in called:
            # A result whose call is gone: the provider rejects the pair, and
            # there is nothing left to attach it to.
            dropped += 1
            continue
        out.append(msg)
        if as_str(msg.get('role')) != 'assistant':
            continue
        for cid, name in _call_ids(msg):
            if cid in answered:
                continue
            out.append({
                'role': 'tool',
                'tool_use_id': cid,
                'name': name or 'tool',
                'content': ORPHAN_RESULT_TEXT,
            })
            answered.add(cid)
            synthesized += 1

    if not synthesized and not dropped:
        # The common path: hand back the caller's list unchanged, so a caller
        # comparing identity (or a cache keyed on it) sees no churn.
        return messages, 0, 0
    return cast('list[dict[str, object]]', out), synthesized, dropped
