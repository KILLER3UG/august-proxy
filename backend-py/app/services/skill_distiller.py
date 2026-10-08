"""Tier-2 judge + distiller (2026-08-30).

One model call per flagged cluster (batches of ≤5 episodes), piggybacking
the consolidation cadence — no new scheduler. The judge sees ONLY the
flagged episode windows (typed events + short excerpts) plus skill
TITLES/DESCRIPTIONS — never whole conversations, never full skill bodies.
Never runs inside a live turn or a sub-agent.

Verdict actions (strict JSON):
  none / memory / create_skill / amend_trigger / amend_body

Wiring:
  * ``memory``          → save_fact(source='harness', kind='lesson') — the
    server-side path `remember` uses; consolidation-deduped; human-deletable
    in the Memory UI.
  * ``create_skill`` /
    ``amend_trigger``   → harness_self_improve.save_proposal — the existing
    human-gated queue. Bodies normalize through _ensure_canonical_body at
    PROPOSE time so reviewers see the final shape.
  * ``amend_body``      → gated on the precision ship bar (≥0.8 on ≥30
    hand-labeled episodes, test_distiller_precision.py); until met the
    verdict downgrades to a proposal-with-note (OQ 2 recommended default:
    the judge is not trusted to rewrite human-authored bodies at birth).
Every drafted summary/body passes the shared sensitive-topic denylist.
Judge failures (bad JSON/timeout) log to lifecycle and return the episode
to tier 1 with a cooldown — no retry storms.
"""

from __future__ import annotations

import json
import logging
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from app.services.memory_conn import conn as _conn

logger = logging.getLogger(__name__)

_BATCH_SIZE = 5
# A drafted skill body is the longest single reply the judge is asked for, on a
# background model chosen for cost rather than speed. 60s measured as enough for
# the old one-line-rule contract and not enough for a real body.
_JUDGE_TIMEOUT_S = 120
_JUDGE_COOLDOWN_MIN = 30
_PRECISION_SHIP_BAR = 0.8
_PRECISION_MIN_LABELED = 30
# 240 chars was chosen when the judge only had to NAME a lesson. It now has to
# write a procedure, and a truncated command is worse than no command: the judge
# fills the gap by inventing the flag it expects to see.
_EXCERPT_CAP = 600
_TIMELINE_LINE_CAP = 220
_TIMELINE_MAX_LINES = 12
# Output budget for the batch reply. A truncated JSON verdict is worse than a
# short one: the batch is dropped and the fingerprint cools down for
# `_JUDGE_COOLDOWN_MIN`. Only the native Anthropic client reads this — the
# OpenAI-compatible path sends no cap at all.
_JUDGE_MAX_TOKENS = 4096

_JUDGE_SYSTEM = (
    "You are the distiller judge for August's self-improvement loop. You receive"
    ' a batch of flagged episode windows. Each window carries the typed events'
    ' (tool errors, user corrections, abandoned approaches) AND the window\'s'
    ' tool calls in order, with their arguments and outcomes, including the calls'
    ' that SUCCEEDED — that sequence is the recovery path, and it is the only'
    ' thing a procedure can be written from.\n'
    '\n'
    'Decide per episode whether anything durable should be learned. Reply with'
    ' STRICT JSON only — no prose, no code fences:\n'
    '{"verdicts": [{"episode": <id>, "action": "none|memory|create_skill|'
    'amend_trigger|amend_body", "reason": "<short>",'
    ' "summary": "<one-line fact>", "category": "project|reference|feedback|general",'
    ' "title": "<short title>", "expires_days": <int>,'
    ' "name": "<skill-name>", "description": "<one sentence, max 60 chars>",'
    ' "trigger": "<trigger phrase>", "keywords": ["<word>"],'
    ' "intro": "<2-3 sentences>", "when_to_use": ["<situation>"],'
    ' "when_not_to_use": ["<situation>"], "prerequisites": ["<tool/file/state>"],'
    ' "steps": [{"do": "<what to do>", "command": "<the exact call, or empty>"}],'
    ' "pitfalls": [{"seen": "<failure that happened here>", "instead": "<what worked>"}],'
    ' "verification": ["<what proves it worked>"],'
    ' "body_markdown": "<whole body, only if you must override the structure>",'
    ' "skill": "<existing skill name>", "patch_markdown": "<amended section>"}]}'
    '\n'
    ' Omit fields irrelevant to the chosen action. Prefer "none" for one-offs.\n'
    '\n'
    'A SKILL IS A PROCEDURE, NOT A RULE. `memory` is where a one-line fact'
    ' belongs. `create_skill` is only for something a future agent has to DO, in'
    ' steps. Before choosing it, check that you can fill `steps` with at least'
    ' two ordered actions AND `pitfalls` with one failure this episode actually'
    ' showed. If you cannot, the episode taught a rule — file `action: memory`.'
    ' Never pad: a skill whose steps you invented will be followed, and a wrong'
    ' step is worse than no step.\n'
    '\n'
    'AUTHORING STANDARDS for create_skill:\n'
    '- name: lowercase letters, digits and hyphens, max 64 chars.\n'
    '- title: a short human title for the body\'s first line — `name` is the id,'
    ' the title is what a reader sees.\n'
    '- description: ONE sentence, max 60 characters, ending with a period. Name'
    ' the capability, not the implementation. Do not restate the name. No'
    ' marketing words (powerful, seamless, robust, advanced, intuitive).\n'
    '- intro: 2-3 sentences — what the skill does, what it does NOT do, and'
    ' whether anything has to be installed or configured first.\n'
    '- when_to_use / when_not_to_use: concrete situations, close to what the user'
    ' actually said. Naming when NOT to use it is what stops a skill firing on'
    ' everything.\n'
    '- steps: in execution order. `command` must be copied verbatim from the tool'
    ' calls in the evidence — a flag, path or argument you cannot see there must'
    ' not appear. Leave `command` empty when the step is a judgement rather than'
    ' a call.\n'
    '- pitfalls: each one is a failure that happened in THIS episode plus the'
    ' change that fixed it. "Be careful" is not a pitfall.\n'
    '- verification: what to look at to know the skill worked.\n'
    '- keywords: 3-8 words a future request would contain.\n'
    '- Never write health, identity or financial details into a skill; the'
    ' denylist refuses them either way.\n'
    '\n'
    'WHAT IS NOT WORTH REMEMBERING (action: memory). A memory is a rule that'
    ' still holds when nobody mentions the conversation that produced it, so'
    ' skip: trivial or obvious information; anything re-discoverable in a'
    ' moment; anything the repo, its instruction files or a tool description'
    ' already says; task progress, completed-work logs and TODO state; runtime'
    ' detail that goes stale silently (ports, versions, token counts, temp'
    ' paths); dates, ticket ids and quoted user text — state the mechanism'
    ' instead. Say WHY: "run the flow with --flat=on because the default mode'
    ' re-resolves every artifact" is a memory; "the user prefers --flat=on" is'
    ' a preference with no reason and will be re-litigated every session.'
    ' NOTHING TO SAVE IS THE EXPECTED ANSWER for most episodes — answering'
    ' `none` costs nothing and a bad memory is paid back on every future turn.\n'
)

