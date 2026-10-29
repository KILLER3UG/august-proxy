"""
Context compressor — summarizes middle messages to fit within token thresholds
while preserving head and tail messages.

Port of backend/services/memory/context-compressor.js (177 lines).
"""

from __future__ import annotations

import inspect
import os
from typing import Callable

from app.json_narrowing import as_int, as_list, as_str
from app.providers.clients.base import estimateTokens

DEFAULT_HEAD_COUNT = 4
DEFAULT_TAIL_COUNT = 6
# The head is the opening ask, kept verbatim. Four messages is 1 % of an 8k
# window and a third of a 128k one, so above the floor it is budgeted by the
# window instead of by count. The floor stays DEFAULT_HEAD_COUNT messages: a
# short transcript, or a caller with no window, is unchanged.
COMPACT_HEAD_RATIO = 0.10
DEFAULT_SUMMARY_MARKER = '<<compressed_summary'
DEFAULT_MAX_SUMMARY_CHARS = 2000
FEATURE_FLAG = 'AUGUST_SUMMARIZING_COMPACTOR'

# ── Prune-then-compact ──
# Tier (a) projection prune: protect the newest PROTECTED_TOOL_TOKENS of tool
# outputs; older tool results are rewritten in the model-facing projection
# only (history itself untouched). Stage A shape (companion to #3): old
# results over PRUNE_THRESHOLD_CHARS keep head+tail with a middle-elision
# marker; smaller old results are cleared outright.
PROTECTED_TOOL_TOKENS = 40_000
PRUNE_THRESHOLD_CHARS = 8192
PRUNE_HEAD_CHARS = 4096
PRUNE_TAIL_CHARS = 1024
# A PREFIX, not a complete sentence: the cleared marker is followed by the name of
# the call it replaced when that is knowable, and a marker persisted by an older
# build (`[Old tool result content cleared]`) must still be recognized as already
# pruned rather than re-eroded on the next turn.
CLEARED_MARKER = '[Old tool result content cleared'
PRUNE_ELISION_MARKER = '[... middle omitted'
# Tier (b) compaction ratios (documented calibration defaults): trigger at
# 0.8 × context window, retain the newest 0.16 verbatim, cap the summary at
# 8192 tokens.
COMPACT_TRIGGER_RATIO = 0.80
COMPACT_RETAIN_RATIO = 0.16
SUMMARY_CAP_TOKENS = 8192
# Compaction lock TTL: a mid-compaction crash must not block compaction
# forever — an orphaned lock older than the TTL is treated as released.
LOCK_TTL_S = 300.0
# Verbatim replay budget for the newest USER messages after a
# summary (whole messages only, never a mid-message cut). The summary
# inevitably loses nuance the user already paid for; replaying the most
# recent user turns under this byte budget (12 KiB, within the plan's
# 8–16 KB range) lets the next agent act without re-asking.
REPLAY_USER_BUDGET_BYTES = 12 * 1024

# ── Skill carryover across compaction ──
# A loaded skill body is a tool result, so compaction summarizes it away while
# the skill index in the system prompt survives. The next turn then remembers
# that the skill exists but not what it said. This restores the bodies of the
# skills loaded before the compaction cut, bounded, newest last, after the
# summary. It is context repair, not a second prompt: the text is current
# skill content fetched through the normal loader.
SKILL_CARRYOVER_MARKER = '<<compacted_skills'
SKILL_CARRYOVER_END = '<<end_compacted_skills>>'
SKILL_CARRYOVER_TOTAL_TOKENS = 10_000
SKILL_CARRYOVER_SKILL_TOKENS = 5_000
SKILL_CARRYOVER_WINDOW_SHARE = 0.10

# ── Two-route context relief ──
# Compact-in-place preserves the FIRST `head_count` messages verbatim forever and
# summarizes what comes after it. From the second relief onward that is loss
# applied to loss: the note is built from a follow-up turn (the original ask sits
# OUTSIDE the summarized span, so `Goal` names whatever the user said fifth), and
# every earlier decision survives only as the 600 characters of prose the previous
# note squeezed out of itself.
RELIEF_COMPACT = 'compact'
RELIEF_ROTATE = 'rotate'


def reliefStrategy(messages: list[dict[str, object]], *, armed: bool) -> str:
    """Pick the relief route: summarize in place, or re-anchor on a fresh note.

    Rotating drops the stale verbatim head and rebuilds the note from the WHOLE
    span, so `Goal` is the task rather than a follow-up and the summary is derived
    from original text again instead of from its own predecessor. What the head
    was holding is not lost: the original ask is replayed verbatim under the same
    byte budget the newest user turns already get, the tail stays verbatim, and
    the transcript archive has the full history before either route runs.

    The first relief never rotates, even when armed. Before a note exists the
    verbatim head IS the live task statement, and re-anchoring on a summary whose
    own footer says "decisions and constraints were not analyzed" would trade a
    fact for a guess.

    Two limits, stated because the route is easier to oversell than to read:
    * it resets the *head* staleness, not note-on-note loss. Each note still
      carries its predecessors as 600 characters of prose, so a tenth rotation is
      built on the ninth one's squeeze. Removing that channel means a real
      durable-handoff store, not a different flag here.
    * the predicate is "a summary block is present", and `_isSummaryMessage`
      matches the fenced shape in any role. A user or an imported transcript that
      pastes a genuine handoff note verbatim therefore reads as "already
      compacted", and the first relief rotates. The same false positive already
      folds such a message into `priorSummaryTexts`, so this rides an existing
      detection choice rather than adding one.
    """
    if not armed:
        return RELIEF_COMPACT
    if not any(_isSummaryMessage(m) for m in messages):
        return RELIEF_COMPACT
    return RELIEF_ROTATE


def reliefHeadCount(relief: str) -> int:
    """The head FLOOR a route is entitled to.

    Above this floor the head is token-budgeted by the window
    (``COMPACT_HEAD_RATIO``), so the number a frame should report is the one
    ``reliefStats['head']`` carries. This value is the fallback for a caller
    that has no split to report — and a route that keeps no head at all.
    """
    return 0 if relief == RELIEF_ROTATE else DEFAULT_HEAD_COUNT


