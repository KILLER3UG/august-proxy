"""Sensitive-code detection hook — warns when writes touch sensitive patterns.

PRE_TOOL_USE on write_file|edit_file. Non-blocking (never denies).
8 categories from better-harness sensitive-code.md.
"""

from __future__ import annotations

import re

from app.services.hooks.registry import HookRegistry
from app.services.hooks.types import HookContext, HookEvent, HookResult

_SENSITIVE_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ('plaintext secrets', re.compile(r'(?:api_key|secret_key|access_token)\s*=\s*[\'"][^\'"]+[\'"]', re.I)),
    ('credential handling', re.compile(r'(?:auth|login|token_refresh|oauth|jwt_verify)', re.I)),
    ('identity/permission boundaries', re.compile(r'(?:rbac|access_control|permission|role_check|is_admin)', re.I)),
    ('sensitive data surface', re.compile(r'(?:pii|user_data|personal_info|ssn|credit_card)', re.I)),
    ('execution boundaries', re.compile(r'(?:eval\(|exec\(|subprocess|os\.system|shell=True)', re.I)),
    ('cryptography', re.compile(r'(?:hashlib|hmac|encrypt|decrypt|sign|verify_signature|AES|RSA)', re.I)),
    ('release/supply chain', re.compile(r'(?:publish|release|version_bump|deploy|npm publish|cargo publish)', re.I)),
    ('destructive operations', re.compile(r'(?:DROP TABLE|DELETE FROM|rm -rf|shutil\.rmtree|format\()', re.I)),
]


async def _detect_sensitive(ctx: HookContext) -> HookResult:
    """Detect sensitive code patterns in write content."""
    content = ''
    if ctx.tool_args:
        content = str(ctx.tool_args.get('content', '') or ctx.tool_args.get('diff', '') or '')
    if not content:
        return HookResult(action='allow')

    triggered: list[str] = []
    for category, pattern in _SENSITIVE_PATTERNS:
        if pattern.search(content):
            triggered.append(category)

    if triggered:
        return HookResult(
            action='allow',  # Non-blocking — warn only
            data={
                'type': 'sensitiveCodeWarning',
                'categories': triggered,
                'message': f'This change touches: {", ".join(triggered)}. Review carefully.',
            },
        )
    return HookResult(action='allow')


def register(reg: HookRegistry) -> None:
    """Register sensitive-code detection hook."""
    reg.register('sensitive_code', HookEvent.PRE_TOOL_USE, _detect_sensitive, matcher='write_file|edit_file', priority=20)
