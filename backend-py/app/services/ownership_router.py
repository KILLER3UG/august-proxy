"""Ownership routing — route detected demand to the smallest durable owner.

Part of Better Harness Plan Sprint D.4.
Implements the coverage ladder: observed → built-in → configured → extend → create → needs evidence.
"""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)

# Owner types ordered by preference (smallest first)
OWNER_TYPES = ['rule', 'memory', 'skill', 'hook', 'script', 'automation', 'agent', 'mcp']

# Routing rules: what kind of demand maps to which owner
_ROUTING_RULES = {
    'correction': {
        'owner': 'memory',
        'criteria': 'Concise correction/decision/preference/trap observed ≥2 times',
        'description': 'Store as a heuristic/memory so the agent remembers next time',
    },
    'repeated_procedure': {
        'owner': 'skill',
        'criteria': 'Stable trigger + ordered steps + output + stop condition + verification',
        'description': 'Capture as a reusable skill with trigger and steps',
    },
    'project_fact': {
        'owner': 'rule',
        'criteria': 'Current project invariant/policy/architecture the agent cannot infer',
        'description': 'Add to AGENTS.md or a scoped instruction file',
    },
    'deterministic_check': {
        'owner': 'hook',
        'criteria': 'Must run every time, blocking or logging, no LLM judgment needed',
        'description': 'Implement as a lifecycle hook (pre/post tool use)',
    },
    'scheduled_work': {
        'owner': 'automation',
        'criteria': 'Explicit cadence + bounded scope + stop condition + validation',
        'description': 'Create an automation with a loop spec card',
    },
    'external_access': {
        'owner': 'mcp',
        'criteria': 'API/tool access without a reusable multi-step procedure',
        'description': 'Configure an MCP server for the external service',
    },
    'delegation': {
        'owner': 'agent',
        'criteria': 'Focused task with bounded tools, benefits from role isolation',
        'description': 'Create a custom agent with specific permissions',
    },
}


def suggest_owner(demand: dict) -> dict:
    """Suggest the smallest durable owner for a detected demand.

    Args:
        demand: {type, description, evidenceCount, existingCoverage}

    Returns:
        {suggestedOwner, criteria, description, existingCoverage, action}
    """
    demand_type = demand.get('type', 'unknown')
    existing = demand.get('existingCoverage')

    # If existing coverage found, suggest extending rather than creating
    if existing:
        return {
            'suggestedOwner': 'extend_existing',
            'criteria': 'Existing coverage found — prefer extending over creating new',
            'description': f'Extend: {existing}',
            'existingCoverage': existing,
            'action': 'extend',
        }

    rule = _ROUTING_RULES.get(demand_type)
    if not rule:
        return {
            'suggestedOwner': 'needs_evidence',
            'criteria': 'Insufficient evidence to determine owner type',
            'description': 'Gather more evidence: is this a correction, procedure, fact, or check?',
            'existingCoverage': None,
            'action': 'investigate',
        }

    return {
        'suggestedOwner': rule['owner'],
        'criteria': rule['criteria'],
        'description': rule['description'],
        'existingCoverage': None,
        'action': 'create',
    }


def get_suggestions() -> list[dict]:
    """Get ownership suggestions for all uncovered demand.

    Joins friction hotspots + workflow candidates with the routing rules.
    """
    suggestions: list[dict] = []

    # From friction: repeated categories suggest specific owners
    try:
        from app.services.memory.friction import get_friction_stats

        stats = get_friction_stats(since_days=30)
        for category, count in stats.get('byCategory', {}).items():
            if count < 3:
                continue
            demand_type = _friction_to_demand_type(category)
            suggestion = suggest_owner({'type': demand_type, 'existingCoverage': None})
            suggestion['demand'] = f'Repeated {category} friction ({count} events/30d)'
            suggestion['evidenceCount'] = count
            suggestions.append(suggestion)
    except Exception:
        pass

    # From workflow candidates: repeated procedures suggest skills
    try:
        from app.services.memory.workflow_detection import get_workflow_candidates

        for wf in get_workflow_candidates():
            if wf.get('confidence', 0) < 0.6:
                continue
            suggestion = suggest_owner({'type': 'repeated_procedure', 'existingCoverage': None})
            suggestion['demand'] = f"Workflow: {wf.get('name', 'unknown')} ({wf.get('sessionCount', 0)} sessions)"
            suggestion['evidenceCount'] = wf.get('sessionCount', 0)
            suggestions.append(suggestion)
    except Exception:
        pass

    return suggestions


def _friction_to_demand_type(category: str) -> str:
    """Map a friction category to a demand type for ownership routing."""
    mapping = {
        'tool': 'deterministic_check',
        'harness': 'project_fact',
        'provider': 'repeated_procedure',
        'model': 'correction',
        'requirement': 'correction',
        'external': 'external_access',
        'complexity': 'repeated_procedure',
    }
    return mapping.get(category, 'correction')
