"""Unified background reflection — the single post-turn learning owner.

Absorbs the former ``self_evolution.py`` (regex corrections/preferences) and
``auto_memory.backgroundReview()`` (frustration detection) into one interval-
gated LLM call that extracts corrections, facts, skills, and frustration.

Design:
- Fires after a turn, **interval-gated** (``ReviewGates.turn_interval``).
- Runs as a background ``asyncio.Task`` (never blocks the response).
- Uses a side LLM call; falls back to the main chat model via providers.py.
- Corrections -> ``learned_heuristics`` (injected into prompt every turn).
- Facts -> ``coreMemory`` KV store.
- Skills -> ``pending_skills`` for user approval before activation.
- Frustration -> brain event for attention flagging.
"""

from __future__ import annotations

import ast
import asyncio
import json
import logging
import re
from dataclasses import dataclass
from typing import Awaitable, Callable, Optional, cast

from app.json_narrowing import as_dict, as_int, as_list, as_str
from app.services import skill_service
from app.type_aliases import JsonValue

log = logging.getLogger(__name__)
_TURNInterval = 3
_TOOLRoundInterval = 6


def _backgroundReviewEnabled() -> bool:
    """Return the explicit background-review switch.

    The default is enabled for compatibility with the existing post-turn
    learning behavior. An explicit UI/config value of false is a hard stop:
    no reflection call and no skill/fact/correction extraction is started.
    """
    try:
        from app.services.background_review_service import getConfig

        return bool(getConfig().get('enabled', True))
    except Exception:
        return True


@dataclass
class ReviewGates:
    turn_interval: int = _TURNInterval
    tool_round_interval: int = _TOOLRoundInterval

    def shouldReview(
        self,
        *,
        sessionTurns: int = 0,
        toolRounds: int = 0,
        lastReviewedAtTurn: int = 0,
        lastReviewedToolRounds: int = 0,
    ) -> bool:
        """Fire when enough NEW turns or NEW tool rounds have accumulated.

        ``toolRounds`` is compared as a delta against ``lastReviewedToolRounds``:
        the cumulative tool-message count never shrinks within a session, so the
        old absolute comparison kept firing on every turn once the session had
        seen ``tool_round_interval`` rounds in total (audit finding).
        """
        if sessionTurns <= 0:
            return False
        turnDelta = sessionTurns - lastReviewedAtTurn
        roundDelta = max(0, toolRounds - lastReviewedToolRounds)
        return turnDelta >= self.turn_interval or roundDelta >= self.tool_round_interval


ReviewClient = Optional[Callable[[list[dict[str, object]]], Awaitable[str]]]


async def tryBackgroundReview(
    session: object,
    messagesSnapshot: list[dict[str, object]],
    *,
    gates: ReviewGates | None = None,
    llm_client: ReviewClient = None,
) -> None:
    """Check gates and, if it is time, fire a background review.

    Called once per turn from the workbench finalizer. The gate check is
    synchronous; the actual review spawns a background ``asyncio.Task`` so
    the user receives the response immediately.
    """
    if not _backgroundReviewEnabled():
        return
    if not messagesSnapshot:
        return
    lastTurn = getattr(session, '_last_reviewed_at_turn', 0)
    sessionTurns = getattr(session, 'messageCount', 0) // 2
    # Auto-compaction shrinks messageCount, which would otherwise wedge the
    # gate below the stored marker; clamp so reviews resume after compaction.
    if lastTurn > sessionTurns:
        lastTurn = sessionTurns
        setattr(session, '_last_reviewed_at_turn', lastTurn)
    toolRounds = len([m for m in messagesSnapshot if as_str(m.get('role')) == 'tool'])
    gates = gates or ReviewGates()
    if not gates.shouldReview(
        sessionTurns=sessionTurns,
        toolRounds=toolRounds,
        lastReviewedAtTurn=lastTurn,
        lastReviewedToolRounds=getattr(session, '_last_reviewed_tool_rounds', 0),
    ):
        return
    setattr(session, '_last_reviewed_at_turn', sessionTurns)
    setattr(session, '_last_reviewed_tool_rounds', toolRounds)
    asyncio.create_task(
        _doReview(
            messagesSnapshot,
            llm_client=llm_client,
            session_id=str(getattr(session, 'id', '') or ''),
        )
    )