# ── per-action verdict schemas (audit P2#16) ──────────────────────────
#
# The judge prompt describes ONE flat verdict shape with every field optional
# and "omit fields irrelevant to the chosen action". That is a contract with
# no teeth: a verdict that says `action: "amend_body"` with no `skill` and no
# `patch_markdown` is structurally indistinguishable from a well-formed one
# until `apply_verdict` reaches a branch that happens to notice. A field the
# action NEEDS should be required by that action, so the shape a verdict must
# have is decided here rather than rediscovered as an `if not x: return` in
# the applier.
#
# These are VALIDATORS, NOT TRANSFORMERS. `parse_verdicts` returns the judge's
# ORIGINAL dict for every verdict that validates. Nothing is rewritten, no
# field is coerced, and `episode` stays exactly as the model sent it —
# `apply_verdict` is called directly by a lot of tests and by the downgrade
# path with hand-built dicts, so its input contract must not move underneath
# it. A validation layer that silently normalised its way into the applier
# would be a second, divergent definition of the same thing.
#
# Unknown extra keys are allowed on purpose: the prompt advertises more fields
# than any one action uses, and a model that volunteers a `reason` on a
# `memory` verdict is being helpful, not malformed.


class _VerdictBase(BaseModel):
    """Fields every verdict shares.

    `episode` is `int | str` because the prompt asks for an id and real
    judges send both `3` and `"3"`; the applier and `set_judge_verdict`
    already tolerate either, so narrowing here would reject a usable verdict.
    """

    model_config = ConfigDict(extra='allow')

    episode: int | str
    reason: str = ''


class _NoneVerdict(_VerdictBase):
    """Nothing durable to learn. Always valid — that is the point of it."""

    action: Literal['none'] = 'none'


class _MemoryVerdict(_VerdictBase):
    """`summary` is the whole payload; a memory verdict without one is empty.

    `title` stays optional because `apply_verdict` derives a key from the
    summary when there is no title, and that fallback is load-bearing.

    `category` and `expires_days` are deliberately NOT constrained. The
    applier already owns both: it defaults a missing/empty category to
    'general' and ignores an `expires_days` that is not a number. Typing
    either more tightly here would not catch a bad value — it would DROP a
    verdict whose summary is perfectly good, losing a real lesson over a
    display label. The vocabulary the judge prompt advertises is documented
    in _JUDGE_SYSTEM; it is not a reason to discard work.
    """

    action: Literal['memory']
    summary: str = Field(min_length=1)
    title: str = ''
    category: str = 'general'
    expires_days: Any = None


class _CreateSkillVerdict(_VerdictBase):
    """A new skill draft.

    Only `name` is required. `description` is NOT: the applier falls back to
    `description or name`, and a judge that omits it today gets a perfectly
    good draft. Requiring it here would silently stop producing those.

    The body-shape fields are typed `Any` and default to None ON PURPOSE. This
    layer exists to drop a verdict whose ACTION cannot be honoured; a missing or
    oddly-shaped section means a THIN skill, which `apply_verdict` decides about
    explicitly (downgrade to memory) rather than discarding. A strict `list[str]`
    here would reject a judge that sent one plain string for `when_to_use` —
    losing a real draft over a shape the renderer can handle. The renderer
    coerces; the gate judges substance.
    """

    action: Literal['create_skill']
    name: str = Field(min_length=1)
    description: str = ''
    trigger: str = ''
    body_markdown: str = ''
    title: str = ''
    intro: Any = None
    when_to_use: Any = None
    when_not_to_use: Any = None
    prerequisites: Any = None
    steps: Any = None
    pitfalls: Any = None
    verification: Any = None
    keywords: Any = None


class _AmendTriggerVerdict(_VerdictBase):
    """Rewrites an EXISTING skill's trigger — both halves are the whole edit."""

    action: Literal['amend_trigger']
    skill: str = Field(min_length=1)
    trigger: str = Field(min_length=1)


class _AmendBodyVerdict(_VerdictBase):
    """Appends a section to an existing skill. An empty patch is a no-op that
    would still burn a proposal slot and a human's attention."""

    action: Literal['amend_body']
    skill: str = Field(min_length=1)
    patch_markdown: str = Field(min_length=1)


VERDICT_MODELS: dict[str, type[_VerdictBase]] = {
    'none': _NoneVerdict,
    'memory': _MemoryVerdict,
    'create_skill': _CreateSkillVerdict,
    'amend_trigger': _AmendTriggerVerdict,
    'amend_body': _AmendBodyVerdict,
}


# ── drafting helpers ─────────────────────────────────────────────────────

# The section fields `renderSkillBody` reads, in body order. Kept as one list
# because the denylist scan and the renderer must see the same set — a drafted
# pitfall that never reaches the denylist is how a health detail gets into a
# skill file.
_DRAFT_FIELDS = (
    'title',
    'intro',
    'when_to_use',
    'when_not_to_use',
    'prerequisites',
    'steps',
    'pitfalls',
    'verification',
    'keywords',
)

def _draftText(value: object) -> str:
    """Every string inside a drafted field, flattened — for the denylist scan."""
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        return ' '.join(_draftText(v) for v in value.values())
    if isinstance(value, (list, tuple, set)):
        return ' '.join(_draftText(v) for v in value)
    return '' if value is None else str(value)


def _fitDescription(raw: str) -> tuple[str, str]:
    """``(usable description, problem)`` — problem is '' when there is none.

    ``_apply_skill_write`` re-validates the description at APPROVAL time, so a
    drafted one over the 60-char authoring cap filed a proposal that was
    unapprovable by construction: the human clicked Approve and got an error.
    Length is a drafting accident and is repairable at a clause boundary. A
    banned marketing word is a CLAIM, not a typo, so it is reported rather than
    quietly rewritten out of the operator's text.
    """
    from app.services.skill_service import (
        SkillValidationError,
        _DESCRIPTIONMax,
        _validateDescription,
    )

    text = (raw or '').strip()
    try:
        _validateDescription(text)
        return text, ''
    except SkillValidationError as exc:
        problem = str(exc)
    if 'exceeds' not in problem:
        return '', problem
    cut = text[: _DESCRIPTIONMax - 1]
    for sep in ('. ', '; ', ', ', ' '):
        idx = cut.rfind(sep)
        if idx >= 24:
            cut = cut[:idx]
            break
    # One period, whatever the cut landed on: the separator may itself have been
    # a sentence end, and `Something..` is not a description.
    fitted = cut.strip().rstrip(' ,;.') + '.'
    try:
        _validateDescription(fitted)
    except SkillValidationError as exc:
        return '', str(exc)
    return fitted, ''


def _draftKeywords(value: object) -> str:
    """The judge's keyword field as the scalar `parse_keywords` reads.

    `_draftText` flattens for the denylist scan; keywords are a LIST, and a
    space-joined flatten parses as one long keyword that matches nothing.
    """
    items = (
        list(value)
        if isinstance(value, (list, tuple, set))
        else re.split(r'[,\n]', str(value or ''))
    )
    return ', '.join(str(item).strip() for item in items if str(item).strip())


def _asLessonVerdict(verdict: dict[str, Any], name: str, description: str) -> dict[str, Any]:
    """A refused skill draft, re-aimed at the memory store instead of dropped.

    The episode still taught something; it just was not a procedure. Before the
    substance bar existed the same verdict shipped as a padded one-sentence
    "skill", and dropping it entirely would have thrown the lesson away — so the
    downgrade keeps what the draft actually said (the description plus the first
    step, which is the actionable half) and files it where a rule belongs.
    """
    summary = str(verdict.get('summary') or '').strip()
    if not summary:
        first = ''
        steps = verdict.get('steps')
        if isinstance(steps, list) and steps:
            head = steps[0]
            if isinstance(head, dict):
                do = str(head.get('do') or head.get('step') or '').strip()
                cmd = str(head.get('command') or '').strip()
                first = f'{do}: {cmd}' if do and cmd else (do or cmd)
            else:
                first = str(head or '').strip()
        summary = '; '.join(x for x in ((description or name).strip(), first) if x)
    return {
        **verdict,
        'action': 'memory',
        'summary': summary[:500],
        'title': str(verdict.get('title') or name).strip(),
    }


