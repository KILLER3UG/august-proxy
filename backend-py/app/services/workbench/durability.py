"""T18 fail-closed session durability barriers.

The durable session log is flushed at exactly three barriers:

1. ``model-dispatch`` — before a model request is dispatched;
2. ``tool-side-effect`` — before a top-level tool body can side-effect
   (nested calls — subagents, code runner — flush their OWN sessions and
   reuse the outer checkpoint, so a tool never triggers a second flush of
   the parent session);
3. ``step-boundary`` — after each completed tool round.

A failed flush aborts the protected operation: losing trajectory state is
worse than stopping. Crash recovery never truncates — a session persisted
mid-turn (``turnOpen``) is closed with a synthetic interrupted marker when
loaded, so replay stays balanced (see WorkbenchSession.fromDict).
"""

from __future__ import annotations

import logging
import re
from typing import TYPE_CHECKING

from app.json_narrowing import as_str

if TYPE_CHECKING:
    from app.services.workbench.sessions import WorkbenchSession

logger = logging.getLogger(__name__)

BARRIER_MODEL_DISPATCH = 'model-dispatch'
BARRIER_TOOL_SIDE_EFFECT = 'tool-side-effect'
BARRIER_STEP_BOUNDARY = 'step-boundary'

# The per-turn tail sections (the `Relevant memory:` section, the `Relevant
# skills:` section, `<session_state>`, `<memory_nudge>`, `<workspace_map>`) are
# patched onto the last user message for THIS request only — they must not ride
# in persisted history (bloat, stale state the model may later trust, phantom
# mining episodes: the miner's injection filter is prefix-only and
# <memory_nudge> contains correction vocabulary). Marked at patch time; stripped
# before every persist.
_TAIL_PATCH_FLAG = '_tailPatched'
# The pre-tail content length, recorded by the patcher as the authoritative
# boundary. The marker scan below is only a fallback for messages patched by an
# older path that did not record it.
_TAIL_FROM_KEY = '_tailFrom'
_TAIL_MARKERS = (
    # The memory and skills sections are plain headed now, not enveloped, so the
    # fallback boundary names the headers. WITHOUT these two the fallback was
    # dead for the largest part of the tail: a message that lost `_tailFrom`
    # persisted its memory recall and its skill list into history permanently,
    # because the tag strings below stopped appearing in anything we inject.
    '\n\nRelevant memory:',
    '\n\nRelevant skills:',
    '\n\nnew in memory since this chat opened:',
    # The tags stay because this path exists for OLD messages — one persisted by
    # a build that still wrapped the sections — and a legacy transcript must not
    # start keeping its tail because the current injector changed spelling.
    '\n\n<memory',
    '\n\n<relevant_skills',
    '\n\n<session_state',
    '\n\n<memory_nudge',
    # The workspace file map joined the tail when it moved OUT of the
    # prefix-cached system block. This list is the FALLBACK strip path, used
    # when a message has lost its `_tailFrom` marker (e.g. an older producer,
    # or `as_int` returning -1). Omitting <workspace_map here meant such a
    # message persisted its whole file map into history, permanently.
    '\n\n<workspace_map',
)

# The fences August USED TO inject, and the ones a model can echo back.
#
# The memory and skills sections are plain headed now, so there is no closing
# tag to key an echo match on and this scrubber no longer sees them; the
# envelope-based removal below still applies to transcripts persisted by an
# older build and to the blocks that keep their tags. The plain sections are
# protected by the recorded boundary above instead — this regex is only the
# assistant-side echo path, and it is deliberately NOT extended to match bare
# prose headers, which would eat a user asking a question about their memory.
#
# Matched as a WHOLE fenced block, case-sensitively, and only in assistant
# messages: a user asking "what does <memory> mean?" must keep their own
# words. An opening tag with no closing tag is left alone too — half a fence
# in prose is not an echo, and eating the rest of the answer over it would be
# the more expensive mistake.
_ECHO_FENCE_RE = re.compile(
    r'<(memory|relevant_skills|session_state|memory_nudge|workspace_map|plan_state)>'
    r'.*?</\1>',
    re.DOTALL,
)
# The plain-headed sections, paired with the LAST line of each. A header alone
# is not an echo — someone asking "what does my Relevant memory: section say?"
# must keep their words — so BOTH ends have to appear before anything is
# removed, the same conservatism the fenced form above already carries.
_ECHO_SECTIONS: tuple[tuple[str, str], ...] = (
    ('Relevant memory:', 'or remove a stale one with forget.'),
    ('Relevant skills:', 'Load one with load_skill(name) if it fits the request.'),
)
# Three or more blank lines where a fence used to be.
_BLANK_RUN_RE = re.compile(r'\n{3,}')


