"""Managed-tool dispatch for the chat loop (P1#11 split, HIGH RISK).

Moved from workbench.py VERBATIM: ``_executeTool`` (the whole dispatcher —
MCP routing, hash-anchored edit rejection, the first-mutation baseline
snapshot join, the managed-tool budget) plus its immediate private helpers
(grant key / preview / categories and the four grant-store accessors), and
the two exec-only support symbols it reads: the ``AUGUST_TOOL_TIMEOUT_S``
constant and the best-effort baseline-snapshot join.

Nothing here was edited. workbench.py re-exports every name under its
original name, so the loop body (and the tests that monkeypatch
``wb._executeTool``) keep resolving them on the workbench module.

One-way import rule: nothing under loop/ imports workbench.py.
"""

from __future__ import annotations

import asyncio
import logging
import os

from app.json_narrowing import as_bool, as_dict, as_list, as_str
from app.services.workbench.loop.guards import _bulk_paths_from_args
from app.services.workbench.permissions import COMMAND_TOOLS as _COMMAND_TOOLS
from app.services.workbench.sessions import WorkbenchSession

logger = logging.getLogger('workbench')


def _envTimeoutSeconds(default: int = 300) -> int:
    try:
        return max(30, int(os.environ.get('AUGUST_TOOL_TIMEOUT_S', str(default))))
    except (TypeError, ValueError):
        return max(30, default)


_TOOL_EXEC_TIMEOUT_S = _envTimeoutSeconds()


async def _awaitBaselineSnapshot(fut: 'asyncio.Future[str] | None') -> str:
    """Best-effort join at the first-mutation boundary (never blocks >60s)."""
    if fut is None:
        return ''
    try:
        return str(await asyncio.wait_for(fut, 60.0) or '')
    except Exception:
        return ''


