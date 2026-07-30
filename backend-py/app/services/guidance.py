"""Support tracks — stage-aware guidance based on project readiness.

Part of Better Harness Plan Phase 5.3.
Bootstrap (<30%) → Operationalize (30-70%) → Optimize (70+%).
"""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)


def get_guidance(workspace_path: str | None = None) -> dict:
    """Get stage-appropriate next steps based on project readiness.

    Returns: {track, score, steps: [{title, description, action}]}
    """
    score = 0
    if workspace_path:
        try:
            from app.services.project_readiness import score_project_readiness

            readiness = score_project_readiness(workspace_path)
            score = readiness.get('percentage', 0)
        except Exception:
            pass

    if score < 30:
        return {
            'track': 'bootstrap',
            'score': score,
            'label': 'Getting Started',
            'steps': _bootstrap_steps(workspace_path),
        }
    elif score < 70:
        return {
            'track': 'operationalize',
            'score': score,
            'label': 'Wiring Your Tools',
            'steps': _operationalize_steps(),
        }
    else:
        return {
            'track': 'optimize',
            'score': score,
            'label': 'Refining Your Flow',
            'steps': _optimize_steps(),
        }


def _bootstrap_steps(workspace: str | None) -> list[dict]:
    """Steps for projects with <30% readiness."""
    steps = [
        {
            'title': 'Add AGENTS.md',
            'description': 'Create an AGENTS.md with your project commands, boundaries, and risk areas.',
            'action': 'create_file',
            'target': 'AGENTS.md',
        },
        {
            'title': 'Configure a test command',
            'description': 'Add a test script so the agent can verify its changes.',
            'action': 'add_script',
            'target': 'test',
        },
    ]
    if workspace:
        import os

        if not os.path.exists(os.path.join(workspace, '.git')):
            steps.append({
                'title': 'Initialize git',
                'description': 'Version control enables safe changes and rollback.',
                'action': 'run_command',
                'target': 'git init',
            })
    return steps


def _operationalize_steps() -> list[dict]:
    """Steps for projects with 30-70% readiness."""
    return [
        {
            'title': 'Create your first skill',
            'description': 'Capture a repeated workflow as a reusable skill.',
            'action': 'navigate',
            'target': '/skills',
        },
        {
            'title': 'Wire a pre-commit hook',
            'description': 'Add automated checks before each commit.',
            'action': 'create_file',
            'target': '.pre-commit-config.yaml',
        },
        {
            'title': 'Review workflow candidates',
            'description': 'Check if August detected repeated patterns worth automating.',
            'action': 'navigate',
            'target': '/brain',
        },
    ]


def _optimize_steps() -> list[dict]:
    """Steps for projects with 70%+ readiness."""
    return [
        {
            'title': 'Review harness trends',
            'description': 'Check if your verified-% and friction are improving over time.',
            'action': 'navigate',
            'target': '/brain',
        },
        {
            'title': 'Set up an automation',
            'description': 'Automate a recurring task with a structured loop spec.',
            'action': 'navigate',
            'target': '/automations',
        },
        {
            'title': 'Tune skill quality',
            'description': 'Review low-scoring skills and improve their triggers and steps.',
            'action': 'navigate',
            'target': '/skills',
        },
    ]