# ── model resolution ────────


def resolve_judge_full() -> tuple[str, str, str]:
    """``(model, gateway, source)`` for the distiller judge.

    Precedence: the dedicated ``skillLearningJudgeModel``, the ``autoMemoryModel``
    background selector, the fleet's ``hippocampus`` role (the distiller
    piggybacks the consolidation cadence and distills that store), the model the
    user is actually chatting with, then the titler's ``titleModel``. No vendor
    id is baked in anywhere: a blank role means "follow the composer", which is
    what the fleet's own comment promises and what a background pass can now
    actually do.

    The first candidate a gateway really serves wins, because a stale id in one
    setting must not strand the loop — on one install the memory role names a
    Claude model none of its four configured gateways lists, and the judge simply
    never ran while writing no error anywhere. When nothing resolves the first
    candidate comes back anyway, so the caller can name what it tried.
    """
    candidates: list[tuple[str, str, str]] = []

    def add(model: str, provider: str, source: str) -> None:
        if model.strip():
            candidates.append((model.strip(), provider.strip(), source))

    try:
        from app.services.brain_config_service import getRuntimeConfig

        cfg = getRuntimeConfig()
        add(str(cfg.get('skillLearningJudgeModel', '') or ''), '', 'skillLearningJudgeModel')
    except Exception:
        cfg = {}
    try:
        from app.services.background_review_service import resolveSelector

        add(*resolveSelector('autoMemory'), 'autoMemoryModel')
    except Exception:
        pass
    try:
        from app.services.model_fleet_service import composerModel, resolveRoleModel

        add(*resolveRoleModel('hippocampus'), 'fleet:hippocampus')
        add(*composerModel(), 'composer')
    except Exception:
        logger.debug('judge fleet/composer fallback failed', exc_info=True)
    try:
        add(str(cfg.get('titleModel', '') or ''), '', 'titleModel')
    except Exception:
        pass

    for cand in candidates:
        if _resolveProvider(cand[0], cand[1]):
            return cand
    return candidates[0] if candidates else ('', '', 'unconfigured')


def resolve_judge() -> tuple[str, str]:
    """The ``(model, gateway)`` view of :func:`resolve_judge_full`."""
    model, provider, _source = resolve_judge_full()
    return model, provider


def resolve_judge_model() -> str:
    """The model-only view of :func:`resolve_judge`."""
    return resolve_judge()[0]


def judgeStatus() -> dict[str, Any]:
    """Why the distiller is or is not looking at the flagged episodes.

    The loop went silent on an install with twelve episodes flagged for tier 2
    and nothing to explain it: an empty ``resolve_judge()`` is not an error, so
    no lifecycle row was ever written, and the Learning panel showed the
    consolidation job running happily while the half of it that learns sat
    unconfigured. This is the read that makes that state visible.
    """
    model, provider, source = resolve_judge_full()
    pending = 0
    try:
        row = _conn().execute(
            'SELECT COUNT(*) AS n FROM episodes'
            " WHERE tier = 2 AND quarantined = 0"
            "   AND (judge_verdict IS NULL OR judge_verdict = '')"
        ).fetchone()
        pending = int(row['n']) if row else 0
    except Exception:
        logger.debug('distiller pending-episode count failed', exc_info=True)
    if not model:
        state, reason = 'unconfigured', (
            'No judge model resolves. Set "Judge model" under Settings → Skills, or '
            'configure the auto-memory selector or a fleet role — chatting with any '
            'model works too, since the composer choice is the default.'
        )
    elif not _resolveProvider(model, provider):
        state, reason = 'no-provider', (
            f'No configured gateway serves {model!r}, so the judge cannot be called.'
        )
    else:
        state, reason = 'ready', ''
    try:
        from app.services.brain_config_service import getRuntimeConfig

        mode = str(getRuntimeConfig().get('skillLearning', 'propose') or 'propose')
    except Exception:
        mode = 'propose'
    return {
        'state': state,
        'reason': reason,
        'model': model,
        'provider': provider,
        'source': source,
        'mode': mode,
        'pendingEpisodes': pending,
        'inCooldown': _in_cooldown(),
    }


def _resolveProvider(model: str, provider_hint: str = '') -> dict[str, object] | None:
    if not model:
        return None
    try:
        from app.providers import resolver as providerResolver

        # A configured gateway first: asked for a bare id, ``resolve()`` answers
        # with the first provider that lists it, which is a different provider
        # for a model served by two gateways.
        return providerResolver.resolve(provider_hint or model)
    except Exception:
        logger.debug('judge provider resolve failed for %r', model, exc_info=True)
        return None


# ── judge I/O ────────────────────────────────────────────────────────────


def _skillIndex() -> list[dict[str, str]]:
    """Titles/descriptions ONLY — the judge never sees full bodies."""
    try:
        from app.services.skill_service import list_all

        return [
            {
                'name': str(s.get('name', '')),
                'description': str(s.get('description', '')),
            }
            for s in list_all()
        ]
    except Exception:
        return []