async def _executeTool(
    toolName: str, args: dict[str, object], session: WorkbenchSession, toolUseId: str = ''
) -> str:
    """Execute a workbench tool by dispatching to the correct handler.

    Two dispatch paths:
      * ``mcp__<server_id>__<tool>`` names route to the MCP client
        (``execute_mcp_tool_call``), which talks to the relevant MCP
        server subprocess over JSON-RPC.
      * everything else dispatches through ``tool_registry``.

    ``toolUseId`` (the parent tool call id) is published as a ContextVar so
    tool handlers can stamp their emitted events (e.g. subagentStart) with
    the parent call — the UI nests sub-agent blocks under it.
    """
    from app.services.tool_registry import dispatch as dispatchTool
    from app.services.workbench.context import currentSessionId, currentToolUseId

    token = currentSessionId.set(session.id)
    toolToken = currentToolUseId.set(toolUseId or '')
    try:
        from app.services.tools.mcp_client import executeMcpToolCall, isMcpToolName

        if isMcpToolName(toolName):
            try:
                return str(
                    await asyncio.wait_for(
                        executeMcpToolCall(toolName, args), timeout=_TOOL_EXEC_TIMEOUT_S
                    )
                )
            except asyncio.TimeoutError:
                return f'Error: MCP tool {toolName} timed out after {_TOOL_EXEC_TIMEOUT_S}s.'

        # Hash-anchored edits (surpass #5): mutating tools may carry the
        # sha256 of the file as read (the read tool reports it). A mismatch
        # means the file changed and the patch would corrupt it — reject and
        # tell the model to re-read instead of applying stale edits.
        # The old `\b(?:write|edit|…)\b` regex was DEAD for every
        # real tool — `_` is a word char, so `\bwrite\b` never matched
        # `write_file`/`edit_lines`/`apply_patch` (the only registered
        # fileHash-carrying tools). That silently disabled both the stale-write
        # hash gate AND the pre-mutation baseline join below. Use the canonical
        # args-aware predicate instead (same authority the worker + tracker use).
        from app.services.harness_mode import is_mutating_tool

        if is_mutating_tool(toolName, args):
            # Latency fix (2026-09-02): the turn-start shadow-git baseline runs
            # OFF the event loop; the FIRST mutating tool joins it here so the
            # snapshot still captures strictly-pre-mutation state. Read-only
            # tools and text-only turns never pay this join.
            _baselineFut = getattr(session, '_pendingBaselineSnapshot', None)
            if _baselineFut is not None:
                session._pendingBaselineSnapshot = None  # type: ignore[attr-defined]
                await _awaitBaselineSnapshot(_baselineFut)
            expected = as_str(args.get('fileHash') or args.get('file_hash') or '', '')
            if expected:
                target = as_str(
                    args.get('path')
                    or args.get('filePath')
                    or args.get('file_path')
                    or args.get('file')
                    or '',
                    '',
                )
                if target:
                    import hashlib
                    from pathlib import Path

                    try:
                        # Expand ~ and resolve symlinks before hashing — a raw
                        # Path('~/x') is never a real file, so `~`-relative
                        # targets silently skipped the stale-write guard
                        # (audit finding), and unresolved symlinks read the
                        # wrong bytes.
                        p = Path(target).expanduser()
                        if not p.is_absolute():
                            ws = as_str(getattr(session, 'workspacePath', '') or '')
                            p = Path(ws) / p if ws else p
                        p = p.resolve()
                        if p.is_file():
                            actual = hashlib.sha256(p.read_bytes()).hexdigest()
                            if actual != expected.lower():
                                from app.services.workbench.read_before_edit import (
                                    STALE_WRITE_HEADLINE,
                                )

                                return (
                                    f'Error: File {STALE_WRITE_HEADLINE}. Read it again '
                                    'before attempting to write it — the fileHash from '
                                    'your last read_file no longer matches the bytes '
                                    'on disk.'
                                )
                    except OSError:
                        pass

        # Lifecycle hooks: PRE_TOOL_USE (can deny or modify)
        try:
            from app.services.hooks import HookContext, HookEvent
            from app.services.hooks import registry as hook_registry

            pre_ctx = HookContext(
                event=HookEvent.PRE_TOOL_USE,
                session_id=session.id,
                tool_name=toolName,
                tool_args=args,
                workspace_path=getattr(session, 'workspacePath', None),
            )
            pre_results = await hook_registry.emit(HookEvent.PRE_TOOL_USE, pre_ctx)
            for r in pre_results:
                if r.action == 'deny':
                    return f'[BLOCKED by hook] {r.message or "Tool call denied by policy."}'
                if r.action == 'modify' and r.modified_args is not None:
                    args = r.modified_args
        except Exception as exc:
            # A PRE hook that raised cannot vet the call — the registered
            # pre-tool hooks are security guards (secret_guard, sensitive_code),
            # so failing CLOSED is the safe default: a broken hook must not
            # silently allow a credential write. The message names the hook
            # failure so the user can fix the hook config.
            logger.warning('PRE_TOOL_USE hook failed for %s — denying: %s', toolName, exc)
            return f'[BLOCKED by hook] Pre-tool hook failed to evaluate the call: {exc}'

        try:
            # The command runner's own max timeout equals _TOOL_EXEC_TIMEOUT_S
            # (300s) — give run_command-style tools grace past the harness cap
            # so a legitimately long command isn't cancelled mid-write at the
            # exact moment its own timeout expires (audit finding).
            toolTimeout = _TOOL_EXEC_TIMEOUT_S
            if toolName in ('run_command', 'bash', 'safe_python', 'terminal_command'):
                toolTimeout = _TOOL_EXEC_TIMEOUT_S + 30
            result = await asyncio.wait_for(dispatchTool(toolName, args), timeout=toolTimeout)
        except asyncio.TimeoutError:
            return f'Error: tool {toolName} timed out after {toolTimeout}s.'
        result_str = str(result)

        # Lifecycle hooks: POST_TOOL_USE (can modify result)
        try:
            from app.services.hooks import HookContext as HC2
            from app.services.hooks import HookEvent as HE2
            from app.services.hooks import registry as hr2

            post_ctx = HC2(
                event=HE2.POST_TOOL_USE,
                session_id=session.id,
                tool_name=toolName,
                tool_args=args,
                tool_result=result_str,
                workspace_path=getattr(session, 'workspacePath', None),
            )
            post_results = await hr2.emit(HE2.POST_TOOL_USE, post_ctx)
            for r in post_results:
                if r.action == 'modify' and r.modified_result is not None:
                    result_str = r.modified_result
        except Exception as exc:
            # POST hooks observe/modify an already-executed tool — a failure
            # here cannot roll the tool back, so log and continue (unlike the
            # PRE hook, which fails closed above).
            logger.warning('POST_TOOL_USE hook failed for %s: %s', toolName, exc)

        try:
            from app.services.post_observation import capture_after_tool

            await capture_after_tool(toolName, result_str)
        except Exception:
            pass
        return result_str
    except Exception as exc:
        import traceback as _tb

        tbList = _tb.extract_tb(exc.__traceback__)
        lastFrame = tbList[-1] if tbList else None
        feedback = {
            'tool': toolName,
            'error_type': type(exc).__name__,
            'error_message': str(exc),
            'file': lastFrame.filename if lastFrame else None,
            'line': lastFrame.lineno if lastFrame else None,
            'function': lastFrame.name if lastFrame else None,
            'offending_code': lastFrame.line if lastFrame else None,
        }
        session._failure_feedback = feedback
        session._failure_feedback_age = 0
        return f'Tool {toolName} failed: {feedback["error_type"]}: {feedback["error_message"]}'
    finally:
        currentSessionId.reset(token)
        currentToolUseId.reset(toolToken)