async def tryEndOfSessionReview(
    session: object,
    messagesSnapshot: list[dict[str, object]],
    *,
    llm_client: ReviewClient = None,
) -> None:
    """Fire one final reflection when a session goes idle, if unreviewed turns exist.

    Cheap gate: only fires when turns-since-last-review > 0. Prevents
    corrections/facts in short 1-2 turn conversations from being lost.
    """
    if not _backgroundReviewEnabled():
        return
    if not messagesSnapshot:
        return
    lastTurn = getattr(session, '_last_reviewed_at_turn', 0)
    sessionTurns = getattr(session, 'messageCount', 0) // 2
    if lastTurn > sessionTurns:
        lastTurn = sessionTurns
        setattr(session, '_last_reviewed_at_turn', lastTurn)
    if sessionTurns <= 0 or sessionTurns - lastTurn <= 0:
        return
    setattr(session, '_last_reviewed_at_turn', sessionTurns)
    asyncio.create_task(
        _doReview(
            messagesSnapshot,
            llm_client=llm_client,
            session_id=str(getattr(session, 'id', '') or ''),
        )
    )


async def scheduleEndOfSessionReview(
    session: object,
    messagesSnapshot: list[dict[str, object]],
    *,
    llm_client: ReviewClient = None,
    idle_seconds: float = 2.0,
) -> None:
    """Debounce a final review until the session has been idle briefly.

    The workbench finalizer runs after every turn. Debouncing here means a
    short one- or two-turn session still gets reviewed, while rapid follow-up
    messages cancel the pending review and avoid one LLM call per message.
    """
    if not _backgroundReviewEnabled() or not messagesSnapshot:
        return
    previous = getattr(session, '_end_of_session_review_task', None)
    if isinstance(previous, asyncio.Task) and not previous.done():
        previous.cancel()

    async def _waitAndReview() -> None:
        try:
            await asyncio.sleep(max(0.25, idle_seconds))
            if getattr(session, 'status', 'idle') not in ('idle', 'awaiting_approval'):
                return
            await tryEndOfSessionReview(session, messagesSnapshot, llm_client=llm_client)
        except asyncio.CancelledError:
            return

    task = asyncio.create_task(_waitAndReview())
    setattr(session, '_end_of_session_review_task', task)


