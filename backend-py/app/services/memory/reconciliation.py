"""Asset demand reconciliation — join friction/workflows with configured assets.

Part of Better Harness Plan Phase 3.8.
Identifies coverage gaps: repeated demand exists but no configured asset covers it.
"""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)


def reconcile_demand_coverage() -> list[dict]:
    """Join friction data and workflow candidates with configured assets.

    Returns list of coverage gaps:
    [{demand, existingCoverage, suggestedOwner, suggestion}]
    """
    try:
        from app.services.memory.friction import get_friction_stats
        from app.services.memory.workflow_detection import get_workflow_candidates

        gaps: list[dict] = []

        # 1. Check friction hotspots without coverage
        friction = get_friction_stats(since_days=30)
        for category, count in friction.get('byCategory', {}).items():
            if count < 3:
                continue  # Not repeated enough to be a gap

            coverage = _find_coverage_for_category(category)
            if not coverage:
                gaps.append({
                    'demand': f'Repeated {category} friction ({count} events in 30d)',
                    'existingCoverage': None,
                    'suggestedOwner': _suggest_owner(category),
                    'suggestion': _suggest_action(category),
                })

        # 2. Check workflow candidates without skill coverage
        candidates = get_workflow_candidates()
        for wf in candidates:
            if wf.get('confidence', 0) < 0.6:
                continue
            has_skill = _has_skill_for_topic(wf.get('commonTopic', ''))
            if not has_skill:
                gaps.append({
                    'demand': f"Workflow: {wf.get('name', 'unknown')} ({wf.get('sessionCount', 0)} sessions)",
                    'existingCoverage': None,
                    'suggestedOwner': 'skill',
                    'suggestion': f"Create a skill for the '{wf.get('name')}' workflow",
                })

        return gaps
    except Exception as exc:
        logger.debug('Reconciliation failed: %s', exc)
        return []


def _find_coverage_for_category(category: str) -> str | None:
    """Check if any configured asset covers a friction category."""
    try:
        from app.services.heuristics_service import listHeuristics

        heuristics = listHeuristics()
        category_keywords = {
            'provider': ['provider', 'timeout', 'retry', 'fallback', 'rate limit'],
            'tool': ['tool', 'command', 'execution', 'sandbox'],
            'harness': ['context', 'agents.md', 'instruction', 'rule'],
            'model': ['model', 'approach', 'hallucination'],
        }
        keywords = category_keywords.get(category, [category])
        for h in heuristics:
            rule = str(h.get('rule', '') or '').lower()
            if any(kw in rule for kw in keywords):
                return f"heuristic: '{rule[:60]}'"
    except Exception:
        pass
    return None


def _has_skill_for_topic(topic: str) -> bool:
    """Check if any existing skill covers a workflow topic."""
    try:
        from app.services import skill_service

        skills = skill_service.list_all()
        topic_words = set(topic.lower().replace('_', ' ').replace('-', ' ').split())
        for skill in skills:
            skill_words = set(
                (str(skill.get('name', '')) + ' ' + str(skill.get('description', '')) + ' ' + str(skill.get('trigger') or '')).lower().split()
            )
            overlap = topic_words & skill_words
            if len(overlap) >= 2:
                return True
    except Exception:
        pass
    return False


def _suggest_owner(category: str) -> str:
    """Suggest the smallest durable owner for a friction category."""
    owners = {
        'provider': 'skill',       # Retry/fallback skill
        'tool': 'rule',            # AGENTS.md rule about tool usage
        'harness': 'rule',         # Add missing context/instruction
        'model': 'heuristic',      # Behavioral correction
        'requirement': 'memory',   # Store clarified requirements
        'external': 'skill',       # Diagnosis/recovery skill
        'complexity': 'skill',     # Decomposition skill
    }
    return owners.get(category, 'rule')


def _suggest_action(category: str) -> str:
    """Suggest a concrete action for a friction category."""
    actions = {
        'provider': 'Create a retry/fallback skill for provider timeouts',
        'tool': 'Add a rule to AGENTS.md about correct tool usage',
        'harness': 'Add missing project context or instructions',
        'model': 'Add a heuristic to correct the model approach',
        'requirement': 'Store clarified requirements in memory',
        'external': 'Create a diagnosis skill for external failures',
        'complexity': 'Create a task decomposition skill',
    }
    return actions.get(category, 'Investigate and add appropriate coverage')
