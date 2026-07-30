"""Automation readiness gate + loop spec cards.

Part of Better Harness Plan Phase 5.7 + 5.8.
Enforces a 10-field contract before automation creation.
Structures automations as WHEN→SEE→DO→CHECK→STOP→LEAVE.
"""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)

_REQUIRED_FIELDS = ['trigger', 'runScope', 'stopCondition']
_RECOMMENDED_FIELDS = ['validation', 'sandbox', 'riskBoundary', 'triagePath']


def validate_automation_spec(spec: dict) -> dict:
    """Validate an automation spec against the readiness gate.

    Returns: {valid, errors: [...], warnings: [...], specCard: {...}}
    """
    errors: list[str] = []
    warnings: list[str] = []

    # Required fields
    for field in _REQUIRED_FIELDS:
        if not spec.get(field):
            errors.append(f'Missing required field: {field}')

    # Shell automations require sandbox mode
    job_type = spec.get('type', 'workbench')
    if job_type == 'shell' and not spec.get('sandbox'):
        errors.append('Shell automations must specify a sandbox mode (read-only|workspace-write)')

    # Recommended fields
    for field in _RECOMMENDED_FIELDS:
        if not spec.get(field):
            warnings.append(f'Missing recommended field: {field}')

    # Stop condition must not be empty or "never"
    stop = str(spec.get('stopCondition', '')).lower().strip()
    if stop in ('', 'never', 'none', 'n/a'):
        errors.append('Stop condition must define when the automation stops iterating')

    # Build spec card (WHEN→SEE→DO→CHECK→STOP→LEAVE)
    spec_card = {
        'when': spec.get('trigger', ''),
        'see': spec.get('inputPack', spec.get('runScope', '')),
        'do': spec.get('prompt', spec.get('command', '')),
        'check': spec.get('validation', ''),
        'stop': spec.get('stopCondition', ''),
        'leave': spec.get('outputArtifact', ''),
        'owner': spec.get('name', 'unnamed'),
    }

    return {
        'valid': len(errors) == 0,
        'errors': errors,
        'warnings': warnings,
        'specCard': spec_card,
    }


def render_spec_card(spec: dict) -> str:
    """Render a human-readable spec card for display."""
    card = validate_automation_spec(spec)['specCard']
    lines = [
        f"WHEN: {card['when'] or '(not set)'}",
        f"SEE:  {card['see'] or '(not set)'}",
        f"DO:   {card['do'][:100] or '(not set)'}",
        f"CHECK: {card['check'] or '(not set)'}",
        f"STOP: {card['stop'] or '(not set)'}",
        f"LEAVE: {card['leave'] or '(not set)'}",
    ]
    return '\n'.join(lines)