async def _doReview(
    messagesSnapshot: list[dict[str, object]],
    *,
    llm_client: ReviewClient = None,
    session_id: str = '',
) -> dict[str, object]:
    """Run the unified reflection: corrections, facts, skills, frustration."""
    result: dict[str, object] = {
        'reviewed': False,
        'corrections_added': [],
        'skills_created': [],
        'skills_patched': [],
        'facts_added': [],
        'frustration': False,
        'errors': [],
    }
    if llm_client is None:
        return result
    try:
        from app.services.brain_event_bus import emitBrainEvent

        emitBrainEvent(
            category='review',
            layer='background_review._do_review',
            summary=f'Unified reflection started over {len(messagesSnapshot)} message(s)',
        )
    except Exception:
        pass
    prompt = _buildReviewPrompt(messagesSnapshot)
    try:
        raw = await llm_client(prompt)
    except Exception as exc:
        log.warning('background_review: LLM call failed: %s', exc)
        as_list(result['errors']).append(str(exc))
        return result
    recommendations = _parseRecommendations(raw)
    result['reviewed'] = True

    # --- Corrections -> learned_heuristics + graph ---
    try:
        from app.services.cognitive_config import get_features

        heuristicsEnabled = bool(get_features().get('heuristics', True))
    except Exception:
        heuristicsEnabled = True
    for correction in as_list(recommendations.get('corrections'), []) if heuristicsEnabled else []:
        if isinstance(correction, dict):
            rule = as_str(as_dict(correction).get('rule'), '')
            confidence = as_dict(correction).get('confidence')
        else:
            rule = as_str(correction)
            confidence = None
        if not rule:
            continue
        try:
            from app.services.heuristics_service import addHeuristic

            added = addHeuristic(
                rule,
                source='reflection',
                category='correction',
                confidence=confidence,
                session_id=session_id,
            )
            if added is not None:
                as_list(result['corrections_added']).append(rule[:80])
                _syncCorrectionToGraph(rule)
                superseded = _supersedeStaleFacts(rule)
                if superseded:
                    result['memories_superseded'] = (
                        as_int(result.get('memories_superseded'), 0) + superseded
                    )
        except Exception as exc:
            as_list(result['errors']).append(f'correction: {exc}')

    # --- Frustration -> brain event ---
    frustration = recommendations.get('frustration', False)
    if frustration:
        result['frustration'] = True
        try:
            from app.services.brain_event_bus import emitBrainEvent

            emitBrainEvent(
                category='review',
                layer='background_review.frustration',
                summary='User frustration detected in recent turns',
                meta={'frustration': True},
            )
        except Exception:
            pass

    # --- Skills -> pending_skills (requires user approval before activation) ---
    try:
        from app.services.cognitive_config import get_features

        skillGenesisEnabled = bool(get_features().get('skill_genesis', True))
    except Exception:
        skillGenesisEnabled = True
    for rec in as_list(recommendations.get('skills'), []) if skillGenesisEnabled else []:
        recDict = as_dict(rec)
        try:
            action = as_str(recDict.get('action'), 'create')
            name = as_str(recDict.get('name'), '')
            if not name:
                continue
            # Worthiness gate: search existing catalogue — near-duplicate forces patch, not create
            if action == 'create':
                try:
                    if skill_service.get(name):
                        action = 'patch'
                    else:
                        hits = skill_service.search(name) if hasattr(skill_service, 'search') else []
                        if hits and any(str(h.get('name') or '').lower() == name.lower() for h in hits):
                            action = 'patch'
                except Exception:
                    pass
                # Quality gate: a skill body should carry actionable structure.
                # Never silently drop a proposal — the reviewer would re-propose
                # it next interval (token loop). Instead queue it with a
                # curation note so the approver sees what needs fleshing out.
                body_ck = as_str(recDict.get('body'), '')
                has_structure = any(
                    marker in body_ck
                    for marker in (
                        'How to Run',
                        'How to run',
                        'When to Use',
                        'when to use',
                        '## Steps',
                        '1.',
                    )
                )
                if body_ck and not has_structure:
                    recDict['body'] = body_ck + (
                        '\n\n> [august curator] Draft lacks step-by-step run/verify'
                        ' sections — patch with concrete steps before activating.'
                    )
            if action == 'create':
                # Route through pending_skills for user approval (Phase 3.6)
                _queue_pending_skill(
                    name,
                    as_str(recDict.get('description'), ''),
                    as_str(recDict.get('body'), ''),
                    trigger=as_str(recDict.get('trigger'), ''),
                    category=as_str(recDict.get('category'), 'evolving'),
                )
                as_list(result['skills_created']).append(name)
                _emitSkillEvent(name, 'pending', as_str(recDict.get('description'), ''))
            elif action == 'patch':
                skill_service.patchSkill(
                    name,
                    body=as_str(recDict.get('body')),
                    description=as_str(recDict.get('description')) if 'description' in recDict else None,
                )
                as_list(result['skills_patched']).append(name)
                _emitSkillEvent(name, 'patch', '')
        except Exception as exc:
            log.warning("background_review: skill '%s' failed: %s", as_str(recDict.get('name')), exc)
            as_list(result['errors']).append(str(exc))

    # --- Facts -> coreMemory + graph ---
    rawFacts = recommendations.get('facts') or recommendations.get('memory')
    factTexts: list[str] = []
    for fact in as_list(rawFacts, []):
        if isinstance(fact, str):
            content = fact
            action = 'add'
        else:
            factDict = as_dict(fact)
            action = as_str(factDict.get('action'), 'add')
            content = as_str(factDict.get('fact'), '')
        if not content:
            continue
        try:
            from app.services.memory.memory_scrubber import emit_scrub_event, find_secrets

            if find_secrets(content):
                emit_scrub_event(layer='background_review')
                continue
            _saveFact(action, content)
            as_list(result['facts_added']).append(content[:80])
            _syncFactToGraph(content)
            factTexts.append(content)
        except Exception as exc:
            as_list(result['errors']).append(str(exc))

    # --- User profile: fold stable facts into the durable summary blob ---
    if factTexts:
        try:
            from app.services.memory.user_profile import consolidateUserProfile

            consolidateUserProfile(factTexts)
        except Exception as exc:
            as_list(result['errors']).append(f'profile: {exc}')

    # --- Summary brain event ---
    try:
        from app.services.brain_event_bus import emitBrainEvent

        parts = []
        if result['corrections_added']:
            parts.append(f"{len(as_list(result['corrections_added']))} correction(s)")
        if result['skills_created']:
            parts.append(f"{len(as_list(result['skills_created']))} skill(s) created")
        if result['skills_patched']:
            parts.append(f"{len(as_list(result['skills_patched']))} skill(s) updated")
        if result['facts_added']:
            parts.append(f"{len(as_list(result['facts_added']))} fact(s)")
        if result['frustration']:
            parts.append('frustration flagged')
        summary = f"Reflection done: {', '.join(parts)}" if parts else 'Reflection done: nothing to save'
        emitBrainEvent(category='review', layer='background_review._do_review', summary=summary)
    except Exception:
        pass
    return result


