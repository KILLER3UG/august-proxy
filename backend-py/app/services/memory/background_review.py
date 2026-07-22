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
- Skills -> ``skill_service`` (autonomous creation, no approval gate).
- Frustration -> brain event for attention flagging.
"""

from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass
from typing import Awaitable, Callable, Optional

from app.json_narrowing import as_dict, as_list, as_str
from app.services import skill_service
from app.type_aliases import JsonValue

log = logging.getLogger(__name__)
_TURNInterval = 3
_TOOLRoundInterval = 6


@dataclass
class ReviewGates:
    turn_interval: int = _TURNInterval
    tool_round_interval: int = _TOOLRoundInterval

    def shouldReview(self, *, sessionTurns: int = 0, toolRounds: int = 0, lastReviewedAtTurn: int = 0) -> bool:
        if sessionTurns <= 0:
            return False
        turnDelta = sessionTurns - lastReviewedAtTurn
        return turnDelta >= self.turn_interval or toolRounds >= self.tool_round_interval


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
    if not messagesSnapshot:
        return
    lastTurn = getattr(session, '_last_reviewed_at_turn', 0)
    sessionTurns = getattr(session, 'messageCount', 0) // 2
    toolRounds = len([m for m in messagesSnapshot if as_str(m.get('role')) == 'tool'])
    gates = gates or ReviewGates()
    if not gates.shouldReview(sessionTurns=sessionTurns, toolRounds=toolRounds, lastReviewedAtTurn=lastTurn):
        return
    setattr(session, '_last_reviewed_at_turn', sessionTurns)
    asyncio.create_task(_doReview(messagesSnapshot, llm_client=llm_client))


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
    if not messagesSnapshot:
        return
    lastTurn = getattr(session, '_last_reviewed_at_turn', 0)
    sessionTurns = getattr(session, 'messageCount', 0) // 2
    if sessionTurns <= 0 or sessionTurns - lastTurn <= 0:
        return
    setattr(session, '_last_reviewed_at_turn', sessionTurns)
    asyncio.create_task(_doReview(messagesSnapshot, llm_client=llm_client))


async def _doReview(messagesSnapshot: list[dict[str, object]], *, llm_client: ReviewClient = None) -> dict[str, object]:
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
    for correction in as_list(recommendations.get('corrections'), []):
        rule = as_str(correction) if not isinstance(correction, dict) else as_str(as_dict(correction).get('rule'), '')
        if not rule:
            continue
        try:
            from app.services.heuristics_service import addHeuristic

            added = addHeuristic(rule, source='reflection', category='correction')
            if added is not None:
                as_list(result['corrections_added']).append(rule[:80])
                _syncCorrectionToGraph(rule)
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

    # --- Skills -> skill_service (autonomous, no approval) ---
    for rec in as_list(recommendations.get('skills'), []):
        recDict = as_dict(rec)
        try:
            action = as_str(recDict.get('action'), 'create')
            name = as_str(recDict.get('name'), '')
            if not name:
                continue
            if action == 'create':
                skill_service.createSkill(
                    name,
                    as_str(recDict.get('description'), ''),
                    as_str(recDict.get('body'), ''),
                    trigger=as_str(recDict.get('trigger'), ''),
                    category=as_str(recDict.get('category'), 'evolving'),
                    createdBy='agent',
                )
                as_list(result['skills_created']).append(name)
                _emitSkillEvent(name, 'create', as_str(recDict.get('description'), ''))
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
            _saveFact(action, content)
            as_list(result['facts_added']).append(content[:80])
            _syncFactToGraph(content)
        except Exception as exc:
            as_list(result['errors']).append(str(exc))

    # --- Summary brain event ---
    try:
        from app.services.brain_event_bus import emitBrainEvent

        parts = []
        if result['corrections_added']:
            parts.append(f"{len(result['corrections_added'])} correction(s)")
        if result['skills_created']:
            parts.append(f"{len(result['skills_created'])} skill(s) created")
        if result['skills_patched']:
            parts.append(f"{len(result['skills_patched'])} skill(s) updated")
        if result['facts_added']:
            parts.append(f"{len(result['facts_added'])} fact(s)")
        if result['frustration']:
            parts.append('frustration flagged')
        summary = f"Reflection done: {', '.join(parts)}" if parts else 'Reflection done: nothing to save'
        emitBrainEvent(category='review', layer='background_review._do_review', summary=summary)
    except Exception:
        pass
    return result


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
    try:
        from app.services.skills.curator import SkillCurator

        SkillCurator().bump_use(name)
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
            '  "corrections": ["User prefers X over Y", "Never do Z in this project"],\n'
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
            'Each becomes a persistent rule injected into future prompts. Be precise and actionable.\n'
            '- facts: stable user/project facts worth remembering (identity, stack, preferences). '
            'Do NOT save transient task details.\n'
            '- skills: ONLY create when a multi-step workflow was completed successfully and is genuinely reusable. '
            'Do NOT create a skill for simple Q&A or single-step tasks.\n'
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
        text = text.replace("'", '"')
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            log.warning('background_review: could not parse: %.200s', text)
            return {'corrections': [], 'facts': [], 'skills': [], 'frustration': False}


def _saveFact(action: str, content: str) -> None:
    """Save a fact to the core memory KV store."""
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
        for f in facts:
            if isinstance(f, dict) and f.get('fact', '') == content:
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