def _mutation_grant_key(toolName: str, args: dict[str, object] | None) -> str:
    """Stable key for once/session/always grants (tool + primary path)."""
    args = args or {}
    # Sandbox escape grants use a fingerprint path so Once/This chat/Always work.
    path = as_str(args.get('path'))
    if path.startswith('sandbox:unsandboxed:') or as_bool(args.get('sandboxEscape')):
        if path.startswith('sandbox:unsandboxed:'):
            return f'{toolName}:{path}'
        try:
            from app.services.sandbox import unsandboxed_grant_key

            return f'{toolName}:{unsandboxed_grant_key(as_str(args.get("command")))}'
        except Exception:
            return f'{toolName}:sandbox:unsandboxed:*'
    # Command grants are keyed by the EXACT command text (fingerprinted)
    # so a one-shot approval covers exactly the asked action — the old
    # 'run_command:*' fallback would have approved every later command.
    if toolName in _COMMAND_TOOLS:
        cmd = as_str(args.get('command'), '').strip()
        if cmd:
            from app.services.sandbox.runner import command_fingerprint

            return f'{toolName}:cmd:{command_fingerprint(cmd)}'
    bulk_paths = _bulk_paths_from_args(args)
    if bulk_paths:
        # Grant is scoped to this exact set of targets (sorted for stability).
        joined = ','.join(sorted(bulk_paths)[:40])
        return f'{toolName}:{joined}'
    path = (
        path
        or as_str(args.get('file_path'))
        or as_str(args.get('filePath'))
        or as_str(args.get('file'))
        or as_str(args.get('target'))
        or '*'
    )
    return f'{toolName}:{path}'