def _queue_pending_skill(
    name: str,
    description: str,
    body: str,
    trigger: str = '',
    category: str = 'evolving',
    session_id: str | None = None,
) -> None:
    """Insert a skill into pending_skills for user approval (Phase 3.6).

    The skill is NOT active until the user approves it via the Brain UI.
    """
    import os
    import re as _re

    from app.services.memory_store import _conn

    # Sanitize name to prevent path traversal
    safe_name = _re.sub(r'[^a-z0-9._-]', '', name.lower())[:64]
    if not safe_name:
        return

    # Use canonical data path
    try:
        from app.lib.paths import dataPath
        skills_dir = str(dataPath('skills'))
    except Exception:
        data_dir = os.environ.get('AUGUST_DATA_DIR', 'data')
        skills_dir = os.path.join(data_dir, 'skills')
    os.makedirs(skills_dir, exist_ok=True)
    draft_path = os.path.join(skills_dir, f'.pending_{safe_name}.md')
    with open(draft_path, 'w', encoding='utf-8') as f:
        f.write(f'---\nname: {name}\ndescription: {description}\ntrigger: {trigger}\ncategory: {category}\n---\n\n{body}\n')

    conn = _conn()
    # Re-proposals must UPDATE, not vanish: when the reflection loop drafts a
    # better version of a skill it already proposed (or the user previously
    # rejected), the improved draft should replace the old one and return to
    # the pending queue. The old ON CONFLICT DO NOTHING silently dropped every
    # refinement — audit finding P3-10. Only 'approved' rows are protected:
    # overwriting those would mutate skills already live on disk.
    conn.execute(
        '''INSERT INTO pending_skills (name, description, trigger_text, draft_path, source_session_id, status)
           VALUES (?, ?, ?, ?, ?, 'pending')
           ON CONFLICT(name) DO UPDATE SET
               description = excluded.description,
               trigger_text = excluded.trigger_text,
               draft_path = excluded.draft_path,
               source_session_id = excluded.source_session_id,
               status = 'pending'
           WHERE pending_skills.status != 'approved'
        ''',
        (name, description, trigger, draft_path, session_id),
    )
    conn.commit()
    log.info('Queued pending skill for approval: %s', name)


def _emitSkillEvent(name: str, action: str, description: str) -> None:
    """Emit brain event + feature flow for skill creation/update."""
    try:
        from app.services.brain_event_bus import emitBrainEvent

        emitBrainEvent(
            category='skill_genesis',
            layer=f'background_review.{action}',
            summary=f"Skill {'created' if action == 'create' else 'updated'}: {name}",
            meta={'name': name, 'action': action},
        )
    except Exception:
        pass
    try:
        from app.services.feature_flow import emit_feature_flow

        emit_feature_flow(
            feature='skills',
            stage='apply',
            summary=f"Evolving skill {'created' if action == 'create' else 'updated'}: {name}",
            status='ok',
            meta={'name': name, 'action': action, 'description': description[:120]},
        )
    except Exception:
        pass
    # Authorship is NOT usage. bump_use previously fired here on every
    # create/patch, so the curator's staleness clock and the quality scorer's
    # effectiveness dimension measured how often the reflection loop wrote a
    # skill — not whether the model ever loaded it (audit finding). Real usage
    # telemetry lives in skill_tools._loadSkill (bump_view) and the curator.
    try:
        from app.services.skills.curator import SkillCurator

        SkillCurator().bump_patch(name)
    except Exception:
        pass


