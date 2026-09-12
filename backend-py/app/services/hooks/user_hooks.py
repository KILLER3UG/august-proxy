"""User-extensible hooks — run lifecycle hooks from JSON configs.

The built-in hooks (secret_guard, blast radius, …) are Python guards
registered at startup. This module adds the user surface: JSON hook
definitions that shell out to a command, loaded from

  * ``<dataDir>/hooks.json``           — user-level, every session
  * ``<workspace>/.aug/hooks.json``    — workspace-level, only fires for
    sessions whose workspacePath matches the file's directory

Format (both levels)::

    {
      "hooks": [
        {
          "name": "block-env-writes",
          "event": "pre_tool_use",          // session_start | pre_tool_use |
                                            // post_tool_use | pre_model_call | stop
          "matcher": "write_file|edit_lines",// fnmatch, '|' alternation, '*' all
          "command": "python tools/hook.py", // shell string, user-trusted
          "timeoutSeconds": 10               // optional, capped at 120
        }
      ]
    }

Contract with the command (mirrors Claude Code / ZCode hooks): it receives
one JSON object on stdin — ``{event, sessionId, hookName, toolName,
toolArgs, toolResult, workspacePath}`` — and either

  * exits 0 (allow) / 2 (deny; stderr becomes the model-visible reason), or
  * prints a JSON verdict on stdout: ``{"action": "allow|deny|modify",
    "message"?: str, "args"?: object, "result"?: str}`` — takes precedence
    over the exit code. Any other exit is a non-blocking error (logged,
    treated as allow).

SECURITY: commands run UNSANDBOXED as the user — the config file itself is
the trust boundary (same model as the automations store and MCP stdio
launch, less the arg blocklist since the user authored the command).
Handlers are cheap to register: the config is re-read on mtime change at
each session prompt build, and unknown/duplicate names are skipped so a
deleted entry's handler never lingers silently (removed entries are
unregistered on reload).
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import subprocess
import time
from pathlib import Path
from typing import Any

from app.services.hooks.registry import registry
from app.services.hooks.types import HookContext, HookEvent, HookResult

logger = logging.getLogger(__name__)

_EVENTS: dict[str, HookEvent] = {e.value: e for e in HookEvent}
_MAX_TIMEOUT_S = 120.0

# name -> (origin path, mtime_ns) bookkeeping so reload detects both content
# changes (re-register) and file removals (unregister).
_LOADED: dict[str, str] = {}
_FILE_MTIMES: dict[str, int] = {}


def _config_paths(workspace: str | Path | None) -> list[tuple[str, Path]]:
    """(origin, path) pairs to load: user-level first, then workspace-level."""
    out: list[tuple[str, Path]] = []
    try:
        from app.lib.paths import dataDir

        out.append(('user', dataDir() / 'hooks.json'))
    except Exception:
        pass
    if workspace:
        ws = Path(workspace)
        if ws.is_dir():
            out.append((f'workspace:{ws}', ws / '.aug' / 'hooks.json'))
    return out


def _parse_specs(path: Path) -> list[dict[str, Any]]:
    try:
        raw = json.loads(path.read_text('utf-8'))
    except FileNotFoundError:
        return []
    except Exception as exc:
        logger.warning('hooks: %s unreadable (%s) — skipped', path, exc)
        return []
    entries = raw.get('hooks') if isinstance(raw, dict) else None
    if not isinstance(entries, list):
        logger.warning('hooks: %s has no "hooks" list — skipped', path)
        return []
    return [e for e in entries if isinstance(e, dict)]


def _make_handler(name: str, command: str, timeout_s: float, workspace_origin: str | None):
    """Build the async hook handler that shells out to ``command``."""

    async def handler(ctx: HookContext) -> HookResult:
        # A workspace-scoped hook must not gate other workspaces' sessions.
        if workspace_origin and (ctx.workspace_path or '') != workspace_origin:
            return HookResult(action='allow')
        payload = {
            'event': ctx.event.value,
            'sessionId': ctx.session_id,
            'hookName': name,
            'toolName': ctx.tool_name,
            'toolArgs': ctx.tool_args,
            'toolResult': ctx.tool_result,
            'workspacePath': ctx.workspace_path,
        }

        def _run() -> subprocess.CompletedProcess:
            return subprocess.run(  # noqa: S602 — user-authored command, see module SECURITY
                command,
                shell=True,  # noqa: S602
                input=json.dumps(payload),
                capture_output=True,
                text=True,
                timeout=timeout_s,
                cwd=workspace_origin or None,
                env={**os.environ, 'AUGUST_HOOK_EVENT': ctx.event.value},
            )

        try:
            proc = await asyncio.to_thread(_run)
        except subprocess.TimeoutExpired:
            logger.warning('hooks: %s timed out after %.0fs — non-blocking', name, timeout_s)
            return HookResult(action='allow', message=f'hook {name} timed out')
        except Exception as exc:
            logger.warning('hooks: %s failed to run: %s', name, exc)
            # PRE events fail closed via the registry only on exceptions;
            # a missing command is a config error — let the registry's
            # fail-closed mapping handle pre_*, allow the rest.
            raise RuntimeError(f'hook {name} could not execute: {exc}') from exc

        stdout = (proc.stdout or '').strip()
        if stdout.startswith('{'):
            try:
                verdict = json.loads(stdout)
            except Exception:
                verdict = None
            if isinstance(verdict, dict):
                action = str(verdict.get('action') or 'allow')
                message = str(verdict.get('message') or '')[:2000] or None
                if action == 'deny':
                    return HookResult(action='deny', message=message or f'hook {name} denied')
                if action == 'modify':
                    return HookResult(
                        action='modify',
                        message=message,
                        modified_args=verdict.get('args')
                        if isinstance(verdict.get('args'), dict)
                        else None,
                        modified_result=str(verdict['result'])[:20000]
                        if verdict.get('result') is not None
                        else None,
                    )
                return HookResult(action='allow', message=message)
        if proc.returncode == 2:
            reason = (proc.stderr or '').strip()[:2000] or f'hook {name} denied'
            return HookResult(action='deny', message=reason)
        if proc.returncode != 0:
            logger.info(
                'hooks: %s exited %d (non-blocking): %s',
                name, proc.returncode, (proc.stderr or '').strip()[:200],
            )
        return HookResult(action='allow')

    return handler


def _register_from_file(origin: str, path: Path) -> int:
    """(Re)register every hook defined in one config file. Returns count."""
    if not path.is_file():
        return 0
    mtime = path.stat().st_mtime_ns
    if _FILE_MTIMES.get(str(path)) == mtime:
        return 0  # unchanged since last load
    _FILE_MTIMES[str(path)] = mtime

    if origin == 'user':
        key_prefix = 'user:'
    else:
        ws_hash = hashlib.sha1(origin.encode('utf-8')).hexdigest()[:8]
        key_prefix = f'ws:{ws_hash}:'
    wanted: set[str] = set()
    count = 0
    for spec in _parse_specs(path):
        name = str(spec.get('name') or '').strip()
        event = _EVENTS.get(str(spec.get('event') or '').strip().lower())
        command = str(spec.get('command') or '').strip()
        if not name or event is None or not command:
            logger.warning('hooks: %s entry skipped (need name/event/command): %r', path, spec)
            continue
        # Deterministic unique key: origin-prefixed so a user hook and a
        # workspace hook with the same name coexist.
        reg_name = f'{key_prefix}{name}'
        wanted.add(reg_name)
        try:
            timeout_s = min(float(spec.get('timeoutSeconds') or 10), _MAX_TIMEOUT_S)
        except (TypeError, ValueError):
            timeout_s = 10.0
        priority = int(spec.get('priority') or 200)  # user hooks run after built-ins
        # Workspace hooks carry their home for the handler's scoping guard and
        # the command's cwd; user hooks scope nothing (None).
        workspace_origin = (
            origin.removeprefix('workspace:') if origin != 'user' else None
        )
        registry.unregister(reg_name)  # pick up edited definitions in place
        registry.register(
            reg_name,
            event,
            _make_handler(name, command, timeout_s, workspace_origin),
            matcher=str(spec.get('matcher') or '*'),
            priority=priority,
            timeout_s=timeout_s + 2.0,  # registry cap slightly above the subprocess cap
        )
        _LOADED[reg_name] = str(path)
        count += 1

    # Drop previously-registered hooks from this file that the new content
    # no longer defines (a deleted entry must not linger).
    for existing in list(_LOADED):
        if existing.startswith(key_prefix) and existing not in wanted:
            # Only remove if it was loaded from THIS path (other files keep theirs).
            if _LOADED.get(existing) == str(path):
                registry.unregister(existing)
                _LOADED.pop(existing, None)
    return count


def ensure_hooks_loaded(workspace: str | Path | None = None) -> int:
    """Load/reload every hook config that changed since the last call.
    Called at startup (user level) and once per prompt build with the
    session's workspace. Cheap: two stat() calls when nothing changed."""
    total = 0
    for origin, path in _config_paths(workspace):
        try:
            total += _register_from_file(origin, path)
        except Exception as exc:
            logger.warning('hooks: load of %s failed: %s', path, exc)
    return total


def describe() -> list[dict[str, Any]]:
    """Registered user/workspace hooks with their source file (for the UI)."""
    out: list[dict[str, Any]] = []
    for name, src in sorted(_LOADED.items()):
        out.append({'name': name, 'source': src, 'loadedAt': time.time()})
    return out


def reset_for_tests() -> None:
    """Forget load bookkeeping (test helper — does not touch the registry)."""
    _LOADED.clear()
    _FILE_MTIMES.clear()