def _actionTimeline(ep: dict[str, Any]) -> str:
    """The window's tool calls IN ORDER — including the ones that worked.

    ``events`` carries only failures, on purpose: it is the fingerprint
    substrate in episode_miner (``_episodeText`` joins every excerpt into the
    dedupe token set), and a fingerprint that included successful calls would
    merge unrelated work. The cost was that the judge could never see the
    RECOVERY — the call that actually solved it, with its arguments — so a
    draft could only restate the error and the user's correction. That is the
    mechanical reason learned skills read like one-line rules: the procedure
    was never in the evidence.

    Read at judge time from the same ``blocks_json`` the UI timeline renders,
    so mining, scoring and fingerprints stay exactly as they are.
    """
    sessionId = str(ep.get('session_id') or '')
    start = ep.get('start_message_id')
    end = ep.get('end_message_id')
    if not sessionId or start is None or end is None:
        return ''
    try:
        rows = _conn().execute(
            'SELECT blocks_json FROM messages'
            ' WHERE session_id = ? AND id >= ? AND id <= ? ORDER BY id',
            (sessionId, int(start), int(end)),
        ).fetchall()
    except Exception:
        logger.debug('distiller timeline read failed for %s', ep.get('id'), exc_info=True)
        return ''
    from app.services.memory_store.transcript_blocks import decode_blocks

    lines: list[str] = []
    for row in rows:
        try:
            blocks = decode_blocks(row['blocks_json']).get('blocks')
        except Exception:
            continue
        if not isinstance(blocks, list):
            continue
        for block in blocks:
            if not isinstance(block, dict) or block.get('type') != 'toolCall':
                continue
            tool = block.get('tool')
            if not isinstance(tool, dict):
                continue
            name = str(tool.get('name') or '').strip()
            if not name:
                continue
            args = str(tool.get('args') or '').strip().replace('\n', ' ')
            status = str(tool.get('status') or 'running')
            if len(args) > _TIMELINE_LINE_CAP:
                args = args[:_TIMELINE_LINE_CAP] + '…'
            lines.append(f'  - {name}({args}) -> {status}')
    if not lines:
        return ''
    if len(lines) > _TIMELINE_MAX_LINES:
        # Keep the head AND the tail: in a failure→recovery window the fix is
        # the last call, and a head-only cut would drop exactly the step the
        # skill needs to record.
        head = lines[: _TIMELINE_MAX_LINES // 2]
        tail = lines[-(_TIMELINE_MAX_LINES - len(head)) :]
        hidden = len(lines) - len(head) - len(tail)
        lines = head + [f'  … {hidden} further call(s) not shown …'] + tail
    return '\n'.join(lines)


def _episodeWindow(ep: dict[str, Any]) -> str:
    events = ep.get('events')
    if isinstance(events, str):
        try:
            events = json.loads(events)
        except Exception:
            events = []
    lines = [f"episode {ep.get('id')} [{ep.get('kind')}] outcome={ep.get('outcome')}"]
    for e in events or []:
        excerpt = str(e.get('excerpt', ''))[:_EXCERPT_CAP]
        lines.append(f"  - {e.get('type')}: {excerpt}")
    timeline = _actionTimeline(ep)
    if timeline:
        lines.append('  tool calls in order (this is what the procedure must be built from):')
        lines.append(timeline)
    return '\n'.join(lines)


def build_judge_prompt(batch: list[dict[str, Any]]) -> str:
    skills = _skillIndex()
    skillLines = '\n'.join(
        f"- {s['name']}: {s['description'][:160]}" for s in skills[:40]
    ) or '(no skills yet)'
    windows = '\n\n'.join(_episodeWindow(ep) for ep in batch)
    return (
        f'Existing skills (titles/descriptions only):\n{skillLines}\n\n'
        f'Flagged episode windows:\n{windows}\n\n'
        'Return verdicts for every episode id above.'
    )


def _extractJson(raw: str) -> dict[str, Any]:
    """Strict JSON out — tolerate a code fence, nothing else."""
    text = (raw or '').strip()
    fence = re.search(r'```(?:json)?\s*(\{.*\})\s*```', text, re.DOTALL)
    if fence:
        text = fence.group(1)
    data = json.loads(text)
    if not isinstance(data, dict) or not isinstance(data.get('verdicts'), list):
        raise ValueError('judge JSON missing verdicts array')
    return data


def parse_verdicts(
    data: dict[str, Any],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Split one judge payload into (applicable, dropped).

    ``applicable`` holds the judge's ORIGINAL dicts, untouched. ``dropped``
    describes each verdict that could not be applied and why, so a pass can
    report what it threw away instead of silently applying half of it.

    Dropping is per-verdict, not per-batch: one malformed verdict in a batch
    of five must not cost the other four, and one bad field must not cost the
    rest of that verdict. An action the judge invented outright (``"rewrite_
    everything"``) is dropped with the same accounting as a missing field.
    """
    applicable: list[dict[str, Any]] = []
    dropped: list[dict[str, Any]] = []
    for raw in data.get('verdicts', []) or []:
        if not isinstance(raw, dict):
            dropped.append({'action': None, 'episode': None, 'why': 'verdict is not an object'})
            continue
        action = str(raw.get('action', 'none') or 'none').strip().lower()
        model = VERDICT_MODELS.get(action)
        if model is None:
            dropped.append(
                {
                    'action': action or None,
                    'episode': raw.get('episode'),
                    'why': f'unknown action {action!r}',
                }
            )
            continue
        try:
            model.model_validate(raw)
        except ValidationError as exc:
            missing = [
                '.'.join(str(p) for p in e['loc']) or '<root>'
                for e in exc.errors()
                if e['type'] in ('missing', 'string_too_short')
            ]
            dropped.append(
                {
                    'action': action,
                    'episode': raw.get('episode'),
                    'why': f'invalid {action} verdict: ' + ', '.join(missing or ['schema mismatch']),
                }
            )
            continue
        applicable.append(raw)
    return applicable, dropped


# ── why the judge did not answer ────────────────────────────────────────────
# The pass used to collapse every outcome into a bare `None`, log a warning, and
# burn a 30-minute cooldown labelled `distiller_judge_failed`. Measured on a real
# install: 13 such rows, each detail exactly {batchSize, cooldownUntil} — the
# CAUSE was never persisted, so a month of failing passes stayed undiagnosable,
# and a pure configuration fault hid among transient ones.
JUDGE_CONFIG_FAILURES: frozenset[str] = frozenset(
    {'no-judge-model', 'no-provider', 'no-client'}
)
_judgeFailure: tuple[str, str] | None = None


def _note_judge_failure(reason: str, error: str = '') -> None:
    global _judgeFailure
    _judgeFailure = (reason, (error or '')[:300])


def _noteMemoryDrop(reason: str, episode: object, text: str) -> None:
    """Record a refused lesson where a human can find it.

    A silent drop is indistinguishable from a loop that never ran — the failure
    this whole file has kept re-discovering. The turn-outcome promotion door
    already writes `lesson_promotion_skipped`; this is the same record for the
    same event at the other automatic door.
    """
    logger.info('distiller memory verdict dropped (%s): %s', reason, text[:120])
    try:
        from app.services.memory_store import record_lifecycle

        record_lifecycle(
            '',
            'distiller_memory_dropped',
            {'reason': reason, 'episode': episode, 'text': text[:160]},
        )
    except Exception:
        logger.debug('distiller memory drop could not be recorded', exc_info=True)


def take_judge_failure() -> tuple[str, str]:
    """Read and clear why the last judge call did not answer."""
    global _judgeFailure
    out = _judgeFailure or ('unknown', '')
    _judgeFailure = None
    return out


async def call_judge(prompt: str) -> dict[str, Any] | None:
    """One judge model call. Returns parsed JSON or None (judge failed).

    §12 F-7: uses an UNPOOLED client, closed after the call — judge batches
    run on throwaway event loops (one ``asyncio.run`` per pass), and a
    pooled client's keep-alive connections bind to the loop that made them,
    so the next pass hits "Event loop is closed" every other time.

    A payload whose verdicts ALL fail validation earns exactly ONE repair
    retry, because "your JSON did not match" is the one judge failure the
    model can actually fix on a second look. The retry is not attempted when
    some verdicts already validated: a partially-good batch is a working
    batch, and re-rolling it would throw away correct answers to chase a
    cosmetic improvement. A second failure returns the payload as-is and lets
    ``parse_verdicts`` drop whatever is still malformed.
    """
    model, judge_provider = resolve_judge()
    provider = _resolveProvider(model, judge_provider)
    if not model:
        _note_judge_failure('no-judge-model', 'skillLearningJudgeModel resolves to nothing')
        logger.info('distiller judge skipped: no judge model resolves')
        return None
    if not provider:
        _note_judge_failure('no-provider', 'no provider serves ' + repr(model))
        logger.info('distiller judge skipped: no provider for %r', model)
        return None
    try:
        from app.providers.clients import getUnpooledClient

        client = getUnpooledClient(provider)
        if not client:
            _note_judge_failure('no-client', 'provider has no client')
            return None
        try:
            client.config = {
                **dict(client.config or {}),
                'model': model,
                # One reply carries up to five verdicts, and a create_skill
                # verdict is now a whole drafted body. The native Anthropic
                # client's default output cap truncates that mid-JSON, which
                # fails the batch and burns the cooldown.
                'max_tokens': _JUDGE_MAX_TOKENS,
            }
            raw = await client.generate(prompt, system=_JUDGE_SYSTEM)
            try:
                data = _extractJson(str(raw))
            except Exception as exc:
                # The shape measured on this install: the provider answered with
                # an EMPTY body (no exception at all), so parsing raised and the
                # whole thing was labelled "judge failed" with no cause kept.
                _note_judge_failure(
                    'unparseable-response',
                    type(exc).__name__ + ': ' + str(exc) + ' | body=' + repr(str(raw)[:120]),
                )
                return None
            applicable, _dropped = parse_verdicts(data)
            if not applicable and data.get('verdicts'):
                # Every verdict was unusable — the shape was wrong, not the
                # content. Ask once more, naming what failed.
                _, dropped = parse_verdicts(data)
                repair = _repair_prompt(prompt, dropped)
                logger.info('distiller judge: %d invalid verdict(s), one repair retry', len(dropped))
                raw2 = await client.generate(repair, system=_JUDGE_SYSTEM)
                return _extractJson(str(raw2))
            return data
        finally:
            try:
                await client.close()
            except Exception:
                pass
    except Exception as exc:
        _note_judge_failure('request-failed', type(exc).__name__ + ': ' + str(exc))
        logger.warning('distiller judge call failed: %s', exc)
        return None


def _repair_prompt(prompt: str, dropped: list[dict[str, Any]]) -> str:
    """The original prompt plus the specific schema failures, for one retry."""
    problems = '; '.join(str(d.get('why', '')) for d in dropped[:8])
    return (
        f'{prompt}\n\n'
        f'Your previous reply could not be used: {problems}. '
        'Reply again with the SAME verdicts object, correcting only those '
        'fields so every verdict carries the fields its action requires. '
        'Strict JSON only.'
    )


# ── anti-drift: one draft per (fingerprint, action, target) ─────────────


def _draftExists(fp: str, action: str, target: str) -> bool:
    """One draft per (fingerprint, action, target) — across ALL statuses.

    §12 F-8: matching only ``open`` meant a human-REJECTED suggestion
    re-filed on every pass (the queue refilled with rejected noise), and an
    APPLIED draft could be filed again. Anti-drift (plan §3.4): once the
    judge has produced a draft for a fingerprint/action/target, the loop
    never re-files it."""
    try:
        from app.services.harness_self_improve import list_proposals

        for p in list_proposals():
            payload = p.get('payload')
            if not isinstance(payload, dict):
                continue
            if (
                str(payload.get('fingerprint', '')) == fp
                and str(payload.get('action', '')) == action
                and str(payload.get('target', '')) == target
            ):
                return True
    except Exception:
        pass
    return False


# ── precision ship bar ───────


def _precisionRow(labeled: int, correct: int) -> dict[str, Any]:
    """One bucket's numbers plus the verdict the ship bar reaches."""
    labeled = int(labeled)
    correct = int(correct)
    precision = (correct / labeled) if labeled else 0.0
    return {
        'labeled': labeled,
        'correct': correct,
        'precision': round(precision, 4),
        'enabled': labeled >= _PRECISION_MIN_LABELED and precision >= _PRECISION_SHIP_BAR,
    }


def precision_state() -> dict[str, Any]:
    """Judge precision over hand-labeled episodes (test_distiller_precision
    harness feeds this store). ``amend_body_enabled`` is the ship bar.

    The top-level counters are the ALL-ACTIONS figure and stay exactly as
    they were: existing harnesses record one (labeled, correct) pair per run
    and read ``amendBodyEnabled`` off it. Per-action buckets are additive and
    FALL BACK to those global numbers for any action with no samples of its
    own, so an install that has never recorded a breakdown behaves exactly as
    it did before rather than reading every action as 0-labeled and locked.

    Per-action is what makes the bar actionable: a judge that is excellent at
    ``memory`` and hopeless at ``amend_body`` should not have the second
    dragged along by the first, and under one global bar the only way to
    raise ``amend_body`` precision was to get better at everything else.
    """
    try:
        from app.lib.paths import dataPath

        path = dataPath('skill_learning_precision.json')
        data = json.loads(path.read_text('utf-8')) if path.exists() else {}
    except Exception:
        data = {}
    labeled = int(data.get('labeled', 0))
    correct = int(data.get('correct', 0))
    overall = _precisionRow(labeled, correct)

    raw_by_action = data.get('byAction')
    byActionRaw: dict[str, Any] = raw_by_action if isinstance(raw_by_action, dict) else {}
    byAction: dict[str, dict[str, Any]] = {}
    for action in VERDICT_MODELS:
        row = byActionRaw.get(action)
        if not isinstance(row, dict):
            # No samples for this action yet — it inherits the global figure
            # rather than reporting an empty bucket that reads as "0%".
            byAction[action] = dict(overall)
        else:
            byAction[action] = _precisionRow(row.get('labeled', 0), row.get('correct', 0))

    return {
        'labeled': labeled,
        'correct': correct,
        'precision': overall['precision'],
        'amendBodyEnabled': bool(byAction['amend_body']['enabled']),
        'byAction': byAction,
    }


def record_precision_run(
    labeled: int,
    correct: int,
    per_action: dict[str, dict[str, int]] | None = None,
) -> dict[str, Any]:
    """Accumulate one harness run into the precision store.

    ``per_action`` is optional and additive: a harness that knows which action
    each labeled episode was judged as passes ``{action: {'labeled': n,
    'correct': n}}`` and gets per-action gates. One that does not keeps the
    single global bar it has always had.
    """
    from app.lib.paths import dataPath

    path = dataPath('skill_learning_precision.json')
    try:
        data = json.loads(path.read_text('utf-8')) if path.exists() else {}
    except Exception:
        data = {}
    data['labeled'] = int(data.get('labeled', 0)) + int(labeled)
    data['correct'] = int(data.get('correct', 0)) + int(correct)

    if per_action:
        byAction = data.get('byAction')
        if not isinstance(byAction, dict):
            byAction = {}
        for action, counts in per_action.items():
            if action not in VERDICT_MODELS or not isinstance(counts, dict):
                continue
            row = byAction.get(action)
            if not isinstance(row, dict):
                row = {'labeled': 0, 'correct': 0}
            row['labeled'] = int(row.get('labeled', 0)) + int(counts.get('labeled', 0))
            row['correct'] = int(row.get('correct', 0)) + int(counts.get('correct', 0))
            byAction[action] = row
        data['byAction'] = byAction

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data), 'utf-8')
    return precision_state()


# ── verdict application ──────────────────────────────────────────────────


def _isBundledSkill(name: str) -> bool:
    try:
        from app.services.skill_service import SKILLS_DIR

        return (SKILLS_DIR / name).is_dir()
    except Exception:
        return False


def _readSkillMd(path: Path) -> tuple[str, str] | None:
    """(description, body) of one SKILL.md, or None when there is no file.

    Both roots are read the same way: an amendment needs the CURRENT text of the
    skill it targets, whichever tree it lives in.
    """
    try:
        md = path / 'SKILL.md'
        if not md.is_file():
            return None
        text = md.read_text('utf-8')
    except Exception:
        return None
    description = ''
    body = text
    if text.startswith('---'):
        try:
            _, fm, rest = text.split('---', 2)
            for line in fm.split('\n'):
                if line.strip().startswith('description:'):
                    description = line.partition(':')[2].strip().strip('"').strip("'")
            body = rest.lstrip('\n')
        except ValueError:
            body = text
    return description, body


def _learnedSkillText(name: str) -> tuple[str, str] | None:
    """(description, current body) of a LEARNED skill — the amend_body
    target. None when the skill doesn't exist (bundled skills are handled
    by the caller before this)."""
    try:
        from app.services.skill_service import _agentSkillsDir

        return _readSkillMd(_agentSkillsDir() / name)
    except Exception:
        return None


def _bundledSkillText(name: str) -> tuple[str, str] | None:
    """(description, current body) of a BUNDLED skill — the `-revised` draft's
    starting text. Bundled skills are never amended in place, so a revision that
    could not read the original would be inventing it."""
    try:
        from app.services.skill_service import SKILLS_DIR

        return _readSkillMd(SKILLS_DIR / name)
    except Exception:
        return None


def _evidenceWindow(verdict: dict[str, Any], episode_id: Any) -> str:
    """The episode as the judge saw it, attached to the proposal for the human.

    The evidence line used to be built from `verdict['events']` — a key the
    judge never sends — so it came out empty for every real draft. A reviewer
    approving a skill body had no sight of the failure that produced it.
    """
    row = None
    if episode_id is not None:
        try:
            row = _conn().execute(
                'SELECT * FROM episodes WHERE id = ?', (episode_id,)
            ).fetchone()
        except Exception:
            logger.debug('distiller evidence read failed for %r', episode_id, exc_info=True)
    if row is not None:
        return _episodeWindow(dict(row))[:4000]
    return _episodeWindow(
        {'id': episode_id, 'kind': '', 'outcome': '', 'events': verdict.get('events') or []}
    )[:4000]


def apply_verdict(
    verdict: dict[str, Any], fingerprint: str, mode: str = 'propose', scope: str = ''
) -> str:
    """Apply one judge verdict. Returns a short result label.

    ``mode``: ``propose`` (ship default) files skill verdicts into the inbox
    and stops; ``full`` lets a drafted skill be acted on; ``extract-only``
    refuses skill drafting entirely; ``off`` never reaches here.
    ``scope``: the M-2 scope of the source episode (Part 26 6.4) — a Bot's
    distilled lessons land in the Bot's own memory home instead of global.
    """
    action = str(verdict.get('action', 'none') or 'none').strip().lower()
    episodeId = verdict.get('episode')

    # extract-only is the mode that never lets a skill verdict become a draft.
    # 'propose' files the verdict into the inbox and stops — those branches end
    # at save_proposal and return 'proposal-filed', so nothing here applies a
    # change; the human still decides through decide_proposal.
    if action in ('create_skill', 'amend_trigger', 'amend_body') and mode == 'extract-only':
        return 'skipped-extract-only'

    if action == 'memory':
        from app.services.memory_store import save_fact
        from app.services.sensitive_topics import isSensitiveMemory
        from app.services.session_scope import GLOBAL_SCOPE, normalize_scope

        summary = str(verdict.get('summary', '')).strip()
        title = str(verdict.get('title', '')).strip()
        if not summary or isSensitiveMemory(summary, title):
            return 'rejected-denylist'
        factScope = normalize_scope(scope) if (scope or '').strip() else GLOBAL_SCOPE
        # The memory bar. Everything before this checked what the text was MADE
        # of (non-empty, not sensitive); nothing checked that it is a memory.
        # This door writes straight into the store with no human in the loop —
        # unlike the skill doors, which file a proposal — so an unguarded write
        # is how the store fills with task-state nobody asked for.
        from app.services.memory_quality import DEDUPE_SIMILARITY, duplicateOf, memoryIsJunk

        junk = memoryIsJunk(summary)
        if junk:
            _noteMemoryDrop(junk, episodeId, summary)
            return 'dropped-not-durable'
        ratio, dupKey = duplicateOf(summary, scope=factScope)
        if ratio >= DEDUPE_SIMILARITY:
            _noteMemoryDrop(f'already known (matches {dupKey!r} at {ratio:.2f})', episodeId, summary)
            return 'dropped-duplicate'
        expiresDays = verdict.get('expires_days')
        expiresAt = (
            (datetime.now(timezone.utc) + timedelta(days=int(expiresDays))).date().isoformat()
            if isinstance(expiresDays, (int, float)) and int(expiresDays) > 0
            else None
        )
        key = re.sub(r'[^a-z0-9-]+', '-', (title or summary).lower()).strip('-')[:48] or 'distilled-lesson'
        save_fact(
            f'distilled:{key}',
            summary,
            category=str(verdict.get('category', 'general') or 'general'),
            source='harness',
            kind='lesson',
            expires_at=expiresAt,
            title=title,
            scope=factScope,
        )
        return 'memory-saved'

    if action in ('create_skill', 'amend_trigger', 'amend_body'):
        # §3.3 denylist: applies to EVERY drafted text before persist —
        # description/body/trigger of skill drafts and amend patches, not just
        # memory verdicts. A health/ID/belief detail must not survive inside a
        # skill file just because the verdict's action was skill-shaped.
        from app.services.sensitive_topics import isSensitiveMemory

        _sensitive_blob = ' '.join(
            str(verdict.get(k, '') or '')
            for k in ('description', 'body_markdown', 'trigger', 'patch_markdown')
        )
        # The structured section fields are drafted text too. A judge that puts
        # the health detail in `pitfalls` instead of `body_markdown` used to walk
        # straight past this gate, since only the flat keys were scanned.
        _sensitive_blob += ' ' + ' '.join(
            _draftText(verdict.get(key)) for key in _DRAFT_FIELDS
        )
        if isSensitiveMemory(_sensitive_blob):
            return 'rejected-denylist'

    if action in ('create_skill', 'amend_trigger'):
        # Bundled skills are never amended in place — an amend against one
        # becomes a FRESH draft referencing it (supersedes lineage). The
        # lineage has to come with the ORIGINAL TEXT: an amend_trigger carries
        # no body, and normalizing the empty one filled the `-revised` draft
        # with placeholder prose that superseded — and disabled — a real
        # hand-written skill on approval.
        if action == 'amend_trigger' and _isBundledSkill(str(verdict.get('skill', '')).strip()):
            skillName = str(verdict.get('skill', '')).strip()
            original = _bundledSkillText(skillName)
            verdict = {
                **verdict,
                'action': 'create_skill',
                'name': f'{skillName}-revised',
                'supersedes': skillName,
                'description': verdict.get('description') or (original[0] if original else '') or skillName,
                'body_markdown': (original[1] if original else ''),
            }
            action = 'create_skill'
        from app.services.harness_self_improve import save_proposal
        from app.services.skill_service import (
            SkillValidationError,
            _ensure_canonical_body,
            _validateName,
            bodySubstance,
            renderSkillBody,
        )

        name = str(verdict.get('name', '') or verdict.get('skill', '')).strip()
        description = str(verdict.get('description', '')).strip()
        body = str(verdict.get('body_markdown', '')).strip()
        trigger = str(verdict.get('trigger', '')).strip()
        target = name
        try:
            _validateName(name)
        except SkillValidationError as exc:
            logger.info('distiller draft refused: %s', exc)
            return 'rejected-name'
        if _draftExists(fingerprint, action, target):
            return 'duplicate-draft'
        description, descProblem = _fitDescription(description or name)
        if descProblem:
            logger.info('distiller draft is a rule, not a skill: %s', descProblem)
            return apply_verdict(
                _asLessonVerdict(verdict, name, description), fingerprint, mode, scope=scope
            )
        if action == 'create_skill':
            # The judge's own markdown wins when it wrote any: honouring the
            # structured fields over a hand-written body would throw away real
            # prose to enforce a template.
            authored = body or renderSkillBody(
                name,
                description,
                {key: verdict.get(key) for key in _DRAFT_FIELDS if key in verdict},
            )
            body = authored
            # Measured on what was DRAFTED, before the normalizer runs: padding
            # is exactly what let a one-line rule pass for a skill, so scoring
            # the padded result would score the template rather than the work.
            thin = (
                bodySubstance(name, description, authored)
                if authored.strip()
                else 'no skill body drafted'
            )
            if thin:
                logger.info('distiller draft is a rule, not a skill: %s', thin)
                return apply_verdict(
                    _asLessonVerdict(verdict, name, description), fingerprint, mode, scope=scope
                )
        else:
            # amend_trigger carries no body. Normalizing an empty one used to
            # build description-derived PLACEHOLDER text into payload.body, and
            # `_apply_skill_write` writes payload.body OVER the target — so
            # approving a trigger patch replaced a real skill's procedure with
            # boilerplate. Carry the current body through instead; a patch that
            # changes only when a skill fires must not change what it says.
            prior = _learnedSkillText(name)
            if prior is None:
                logger.info('distiller amend_trigger: %r is not a learned skill', name)
                return 'rejected-unknown-skill'
            body = prior[1]
        normalized = _ensure_canonical_body(body, name=name, description=description, is_learned=True)
        try:
            save_proposal(
                problem=f'distiller {action} for fingerprint {fingerprint} (episode {episodeId})',
                evidence=_evidenceWindow(verdict, episodeId)
                or f'flagged fingerprint {fingerprint}',
                proposal=(f'{action}: {name}' + (f' — {description}' if description else ''))[:4000],
                rollback=(
                    f'skill_delete proposal for {name!r} or hand-delete the skill dir; '
                    'the draft never took effect until a human approved it.'
                ),
                kind='skill_create' if action == 'create_skill' else 'skill_patch',
                expected_metric='recurrence stops within 30 days of approval',
                payload={
                    'name': name,
                    'description': description or name,
                    'body': normalized,
                    'trigger': trigger,
                    # The judge's own tags, so approval does not spend a second
                    # model call re-inventing them (`_apply_skill_write` falls
                    # back to keyword expansion only when this is empty).
                    'keywords': _draftKeywords(verdict.get('keywords')),
                    'fingerprint': fingerprint,
                    'action': action,
                    'target': target,
                    'origin': 'distilled',
                    'episodeIds': [episodeId] if episodeId is not None else [],
                    'supersedes': str(verdict.get('supersedes', '') or ''),
                },
            )
        except ValueError as exc:
            logger.info('distiller draft proposal refused: %s', exc)
            return 'refused'
        # The fingerprint's status clock starts at ship time, not
        # at the last mined occurrence.
        try:
            from app.services.episode_miner import set_fingerprint_status

            set_fingerprint_status(fingerprint, 'skill_drafted')
        except Exception:
            pass
        return 'proposal-filed'

    if action == 'amend_body':
        # Human-authored bodies are off-limits until the precision
        # ship bar is met. §12 F-5: the downgrade MUST NOT file an
        # approvable skill_patch — its payload has no body, and approving
        # that used to overwrite the target SKILL.md with placeholder
        # canonical text. Downgrades are review-only observations.
        state = precision_state()
        skill = str(verdict.get('skill', '')).strip()
        if not state['amendBodyEnabled']:
            if skill and not _draftExists(fingerprint, 'amend_body_downgrade', skill):
                from app.services.harness_self_improve import save_proposal

                save_proposal(
                    problem=f'amend_body downgrade for {skill!r} (precision bar unmet: '
                    f"{state['precision']} over {state['labeled']} labels)",
                    evidence=f'flagged fingerprint {fingerprint}',
                    proposal=str(verdict.get('patch_markdown', ''))[:4000] or 'no patch text',
                    rollback='reject the observation; the existing skill body is untouched.',
                    kind='observation',
                    payload={
                        'name': skill,
                        'fingerprint': fingerprint,
                        # Distinct dedupe key from a GENUINE amend_trigger: the
                        # observation is review-only and must never consume
                        # (fp, 'amend_trigger', skill) — a later real amend
                        # verdict for the same fingerprint+skill would read as
                        # duplicate and be silently dropped. 'amend_body_downgrade'
                        # dedupes this observation against ITSELF across passes
                        # (F-8 re-file suppression preserved).
                        'action': 'amend_body_downgrade',
                        'target': skill,
                        'origin': 'distilled',
                        'note': 'amend_body downgraded — judge precision below ship bar',
                    },
                )
            return 'downgraded-proposal'
        # Ship bar MET: file a REAL skill_patch — still
        # human-approved, never auto-applied. The judge never sees skill
        # bodies, so ``patch_markdown`` is an amendment to APPEND, not a
        # replacement: the parent merges it onto the current body
        # deterministically (nothing is lost on approval).
        if not skill:
            return 'amend_body-no-target'
        if _isBundledSkill(skill):
            # Bundled skills are never amended in place — fresh draft with
            # supersession lineage, same rule as amend_trigger. The lineage is
            # only honest if the revision CONTAINS what it revises: with no body
            # carried through, the create path below normalized an empty one
            # into a `skill_create` proposal whose entire body was placeholder
            # text superseding a real human-written skill.
            original = _bundledSkillText(skill)
            patch = str(verdict.get('patch_markdown', '')).strip()
            if original is None or not patch:
                return 'amend_body-target-missing'
            return apply_verdict(
                {
                    **verdict,
                    'action': 'create_skill',
                    'name': f'{skill}-revised',
                    'supersedes': skill,
                    'description': verdict.get('description') or original[0] or skill,
                    'body_markdown': f'{original[1]}\n\n{patch}'.strip(),
                },
                fingerprint,
                mode,
                scope=scope,
            )
        if _draftExists(fingerprint, 'amend_body', skill):
            return 'duplicate-draft'
        current = _learnedSkillText(skill)
        if current is None:
            return 'amend_body-target-missing'
        desc, body = current
        patch = str(verdict.get('patch_markdown', '')).strip()
        if not patch:
            return 'amend_body-empty-patch'
        merged = f'{body}\n\n{patch}'.strip()
        from app.services.harness_self_improve import save_proposal
        from app.services.skill_service import (
            SkillValidationError,
            _ensure_canonical_body,
            _validateName,
        )

        try:
            _validateName(skill)
        except SkillValidationError as exc:
            logger.info('amend_body refused: %s', exc)
            return 'rejected-name'
        normalized = _ensure_canonical_body(merged, name=skill, description=desc or skill, is_learned=True)
        try:
            save_proposal(
                problem=f'amend_body for {skill!r} (episode {episodeId}, precision '
                f"{state['precision']} over {state['labeled']} labels)",
                evidence=f'flagged fingerprint {fingerprint}',
                proposal=f'amend_body: {skill} — appends the amended section to the current body',
                rollback='reject the patch; the current SKILL.md body is untouched until approval.',
                kind='skill_patch',
                expected_metric='recurrence stops within 30 days of approval',
                payload={
                    'name': skill,
                    'description': desc or skill,
                    'body': normalized,
                    'fingerprint': fingerprint,
                    'action': 'amend_body',
                    'target': skill,
                    'origin': 'distilled',
                    'episodeIds': [episodeId] if episodeId is not None else [],
                },
            )
        except ValueError as exc:
            logger.info('amend_body proposal refused: %s', exc)
            return 'refused'
        try:
            from app.services.episode_miner import set_fingerprint_status

            set_fingerprint_status(fingerprint, 'skill_drafted')
        except Exception:
            pass
        return 'patch-proposal-filed'

    return 'none'


# ── the pass (piggybacks the consolidation cadence) ─────────────────────


def run_distiller_pass(dryRun: bool = False) -> dict[str, Any]:
    """One batched judge pass over flagged tier-2 episodes."""
    from app.services.episode_miner import flagged_episodes, set_judge_verdict

    try:
        from app.services.brain_config_service import getRuntimeConfig

        mode = str(getRuntimeConfig().get('skillLearning', 'propose') or 'propose')
    except Exception:
        mode = 'propose'
    if mode == 'off':
        return {'skipped': 'skillLearning=off'}
    if _in_cooldown():
        return {'skipped': 'judge cooldown'}

    flagged = flagged_episodes(limit=50)
    unjudged = [
        ep
        for ep in flagged
        if not str(ep.get('judge_verdict') or '').strip()
    ]
    if not unjudged:
        return {'batches': 0, 'verdicts': 0}

    results: list[dict[str, Any]] = []
    for i in range(0, min(len(unjudged), _BATCH_SIZE * 4), _BATCH_SIZE):
        batch = unjudged[i : i + _BATCH_SIZE]
        if dryRun:
            results.append({'batch': len(batch), 'dryRun': True})
            continue
        verdicts = _run_batch(batch)
        if verdicts is None:
            # Judge failed: log + cooldown — the batch stays tier-2 unjudged
            # and the pass is skipped until the cooldown expires (no retry
            # storms).
            _cooldown_batch(len(batch))
            results.append({'batch': len(batch), 'judgeFailed': True})
            break
        # P2#16: validate BEFORE anything is applied. A verdict that cannot be
        # applied is dropped here, whole — it never reaches `apply_verdict`,
        # so it can never half-apply (a fact saved from a verdict whose skill
        # half was unusable). `apply_verdict` keeps its own denylist check as
        # the LAST gate before persistence; this layer only ever removes more.
        applicable, dropped = parse_verdicts(verdicts)
        _record_judge_success(len(batch), verdicts)
        for d in dropped:
            results.append({'episode': d.get('episode'), 'label': 'dropped-invalid', 'why': d['why']})
        for v in applicable:
            epId = v.get('episode')
            fpRow = _conn().execute(
                'SELECT fingerprint_id, scope FROM episodes WHERE id = ?', (epId,)
            ).fetchone()
            fp = str(fpRow['fingerprint_id']) if fpRow and fpRow['fingerprint_id'] else 'unknown'
            # The distilled fact lands in the episode's scope —
            # bot-private episodes must not leak lessons into global memory.
            epScope = str(fpRow['scope'] or '') if fpRow and 'scope' in fpRow.keys() else ''
            label = apply_verdict(v, fp, mode, scope=epScope)
            if epId is not None:
                set_judge_verdict(int(epId), json.dumps(v, ensure_ascii=False)[:2000])
            results.append({'episode': epId, 'label': label})
        if dropped:
            logger.info(
                'distiller batch dropped %d invalid verdict(s) of %d',
                len(dropped),
                len(applicable) + len(dropped),
            )
    return {
        'verdicts': len(results),
        'dropped': sum(1 for r in results if r.get('label') == 'dropped-invalid'),
        'results': results,
    }


def _run_batch(batch: list[dict[str, Any]]) -> dict[str, Any] | None:
    """One judge model call over a batch. None = judge failed."""
    import asyncio

    prompt = build_judge_prompt(batch)
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        pass
    else:
        # A live loop (e.g. the runCurator API handler) must NOT
        # block on the judge — but it must not silently skip either. Offload
        # to a worker thread that owns a fresh event loop.
        return _run_batch_off_loop(prompt)
    take_judge_failure()  # clear any stale reason before this batch
    try:
        return asyncio.run(asyncio.wait_for(call_judge(prompt), timeout=_JUDGE_TIMEOUT_S))
    except asyncio.TimeoutError:
        _note_judge_failure('timeout', 'judge exceeded ' + str(_JUDGE_TIMEOUT_S) + 's')
        logger.warning('distiller judge batch timed out after %ss', _JUDGE_TIMEOUT_S)
        return None
    except Exception as exc:
        _note_judge_failure('request-failed', type(exc).__name__ + ': ' + str(exc))
        logger.warning('distiller judge batch failed: %s', exc)
        return None


def _run_batch_off_loop(prompt: str) -> dict[str, Any] | None:
    """Run one judge call on a worker thread. None = judge failed
    or timed out past the grace window."""
    import asyncio
    import threading

    box: dict[str, Any] = {}

    def worker() -> None:
        try:
            box['result'] = asyncio.run(
                asyncio.wait_for(call_judge(prompt), timeout=_JUDGE_TIMEOUT_S)
            )
        except asyncio.TimeoutError:
            _note_judge_failure('timeout', 'judge exceeded ' + str(_JUDGE_TIMEOUT_S) + 's')
            box['result'] = None
        except Exception as exc:
            _note_judge_failure('request-failed', type(exc).__name__ + ': ' + str(exc))
            logger.warning('distiller judge batch failed: %s', exc)
            box['result'] = None

    thread = threading.Thread(target=worker, daemon=True, name='august-distiller-judge')
    thread.start()
    thread.join(_JUDGE_TIMEOUT_S + 15)
    if thread.is_alive():
        # The worker outlived the grace window and is still holding a socket on
        # its own loop. Naming that beats reporting nothing at all.
        _note_judge_failure('timeout', 'judge worker exceeded ' + str(_JUDGE_TIMEOUT_S + 15) + 's')
    return box.get('result')


def _cooldownKey() -> str:
    return 'skill_distiller_judge_cooldown'


def _in_cooldown() -> bool:
    from app.services.memory_store import get_internal_state

    raw = str(get_internal_state(_cooldownKey()) or '')
    if not raw:
        return False
    try:
        return datetime.fromisoformat(raw) > datetime.now(timezone.utc)
    except Exception:
        return False


def _record_judge_success(batchSize: int, verdicts: Any) -> None:
    """One row per judged BATCH — the pass logs no per-verdict write.

    The mirror of ``_cooldown_batch``: without it the lifecycle table could show
    only failures, so "0 successes" was unfalsifiable rather than a measurement.
    Best-effort — a telemetry write must never fail a pass that judged fine.
    """
    from app.services.memory_store import record_lifecycle

    try:
        model = ''
        try:
            model = resolve_judge_model()
        except Exception:
            model = ''
        items = verdicts.get('verdicts') if isinstance(verdicts, dict) else None
        record_lifecycle(
            '',
            'distiller_judge_succeeded',
            {
                'batchSize': batchSize,
                'model': model,
                'verdicts': len(items) if isinstance(items, list) else 0,
            },
        )
    except Exception:
        logger.debug('distiller judge success bookkeeping failed', exc_info=True)


def _cooldown_batch(batchSize: int) -> None:
    """Record WHY the judge did not answer, and only arm a cooldown for a fault
    that a retry could plausibly cure.

    A config failure (`no-judge-model` / `no-provider` / `no-client`) is
    permanent until a human changes something. Cooling down for 30 minutes and
    labelling it "judge failed" is how one install buried a fake model name
    under 13 indistinguishable rows.
    """
    from app.services.memory_store import record_lifecycle, set_internal_state

    reason, error = take_judge_failure()
    try:
        if reason in JUDGE_CONFIG_FAILURES:
            record_lifecycle(
                '',
                'distiller_judge_unavailable',
                {'reason': reason, 'error': error, 'batchSize': batchSize},
            )
            return
        until = datetime.now(timezone.utc) + timedelta(minutes=_JUDGE_COOLDOWN_MIN)
        set_internal_state(_cooldownKey(), until.isoformat())
        record_lifecycle(
            '',
            'distiller_judge_failed',
            {
                'batchSize': batchSize,
                'cooldownUntil': until.isoformat(),
                'reason': reason,
                'error': error,
            },
        )
    except Exception:
        logger.debug('distiller cooldown bookkeeping failed', exc_info=True)