def _buildReviewPrompt(messagesSnapshot: list[dict[str, object]]) -> list[dict[str, object]]:
    """Build an OpenAI-format message list for the unified reflection LLM."""
    systemMsg: dict[str, object] = {
        'role': 'system',
        'content': (
            'You are reviewing a conversation between a user and an AI assistant. '
            'Extract what should be learned for future interactions.\n\n'
            'Respond with a JSON object only (no markdown, no code fences):\n'
            '{\n'
            '  "corrections": [{"rule": "User prefers X over Y", "confidence": 0.8}],\n'
            '  "facts": ["User is a backend developer", "Project uses Python 3.12"],\n'
            '  "skills": [\n'
            '    {\n'
            '      "action": "create" | "patch",\n'
            '      "name": "lowercase-dotted-name",\n'
            '      "description": "<=60 chars, one sentence",\n'
            '      "body": "Full SKILL.md body markdown",\n'
            '      "trigger": "optional trigger phrase",\n'
            '      "category": "optional-category"\n'
            '    }\n'
            '  ],\n'
            '  "frustration": false\n'
            '}\n\n'
            'Rules:\n'
            '- corrections: behavioral rules the user stated or implied ("don\'t X", "always Y", "prefer Z"). '
            'Each becomes a persistent rule injected into future prompts. Be precise and actionable. '
            'Set confidence (0.0-1.0) for how durable the rule is: repeated, emphasized, or explicit '
            'statements score higher; single mentions lower.\n'
            '- facts: stable user/project facts worth remembering (identity, stack, preferences). '
            'Do NOT save transient task details.\n'
            '- skills: ONLY create when a multi-step workflow was completed successfully and is genuinely reusable. '
            'Do NOT create a skill for simple Q&A or single-step tasks.\n'
            '- skills worthiness: Before creating, imagine searching the existing catalogue — if a near-duplicate exists, use action "patch" to improve it, not "create". '
            'A proper skill must have: a specific trigger (not "help me"), a body with sections When to Use / Prerequisites / How to Run / Verification, and a concrete multi-step example. '
            'Tool rounds >=3 and a completed multi-step success are evidence of reusability. Vague single-step helps are not skills.\n'
            '- frustration: set true if the user showed repeated frustration, corrections, or dissatisfaction.\n'
            '- Return empty arrays/false when nothing qualifies. Silence is better than noise.'
        ),
    }
    return [systemMsg] + _lastRelevantMessages(messagesSnapshot, maxLen=60)


def _lastRelevantMessages(messages: list[dict[str, object]], maxLen: int = 60) -> list[dict[str, object]]:
    """Take the tail of the conversation — user + assistant turns only."""
    relevant = [m for m in messages if as_str(m.get('role')) in ('user', 'assistant')]
    return relevant[-maxLen:] if len(relevant) > maxLen else relevant


def _parseRecommendations(raw: str) -> dict[str, object]:
    """Parse the LLM JSON response, handling common edge cases."""
    text = raw.strip()
    if text.startswith('```'):
        lines = text.split('\n', 1)
        text = lines[1] if len(lines) > 1 else ''
        if text.endswith('```'):
            text = text[:-3]
    text = text.strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    # Repair passes for near-miss LLM output. The old fallback blanket-replaced
    # "'" with '"' which corrupted extracted rule text ("don't X" became
    # invalid JSON and the correction was silently dropped — audit finding).
    start, end = text.find('{'), text.rfind('}')
    if start != -1 and end > start:
        obj = text[start : end + 1]
        # 1) Python-style dict literals (single-quoted strings): parse without
        #    ever touching string contents.
        try:
            parsed = ast.literal_eval(obj)
            if isinstance(parsed, dict):
                return cast(dict[str, object], parsed)
        except (ValueError, SyntaxError):
            pass
        # 2) Structural quirk: trailing commas before } or ].
        repaired = re.sub(r',\s*([}\]])', r'\1', obj)
        try:
            parsed = json.loads(repaired)
            if isinstance(parsed, dict):
                return cast(dict[str, object], parsed)
        except json.JSONDecodeError:
            pass
    log.warning('background_review: could not parse: %.200s', text)
    return {'corrections': [], 'facts': [], 'skills': [], 'frustration': False}


def _saveFact(action: str, content: str) -> None:
    """Save a fact to the core memory KV store (near-dups refresh, never twin)."""
    from app.services.memory.user_profile import _similarity
    from app.services.memory_store import get_memory, save_memory

    KEY = 'coreMemory'
    raw = get_memory(KEY)
    facts: list[JsonValue] = raw if isinstance(raw, list) else []
    now = __import__('time').time()
    newFact: dict[str, object] = {'fact': content, 'updated_at': now}
    if action == 'replace':
        for i, f in enumerate(facts):
            if isinstance(f, dict) and f.get('fact', '') == content:
                facts[i] = newFact
                save_memory(KEY, facts)
                return
        facts.append(newFact)
    else:
        for i, f in enumerate(facts):
            if not isinstance(f, dict):
                continue
            existing = str(f.get('fact', ''))
            if existing == content:
                return
            if _similarity(content, existing) >= 0.85:
                # Near-dup: refresh the timestamp, keep the existing (usually
                # more specific) fact text — never replace detail with a
                # shorter paraphrase.
                facts[i] = {**dict(f), 'updated_at': now}
                save_memory(KEY, facts)
                return
        facts.append(newFact)
    save_memory(KEY, facts)