def isFeatureEnabled() -> bool:
    """Check if the summarizing compactor feature flag is set.

    Enabled by default — the env var AUGUST_SUMMARIZING_COMPACTOR
    can be set to "0" to disable."""
    val = os.environ.get(FEATURE_FLAG)
    if val is not None:
        return val == '1'
    return True


def localSummarize(messages: list[dict[str, object]], maxSummaryChars: int = DEFAULT_MAX_SUMMARY_CHARS) -> str:
    """Default local summarizer.

    Joins text content from each message, truncates to max_summary_chars,
    and returns the summary string.
    """
    lines: list[str] = []
    for msg in messages:
        role = msg.get('role', 'unknown')
        content = msg.get('content', '')
        text = ''
        if isinstance(content, str):
            text = content
        elif isinstance(content, list):
            # Denser elision (surpass #4): assistant blocks keep only the
            # FINAL text block — earlier provisional text and thinking are
            # noise once the answer exists.
            blocks = [b for b in content if isinstance(b, dict)]
            text_blocks = [
                str(b.get('text', ''))
                for b in blocks
                if b.get('type') in ('text', 'output_text')
            ]
            if role == 'assistant' and text_blocks:
                text = text_blocks[-1]
            else:
                text = ' '.join(text_blocks)
        elif content:
            try:
                import json

                text = json.dumps(content)
            except (TypeError, ValueError):
                text = str(content)
        toolCalls = as_list(msg.get('tool_calls'))
        if toolCalls:
            names: list[str] = []
            for tc in toolCalls:
                if not isinstance(tc, dict):
                    continue
                func = tc.get('function')
                name = as_str(func.get('name')) if isinstance(func, dict) else ''
                if not name:
                    name = as_str(tc.get('name'))
                if name:
                    names.append(name)
            if names:
                text += f' [tool_calls: {", ".join(names)}]'
        # Denser elision: tool results (the largest blocks) slim to one line;
        # users keep 400 chars, assistant text 600.
        cap = 120 if role == 'tool' else (400 if role == 'user' else 600)
        trimmed = ' '.join(text.split())[:cap]
        if trimmed:
            lines.append(f'[{role}] {trimmed}')
    summary = '\n'.join(lines)
    if len(summary) > maxSummaryChars:
        summary = summary[:maxSummaryChars] + '…'
    return summary


# ── Tier (a): projection prune of old tool outputs ──


