"""Background review — interval-gated after-turn reflection loop.

Modeled on Hermes ``agent/background_review.py`` which runs a daemon AIAgent
that replays the conversation snapshot and asks whether any skill or memory
should be saved or updated.

Key design points (matching Hermes):
- Fires after a turn, **interval-gated** — not every turn (controlled by
  ``ReviewGates.turn_interval`` and ``tool_round_interval``).
- Runs as a background ``asyncio.Task`` (does not block the response).
- Uses a **side LLM** call (separate from the main session's prompt cache;
  configurable, defaults to no-op unless ``llm_client`` is provided).
- Skill review: writes lessons into **agent-authored skills** via
  ``skill_service.create_skill/patch_skill`` so the model loads them via
  ``load_skill`` (the Hermes model — replacing the learned-guidelines store).
- Memory review: stores user facts in the core memory KV store.
"""
from __future__ import annotations
import asyncio
import json
import logging
from dataclasses import dataclass, field
from typing import Callable, Optional
from app.jsonUtils import as_str, as_list
from app.services import skill_service
log = logging.getLogger(__name__)
_TURNInterval = 3
_TOOLRoundInterval = 6

@dataclass
class ReviewGates:
    turnInterval: int = _TURNInterval
    toolRoundInterval: int = _TOOLRoundInterval

    def shouldReview(self, *, sessionTurns: int=0, toolRounds: int=0, lastReviewedAtTurn: int=0) -> bool:
        if sessionTurns <= 0:
            return False
        turnDelta = sessionTurns - lastReviewedAtTurn
        return turnDelta >= self.turnInterval or toolRounds >= self.toolRoundInterval
ReviewClient = Optional[Callable[[list[dict[str, object]]], str]]

async def tryBackgroundReview(session: object, messagesSnapshot: list[dict[str, object]], *, gates: ReviewGates | None=None, llmClient: ReviewClient=None) -> None:
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
    session._last_reviewed_at_turn = sessionTurns
    asyncio.create_task(_doReview(messagesSnapshot, llmClient=llmClient))

async def _doReview(messagesSnapshot: list[dict[str, object]], *, llmClient: ReviewClient=None) -> dict[str, object]:
    """Run the actual review — call the side LLM, parse recommendations, apply."""
    result: dict[str, object] = {'reviewed': False, 'skills_created': [], 'skills_patched': [], 'facts_added': [], 'errors': []}
    if llmClient is None:
        return result
    try:
        from app.services.brain_event_bus import emitBrainEvent
        emitBrainEvent(category='review', layer='background_review._do_review', summary=f'Background review started over {len(messagesSnapshot)} message(s)')
    except Exception:
        pass
    prompt = _buildReviewPrompt(messagesSnapshot)
    try:
        raw = await llmClient(prompt)
    except Exception as exc:
        log.warning('background_review: LLM call failed: %s', exc)
        result['errors'].append(str(exc))
        return result
    recommendations = _parseRecommendations(raw)
    result['reviewed'] = True
    try:
        from app.services.brain_event_bus import emitBrainEvent
        emitBrainEvent(category='review', layer='background_review._do_review', summary=f"Background review done: {len(as_list(recommendations.get('skills'), []))} skill recs, {len(as_list(recommendations.get('facts'), []))} fact recs", meta={'skills': len(as_list(recommendations.get('skills'), [])), 'facts': len(as_list(recommendations.get('facts'), []))})
    except Exception:
        pass
    for rec in as_list(recommendations.get('skills'), []):
        try:
            action = as_str(rec.get('action'), 'create')
            name = as_str(rec.get('name'), '')
            if not name:
                continue
            if action == 'create':
                skill_service.createSkill(name, as_str(rec.get('description'), ''), as_str(rec.get('body'), ''), trigger=as_str(rec.get('trigger'), ''), category=as_str(rec.get('category'), 'uncategorized'))
                result['skills_created'].append(name)
                try:
                    from app.services.skills.curator import SkillCurator
                    SkillCurator().bumpUse(name)
                except Exception:
                    pass
            elif action == 'patch':
                skill_service.patchSkill(name, body=as_str(rec.get('body')), description=as_str(rec.get('description')))
                result['skills_patched'].append(name)
                try:
                    from app.services.skills.curator import SkillCurator
                    SkillCurator().bumpUse(name)
                except Exception:
                    pass
        except Exception as exc:
            log.warning("background_review: skill '%s' failed: %s", as_str(rec.get('name')), exc)
            result['errors'].append(str(exc))
    for fact in as_list(recommendations.get('memory'), []):
        try:
            action = as_str(fact.get('action'), 'add')
            content = as_str(fact.get('fact'), '')
            if not content:
                continue
            _saveFact(action, content)
            result['facts_added'].append(content[:80])
        except Exception as exc:
            result['errors'].append(str(exc))
    return result

def _buildReviewPrompt(messagesSnapshot: list[dict[str, object]]) -> list[dict[str, object]]:
    """Build an OpenAI-format message list for the review LLM."""
    systemMsg = {'role': 'system', 'content': 'You are reviewing a conversation between a user and an AI assistant. Identify any lessons, corrections, or recurring patterns that should be saved for future interactions.\n\nRespond with a JSON object only (no markdown, no code fences):\n{\n  "skills": [\n    {\n      "action": "create" | "patch",\n      "name": "lowercase-dotted-name",\n      "description": "≤60 chars, one sentence",\n      "body": "Full SKILL.md body markdown (sections: When to Use, Prerequisites, How to Run, Quick Reference, Procedure, Pitfalls, Verification)",\n      "trigger": "optional trigger phrase",\n      "category": "optional-category"\n    }\n  ],\n  "memory": [\n    {\n      "action": "add" | "replace",\n      "fact": "User prefers short answers."\n    }\n  ]\n}\n\nOnly include skills/memory that are genuinely new or corrective. Do NOT create a skill for every turn — be selective.'}
    return [systemMsg] + _lastRelevantMessages(messagesSnapshot, maxLen=60)

def _lastRelevantMessages(messages: list[dict[str, object]], maxLen: int=60) -> list[dict[str, object]]:
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
            return {'skills': [], 'memory': []}

def _saveFact(action: str, content: str) -> None:
    """Save a fact to the core memory KV store."""
    from app.services.memory_store import getMemory, saveMemory
    KEY = 'coreMemory'
    facts: list[dict] = getMemory(KEY) or []
    if not isinstance(facts, list):
        facts = []
    now = __import__('time').time()
    if action == 'replace':
        for i, f in enumerate(facts):
            if isinstance(f, dict) and f.get('fact', '') == content:
                facts[i] = {'fact': content, 'updated_at': now}
                saveMemory(KEY, facts)
                return
        facts.append({'fact': content, 'updated_at': now})
    else:
        for f in facts:
            if isinstance(f, dict) and f.get('fact', '') == content:
                return
        facts.append({'fact': content, 'updated_at': now})
    saveMemory(KEY, facts)