def _mutation_preview(toolName: str, args: dict[str, object] | None) -> str:
    """Short human preview for the approval UI (file content snippet, command, …)."""
    args = args or {}
    name = toolName.lower()
    op = as_str(args.get('operation')).lower()
    bulk_paths = _bulk_paths_from_args(args)
    if bulk_paths and (
        name in {'bulk', 'write_files', 'delete_sessions', 'rename_sessions', 'kill_daemons'}
        or op in {'write_files', 'delete_sessions', 'rename_sessions', 'kill_daemons'}
        or 'write_files' in name
        or 'delete_sessions' in name
    ):
        label = op or name
        listing = '\n'.join(f'• {p}' for p in bulk_paths[:25])
        more = f'\n…and {len(bulk_paths) - 25} more' if len(bulk_paths) > 25 else ''
        return f'Bulk {label} ({len(bulk_paths)} item(s)):\n{listing}{more}'
    path = (
        as_str(args.get('path'))
        or as_str(args.get('file_path'))
        or as_str(args.get('filePath'))
        or as_str(args.get('file'))
    )
    if any(m in name for m in ('write', 'edit', 'create', 'patch', 'str_replace')):
        content = (
            as_str(args.get('content'))
            or as_str(args.get('new_str'))
            or as_str(args.get('new_string'))
            or as_str(args.get('text'))
        )
        head = content[:1200] if content else ''
        if path and head:
            return f'Write {path}\n\n{head}{"…" if len(content) > 1200 else ""}'
        if path:
            return f'Modify {path}'
        return f'{toolName} (file change)'
    if any(m in name for m in ('bash', 'shell', 'command', 'exec', 'terminal')):
        cmd = as_str(args.get('command')) or as_str(args.get('cmd')) or as_str(args.get('input'))
        return f'Run: {cmd[:500]}' if cmd else f'Run {toolName}'
    if path:
        return f'{toolName} → {path}'
    return toolName


def _mutation_categories(
    toolName: str,
    args: dict[str, object] | None,
    workspace_path: str = '',
) -> list[str]:
    """Permission-axis categories for a pending call (sorted, may be empty).

    Same classifier the approval axis itself uses, so the value the UI reads to
    decide whether to offer a durable grant cannot drift from the value the
    policy clamps on. Non-command tools carry no categories — the durable-scope
    rule is about what a command can do.
    """
    if toolName not in _COMMAND_TOOLS:
        return []
    cmd = as_str(as_dict(args or {}).get('command'), '').strip()
    if not cmd:
        return []
    try:
        from app.services.workbench.permissions import classify_command

        return sorted(classify_command(cmd, workspace_path or ''))
    except Exception:
        logger.debug('mutation category classification failed', exc_info=True)
        return []


def _get_tool_grants(session: WorkbenchSession) -> dict[str, list[str]]:
    meta = as_dict(session.metadata) if session.metadata else {}
    raw = as_dict(meta.get('toolGrants')) if meta.get('toolGrants') is not None else {}
    return {
        'once': [str(x) for x in as_list(raw.get('once'))],
        'session': [str(x) for x in as_list(raw.get('session'))],
        'always': [str(x) for x in as_list(raw.get('always'))],
    }


def _set_tool_grants(session: WorkbenchSession, grants: dict[str, list[str]]) -> None:
    meta = dict(as_dict(session.metadata) if session.metadata else {})
    meta['toolGrants'] = {
        'once': list(grants.get('once') or []),
        'session': list(grants.get('session') or []),
        'always': list(grants.get('always') or []),
    }
    session.metadata = meta


def _load_always_grants_for_workspace(workspace_path: str) -> list[str]:
    if not workspace_path:
        return []
    try:
        from app.services.config_service import getConfig

        cfg = getConfig()
        store = as_dict(cfg.get('toolAlwaysGrants')) if cfg.get('toolAlwaysGrants') is not None else {}
        # Normalize path keys loosely
        for key, vals in store.items():
            if str(key).replace('\\', '/').rstrip('/').lower() == workspace_path.replace('\\', '/').rstrip('/').lower():
                return [str(v) for v in as_list(vals)]
        return [str(v) for v in as_list(store.get(workspace_path))]
    except Exception:
        return []


def _save_always_grant(workspace_path: str, key: str) -> None:
    if not workspace_path or not key:
        return
    try:
        from app.services.config_service import getConfig, saveConfig

        cfg = getConfig()
        store = as_dict(cfg.get('toolAlwaysGrants')) if cfg.get('toolAlwaysGrants') is not None else {}
        existing = [str(v) for v in as_list(store.get(workspace_path))]
        if key not in existing:
            existing.append(key)
        store[workspace_path] = existing
        # Also store tool:* wildcard companion if user chose path-specific
        cfg['toolAlwaysGrants'] = store
        saveConfig(cfg)
    except Exception:
        logger.debug('failed to persist always grant', exc_info=True)