def _approxTokens(text: str) -> int:
    """Cheap char→token estimate (4 chars/token) for prune budgeting."""
    return max(1, len(text) // 4)


def _toolResultSlots(msg: dict[str, object]) -> list[tuple[str, int] | None]:
    """Enumerate the tool-result text slots of one message.

    Returns a list with one entry per slot: ``('content', -1)`` for a
    plain ``role: tool`` message, or ``('block', i)`` for each
    ``tool_result`` block inside a user message's content list. Non-result
    messages return an empty list.
    """
    role = msg.get('role')
    content = msg.get('content')
    if role == 'tool' and isinstance(content, str):
        return [('content', -1)]
    if role in ('user', 'tool') and isinstance(content, list):
        slots: list[tuple[str, int] | None] = []
        for i, b in enumerate(content):
            if isinstance(b, dict) and b.get('type') == 'tool_result':
                slots.append(('block', i))
        return slots
    return []


def _slotText(msg: dict[str, object], slot: tuple[str, int] | None) -> str:
    if slot is None:
        return ''
    kind, idx = slot
    if kind == 'content':
        return as_str(msg.get('content'))
    content = msg.get('content')
    if isinstance(content, list) and 0 <= idx < len(content):
        block = content[idx]
        if isinstance(block, dict):
            c = block.get('content')
            if isinstance(c, str):
                return c
            if isinstance(c, list):
                return '\n'.join(
                    as_str(b.get('text')) for b in c if isinstance(b, dict) and b.get('type') == 'text'
                )
    return ''


def _slotCallId(msg: dict[str, object], slot: tuple[str, int] | None) -> str:
    """The call id a tool-result slot answers, or '' when it names none."""
    if slot is None:
        return ''
    kind, idx = slot
    if kind == 'content':
        return as_str(msg.get('tool_call_id'))
    content = msg.get('content')
    if isinstance(content, list) and 0 <= idx < len(content):
        block = content[idx]
        if isinstance(block, dict):
            return as_str(block.get('tool_use_id'))
    return ''


def _rewriteSlot(msg: dict[str, object], slot: tuple[str, int] | None, text: str) -> dict[str, object]:
    """Return a copy of ``msg`` with one tool-result slot replaced."""
    if slot is None:
        return msg
    kind, idx = slot
    copy = dict(msg)
    if kind == 'content':
        copy['content'] = text
        return copy
    content = msg.get('content')
    if isinstance(content, list) and 0 <= idx < len(content):
        newContent = list(content)
        block = newContent[idx]
        if isinstance(block, dict):
            newBlock = dict(block)
            c = newBlock.get('content')
            if isinstance(c, list):
                newBlock['content'] = [{'type': 'text', 'text': text}]
            else:
                newBlock['content'] = text
            newContent[idx] = newBlock
        copy['content'] = newContent
    return copy


def _callSubjects(messages: list[dict[str, object]]) -> dict[str, str]:
    """`tool_call_id` → the shortest thing that names the call that made it.

    A cleared result said only `[Old tool result content cleared]`. The model knew
    SOMETHING had been blanked but not what, so it could not decide whether to
    re-read that file deliberately — it had to guess, or re-run the whole step.
    Naming the call makes the loss inspectable. `[]` means the call was not found:
    never invent a subject.
    """
    out: dict[str, str] = {}
    for m in messages:
        if m.get('role') != 'assistant':
            continue
        content = m.get('content')
        blocks = [b for b in content if isinstance(b, dict)] if isinstance(content, list) else []
        for b in blocks:
            if b.get('type') != 'tool_use':
                continue
            cid = as_str(b.get('id'))
            if cid:
                out[cid] = _subjectOf(as_str(b.get('name')), b.get('input'))
        for tc in as_list(m.get('tool_calls')):
            if not isinstance(tc, dict):
                continue
            cid = as_str(tc.get('id'))
            if not cid or cid in out:
                continue
            fn = tc.get('function')
            name = as_str(fn.get('name')) if isinstance(fn, dict) else as_str(tc.get('name'))
            rawArgs = fn.get('arguments') if isinstance(fn, dict) else None
            if isinstance(rawArgs, str):
                import json as _json

                try:
                    argsObj: object = _json.loads(rawArgs)
                except (ValueError, TypeError):
                    argsObj = {}
            elif isinstance(rawArgs, dict):
                argsObj = rawArgs
            else:
                argsObj = {}
            out[cid] = _subjectOf(name, argsObj if isinstance(argsObj, dict) else {})
    return out


def _subjectOf(name: str, args: object) -> str:
    """`read_file src/a.ts`; empty when nothing identifies the call.

    Read-style targets only. `command` and `url` are deliberately excluded: naming
    half a truncated compound command (`rm -rf build && npm publish`) advertises it
    as the thing to redo, when what the model actually lost is the OUTCOME — and a
    cleared marker is persisted into the projection on compaction, so it would keep
    suggesting that re-run in every later turn. A lost search or file read has no
    such hazard.
    """
    target = ''
    if isinstance(args, dict):
        for key in ('path', 'file_path', 'filePath', 'pattern', 'query'):
            val = args.get(key)
            if isinstance(val, str) and val.strip():
                target = ' '.join(val.split())[:120]
                break
    label = name.strip()
    if not label:
        return ''
    return f'{label} {target}'.strip()


def _pruneOne(text: str, subject: str = '') -> str:
    """Stage A rewrite of a single old tool result (deterministic)."""
    if len(text) <= PRUNE_THRESHOLD_CHARS:
        return f'{CLEARED_MARKER} — {subject}]' if subject else f'{CLEARED_MARKER}]'
    omitted = len(text) - PRUNE_HEAD_CHARS - PRUNE_TAIL_CHARS
    return (
        text[:PRUNE_HEAD_CHARS]
        + f'\n{PRUNE_ELISION_MARKER} — {omitted} characters cleared]\n'
        + text[-PRUNE_TAIL_CHARS:]
    )


def pruneToolOutputs(
    messages: list[dict[str, object]], protectTokens: int = PROTECTED_TOOL_TOKENS
) -> list[dict[str, object]]:
    """Projection prune: blank old tool outputs in a COPY of the transcript.

    Walks from the end, protecting the newest ``protectTokens`` of tool
    output; every older tool result is rewritten — large ones keep
    head 4096 + tail 1024 code points with a middle-elision marker (stage A),
    small ones are cleared to ``CLEARED_MARKER``. The input list and its
    messages are never mutated (non-destructive projection).
    """
    slots: list[tuple[int, tuple[str, int] | None, str]] = []
    for i, m in enumerate(messages):
        for slot in _toolResultSlots(m):
            if slot is not None:
                slots.append((i, slot, _slotText(m, slot)))
    if not slots:
        return list(messages)
    protected: set[tuple[int, int]] = set()
    acc = 0
    newest = True
    for i, slot, text in reversed(slots):
        tokens = _approxTokens(text)
        # The newest tool result is always protected — blanking the freshest
        # output would defeat the point even when it alone exceeds the budget.
        if newest or acc + tokens <= protectTokens:
            protected.add((i, slot[1] if slot else -1))
            acc += tokens
            newest = False
    out = list(messages)
    subjects = _callSubjects(messages)
    for i, slot, text in slots:
        key = (i, slot[1] if slot else -1)
        if key in protected:
            continue
        if not text or text.startswith(CLEARED_MARKER) or PRUNE_ELISION_MARKER in text[: PRUNE_HEAD_CHARS + 80]:
            continue  # already pruned — idempotent, suffix included
        callId = _slotCallId(out[i], slot)
        out[i] = _rewriteSlot(out[i], slot, _pruneOne(text, subjects.get(callId, '') if callId else ''))
    return out


# ── Tool-pair-safe unit splitting (a tool result stays with its call) ──


def _hasToolUse(msg: dict[str, object]) -> bool:
    if msg.get('role') != 'assistant':
        return False
    content = msg.get('content')
    if isinstance(content, list):
        for b in content:
            if isinstance(b, dict) and b.get('type') == 'tool_use':
                return True
    for tc in as_list(msg.get('tool_calls')):
        if isinstance(tc, dict):
            return True
    return False


def _isToolResultMsg(msg: dict[str, object]) -> bool:
    return bool(_toolResultSlots(msg))


def _splitUnits(messages: list[dict[str, object]]) -> list[list[dict[str, object]]]:
    """Group messages into atomic units: an assistant tool-call message plus
    ALL tool results that follow it stay one unit, so no compaction boundary
    can orphan a tool result from its call (wire-format safety)."""
    units: list[list[dict[str, object]]] = []
    i = 0
    n = len(messages)
    while i < n:
        m = messages[i]
        if _hasToolUse(m):
            unit = [m]
            j = i + 1
            while j < n and _isToolResultMsg(messages[j]):
                unit.append(messages[j])
                j += 1
            units.append(unit)
            i = j
        else:
            units.append([m])
            i += 1
    return units


# ── Fixed markdown summary schema ──

_READ_TOOLS = {'read_file', 'list_files', 'search_files', 'grep_files', 'glob', 'grep'}
_MODIFY_TOOLS = {
    'write_file',
    'edit_file',
    'edit_lines',
    'create_file',
    'str_replace',
    'str_replace_editor',
    'apply_patch',
    'patch_file',
}


def _iterToolCalls(messages: list[dict[str, object]]):
    """Yield (name, inputDict) for every tool call in assistant messages."""
    for m in messages:
        if m.get('role') != 'assistant':
            continue
        content = m.get('content')
        if isinstance(content, list):
            for b in content:
                if isinstance(b, dict) and b.get('type') == 'tool_use':
                    inp = b.get('input')
                    yield as_str(b.get('name')), (inp if isinstance(inp, dict) else {})
        for tc in as_list(m.get('tool_calls')):
            if not isinstance(tc, dict):
                continue
            fn = tc.get('function')
            name = ''
            callInput: dict[str, object] = {}
            if isinstance(fn, dict):
                name = as_str(fn.get('name'))
                raw = fn.get('arguments')
                if isinstance(raw, dict):
                    callInput = raw
                elif isinstance(raw, str):
                    try:
                        import json

                        parsed = json.loads(raw)
                        callInput = parsed if isinstance(parsed, dict) else {}
                    except (ValueError, TypeError):
                        callInput = {}
            if name:
                yield name, callInput


def _loadedSkillNames(messages: list[dict[str, object]]) -> list[str]:
    """Skills whose bodies this span loaded, in load order.

    `load_skill` and the bulk `load_skills` are the two doors; a file argument
    is a reference read, not a body load. A previous carryover block also
    counts: after a second compaction its original load call may itself be
    summarized away, and the carried names are the only durable evidence.
    """
    import re

    names: list[str] = []
    for toolName, inp in _iterToolCalls(messages):
        n = toolName.strip().lower()
        if n == 'load_skill':
            if as_str(inp.get('file')):
                continue
            name = as_str(inp.get('name'))
            if name:
                names.append(name)
        elif n == 'load_skills':
            for item in as_list(inp.get('names') or inp.get('name')):
                name = as_str(item.get('name')) if isinstance(item, dict) else as_str(item)
                if name:
                    names.append(name)
    for message in messages:
        content = message.get('content')
        if isinstance(content, str) and SKILL_CARRYOVER_MARKER in content:
            names.extend(re.findall(r'<skill name="([^"]+)"', content))
    return names


def _skillCarryoverBudget(context_window: int) -> tuple[int, int]:
    """(per-skill chars, total chars) for restored skill bodies."""
    if context_window > 0:
        total_tokens = min(
            SKILL_CARRYOVER_TOTAL_TOKENS,
            int(context_window * SKILL_CARRYOVER_WINDOW_SHARE),
        )
    else:
        total_tokens = SKILL_CARRYOVER_TOTAL_TOKENS
    total_tokens = max(1_000, total_tokens)
    return min(SKILL_CARRYOVER_SKILL_TOKENS, total_tokens) * 4, total_tokens * 4


def buildSkillCarryover(
    messages: list[dict[str, object]],
    compacted: list[dict[str, object]],
    *,
    workspace: str = '',
    context_window: int = 0,
) -> dict[str, object] | None:
    """A user-role context-repair message for skills lost in compaction.

    Only skills loaded before the cut whose load call is no longer present in
    the compacted surface are restored. The body is fetched through the normal
    loader (current content), capped per skill and in total, and marked with
    the file path when truncated. Automatic compaction passes this through the
    same policy as every other path; the message is tagged `harness_nudge` so
    the Bot runaway ceiling does not read it as the human speaking.
    """
    if not compacted or not any(_isSummaryMessage(m) for m in compacted):
        return None
    before = _loadedSkillNames(messages)
    after = set(_loadedSkillNames(compacted))
    order: dict[str, int] = {}
    for index, name in enumerate(before):
        order[name] = index
    missing = [name for name in sorted(order, key=lambda n: order[n]) if name not in after]
    if not missing:
        return None

    try:
        from app.services import skill_service
    except Exception:
        return None

    perSkillChars, totalChars = _skillCarryoverBudget(context_window)
    blocks: list[str] = []
    used = 0
    for name in missing:
        try:
            skill = skill_service.get(name, workspace or None)
        except Exception:
            continue
        if not skill or not skill.get('enabled'):
            continue
        body = as_str(skill.get('instructions')).strip()
        if not body:
            continue
        path = as_str(skill.get('path'))
        openTag = f'<skill name="{name}"' + (f' path="{path}"' if path else '') + '>\n'
        closeTag = '\n</skill>'
        room = totalChars - used - len(openTag) - len(closeTag) - 2
        if room < 500:
            break
        cap = min(perSkillChars, room)
        if len(body) > cap:
            notice = (
                f'\n\n[Truncated after compaction. Read {path or "the skill file"} '
                'for the full text.]'
            )
            body = body[: max(0, cap - len(notice))] + notice
        block = f'{openTag}{body}{closeTag}'
        blocks.append(block)
        used += len(block) + 2
    if not blocks:
        return None
    content = (
        '[COMPACTED SKILLS — harness-restored context, not a user request. '
        'These skills were loaded earlier and their bodies were summarized away; '
        'the current bodies are restored below, newest last. If a body is marked '
        'truncated, read its file before relying on the missing part.]\n'
        f'{SKILL_CARRYOVER_MARKER}\n\n'
        + '\n\n'.join(blocks)
        + f'\n{SKILL_CARRYOVER_END}'
    )
    return {'role': 'user', 'content': content, 'source': 'harness_nudge'}


def insertSkillCarryover(
    compacted: list[dict[str, object]], carryover: dict[str, object]
) -> list[dict[str, object]]:
    """Place the restored skills immediately after the newest summary note."""
    index = -1
    for i, message in enumerate(compacted):
        if _isSummaryMessage(message):
            index = i
    if index < 0:
        return compacted
    return compacted[: index + 1] + [carryover] + compacted[index + 1 :]


def extractFileLedger(messages: list[dict[str, object]]) -> tuple[list[str], list[str]]:
    """Deterministic read/modified file ledger from tool-call arguments."""
    read: list[str] = []
    modified: list[str] = []
    for name, inp in _iterToolCalls(messages):
        path = as_str(inp.get('path') or inp.get('file_path') or inp.get('filePath') or '')
        if not path:
            continue
        if name in _MODIFY_TOOLS:
            if path not in modified:
                modified.append(path)
        elif name in _READ_TOOLS:
            if path not in read and path not in modified:
                read.append(path)
    return read, modified


def _parseLedgerTags(text: str) -> tuple[list[str], list[str]]:
    """Recover <read-files>/<modified-files> ledgers from a prior summary."""
    import re

    def _grab(tag: str) -> list[str]:
        m = re.search(rf'<{tag}>\n?(.*?)\n?</{tag}>', text, re.DOTALL)
        if not m:
            return []
        return [ln.strip() for ln in m.group(1).splitlines() if ln.strip()]

    return _grab('read-files'), _grab('modified-files')


def _firstUserText(messages: list[dict[str, object]]) -> str:
    for m in messages:
        if m.get('role') != 'user':
            continue
        content = m.get('content')
        if isinstance(content, str) and content.strip() and not content.startswith('<<compressed_summary'):
            return ' '.join(content.split())
        if isinstance(content, list):
            texts = [
                as_str(b.get('text'))
                for b in content
                if isinstance(b, dict) and b.get('type') == 'text' and as_str(b.get('text')).strip()
            ]
            if texts:
                return ' '.join(' '.join(texts).split())
    return ''


def schemaSummarize(
    messages: list[dict[str, object]],
    priorSummaryTexts: list[str] | None = None,
    goalHint: str = '',
    maxChars: int = SUMMARY_CAP_TOKENS * 4,
    keep_hint: str = '',
) -> str:
    """Fixed-handoff markdown summary (deterministic, no LLM).

    Part 18 P2.2: the shape is a handoff contract — Goal / Keep / State /
    Context / Memory / Next / Pitfalls — so a compacted session hands the next
    agent (or the next LLM call) enough to act without re-asking the user, with
    the file ledger carried forward as trailing tags across repeated
    compactions. ``keep_hint`` is the manual-compaction instruction, carried
    verbatim (and capped) at the TOP so the summary cap cannot truncate it
    away; this deterministic extractor never interprets it. Mapping from the
    pre-P2.2 schema: Progress → State, Key Decisions / Constraints /
    earlier-summary prose → Context, Next Steps → Next, the latest failing
    receipt + update_state blockers were split into Pitfalls (they were
    previously buried in Critical Context).
    """
    goal = ' '.join((goalHint or '').split())[:400] or _firstUserText(messages)[:400] or '(not recorded)'

    done: list[str] = []
    blockers: list[str] = []
    lastPhase = ''
    lastStep: object = None
    for name, inp in _iterToolCalls(messages):
        if name != 'update_state':
            continue
        phase = as_str(inp.get('phase'))
        if phase:
            lastPhase = phase
            lastStep = inp.get('step')
        for c in as_str(inp.get('completed')).split('\n'):
            c = c.strip()
            if c and c not in done:
                done.append(c)
        latestBlockers = [b.strip() for b in as_str(inp.get('blockers')).split('\n') if b.strip()]
        if latestBlockers:
            blockers = latestBlockers

    # Pitfalls: the latest failing receipt (first line), if any, plus the
    # carried-forward prose of earlier summaries (capped) so repeated
    # compactions don't silently drop older context.
    critical = ''
    for m in reversed(messages):
        if m.get('role') != 'tool':
            continue
        content = m.get('content')
        text = content if isinstance(content, str) else ''
        low = text.lower()
        if 'error:' in low or 'failed' in low or 'exit code: 1' in low:
            critical = ' '.join(text.split())[:300]
            break
    earlier = ''
    if priorSummaryTexts:
        import re as _re

        # Strip the ledger blocks from the carried-forward prose — leaving
        # them in would plant fake <read-files> tags inside the Context
        # section that a later ledger parse would match first.
        earlierProse = '\n---\n'.join(priorSummaryTexts)
        earlierProse = _re.sub(r'<read-files>.*?</read-files>', '', earlierProse, flags=_re.DOTALL)
        earlierProse = _re.sub(r'<modified-files>.*?</modified-files>', '', earlierProse, flags=_re.DOTALL)
        earlier = ' '.join(earlierProse.split())[:600]

    # Ledger: prior summaries first, then fresh observations (deduped).
    priorRead: list[str] = []
    priorModified: list[str] = []
    for t in priorSummaryTexts or []:
        r, w = _parseLedgerTags(t)
        for p in r:
            if p not in priorRead:
                priorRead.append(p)
        for p in w:
            if p not in priorModified:
                priorModified.append(p)
    freshRead, freshModified = extractFileLedger(messages)
    for p in freshModified:
        if p not in priorModified:
            priorModified.append(p)
        if p in priorRead:
            priorRead.remove(p)
    for p in freshRead:
        if p not in priorRead and p not in priorModified:
            priorRead.append(p)

    inProgress = f'phase={lastPhase} step={lastStep}' if lastPhase else '(not recorded)'
    # Memory: the durable writes made inside the span about to be thrown away.
    # Saved facts live in the brain DB and are re-recalled, but *that* they were
    # saved — and, worse, what the user volunteered here and nobody stored — is
    # exactly what a compaction erases with no trace. Name both.
    savedTitles: list[str] = []
    forgotten = 0
    for name, inp in _iterToolCalls(messages):
        if name == 'remember':
            label = as_str(inp.get('title')).strip() or ' '.join(as_str(inp.get('fact')).split())[:80]
            if label and label not in savedTitles:
                savedTitles.append(label)
        elif name == 'forget':
            forgotten += 1
    keepLines: list[str] = []
    if keep_hint:
        keepLines = ['## Keep', ' '.join(keep_hint.split())[:1000], '']
    lines: list[str] = keepLines + [
        '## Goal',
        goal,
        '',
        '## State',
        '- Done: ' + ('; '.join(done[:20]) if done else '(none recorded)'),
        f'- In progress: {inProgress}',
        '- Blocked: ' + ('; '.join(blockers[:10]) if blockers else '(none)'),
        '',
        '## Context',
        '- Key decisions: (uncaptured)',
        '- Constraints: (uncaptured)',
    ]
    if earlier:
        lines.append(f'- Earlier context: {earlier}')
    memoryLines = ['', '## Memory']
    if savedTitles:
        memoryLines.append('- Saved during this span: ' + '; '.join(savedTitles[:12]))
    if forgotten:
        memoryLines.append(f'- {forgotten} memory delete(s) applied')
    if not savedTitles and not forgotten:
        memoryLines.append(
            '- No memory write occurred in the compacted span, so anything the user '
            'stated there that was never saved is gone from this summary. If a '
            'durable preference, constraint or project fact seems to be missing, '
            'ask before acting as though none was given.'
        )
    lines += memoryLines
    # `(uncaptured)` was TRUE of the decision text but false of the position:
    # the loop's own phase/step is right there and survives compaction, so the
    # next turn was told "nothing known about what is next" while the harness
    # held the exact resume point. Extraction, not invention.
    resume = (
        f'resume at phase={lastPhase} step={lastStep}'
        if lastPhase and lastStep is not None
        else f'resume at phase={lastPhase}'
        if lastPhase
        else '(uncaptured)'
    )
    lines += [
        '',
        '## Next',
        resume,
        '',
        '## Pitfalls',
        f'- Latest failure: {critical}' if critical else '(none recorded)',
        # This block is assembled by string extraction, not by a model. Saying
        # "(not recorded)" for a whole field read to the next turn as *proof of
        # absence*, so a constraint stated 40 messages back would be dropped
        # with confidence. Name the limitation instead of asserting a negative.
        '',
        '_Produced by the deterministic compactor: decisions and constraints '
        'were not analyzed; Next is the loop\'s own resume point, not a plan. '
        'A field reading (uncaptured) or (none) means "not extracted here", '
        'not "never stated" — re-read recent messages before concluding such '
        'an item does not exist._',
        '',
        '<read-files>',
        *priorRead[:100],
        '</read-files>',
        '',
        '<modified-files>',
        *priorModified[:100],
        '</modified-files>',
    ]
    out = '\n'.join(lines)
    if len(out) > maxChars:
        out = out[:maxChars] + '\n[... summary truncated at the token cap]'
    return out


# ── Compaction lock events ──


def acquireCompactionLock(session: object, ttl: float = LOCK_TTL_S) -> bool:
    """Acquire the session's compaction lock; False when held.

    A lock older than ``ttl`` is orphaned (mid-compaction crash) and is
    re-acquired so compaction is never blocked forever.
    """
    import logging
    import time as _time

    now = _time.time()
    lock = getattr(session, '_compaction_lock', None)
    if isinstance(lock, dict):
        started = float(lock.get('startedAt') or 0.0)
        if now - started < ttl:
            return False
        logging.getLogger(__name__).warning(
            'compaction lock orphaned (age %.0fs > TTL %.0fs) — re-acquiring', now - started, ttl
        )
    try:
        session._compaction_lock = {'startedAt': now, 'phase': 'start'}  # type: ignore[attr-defined]
    except Exception:
        return True
    logging.getLogger(__name__).info('compaction lock start session=%s', getattr(session, 'id', '?'))
    return True


def noteCompactionPhase(session: object, phase: str) -> None:
    """Record a lock phase transition (start → summary → end)."""
    import logging

    lock = getattr(session, '_compaction_lock', None)
    if isinstance(lock, dict):
        lock['phase'] = phase
    logging.getLogger(__name__).info('compaction phase=%s session=%s', phase, getattr(session, 'id', '?'))


def releaseCompactionLock(session: object) -> None:
    import logging

    try:
        session._compaction_lock = None  # type: ignore[attr-defined]
    except Exception:
        pass
    logging.getLogger(__name__).info('compaction lock end session=%s', getattr(session, 'id', '?'))


def buildSummaryMessage(
    middleMessages: list[dict[str, object]],
    summaryText: str,
    summaryMarker: str = DEFAULT_SUMMARY_MARKER,
    role: str = 'user',
) -> dict[str, object]:
    """Build a fenced summary message from the middle messages.

    Role defaults to ``user`` — a mid-transcript ``system`` message breaks the
    Anthropic wire format (the Messages API has no system role inside
    ``messages``) and would 400 the next turn after compaction.
    """
    import json

    meta = json.dumps({'marker': 'august.summary', 'compressed_count': len(middleMessages)})
    return {
        'role': role,
        'content': f'{summaryMarker}\n{meta}\n{summaryText}\n{summaryMarker.replace("<", "</")}>>',
    }


def _isSummaryMessage(msg: dict[str, object], summaryMarker: str = DEFAULT_SUMMARY_MARKER) -> bool:
    """True if msg is a prior compressed-summary block (any role).

    Detected by the full fenced shape — opening marker ``<<compressed_summary``
    plus the closing fence — in string content. Role-agnostic so legacy
    system-role summaries (older builds) and current user-role summaries are
    both recognized, while a user message that merely starts with the marker
    text is not mistaken for one.
    """
    content = msg.get('content', '')
    if not isinstance(content, str):
        return False
    closing = f'{summaryMarker.replace("<", "</")}>>'
    return content.startswith(summaryMarker) and closing in content


def _extractSummaryText(msg: dict[str, object], summaryMarker: str = DEFAULT_SUMMARY_MARKER) -> str:
    """Recover the human summary text from a fenced summary message.

        build_summary_message emits
        ``{marker}
    {meta_json}
    {summary_text}
    {closing}``. Drop the first line
        (marker), the second (meta json), and the last (closing marker) to get the
        body. Returns "" if the shape is unexpected.
    """
    content = msg.get('content', '')
    if not isinstance(content, str) or not content.startswith(summaryMarker):
        return ''
    lines = content.split('\n')
    if len(lines) < 3:
        return ''
    return '\n'.join(lines[2:-1])


async def compressMessages(
    messages: list[dict[str, object]],
    threshold: int,
    head_count: int = DEFAULT_HEAD_COUNT,
    tail_count: int = DEFAULT_TAIL_COUNT,
    summarizer: Callable | None = None,
    pin_predicates: list[Callable[[dict[str, object]], bool]] | None = None,
    max_pinned: int = 4,
    contextWindow: int | None = None,
    retainRatio: float = COMPACT_RETAIN_RATIO,
    summaryCapTokens: int = SUMMARY_CAP_TOKENS,
    goalHint: str = '',
    schema: bool = False,
    replayUserBytes: int = 0,
    rotate: bool = False,
    reliefStats: dict[str, int] | None = None,
    keep_hint: str = '',
) -> list[dict[str, object]]:
    """Compress messages to fit within a token threshold by summarizing the middle.

    Preserves head messages and a verbatim tail, summarizing everything in
    between. Two tail modes:

    * token-budgeted: when ``contextWindow`` is
      given, the tail keeps the newest ``retainRatio × contextWindow`` tokens
      word-for-word instead of a fixed message count;
    * count-budgeted (legacy): ``tail_count`` messages.

    Boundaries are tool-pair-safe: an assistant tool-call message and its
    tool results form one atomic unit, so a tool result is never orphaned
    from its call (wire-format safety). With ``schema=True`` the summary
    uses the fixed handoff schema (Goal/State/Context/Next/Pitfalls +
    <read-files>/<modified-files>) and carries the file ledger forward
    across repeated compactions; the summary text is capped at
    ``summaryCapTokens`` (≈4 chars/token), splitting the middle into two
    summaries and merging when one alone would exceed it.

    Part 18 P2.2: ``replayUserBytes`` > 0 replays the newest whole USER
    messages from the summarized middle VERBATIM right after the summary
    (budget-bounded, never a mid-message cut). User messages that get
    replayed are excluded from the summary so they are not duplicated.
    Tool results are never replayed and never separated from their call
    (unit split).

    Args:
        messages: Full conversation messages.
        threshold: Token threshold to compress under.
        head_count: Messages preserved at the start as a FLOOR. With a
            ``contextWindow`` the head may grow beyond it, up to
            ``COMPACT_HEAD_RATIO × contextWindow`` tokens.
        tail_count: Number of messages to preserve at the end (count mode).
        summarizer: Optional callable — sync or async — that returns a summary
            string; awaited transparently. ``localSummarize`` is the default.
        pin_predicates: Optional predicates marking MIDDLE messages as
            landmarks to keep verbatim (e.g. the latest update_state
            transition, a failing verification receipt). At most
            ``max_pinned`` landmarks are retained.
        contextWindow: Model context window in tokens; enables the
            token-budgeted verbatim tail.
        retainRatio: Fraction of the window retained verbatim (tail).
        summaryCapTokens: Hard cap for the summary text, in tokens.
        goalHint: Session goal forwarded to the schema summarizer.
        schema: Use the fixed handoff schema for deterministic summaries.
        replayUserBytes: Byte budget for verbatim user-message replay (0 = off).
        keep_hint: Manual-compaction instruction, carried verbatim into the
            schema note's Keep section (automatic paths pass '').        rotate: Re-anchor instead of stacking (see :func:`reliefStrategy`). Keeps
            NO head verbatim, so the summarized span includes the opening — the
            note's Goal becomes the original ask rather than whatever the user
            said fifth — and the original ask itself is claimed back verbatim
            first, before the newest turns, inside the same ``replayUserBytes``.

    Returns:
        Compressed message list (may be unchanged if already under threshold).
    """
    if not messages:
        return messages
    currentTokens = estimateTokens(messages)
    if currentTokens <= threshold:
        return list(messages)
    nonSystem = [m for m in messages if m.get('role') != 'system' and not _isSummaryMessage(m)]
    systemMsgs = [m for m in messages if m.get('role') == 'system' and not _isSummaryMessage(m)]
    priorSummaryTexts = [_extractSummaryText(m) for m in messages if _isSummaryMessage(m)]
    priorSummaryTexts = [t for t in priorSummaryTexts if t]
    otherSystem = systemMsgs
    # Rotating keeps no head: the opening moves INTO the summarized span, which is
    # the whole point (the note then describes the task instead of a follow-up).
    headFloor = 0 if rotate else head_count
    # Above the floor, the head spends at most COMPACT_HEAD_RATIO of the window
    # (0 when the window is unknown, which keeps the count-only behaviour).
    headTokenBudget = 0 if rotate else int((contextWindow or 0) * COMPACT_HEAD_RATIO)
    if len(nonSystem) <= headFloor + tail_count:
        return list(messages)

    # Tool-pair-safe split: group into atomic units, then take tail units
    # (token- or count-budgeted) and head units, and summarize what is left.
    units = _splitUnits(nonSystem)
    # How many leading units the floor needs — the reserve the tail must leave.
    floorUnits = 0
    floorMsgs = 0
    while floorUnits < len(units) and floorMsgs < headFloor:
        floorMsgs += len(units[floorUnits])
        floorUnits += 1
    # TAIL FIRST. Taking the head first let a window-relative head eat the
    # transcript, the greedy tail then found nothing, and compaction returned
    # the input UNCHANGED — the relief would stop being relief precisely on the
    # largest windows. The tail may never take the floor's units or the one unit
    # the middle needs to exist.
    minJdx = floorUnits + 1
    tailUnits: list[list[dict[str, object]]] = []
    tailMsgCount = 0
    jdx = len(units)
    if contextWindow:
        tailBudget = int(contextWindow * retainRatio)
        acc = 0
        while jdx > minJdx:
            unit = units[jdx - 1]
            unitTokens = estimateTokens(unit)
            if tailUnits and acc + unitTokens > tailBudget:
                break
            jdx -= 1
            tailUnits.insert(0, unit)
            acc += unitTokens
            tailMsgCount += len(unit)
    else:
        while jdx > minJdx and tailMsgCount < tail_count:
            jdx -= 1
            tailUnits.insert(0, units[jdx])
            tailMsgCount += len(units[jdx])
    # HEAD SECOND: the floor always ships; above it a unit joins only while the
    # head still fits its window-relative token budget AND a middle unit remains.
    headUnits: list[list[dict[str, object]]] = []
    headMsgCount = 0
    headSpent = 0
    idx = 0
    while idx < jdx - 1:
        unit = units[idx]
        unitTokens = estimateTokens(unit)
        if headMsgCount >= headFloor and headSpent + unitTokens > headTokenBudget:
            break
        headUnits.append(unit)
        headSpent += unitTokens
        headMsgCount += len(unit)
        idx += 1
    if jdx <= idx:
        # Head and tail consumed everything — nothing left to summarize.
        return list(messages)
    head = [m for u in headUnits for m in u]
    tail = [m for u in tailUnits for m in u]
    middleUnits = units[idx:jdx]
    middle = [m for u in middleUnits for m in u]
    if not middle:
        return list(messages)
    # Landmark pins: middle messages a predicate marks are kept VERBATIM
    # (before the summary) instead of being folded into it.
    #
    # Pinned by UNIT, never by message. Every other boundary here is unit-safe,
    # and this one used to walk the flattened messages: a predicate matching a
    # `role: tool` result whose `read_file` call does NOT match pinned the result
    # and summarized the call, emitting a projection that opens with a tool result
    # after the system message. That is a 400 from every provider, and because the
    # projection is what gets persisted, one orphan bricked every later turn — the
    # exact failure the stuck-request ladder exists to escape.
    replayed: list[dict[str, object]] = []

    def _noteSplit() -> None:
        """Report the split this projection actually used.

        Three emitters hardcoded `headCount: 4, tailCount: 6` — the defaults, not
        the result — while the tail is token-budgeted, so the chat card told the user
        "Kept the first 4 and last 6 messages" about a compaction that had kept 120
        verbatim. The counts are only knowable here.
        """
        if reliefStats is None:
            return
        reliefStats.update(
            {'head': len(head), 'pinned': len(pinned), 'replayed': len(replayed), 'tail': len(tail)}
        )

    pinned: list[dict[str, object]] = []
    if pin_predicates:
        for unit in middleUnits:
            if len(pinned) >= max_pinned:
                break
            if any(any(p(m) for p in pin_predicates) for m in unit):
                pinned.extend(unit)
        if pinned:
            pinnedIds = {id(m) for m in pinned}
            middle = [m for m in middle if id(m) not in pinnedIds]
    if not middle:
        # The whole middle was pinned — no summary needed.
        compressed = otherSystem + head + pinned + tail
        compressedTokens = estimateTokens(compressed)
        if compressedTokens >= currentTokens:
            return list(messages)
        _noteSplit()
        return compressed

    # Verbatim replay of the newest USER messages from the
    # summarized middle (whole messages only — never a mid-message cut; a
    # tool result is never replayed, and tool-pair-safe unit splitting
    # already keeps every result with its call).
    import json as _json

    if replayUserBytes > 0 and middle:
        selected: list[dict[str, object]] = []
        acc = 0
        # Rotating moved the opening INTO the span, so it is claimed back first:
        # of every message the compaction is about to fold away, the original ask
        # is the one whose loss changes what the model believes the task is. It
        # spends budget the newest turns would otherwise get, which is the trade.
        opening: dict[str, object] | None = None
        if rotate:
            for m in middle:
                if m.get('role') == 'user' and not _isToolResultMsg(m) and not _isSummaryMessage(m):
                    opening = m
                    break
        if opening is not None:
            openingCost = len(_json.dumps(opening, default=str, sort_keys=True))
            if openingCost > replayUserBytes:
                # A pasted spec larger than the whole replay budget stays in the
                # summarized span. Claiming it anyway would spend the budget on one
                # message and replay nothing else, and the relief could then fail to
                # free enough context to be worth running at all.
                opening = None
            else:
                acc += openingCost
        for m in reversed(middle):
            if m.get('role') != 'user' or _isToolResultMsg(m) or _isSummaryMessage(m):
                continue
            if opening is not None and m is opening:
                continue
            cost = len(_json.dumps(m, default=str, sort_keys=True))
            if (selected or opening is not None) and acc + cost > replayUserBytes:
                break
            selected.append(m)
            acc += cost
        if selected or opening is not None:
            selected.reverse()
            replayed = ([opening] if opening is not None else []) + selected
            removedIds = {id(m) for m in replayed}
            middle = [m for m in middle if id(m) not in removedIds]
        if opening is not None and not goalHint:
            # Claiming the ask back for verbatim replay takes it OUT of the span
            # the note is summarized from, so `_firstUserText(middle)` would read
            # the next user turn and Goal would still name a follow-up — the very
            # defect rotating exists to fix. Hand the note the ask directly.
            goalHint = _firstUserText([opening])
    if not middle:
        # The whole middle was pinned or replayed — no summary needed.
        compressed = otherSystem + head + pinned + replayed + tail
        compressedTokens = estimateTokens(compressed)
        if compressedTokens >= currentTokens:
            return list(messages)
        _noteSplit()
        return compressed

    summaryMaxChars = summaryCapTokens * 4

    async def _summarize(chunk: list[dict[str, object]]) -> str:
        if summarizer:
            text = summarizer(chunk)
            if inspect.isawaitable(text):
                text = await text
            return as_str(text)
        if schema:
            return schemaSummarize(
                chunk,
                priorSummaryTexts,
                goalHint,
                maxChars=summaryMaxChars,
                keep_hint=keep_hint,
            )
        return localSummarize(chunk)

    summaryText = await _summarize(middle)
    # A degenerate note must never replace history. The LLM summariser returns
    # '' on ANY provider failure (it logs and swallows), so without this an
    # outage erased the middle span, reported success, and left the model a
    # blank note where 40 turns of decisions were. Refusing keeps the oversized
    # context — the honest failure — and the next round tries again.
    if not summaryText.strip():
        return list(messages)
    # Split-and-merge: a single turn alone can exceed the summary budget —
    # summarize two halves and merge instead of losing the excess silently.
    if len(summaryText) > summaryMaxChars and len(middle) >= 2:
        half = len(middle) // 2
        first = await _summarize(middle[:half])
        second = await _summarize(middle[half:])
        summaryText = first + '\n---\n' + second
    if len(summaryText) > summaryMaxChars:
        summaryText = summaryText[:summaryMaxChars] + '\n[... summary truncated at the token cap]'
    if priorSummaryTexts and not schema:
        summaryText = 'Earlier summary:\n' + '\n---\n'.join(priorSummaryTexts) + '\n\nRecent summary:\n' + summaryText
    summaryMsg = buildSummaryMessage(middle, summaryText)
    # Aggregate the compacted region's usage into the summary message so the
    # conversation's usage details survive compaction AND restart: the SSE
    # events are volatile, but the persisted summary carries the totals
    # (audit fix).
    try:
        aggIn = 0
        aggOut = 0
        for m in middle:
            u = m.get('usage')
            if isinstance(u, dict):
                aggIn += as_int(u.get('inputTokens') or u.get('input_tokens'), 0)
                aggOut += as_int(u.get('outputTokens') or u.get('output_tokens'), 0)
        if aggIn > 0 or aggOut > 0:
            summaryMsg['usage'] = {
                'inputTokens': aggIn,
                'outputTokens': aggOut,
                'compacted': True,
            }
    except Exception:
        pass
    compressed = otherSystem + head + pinned + [summaryMsg] + replayed + tail
    compressedTokens = estimateTokens(compressed)
    if compressedTokens >= currentTokens:
        return list(messages)
    _noteSplit()
    return compressed
