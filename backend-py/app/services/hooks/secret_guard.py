"""Secret guard hook — blocks credential exposure via tool calls.

PRE_TOOL_USE: scans write arguments for secret patterns → deny.
POST_TOOL_USE: redacts secrets from read results on protected paths.
"""

from __future__ import annotations

import re

from app.services.hooks.registry import HookRegistry
from app.services.hooks.types import HookContext, HookEvent, HookResult

# Secret patterns (never log the matched value)
_SECRET_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ('OpenAI API key', re.compile(r'sk-[a-zA-Z0-9]{20,}')),
    ('Anthropic API key', re.compile(r'sk-ant-[a-zA-Z0-9\-]{20,}')),
    ('AWS access key', re.compile(r'AKIA[0-9A-Z]{16}')),
    ('GitHub token', re.compile(r'ghp_[a-zA-Z0-9]{36}')),
    ('GitLab token', re.compile(r'glpat-[a-zA-Z0-9\-]{20,}')),
    ('Slack token', re.compile(r'xox[bpras]-[a-zA-Z0-9\-]{10,}')),
    ('Private key', re.compile(r'-----BEGIN (?:RSA |EC )?PRIVATE KEY-----')),
    ('Generic secret assignment', re.compile(
        r'\b(?:api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token|password|passwd)\b\s*[:=]\s*[\'"][^\'"]{8,}[\'"]',
        re.IGNORECASE,
    )),
]

# Protected file paths (POST_TOOL_USE redaction)
_PROTECTED_PATH_PATTERNS = re.compile(
    r'(\.env|providers\.json|credentials|\.ssh/|id_rsa|\.aws/|\.npmrc|\.pypirc)',
    re.IGNORECASE,
)

_WRITE_TOOLS = (
    'write_file|write_files|edit_file|create_file|create_files|run_command|'
    'str_replace|str_replace_editor|apply_patch|patch_file|bulk'
)
_READ_TOOLS = 'read_file|read_files|list_directory|search_files|bulk'


def scan_secrets(text: str) -> list[str]:
    """Return labels of every secret pattern found in ``text`` (never the values)."""
    return [label for label, pattern in _SECRET_PATTERNS if pattern.search(text)]


def _scan_for_secrets(text: str) -> str | None:
    """Return the label of the first secret pattern found, or None."""
    found = scan_secrets(text)
    return found[0] if found else None


def _redact_secrets(text: str) -> str:
    """Replace secret values with [REDACTED]."""
    result = text
    for _label, pattern in _SECRET_PATTERNS:
        result = pattern.sub('[REDACTED]', result)
    return result


def _text_values(value: object):
    """Yield all string leaves, including nested bulk-tool file entries."""
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for nested in value.values():
            yield from _text_values(nested)
    elif isinstance(value, (list, tuple)):
        for nested in value:
            yield from _text_values(nested)


async def _pre_tool_guard(ctx: HookContext) -> HookResult:
    """Block writes containing secret patterns."""
    if not ctx.tool_args:
        return HookResult(action='allow')

    found = None
    for text in _text_values(ctx.tool_args):
        found = _scan_for_secrets(text)
        if found:
            break
    if found:
        return HookResult(
            action='deny',
            message=f'Blocked: {found} pattern detected in {ctx.tool_name}. '
                    'Remove credentials before proceeding.',
        )
    return HookResult(action='allow')


async def _post_tool_redact(ctx: HookContext) -> HookResult:
    """Redact secrets from reads of protected paths."""
    # Canonicalize backslashes so Windows paths match the protected patterns.
    protected_path = any(
        _PROTECTED_PATH_PATTERNS.search(text.replace('\\', '/'))
        for text in _text_values(ctx.tool_args or {})
    )
    if not protected_path:
        return HookResult(action='allow')

    if ctx.tool_result:
        redacted = _redact_secrets(ctx.tool_result)
        if redacted != ctx.tool_result:
            return HookResult(action='modify', modified_result=redacted)
    return HookResult(action='allow')


def register(reg: HookRegistry) -> None:
    """Register secret guard hooks."""
    reg.register('secret_guard_write', HookEvent.PRE_TOOL_USE, _pre_tool_guard, matcher=_WRITE_TOOLS, priority=10)
    reg.register('secret_guard_read', HookEvent.POST_TOOL_USE, _post_tool_redact, matcher=_READ_TOOLS, priority=10)
