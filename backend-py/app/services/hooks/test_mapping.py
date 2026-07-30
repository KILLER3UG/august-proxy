"""Test-mapping gate hook — warns when critical files lack test coverage.

POST_TOOL_USE on write_file|edit_file|create_file. Non-blocking.
Resolves candidate test paths per language and warns if missing.
"""

from __future__ import annotations

import os
import re

from app.services.hooks.registry import HookRegistry
from app.services.hooks.types import HookContext, HookEvent, HookResult

# Critical paths that should always have tests
CRITICAL_PATHS = ('app/routers/', 'app/adapters/', 'app/services/sandbox/', 'app/providers/')


def _is_critical(file_path: str) -> bool:
    """Check if file is in a critical path."""
    normalized = file_path.replace('\\', '/')
    return any(cp in normalized for cp in CRITICAL_PATHS)


def _candidate_test_paths(file_path: str, workspace: str | None) -> list[str]:
    """Resolve candidate test file paths for a given source file."""
    if not workspace:
        return []
    stem = os.path.splitext(os.path.basename(file_path))[0]
    ext = os.path.splitext(file_path)[1]

    candidates = []
    if ext == '.py':
        candidates = [
            os.path.join(workspace, 'tests', f'test_{stem}.py'),
            os.path.join(workspace, 'tests', f'{stem}_test.py'),
        ]
    elif ext in ('.ts', '.tsx'):
        # Check common test locations
        for pattern in [
            os.path.join(workspace, 'src', '**', '__tests__', f'{stem}.test.ts'),
            os.path.join(workspace, 'src', '**', '__tests__', f'{stem}.test.tsx'),
            os.path.join(workspace, 'src', '**', f'{stem}.test.ts'),
            os.path.join(workspace, 'src', '**', f'{stem}.test.tsx'),
        ]:
            candidates.append(pattern)
    return candidates


def _test_exists(file_path: str, workspace: str | None) -> bool:
    """Check if any candidate test path exists."""
    for candidate in _candidate_test_paths(file_path, workspace):
        if '**' in candidate:
            # Glob-style: just check if any file matching the stem exists in tests
            parts = candidate.split('**')
            base_dir = parts[0]
            suffix = parts[1].lstrip('/\\')
            if os.path.isdir(base_dir):
                for root, _dirs, files in os.walk(base_dir):
                    for f in files:
                        if re.match(re.escape(suffix).replace(re.escape('*'), '.*'), f):
                            return True
        elif os.path.exists(candidate):
            return True
    return False


async def _check_test_mapping(ctx: HookContext) -> HookResult:
    """Warn if a critical file has no corresponding test."""
    file_path = ''
    if ctx.tool_args:
        file_path = str(ctx.tool_args.get('path', '') or ctx.tool_args.get('file_path', '') or '')
    if not file_path:
        return HookResult(action='allow')

    if not _is_critical(file_path):
        return HookResult(action='allow')

    if _test_exists(file_path, ctx.workspace_path):
        return HookResult(action='allow')

    return HookResult(
        action='allow',  # Non-blocking
        data={
            'type': 'testMappingWarning',
            'file': file_path,
            'message': f'No test covers {os.path.basename(file_path)}. Consider adding one before shipping.',
        },
    )


def register(reg: HookRegistry) -> None:
    """Register test-mapping gate hook."""
    reg.register(
        'test_mapping', HookEvent.POST_TOOL_USE, _check_test_mapping,
        matcher='write_file|edit_file|create_file', priority=60,
    )