def scrub_injected_fences(text: str) -> str:
    """Remove August's injected fences from a piece of assistant text.

    Returns the text unchanged when it carries no fence, so the caller can
    tell "nothing to do" from "something was removed" by comparing the two.
    """
    if not text:
        return text
    cleaned = _ECHO_FENCE_RE.sub('', text) if '<' in text else text
    for header, footer in _ECHO_SECTIONS:
        start = cleaned.find(header)
        if start < 0:
            continue
        end = cleaned.find(footer, start)
        if end < 0:
            # The header without its footer is a human talking about the
            # section, not the section.
            continue
        cleaned = cleaned[:start] + cleaned[end + len(footer):]
    if cleaned == text:
        return text
    # A fence that sat between two paragraphs left the gap behind it.
    return _BLANK_RUN_RE.sub('\n\n', cleaned).strip()


def _scrub_message_echo(msg: dict[str, object]) -> bool:
    """Strip injected fences from one ASSISTANT message, in place.

    In place on purpose: the caller hands this function the live transcript
    list, and the model request is built from it. A copy would clean the
    persisted transcript and leave the echo in the very request the model is
    answering — the same defect one layer up.

    Only assistant messages are touched. The USER's own text is never
    rewritten: a question about the memory block must survive verbatim.
    """
    if as_str(msg.get('role')) != 'assistant':
        return False
    content = msg.get('content')
    if isinstance(content, str):
        cleaned = scrub_injected_fences(content)
        if cleaned != content:
            msg['content'] = cleaned
            return True
        return False
    if isinstance(content, list):
        changed = False
        for block in content:
            if not isinstance(block, dict):
                continue
            if block.get('type') not in ('text', 'output_text'):
                continue
            text = block.get('content')
            if not isinstance(text, str):
                text = block.get('text')
            if not isinstance(text, str):
                continue
            cleaned = scrub_injected_fences(text)
            if cleaned != text:
                if 'content' in block and isinstance(block.get('content'), str):
                    block['content'] = cleaned
                else:
                    block['text'] = cleaned
                changed = True
        return changed
    return False


def strip_tail_patches(messages: list[dict[str, object]]) -> list[dict[str, object]]:
    """Return the list with tail-patched messages reverted to their base text
    and August's injected fences stripped from assistant output.

    Two different leaks, one seam: the volatile tail blocks must not ride in
    persisted history, and an assistant's echo of one must not ride in it
    either.
    """
    changed = False
    out: list[dict[str, object]] = []
    for msg in messages:
        if isinstance(msg, dict) and msg.get(_TAIL_PATCH_FLAG):
            changed = True
            clean = {k: v for k, v in msg.items() if k not in (_TAIL_PATCH_FLAG, _TAIL_FROM_KEY)}
            content = clean.get('content')
            if isinstance(content, str):
                # Prefer the recorded boundary. Scanning for the first tail
                # marker ANYWHERE truncated a message whose own text contained
                # one — a user asking about the <memory> block, who put the tag
                # on its own line, lost everything from that point onward in the
                # persisted transcript.
                cut = None
                rawFrom = msg.get(_TAIL_FROM_KEY)
                if isinstance(rawFrom, int) and not isinstance(rawFrom, bool):
                    if 0 <= rawFrom < len(content):
                        cut = rawFrom
                if cut is None:
                    cuts = [c for c in (content.find(m) for m in _TAIL_MARKERS) if c > 0]
                    if cuts:
                        cut = min(cuts)
                if cut is not None:
                    clean = {**clean, 'content': content[:cut].rstrip()}
            msg = clean
        elif isinstance(msg, dict) and _scrub_message_echo(msg):
            changed = True
        out.append(msg)
    return out if changed else messages


def flush_session_barrier(
    session: 'WorkbenchSession',
    barrier: str,
    messages: list[dict[str, object]] | None = None,
) -> tuple[bool, str]:
    """Durable flush of one session; returns ``(ok, errorText)``.

    When ``messages`` is given the session's transcript is synced from the
    turn's working copy first, so the snapshot includes mid-turn progress
    (session.messages otherwise only syncs at turn end). Exceptions are
    caught and reported — the CALLER decides how to abort (fail-closed).
    """
    try:
        if messages is not None:
            session.messages = strip_tail_patches(list(messages))
            session.messageCount = len(session.messages)
        session.turnOpen = True
        from app.services import memory_store
        from app.services.memory_store import save_workbench_session_sot

        memory_store.init()
        save_workbench_session_sot(session.toDict())
        return True, ''
    except Exception as exc:
        logger.error(
            'T18 durability barrier %s failed session=%s: %s',
            barrier,
            getattr(session, 'id', '?'),
            exc,
        )
        return False, str(exc)
