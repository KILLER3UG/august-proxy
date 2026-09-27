"""Provenance vocabulary for stored ``messages.source`` values (audit C3/D7).

Machine plumbing used to be injected into **user-role** message content, so
every downstream consumer — episode mining, persist-time tail trimming, the
transcript — had to guess from text prefixes (``_INJECTION_PREFIXES``), a
hand-maintained denylist that must grow forever and misses one new block and
the learning loop learns from the harness's own plumbing. Migration 049 adds
a ``source`` column instead: the writer tags the message once, and consumers
filter on the column.

``NULL`` source means "not recorded" — every message written before 049, and
any writer that never learned the column. Consumers fall back to the legacy
prefix filter for those rows only.

The workbench's tail-patched user messages (per-turn ``<memory>``/skills/
session-state blocks appended to the human's text) are NOT machine sources:
they are the user's own message carrying a volatile rider. They carry the
``_tailPatched``/``_tailFrom`` markers instead, which the persist path uses
to store the pre-tail text — the tail is re-injected fresh every turn and a
persisted copy is stale context the model should not trust.
"""

from __future__ import annotations

SOURCE_USER = 'user'
SOURCE_ASSISTANT = 'assistant'
SOURCE_TOOL = 'tool'
# Machine plumbing — never mine these as user speech.
SOURCE_HARNESS_NUDGE = 'harness_nudge'
SOURCE_QUEUED_USER = 'queued_user'
SOURCE_SUBAGENT_RESULTS = 'subagent_results'

MACHINE_SOURCES: frozenset[str] = frozenset(
    {SOURCE_HARNESS_NUDGE, SOURCE_QUEUED_USER, SOURCE_SUBAGENT_RESULTS}
)

# August-internal keys that ride on in-memory message dicts but must never
# reach an upstream provider body (the dump layer strips them per message —
# the body-level ``session_id``/``_endpoint`` strip does not cover these).
AUGUST_MESSAGE_ONLY_KEYS: frozenset[str] = frozenset(
    {'_tailPatched', '_tailFrom', 'source'}
)


def strip_august_message_keys(messages: object) -> object:
    """Drop :data:`AUGUST_MESSAGE_ONLY_KEYS` from per-message dicts.

    Used by both upstream dump paths (``dump_anthropic_upstream_body`` /
    ``dump_openai_upstream_body``): the markers ride on the loop's in-memory
    message dicts, the body-level strip never sees them, and strict gateways
    can reject unknown message fields. Non-list payloads pass through.
    """
    if not isinstance(messages, list):
        return messages
    out: list[object] = []
    for msg in messages:
        if isinstance(msg, dict) and not AUGUST_MESSAGE_ONLY_KEYS.isdisjoint(msg):
            out.append({k: v for k, v in msg.items() if k not in AUGUST_MESSAGE_ONLY_KEYS})
        else:
            out.append(msg)
    return out