def _syncCorrectionToGraph(rule: str) -> None:
    """Write a learned correction to the knowledge graph as a workflowRule entity."""
    try:
        from app.services.cognitive_config import get_features

        if not get_features().get('graph_memory', True):
            return
        from app.services.memory import graph_memory

        key = f'correction_{graph_memory.entityKey(rule[:60])}'
        graph_memory.addEntity(
            key,
            entityType='workflowRule',
            metadata={
                'importance': 0.8,
                'label': rule[:48],
                'preview': rule[:240],
                'source': 'reflection',
            },
        )
        # Link to a 'Corrections' category node
        graph_memory.addEntity(
            'learned_corrections',
            entityType='category',
            metadata={'label': 'Learned Corrections'},
        )
        graph_memory.addRelation('learned_corrections', key, 'contains')
    except Exception:
        pass


def _supersedeStaleFacts(correction: str) -> int:
    """Demote memories contradicted by a learned correction (audit finding P3-9).

    A correction used to land in learned_heuristics + graph while the
    superseded fact stayed fully live in auto_memories AND its vector twin —
    recall then served both sides of a contradiction. This halves importance,
    confidence, and TTL on near-duplicate rows (never user-added or pinned)
    so the corrected rule wins recall, and deletes the stale vector entry.
    Returns the number of demoted rows. Best-effort: any failure is logged
    at debug and reported as 0.
    """
    demoted = 0
    try:
        from datetime import datetime, timedelta, timezone

        from app.services.memory.auto_memory import _NEAR_DUP_THRESHOLD, _similarity
        from app.services.memory_store import _conn

        conn = _conn()
        rows = conn.execute('SELECT id, key, content FROM auto_memories').fetchall()
        for r in rows:
            if str(r['key'] or '').startswith('user_added_'):
                continue
            if _similarity(correction, r['content']) < _NEAR_DUP_THRESHOLD:
                continue
            conn.execute(
                "UPDATE auto_memories SET "
                'importance = MIN(importance, 0.2), '
                'confidence = MIN(COALESCE(confidence, 1.0), 0.2), '
                'expires_at = ? '
                'WHERE id = ?',
                (
                    (datetime.now(timezone.utc) + timedelta(days=7))
                    .isoformat()
                    .replace('+00:00', 'Z'),
                    r['id'],
                ),
            )
            demoted += 1
            try:
                from app.services.memory import vector_db

                # Vector entries are keyed by metadata ('key' field), not id.
                vector_db.deleteByKey(str(r['key'] or ''), namespace='auto_memory')
            except Exception:
                pass
        if demoted:
            conn.commit()
            log.info(
                'background_review: correction superseded %d stale memory row(s)', demoted
            )
    except Exception:
        log.debug('_supersedeStaleFacts failed', exc_info=True)
    return demoted


def _syncFactToGraph(fact: str) -> None:
    """Write a learned fact to the knowledge graph as a userDetail/concept entity."""
    try:
        from app.services.cognitive_config import get_features

        if not get_features().get('graph_memory', True):
            return
        from app.services.memory import graph_memory

        key = f'fact_{graph_memory.entityKey(fact[:60])}'
        # Classify: user-related facts get userDetail, others get concept
        lower = fact.lower()
        if any(w in lower for w in ('user', 'i am', 'i\'m', 'my ', 'prefer', 'name')):
            entity_type = 'userDetail'
            category_key = 'user_facts'
            category_label = 'User Facts'
        else:
            entity_type = 'concept'
            category_key = 'project_facts'
            category_label = 'Project Facts'
        graph_memory.addEntity(
            key,
            entityType=entity_type,
            metadata={
                'importance': 0.7,
                'label': fact[:48],
                'preview': fact[:240],
                'source': 'reflection',
            },
        )
        graph_memory.addEntity(
            category_key,
            entityType='category',
            metadata={'label': category_label},
        )
        graph_memory.addRelation(category_key, key, 'contains')
    except Exception:
        pass
