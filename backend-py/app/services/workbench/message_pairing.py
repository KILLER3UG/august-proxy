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
  to and a stray tool message is the half the provider actually rejects. A
  user message carrying text beside a stray tool result keeps the text;
* every result id in a message counts, not just the first: Anthropic clients
  batch several tool results into one user message;
* the pass is idempotent, so calling it on every round of a turn cannot
  accumulate markers.

Deliberately NOT applied to the pass-through `/v1` proxy adapters: rewriting a
third party's request body is a different contract from fixing the workbench's
own history. The OpenAI-as-Anthropic bridge is a workbench round loop and
repairs its own history; the native Anthropic workbench door does too.
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
# The mutating arm. An orphan in PERSISTED history is not the same evidence as
# an orphan in a live round: the turn ended after dispatch, so the write most
# likely DID happen. Telling the model to re-issue a `write_file`/`run_command`
# in that state invites the double-apply the two-armed receipt in
# `tool_protocol.synthetic_tool_result` exists to prevent — this file just
# never consulted it.
ORPHAN_MUTATING_TEXT = (
    '[August] This tool call has no recorded result: the turn that issued it '
    'ended before the result was persisted. It may or may not have applied — do '
    'NOT re-issue it. Check the effect first (read the file, list the state), '
    'then act on what is actually there.'
)


def _orphan_text(name: str) -> str:
    """Pick the arm for an unanswered call, by whether re-running it is safe.

    A call with no readable name takes the mutating arm: "check the effect
    first" is harmless advice for a read and the only safe advice for a write,
    so the unresolvable case resolves away from a double apply.
    """
    if not (name or '').strip():
        return ORPHAN_MUTATING_TEXT
    from app.services.workbench.tool_protocol import call_is_mutating

    if call_is_mutating(name):
        return ORPHAN_MUTATING_TEXT
    return ORPHAN_RESULT_TEXT


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


def _result_ids(msg: dict[str, object]) -> list[str]:
    """Every call id a message answers. Anthropic batches results in one user
    message; reading only the first marked the other calls unanswered and
    inserted duplicate synthetic results ahead of the real ones."""
    role = as_str(msg.get('role'))
    if role == 'tool':
        rid = as_str(msg.get('tool_use_id') or msg.get('tool_call_id'))
        return [rid] if rid else []
    if role == 'user':
        content = msg.get('content')
        if isinstance(content, list):
            out: list[str] = []
            for block in content:
                if isinstance(block, dict) and as_str(block.get('type')) == 'tool_result':
                    rid = as_str(block.get('tool_use_id'))
                    if rid:
                        out.append(rid)
            return out
    return []


def _filtered_message(
    msg: dict[str, object], called: set[str]
) -> tuple[dict[str, object] | None, int]:
    """Drop results whose call is gone, preserving text in a mixed user message.

    A `tool` message is only a result, so it is dropped whole. A user message
    can carry a text block beside a stray tool_result; the text is the user's
    content and must survive.
    """
    role = as_str(msg.get('role'))
    if role == 'tool':
        rids = _result_ids(msg)
        if rids and all(rid not in called for rid in rids):
            return None, len(rids)
        return msg, 0
    if role == 'user':
        content = msg.get('content')
        if isinstance(content, list):
            kept: list[object] = []
            dropped = 0
            for block in content:
                if isinstance(block, dict) and as_str(block.get('type')) == 'tool_result':
                    rid = as_str(block.get('tool_use_id'))
                    if rid and rid not in called:
                        dropped += 1
                        continue
                kept.append(block)
            if dropped:
                if not kept:
                    return None, dropped
                return {**msg, 'content': kept}, dropped
    return msg, 0


def repair_tool_pairing(messages: list[dict[str, object]]) -> tuple[list[dict[str, object]], int, int]:
    """Return (repaired messages, synthesized results, dropped results).

    The input list is never mutated: a repaired copy is built, so the caller's
    own `session.messages` stays the record of what the user actually had.
    """
    if not messages:
        return messages, 0, 0

    called: set[str] = set()
    for msg in messages:
        if isinstance(msg, dict):
            called.update(cid for cid, _name in _call_ids(msg))

    answered: set[str] = set()
    for msg in messages:
        if isinstance(msg, dict):
            for rid in _result_ids(msg):
                if rid in called:
                    answered.add(rid)

    out: list[dict[str, object]] = []
    dropped = 0
    synthesized = 0
    for msg in messages:
        if not isinstance(msg, dict):
            out.append(msg)
            continue
        clean, lost = _filtered_message(msg, called)
        dropped += lost
        if clean is None:
            continue
        out.append(clean)
        if as_str(clean.get('role')) != 'assistant':
            continue
        for cid, name in _call_ids(clean):
            if cid in answered:
                continue
            out.append({
                'role': 'tool',
                'tool_use_id': cid,
                'tool_call_id': cid,
                'name': name or 'tool',
                'content': _orphan_text(name),
                'is_error': True,
            })
            answered.add(cid)
            synthesized += 1

    if not synthesized and not dropped:
        # The common path: hand back the caller's list unchanged, so a caller
        # comparing identity (or a cache keyed on it) sees no churn.
        return messages, 0, 0
    return cast('list[dict[str, object]]', out), synthesized, dropped
