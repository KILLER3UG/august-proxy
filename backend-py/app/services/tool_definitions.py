"""
Register all built-in tool handlers into the tool registry.

Replaces the echo stubs with real implementations:
- File tools (read, write, list, search) via aiofiles/pathlib
- Shell commands via asyncio.create_subprocess_exec
- Web tools via httpx
- Memory tools via memory_store.py
- Subagent dispatch via HTTP
- Skill tools via skill_service.py
"""

from __future__ import annotations
import asyncio
import json
import os
from pathlib import Path
from typing import cast
from app.services import tool_registry
from app.json_narrowing import as_bool, as_dict, as_int, as_list, as_str
from app.services.tool_html import html_to_markdown, unescape_html

# Private aliases for minimal churn inside this module
_htmlToMarkdown = html_to_markdown
_unescapeHtml = unescape_html

_MAXFileSize = 10 * 1024 * 1024
_MAXSearchResults = 100
_MAXCommandTimeout = 300
_ALLOWEDCommandPrefixes = [
    'git',
    'python',
    'node',
    'npm',
    'npx',
    'pip',
    'cargo',
    'rustc',
    'ls',
    'cat',
    'head',
    'tail',
    'wc',
    'sort',
    'uniq',
    'grep',
    'find',
    'echo',
    'printf',
    'date',
    'pwd',
    'which',
    'whoami',
    'id',
    'mkdir',
    'cp',
    'mv',
    'rm',
    'touch',
    'chmod',
    'chown',
    'curl',
    'wget',
    'docker',
    'podman',
    'cd',
    '.',
    './',
]


async def _readFile(path: str) -> str:
    """Read a file from the filesystem."""
    filePath = Path(path).resolve()
    if not filePath.exists():
        return f'Error: File not found: {path}'
    if not filePath.is_file():
        return f'Error: Not a file: {path}'
    size = filePath.stat().st_size
    if size > _MAXFileSize:
        return f'Error: File too large ({size} bytes). Maximum: {_MAXFileSize} bytes.'
    try:
        import aiofiles

        async with aiofiles.open(str(filePath), 'r', encoding='utf-8', errors='replace') as f:
            content = await f.read()
        return content
    except Exception as exc:
        return f'Error reading file: {exc}'


async def _writeFile(path: str, content: str) -> str:
    """Write content to a file."""
    filePath = Path(path).resolve()
    try:
        filePath.parent.mkdir(parents=True, exist_ok=True)
        import aiofiles

        async with aiofiles.open(str(filePath), 'w', encoding='utf-8') as f:
            await f.write(content)
        return f'Successfully wrote {len(content)} bytes to {path}'
    except Exception as exc:
        return f'Error writing file: {exc}'


async def _listDirectory(path: str) -> str:
    """List files and directories."""
    dirPath = Path(path).resolve()
    if not dirPath.exists():
        return f'Error: Path not found: {path}'
    if not dirPath.is_dir():
        return f'Error: Not a directory: {path}'
    try:
        entries = []
        for entry in sorted(dirPath.iterdir()):
            entryType = 'dir' if entry.is_dir() else 'file'
            size = entry.stat().st_size if entry.is_file() else 0
            entries.append(f'{entryType:4s} {entry.name:50s} {size:>10,} bytes')
        return '\n'.join(entries) if entries else '(empty directory)'
    except Exception as exc:
        return f'Error listing directory: {exc}'


async def _searchFiles(query: str, path: str = '.') -> str:
    """Search file contents using ripgrep or fallback grep."""
    searchPath = Path(path).resolve()
    if not searchPath.exists():
        return f'Error: Path not found: {path}'
    try:
        proc = await asyncio.create_subprocess_exec(
            'rg',
            '-n',
            '--max-count',
            '5',
            '-i',
            query,
            str(searchPath),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            limit=_MAXFileSize,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=30)
        if proc.returncode == 0:
            output = stdout.decode('utf-8', errors='replace')
            lines = output.split('\n')
            if len(lines) > _MAXSearchResults:
                lines = lines[:_MAXSearchResults]
                lines.append(f'... and {len(lines) - _MAXSearchResults} more results')
            return '\n'.join(lines)
        return await _pySearchFiles(query, searchPath)
    except asyncio.TimeoutError:
        return 'Error: Search timed out'
    except Exception as exc:
        return f'Error searching files: {exc}'


async def _pySearchFiles(query: str, searchPath: Path) -> str:
    """Python fallback file search (no external deps)."""
    results = []
    try:
        for filePath in searchPath.rglob('*'):
            if not filePath.is_file():
                continue
            try:
                if filePath.stat().st_size > _MAXFileSize:
                    continue
                text = filePath.read_text('utf-8', errors='replace')
                for i, line in enumerate(text.split('\n'), 1):
                    if query.lower() in line.lower():
                        rel = filePath.relative_to(searchPath)
                        results.append(f'{rel}:{i}:{line[:200].strip()}')
                        if len(results) >= _MAXSearchResults:
                            break
            except (UnicodeDecodeError, OSError):
                continue
        return '\n'.join(results) if results else 'No matches found.'
    except Exception as exc:
        return f'Error during search: {exc}'


async def _runCommand(command: str) -> str:
    """Run a shell command with safety checks."""
    firstWord = command.strip().split()[0].lower() if command.strip() else ''
    if firstWord not in _ALLOWEDCommandPrefixes and (not command.startswith('./')):
        return f"Error: Command '{firstWord}' is not in the allowed list."
    dangerous = ['rm -rf /', 'rm -rf ~', ':(){ :|:& };:', 'dd if=', '> /dev/', 'mkfs.']
    for pattern in dangerous:
        if pattern in command:
            return f'Error: Command contains dangerous pattern: {pattern}'
    try:
        proc = await asyncio.create_subprocess_shell(
            command, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, cwd=os.getcwd()
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=_MAXCommandTimeout)
        resultParts = []
        if stdout:
            resultParts.append(stdout.decode('utf-8', errors='replace'))
        if stderr:
            resultParts.append(f'STDERR:\n{stderr.decode("utf-8", errors="replace")}')
        if proc.returncode != 0:
            resultParts.append(f'Exit code: {proc.returncode}')
            if not resultParts:
                resultParts.append(f'Command failed with exit code {proc.returncode}')
        return '\n'.join(resultParts) if resultParts else '(no output)'
    except asyncio.TimeoutError:
        return f'Error: Command timed out after {_MAXCommandTimeout}s'
    except Exception as exc:
        return f'Error executing command: {exc}'


async def _fetchUrlContent(url: str, maxLength: int = 50000) -> str:
    """Fetch a URL and return its content as Markdown (shared helper for web_fetch and web_search auto-fetch)."""
    import httpx

    blockedPrefixes = [
        'http://localhost',
        'http://127.0.0.1',
        'http://10.',
        'http://172.16.',
        'http://192.168.',
        'https://localhost',
    ]
    if any((url.startswith(prefix) for prefix in blockedPrefixes)):
        return f'Error: Private/local network addresses are blocked: {url}'
    try:
        async with httpx.AsyncClient(timeout=30.0, follow_redirects=True) as client:
            resp = await client.get(
                url, headers={'User-Agent': 'August-Proxy/1.0', 'Accept': 'text/html,text/markdown,text/plain,*/*'}
            )
            resp.raise_for_status()
            contentType = as_str(resp.headers.get('content-type'), '')
            text = resp.text
            if 'text/html' in contentType:
                text = _htmlToMarkdown(text)
            return f'URL: {url}\nStatus: {resp.status_code}\n\n{text[:maxLength]}'
    except httpx.HTTPStatusError as exc:
        return f'Error: HTTP {exc.response.status_code} fetching {url}'
    except httpx.RequestError as exc:
        return f'Error: Request failed: {exc}'
    except Exception as exc:
        return f'Error: {exc}'


async def _webFetch(url: str) -> str:
    """Fetch a URL and return its content as Markdown."""
    return await _fetchUrlContent(url, maxLength=50000)


async def _webSearch(query: str, maxResults: int = 10) -> str:
    """Search the web using DuckDuckGo. Automatically fetches content from top results.

    Uses the ``duckduckgo_search`` library which handles DuckDuckGo's anti-bot
    protections. Returns a JSON object (serialised) with:
      search_query    — the query string
      result_count    — number of search results found
      results         — array of {index, title, url, snippet}
      fetched_content — array of {index, url, content} with full page content
    """
    import json as _json
    from ddgs import DDGS

    maxResults = min(maxResults, 20)
    searchResults: list[dict[str, object]] = []
    errorHint: str | None = None
    try:

        def _search() -> list[dict[str, str]]:
            with DDGS() as ddgs:
                return list(ddgs.text(query, max_results=maxResults))

        loop = asyncio.get_running_loop()
        rawResults: list[dict[str, str]] = await loop.run_in_executor(None, _search)
        for i, r in enumerate(rawResults):
            title = as_str(r.get('title'), '').strip()
            url = as_str(r.get('href'), '').strip()
            snippet = as_str(r.get('body'), '').strip()
            if title and url:
                searchResults.append({'index': i + 1, 'title': title, 'url': url, 'snippet': snippet})
    except Exception as exc:
        errorHint = str(exc)
    if not searchResults and (not errorHint):
        try:
            import httpx

            async with httpx.AsyncClient(timeout=10.0) as client:
                iaResp = await client.get(
                    'https://api.duckduckgo.com/',
                    params={'q': query, 'format': 'json', 'no_html': '1', 'skip_disambig': '1'},
                )
                iaResp.raise_for_status()
                iaData = iaResp.json()
                abstract = as_str(iaData.get('Abstract'), '')
                if abstract:
                    return _json.dumps(
                        {
                            'search_query': query,
                            'result_count': 0,
                            'abstract': abstract,
                            'source': as_str(iaData.get('AbstractURL'), ''),
                        },
                        ensure_ascii=False,
                    )
        except Exception:
            pass
    if not searchResults:
        msg = errorHint or f'No results found for: {query}'
        return _json.dumps({'search_query': query, 'result_count': 0, 'message': msg}, ensure_ascii=False)
    fetchCount = min(10, len(searchResults))
    fetchedContent: list[dict[str, object]] = []
    if fetchCount > 0:
        fetched = await asyncio.gather(
            *[_fetchUrlContent(as_str(r['url']), maxLength=8000) for r in searchResults[:fetchCount]],
            return_exceptions=True,
        )
        for i, content in enumerate(fetched):
            if isinstance(content, BaseException):
                continue
            fetchedContent.append(
                {'index': searchResults[i]['index'], 'url': searchResults[i]['url'], 'content': content}
            )
    return _json.dumps(
        {
            'search_query': query,
            'result_count': len(searchResults),
            'results': searchResults,
            'fetched_content': fetchedContent,
        },
        ensure_ascii=False,
    )


async def _memorySearch(query: str) -> str:
    """Search past conversation memory."""
    from app.services.memory_store import search_memory

    try:
        results = search_memory(query)
        if not results:
            return f'No memory results for: {query}'
        lines = [f'Memory search results for: {query}\n']
        for r in results:
            key = as_str(r.get('key'), '')
            value = r.get('value', '')
            if isinstance(value, dict) or isinstance(value, list):
                value = json.dumps(value, indent=2)
            lines.append(f'  [{key}]: {str(value)[:500]}')
        return '\n'.join(lines)
    except Exception as exc:
        return f'Error searching memory: {exc}'


async def _factSearch(query: str) -> str:
    """Search semantic facts in memory."""
    return await _memorySearch(query)


async def _contextRead() -> str:
    """Read current context/profile from memory."""
    from app.services.memory_store import get_memory

    try:
        profile = get_memory('userProfile')
        context = get_memory('current_context')
        preferences = get_memory('user_preferences')
        parts = []
        if profile:
            parts.append(f'User Profile:\n{json.dumps(profile, indent=2)}')
        if context:
            parts.append(f'Current Context:\n{json.dumps(context, indent=2)}')
        if preferences:
            parts.append(f'Preferences:\n{json.dumps(preferences, indent=2)}')
        return '\n\n'.join(parts) if parts else 'No context stored yet.'
    except Exception as exc:
        return f'Error reading context: {exc}'


async def _brainQuery(store: str, query: str = '', filters: str = '', limit: int = 10) -> str:
    """Read-only unified brain query across any cognitive store.

    Returns compact JSON. Stores not yet shipped return "not available".
    """
    from app.services.memory_store import brain_query as _bq

    try:
        filtersDict = {}
        if filters and filters.strip():
            import json as _json

            try:
                filtersDict = _json.loads(filters)
            except _json.JSONDecodeError:
                pass
        result = _bq(store, query, filtersDict or None, limit)
        return result
    except Exception as exc:
        return f'{{"error": "brain_query: {exc}"}}'


async def _diagnoseProxy() -> str:
    """Diagnose the proxy runtime environment.

    Returns paths, providers, mode, permissions — let the model
    understand its own runtime.
    """
    from app.config import settings

    parts = [
        f'Data directory: {settings.dataDir}',
        f'Web dist: {settings.webDist}',
        f'Port: {settings.port}',
        'Mode: python',
        f'Environment: {getattr(settings, "env", "production")}',
    ]
    try:
        providers = as_dict(settings.config.get('providers'), {})
        if isinstance(providers, dict):
            for name, info in list(providers.items())[:10]:
                if isinstance(info, dict):
                    parts.append(f"Provider '{name}': model={as_str(info.get('model'), 'unknown')}")
    except Exception:
        pass
    try:
        from app.services.workbench import workbench as _wb

        _getCurrentSessionMode = getattr(_wb, 'getCurrentSessionMode', None)
        if callable(_getCurrentSessionMode):
            parts.append(f'Session mode: {_getCurrentSessionMode()}')
    except Exception:
        pass
    return '\n'.join(parts)


async def _describeEnvironment() -> str:
    """Describe the workspace environment: paths, VCS, available tools."""
    from app.config import settings

    parts = ['Proxy version: 0.1.0', f'Data directory: {settings.dataDir}', 'Platform: win32']
    try:
        import subprocess

        cwd = str(settings.dataDir.parent)
        branch = subprocess.run(
            ['git', 'branch', '--show-current'], cwd=cwd, capture_output=True, text=True, timeout=5
        ).stdout.strip()
        if branch:
            parts.append(f'Git branch: {branch}')
    except Exception:
        pass
    try:
        from app.services.tool_registry import listTools

        tools = listTools()
        parts.append(f'Registered tools: {len(tools)}')
    except Exception:
        pass
    return '\n'.join(parts)


async def _updateHeuristics(action: str, rule: str = '') -> str:
    """Manage learned behavioral heuristics.

    Actions:
      add    — Persist a new rule: "Project uses Yarn, not NPM"
      remove — Remove a rule by id or exact text
      clear  — Clear all rules
      list   — Return current rules
    """
    from app.services.heuristics_service import addHeuristic, removeByRule, clearHeuristics, listHeuristics

    try:
        if action == 'add':
            if not rule:
                return "Error: 'rule' is required for add action."
            result = addHeuristic(rule)
            if result is not None:
                return f'Heuristic added (id={result}).'
            return 'Heuristic already exists (duplicate).'
        elif action == 'remove':
            if not rule:
                return "Error: 'rule' is required for remove action."
            if removeByRule(rule):
                return f'Heuristic removed: {rule}'
            return f'Heuristic not found: {rule}'
        elif action == 'clear':
            count = clearHeuristics()
            return f'Cleared {count} heuristic(s).'
        elif action == 'list':
            heuristics = listHeuristics()
            if not heuristics:
                return 'No learned heuristics.'
            lines = ['Learned heuristics:']
            for h in heuristics:
                lines.append(f'  [{h["id"]}] {h["rule"]} (source: {h["source"]}, category: {h["category"]})')
            return '\n'.join(lines)
        else:
            return f'Unknown action: {action}. Use add, remove, clear, or list.'
    except Exception as exc:
        return f'Error managing heuristics: {exc}'


async def _writeScratchpad(text: str) -> str:
    """Write a scratchpad note to working memory.

    Proxy keeps only the MOST RECENT scratchpad content. Old content is
    DISCARDED — not accumulated. Use this to keep your current analysis,
    code diff, or reasoning step in front of you across turns.
    """
    from app.services.workbench.workbench import get_session, updateSessionState

    try:
        session = get_session()
        if not session:
            return 'Error: no active workbench session.'
        await updateSessionState(
            session,
            executionState={
                'phase': as_str(getattr(session, '_execution_state', {}).get('phase'), 'research'),
                'step': as_int(getattr(session, '_execution_state', {}).get('step'), 1),
                'completed': as_list(getattr(session, '_execution_state', {}).get('completed'), []),
                'blockers': as_list(getattr(session, '_execution_state', {}).get('blockers'), []),
            },
        )
        setattr(session, '_working_memory', text)
        return 'Scratchpad updated.'
    except Exception as exc:
        return f'Error writing scratchpad: {exc}'


async def _spawnDaemon(name: str, prompt: str, watchCondition: str = '', tools: str = '') -> str:
    """Spawn a background daemon (subconscious agent).

    Daemons run headless on the Cerebellum model (fast, cheap) with a
    restricted read-only tool set. They are best for polling, monitoring,
    and watching. The model gets results in <subconscious_updates> on
    subsequent turns.

    For complex background tasks that need full tool access, use
    ``spawn_subagent`` instead.
    """
    from app.services.daemon_manager import DaemonSpec, getManager

    try:
        toolsList: list[str] | None = None
        if tools == 'none':
            toolsList = []
        elif tools:
            toolsList = [t.strip() for t in tools.split(',') if t.strip()]
        spec = DaemonSpec(name=name, prompt=prompt, watchCondition=watchCondition or None, tools=toolsList)
        from app.services.workbench.workbench import get_session

        session = get_session()
        sessionId = getattr(session, 'id', '') if session else ''
        manager = getManager()
        result = await manager.spawn(spec, sessionId)
        return result
    except Exception as exc:
        return f'Error spawning daemon: {exc}'


async def _listDaemons(sessionId: str = '') -> str:
    """List active daemons and their status."""
    from app.services.daemon_manager import getManager

    try:
        manager = getManager()
        daemons = manager.list_daemons(sessionId or None)
        if not daemons:
            return 'No active daemons.'
        lines = ['Active daemons:']
        for d in daemons:
            status = d['status']
            dd = as_dict(d)
            triggered = ' [TRIGGERED]' if as_bool(dd.get('triggered')) else ''
            err = as_str(dd.get('error'))
            error = f' error={err}' if err else ''
            lines.append(f'  [{d["name"]}] {status}{triggered}{error}')
        return '\n'.join(lines)
    except Exception as exc:
        return f'Error listing daemons: {exc}'


async def _killDaemon(daemonId: str) -> str:
    """Kill a running daemon by its id."""
    from app.services.daemon_manager import getManager

    try:
        manager = getManager()
        if await manager.kill(daemonId):
            return f"Daemon '{daemonId}' killed."
        return f"Daemon '{daemonId}' not found."
    except Exception as exc:
        return f'Error killing daemon: {exc}'


async def _writeBlackboard(key: str, value: str, priority: int = 0) -> str:
    """Write a note to the shared blackboard.

    Blackboard notes are visible to all agents in the session (main loop
    and daemons). They expire after a TTL or when acknowledged.
    """
    from app.services.workbench.workbench import get_session
    from app.services.blackboard_service import writeNote

    try:
        session = get_session()
        sessionId = getattr(session, 'id', '') if session else ''
        agent = getattr(session, '_current_agent', 'main')
        writeNote(sessionId, agent, key, value, priority)
        return f'Blackboard note written: {key}'
    except Exception as exc:
        return f'Error writing blackboard: {exc}'


async def _readBlackboard(agent: str = '', key: str = '') -> str:
    """Read notes from the shared blackboard."""
    from app.services.workbench.workbench import get_session
    from app.services.blackboard_service import readNotes

    try:
        session = get_session()
        sessionId = getattr(session, 'id', '') if session else ''
        notes = readNotes(sessionId, agent, key)
        if not notes:
            return 'No blackboard notes found.'
        lines = ['Blackboard notes:']
        for n in notes[:20]:
            lines.append(f'  [{n["agent"]}] {n["key"]}: {str(n["value"])[:200]}')
        return '\n'.join(lines)
    except Exception as exc:
        return f'Error reading blackboard: {exc}'


async def _clearBlackboard(agent: str = '') -> str:
    """Clear blackboard notes."""
    from app.services.workbench.workbench import get_session
    from app.services.blackboard_service import clearNotes

    try:
        session = get_session()
        sessionId = getattr(session, 'id', '') if session else ''
        count = clearNotes(sessionId, agent)
        return f'Cleared {count} blackboard note(s).'
    except Exception as exc:
        return f'Error clearing blackboard: {exc}'


async def _updateState(
    phase: str = '', step: int = 1, completed: str = '', blockers: str = '', verificationCommand: str = ''
) -> str:
    """Track execution state across a multi-step task.

    Gives the model phase awareness so it doesn't loop or repeat steps.
    State is stored in the session and injected as <execution_state> in
    Tier 3 on every turn. Call this when you start, progress through, or
    complete a phase of work.
    """
    from app.services.workbench.workbench import get_session, updateSessionState

    try:
        session = get_session()
        if not session:
            return 'Error: no active workbench session.'
        completedList = [c.strip() for c in completed.split('\n') if c.strip()] if completed else []
        blockersList = [b.strip() for b in blockers.split('\n') if b.strip()] if blockers else []
        state: dict[str, object] = {
            'phase': phase or getattr(session, '_execution_phase', 'research'),
            'step': step,
            'completed': completedList,
            'blockers': blockersList,
        }
        if verificationCommand:
            state['verification_command'] = verificationCommand
        await updateSessionState(session, executionState=state)
        return f'State updated: phase={state["phase"]}, step={state["step"]}, completed={len(completedList)}, blockers={len(blockersList)}'
    except Exception as exc:
        return f'Error updating state: {exc}'


async def _spawnSubagent(goal: str, agentId: str = '', context: str = '', toolsets: list[str] | None = None) -> str:
    """Dispatch a sub-agent for a focused task and return its final answer.

    Resolves the active workbench session via the contextvar, then runs the
    sub-agent to completion. Sub-agent lifecycle/text/tool events are emitted
    to the parent session's SSE stream through the event log.
    """
    from app.services import event_log
    from app.services.workbench import workbench as wb
    from app.services.workbench.context import currentSessionId
    from app.services.workbench.subagent import executeSubAgent

    sessionId = currentSessionId.get()
    session = wb.getWorkbenchSession(sessionId)
    if not session:
        return 'Error: no active workbench session for sub-agent dispatch.'

    def _emit(ev: dict) -> None:
        try:
            event_log.event_log.append(sessionId, as_str(ev.get('type'), 'subagent_event'), ev)
        except Exception:
            pass

    result = await executeSubAgent(session, agentId or 'general', goal, context or '', emit=_emit)
    status = as_str(result.get('status'), 'completed')
    text = as_str(result.get('result')) or as_str(result.get('error')) or ''
    return f"Sub-agent '{as_str(result.get('agentId'), 'general')}' {status}.\n\n{text}"


async def _loadSkill(name: str) -> str:
    """Load a skill's full instructions."""
    from app.services import skill_service

    try:
        skill = skill_service.get(name)
        if not skill:
            return f"Error: Skill '{name}' not found."
        return f'# {skill["name"]}\n\n{as_str(skill.get("description"), "")}\n\n{as_str(skill.get("instructions"), "")}'
    except Exception as exc:
        return f"Error loading skill '{name}': {exc}"


async def _listSkills(query: str = '') -> str:
    """List available skills with optional search."""
    from app.services import skill_service

    try:
        if query:
            skills = skill_service.search(query)
        else:
            skills = skill_service.list_all()
        if not skills:
            return 'No skills found.' if not query else f"No skills matching '{query}'."
        lines = [f'Available skills ({len(skills)}):\n']
        for s in skills:
            lines.append(f'  - {s["name"]:30s} {as_str(s.get("description"), "")[:60]}')
        return '\n'.join(lines)
    except Exception as exc:
        return f'Error listing skills: {exc}'


async def _skillManage(
    action: str,
    name: str,
    body: str = '',
    description: str = '',
    trigger: str = '',
    category: str = 'uncategorized',
    filePath: str = '',
    content: str = '',
) -> str:
    """Author/maintain skills: create, patch, write_file, remove_file, delete.

    Lessons captured by the background-review reflection loop land here as
    agent-authored skills the model loads via load_skill.
    """
    from app.services import skill_service
    from app.services.skill_service import SkillValidationError

    try:
        if action == 'create':
            result = skill_service.createSkill(name, description, body, trigger=trigger, category=category)
            return f"Created skill '{name}'.\n" + json.dumps(result, default=str)
        if action == 'patch':
            result = skill_service.patchSkill(
                name,
                body=body or None,
                description=description or None,
                trigger=trigger or None,
                category=category or None,
            )
            return f"Patched skill '{name}'.\n" + json.dumps(result, default=str)
        if action == 'write_file':
            result = skill_service.writeSkillFile(name, filePath, content)
            return f"Wrote '{filePath}' into skill '{name}'.\n" + json.dumps(result, default=str)
        if action == 'remove_file':
            result = skill_service.removeSkillFile(name, filePath)
            return f"Removed '{filePath}' from skill '{name}'.\n" + json.dumps(result, default=str)
        if action == 'delete':
            result = skill_service.deleteSkill(name)
            return f"Deleted skill '{name}'.\n" + json.dumps(result, default=str)
        return f"Error: unknown skill_manage action '{action}'. Use one of: create, patch, write_file, remove_file, delete."
    except SkillValidationError as exc:
        return f'Error: {exc}'
    except Exception as exc:
        return f'Error in skill_manage({action}): {exc}'


async def _deleteSession(sessionId: str) -> str:
    """Delete a chat session and its messages from the brain database."""
    from app.services import memory_store

    try:
        i = memory_store.delete_session_record(sessionId)
        msgCount = memory_store.delete_session_messages(sessionId)
        if i:
            return f'Deleted session {sessionId} (+ {msgCount} message(s)).'
        return f'Session {sessionId} not found — it may have already been deleted.'
    except Exception as exc:
        return f'Error deleting session {sessionId}: {exc}'


async def _deleteFolder(folderId: str) -> str:
    """Delete all sessions in a folder and their messages from the brain database."""
    from app.services import memory_store

    try:
        sessions = memory_store.list_sessions()
        folderSessions = [s for s in sessions if s.get('folderId') == folderId]
        if not folderSessions:
            return f"No sessions found in folder '{folderId}'."
        count = 0
        msgCount = 0
        for s in folderSessions:
            sid = s['id']
            if memory_store.delete_session_record(sid):
                count += 1
                msgCount += memory_store.delete_session_messages(sid)
        return f"Deleted {count} session(s) from folder '{folderId}' (+ {msgCount} message(s))."
    except Exception as exc:
        return f"Error deleting folder '{folderId}': {exc}"


def registerAll() -> None:
    """Register all core tool definitions with real handlers."""
    tool_registry.register(
        'read_file',
        'Read a file from the filesystem. Path must be absolute. Max file size ~10 MB.',
        _readFile,
        {
            'type': 'object',
            'properties': {'path': {'type': 'string', 'description': 'Absolute path to the file to read.'}},
            'required': ['path'],
        },
    )
    tool_registry.register(
        'write_file',
        'Write content to a file, overwriting any existing content. Creates parent directories if needed.',
        _writeFile,
        {
            'type': 'object',
            'properties': {
                'path': {'type': 'string', 'description': 'Absolute path to the file to write.'},
                'content': {'type': 'string', 'description': 'The content to write.'},
            },
            'required': ['path', 'content'],
        },
    )
    tool_registry.register(
        'list_directory',
        'List files and directories in a given path (absolute). Output shows dir/file prefix, size, and name.',
        _listDirectory,
        {
            'type': 'object',
            'properties': {'path': {'type': 'string', 'description': 'Absolute path to the directory.'}},
            'required': ['path'],
        },
    )
    tool_registry.register(
        'search_files',
        'Search file contents using ripgrep or fallback grep. Case-insensitive. Path defaults to current directory.',
        _searchFiles,
        {
            'type': 'object',
            'properties': {
                'query': {'type': 'string', 'description': 'The text to search for.'},
                'path': {'type': 'string', 'description': 'Directory to search in (default: current).'},
            },
            'required': ['query'],
        },
    )
    tool_registry.register(
        'run_command',
        'Run a shell command. Allowed commands: git, python, npm, node, npx, ls, cat, less, head, tail, wc, echo, mkdir, cp, mv, rm, rmdir, chmod, curl, wget, jq, sed, awk, grep, sort, uniq, date, whoami, pwd, cd, source, export, which, make, cargo, pip, deno, bun, go, rustc, clang, gcc, bash, zsh, sh. Timeout 300s.',
        _runCommand,
        {
            'type': 'object',
            'properties': {'command': {'type': 'string', 'description': 'The command to execute.'}},
            'required': ['command'],
        },
    )
    tool_registry.register(
        'web_fetch',
        'Fetch a specific URL and return its content as clean Markdown. Use this to fetch additional URLs beyond those auto-fetched by web_search. Local/private network addresses are blocked. Max response ~50 KB.',
        _webFetch,
        {
            'type': 'object',
            'properties': {'url': {'type': 'string', 'description': 'The URL to fetch.'}},
            'required': ['url'],
        },
    )
    tool_registry.register(
        'web_search',
        'Search the web for information using DuckDuckGo. Returns a numbered list of results with titles, URLs, and snippets, and AUTOMATICALLY fetches the full content from the top 10 results (fetched content appears below the result list). Max 20 results (default 10).',
        _webSearch,
        {
            'type': 'object',
            'properties': {
                'query': {'type': 'string', 'description': 'The search query.'},
                'maxResults': {
                    'type': 'integer',
                    'description': 'Maximum results (max 20, default 10). Request at least 5-10 for thorough research.',
                },
            },
            'required': ['query'],
        },
    )
    from app.services.browser import handlers as _browser

    tool_registry.register(
        'browser_open',
        'Open a URL in the headless browser and return the page title plus an interactive-element snapshot (use the [@eN] refs for clicks/types).',
        _browser.browserOpen,
        {
            'type': 'object',
            'properties': {
                'url': {'type': 'string', 'description': 'The URL to open.'},
                'waitUntil': {
                    'type': 'string',
                    'enum': ['load', 'domcontentloaded', 'networkidle', 'commit'],
                    'description': 'When navigation is considered complete (default: load).',
                },
            },
            'required': ['url'],
        },
    )
    tool_registry.register(
        'browser_click',
        "Click an element. Locate it by ref (e.g. '@e3'), CSS/XPath selector, or visible text.",
        _browser.browserClick,
        {
            'type': 'object',
            'properties': {
                'ref': {'type': 'string', 'description': "Snapshot ref like '@e3'."},
                'selector': {'type': 'string', 'description': 'CSS selector or XPath (//...).'},
                'text': {'type': 'string', 'description': 'Visible text of the element.'},
            },
        },
    )
    tool_registry.register(
        'browser_type',
        'Type text into a field located by ref or selector, optionally pressing Enter to submit.',
        _browser.browserType,
        {
            'type': 'object',
            'properties': {
                'ref': {'type': 'string', 'description': "Snapshot ref like '@e3'."},
                'selector': {'type': 'string', 'description': 'CSS selector or XPath.'},
                'text': {'type': 'string', 'description': 'The text to type into the field.'},
                'submit': {'type': 'boolean', 'description': 'Press Enter after typing (default false).'},
            },
            'required': ['text'],
        },
    )
    tool_registry.register(
        'browser_select',
        'Select an option value from a <select> dropdown located by ref or selector.',
        _browser.browserSelect,
        {
            'type': 'object',
            'properties': {
                'ref': {'type': 'string', 'description': "Snapshot ref like '@e3'."},
                'selector': {'type': 'string', 'description': 'CSS selector or XPath.'},
                'value': {'type': 'string', 'description': 'The option value to select.'},
            },
            'required': ['value'],
        },
    )
    tool_registry.register(
        'browser_scroll',
        'Scroll the page by a number of pixels, or scroll an element into view.',
        _browser.browserScroll,
        {
            'type': 'object',
            'properties': {
                'direction': {
                    'type': 'string',
                    'enum': ['up', 'down'],
                    'description': 'Scroll direction (default down).',
                },
                'amount': {'type': 'integer', 'description': 'Pixels to scroll (default 400).'},
                'selector': {'type': 'string', 'description': 'Scroll this element into view instead of the page.'},
            },
        },
    )
    tool_registry.register(
        'browser_wait',
        'Wait for an element to appear, a load state, or a fixed timeout.',
        _browser.browserWait,
        {
            'type': 'object',
            'properties': {
                'strategy': {
                    'type': 'string',
                    'enum': ['selector', 'load', 'networkidle', 'timeout'],
                    'description': 'What to wait for (default selector).',
                },
                'selector': {'type': 'string', 'description': 'Required when strategy=selector.'},
                'timeout': {'type': 'integer', 'description': 'Seconds before giving up (default 30).'},
            },
        },
    )
    tool_registry.register(
        'browser_screenshot',
        'Take a screenshot, save it to disk, and return the file path + dimensions.',
        _browser.browserScreenshot,
        {
            'type': 'object',
            'properties': {
                'fullPage': {'type': 'boolean', 'description': 'Capture the full scrollable page (default false).'}
            },
        },
    )
    tool_registry.register(
        'browser_evaluate',
        'Execute JavaScript in the page and return the JSON-serialised result.',
        _browser.browserEvaluate,
        {
            'type': 'object',
            'properties': {
                'script': {'type': 'string', 'description': 'JavaScript expression or function body to evaluate.'}
            },
            'required': ['script'],
        },
    )
    tool_registry.register(
        'browser_get_content',
        'Extract page content. format: html | text | markdown | elements (elements returns the interactive-element snapshot).',
        _browser.browserGetContent,
        {
            'type': 'object',
            'properties': {
                'format': {
                    'type': 'string',
                    'enum': ['html', 'text', 'markdown', 'elements'],
                    'description': 'What to extract (default text).',
                }
            },
        },
    )
    from app.services import desktop_automation as _desktop

    tool_registry.register(
        'desktop_screenshot',
        'Capture the real desktop screen as a base64-encoded PNG image.',
        cast(tool_registry.ToolHandler, _desktop.takeScreenshot),
        {'type': 'object', 'properties': {}, 'required': []},
    )
    tool_registry.register(
        'desktop_screen_size',
        'Return the real screen dimensions in pixels.',
        cast(tool_registry.ToolHandler, _desktop.getScreenSize),
        {'type': 'object', 'properties': {}, 'required': []},
    )
    tool_registry.register(
        'desktop_mouse_position',
        'Return the current real cursor (x, y) position.',
        cast(tool_registry.ToolHandler, _desktop.getMousePosition),
        {'type': 'object', 'properties': {}, 'required': []},
    )
    tool_registry.register(
        'desktop_click',
        'Move the real mouse to (x, y) and click. button: left|right|middle.',
        cast(tool_registry.ToolHandler, _desktop.clickMouse),
        {
            'type': 'object',
            'properties': {
                'x': {'type': 'integer', 'description': 'Screen X coordinate.'},
                'y': {'type': 'integer', 'description': 'Screen Y coordinate.'},
                'button': {
                    'type': 'string',
                    'enum': ['left', 'right', 'middle'],
                    'description': 'Mouse button (default left).',
                },
            },
            'required': ['x', 'y'],
        },
    )
    tool_registry.register(
        'desktop_type',
        'Type text on the real keyboard.',
        cast(tool_registry.ToolHandler, _desktop.typeText),
        {
            'type': 'object',
            'properties': {'text': {'type': 'string', 'description': 'The text to type.'}},
            'required': ['text'],
        },
    )
    tool_registry.register(
        'desktop_press_key',
        'Press a single real keyboard key (e.g. enter, escape, tab, f1).',
        cast(tool_registry.ToolHandler, _desktop.pressKey),
        {
            'type': 'object',
            'properties': {'key': {'type': 'string', 'description': "Key name (e.g. 'enter', 'escape')."}},
            'required': ['key'],
        },
    )
    tool_registry.register(
        'desktop_list_windows',
        'List visible desktop windows with title and position (x, y, width, height).',
        cast(tool_registry.ToolHandler, _desktop.listWindows),
        {'type': 'object', 'properties': {}, 'required': []},
    )
    tool_registry.register(
        'desktop_open_url',
        "Open a URL in the user's default *visible* browser (not headless). Use browser_open instead for background page inspection.",
        cast(tool_registry.ToolHandler, _desktop.openUrl),
        {
            'type': 'object',
            'properties': {'url': {'type': 'string', 'description': 'The URL to open.'}},
            'required': ['url'],
        },
    )
    tool_registry.register(
        'memory_search',
        'Search the key-value memory store for past conversation context and session notes. Use this to recall earlier information from the current or past sessions. For structured facts use fact_search; for cross-store search use brain_query.',
        _memorySearch,
        {
            'type': 'object',
            'properties': {'query': {'type': 'string', 'description': 'Search query.'}},
            'required': ['query'],
        },
    )
    tool_registry.register(
        'fact_search',
        'Search structured semantic facts (key-value pairs with categories, confidence scores, and source tracking). Use this when looking for specific learned facts, preferences, or knowledge. For general conversation history use memory_search; for broad cross-store search use brain_query.',
        _factSearch,
        {
            'type': 'object',
            'properties': {'query': {'type': 'string', 'description': 'Search query.'}},
            'required': ['query'],
        },
    )
    tool_registry.register(
        'context_read',
        "Read the user's current context and profile from memory: stored preferences, session goals, user profile data, and active context flags.",
        _contextRead,
        {'type': 'object', 'properties': {}, 'required': []},
    )
    tool_registry.register(
        'brain_query',
        "Read-only query across any brain store (memory, autoMemories, heuristics, facts, sessions, messages, timeline, blackboard, graph, daemons, exams, examAttempts). Stores not yet shipped return 'not available'. Returns compact JSON rows.",
        _brainQuery,
        {
            'type': 'object',
            'properties': {
                'store': {
                    'type': 'string',
                    'description': 'Which brain store to read: memory | autoMemories | heuristics | facts | sessions | messages | timeline | blackboard | graph | daemons | exams | examAttempts',
                    'enum': [
                        'memory',
                        'autoMemories',
                        'heuristics',
                        'facts',
                        'sessions',
                        'messages',
                        'timeline',
                        'blackboard',
                        'graph',
                        'daemons',
                        'exams',
                        'examAttempts',
                    ],
                },
                'query': {'type': 'string', 'description': 'Search text (FTS or LIKE). Optional.'},
                'filters': {
                    'type': 'string',
                    'description': 'JSON object of column filters (e.g. \'{"category": "auth"}\'). Optional.',
                },
                'limit': {'type': 'integer', 'description': 'Max rows to return (1-100). Default 10.'},
            },
            'required': ['store'],
        },
    )
    tool_registry.register(
        'diagnose_proxy',
        "Diagnose the proxy runtime environment: paths, providers, mode, permissions. Use this to understand what the proxy can do and how it's configured.",
        _diagnoseProxy,
        {'type': 'object', 'properties': {}, 'required': []},
    )
    tool_registry.register(
        'describe_environment',
        'Describe the workspace environment: data paths, VCS status, registered tools. Use diagnose_proxy to understand the proxy runtime itself.',
        _describeEnvironment,
        {'type': 'object', 'properties': {}, 'required': []},
    )
    tool_registry.register(
        'update_heuristics',
        "Manage learned behavioral heuristics. Add a rule when you notice a recurring user preference (e.g. 'Project uses Yarn, not NPM'). Rules persist across sessions. Actions: add, remove, clear, list.",
        _updateHeuristics,
        {
            'type': 'object',
            'properties': {
                'action': {
                    'type': 'string',
                    'description': 'Action to perform: add | remove | clear | list',
                    'enum': ['add', 'remove', 'clear', 'list'],
                },
                'rule': {'type': 'string', 'description': 'The heuristic rule text (required for add/remove).'},
            },
            'required': ['action'],
        },
    )
    tool_registry.register(
        'update_state',
        "Track execution state across a multi-step task. Call this when you start, progress through, or complete a phase. The state is injected into the next turn's system prompt so you know where you left off.",
        _updateState,
        {
            'type': 'object',
            'properties': {
                'phase': {
                    'type': 'string',
                    'description': 'Current phase: research | plan | implement | review | complete',
                    'enum': ['research', 'plan', 'implement', 'review', 'complete'],
                },
                'step': {'type': 'integer', 'description': 'Step number within the current phase.'},
                'completed': {
                    'type': 'string',
                    'description': 'Newline-separated list of completed items for this step.',
                },
                'blockers': {'type': 'string', 'description': 'Newline-separated list of blockers.'},
                'verificationCommand': {
                    'type': 'string',
                    'description': 'Command to verify this step is complete (optional, for Verifier Reflex).',
                },
            },
            'required': [],
        },
    )
    tool_registry.register(
        'write_scratchpad',
        'Write a scratchpad note to working memory. Only the most recent note is kept — old content is discarded. Use this to hold your current analysis, code diff, or reasoning step across turns.',
        _writeScratchpad,
        {
            'type': 'object',
            'properties': {
                'text': {
                    'type': 'string',
                    'description': 'The scratchpad content. This REPLACES any previous scratchpad content.',
                }
            },
            'required': ['text'],
        },
    )
    tool_registry.register(
        'spawn_daemon',
        'Spawn a background daemon (subconscious agent). Daemons run on the Cerebellum model (fast, cheap) with a restricted read-only tool set. Use for polling, monitoring, and watching CI. Results appear in <subconscious_updates> on subsequent turns. Max 3 daemons per session.',
        _spawnDaemon,
        {
            'type': 'object',
            'properties': {
                'name': {'type': 'string', 'description': 'Unique name for the daemon.'},
                'prompt': {'type': 'string', 'description': 'Instructions for the daemon.'},
                'watchCondition': {
                    'type': 'string',
                    'description': 'Trigger: on_completion | on_match:KEYWORD | on_change | (empty for none)',
                },
                'tools': {
                    'type': 'string',
                    'description': "Comma-separated tool allowlist, or 'none' for no tools, or empty for defaults.",
                },
            },
            'required': ['name', 'prompt'],
        },
    )
    tool_registry.register(
        'list_daemons',
        'List active daemons and their status (running, triggered, completed, errored). Limited to 3 per session. Omits session_id to use the current session.',
        _listDaemons,
        {
            'type': 'object',
            'properties': {
                'sessionId': {'type': 'string', 'description': 'Session ID (optional; defaults to current).'}
            },
            'required': [],
        },
    )
    tool_registry.register(
        'kill_daemon',
        'Kill a daemon by its id. Use list_daemons to find active daemon IDs.',
        _killDaemon,
        {
            'type': 'object',
            'properties': {'daemonId': {'type': 'string', 'description': 'Daemon ID to kill.'}},
            'required': ['daemonId'],
        },
    )
    tool_registry.register(
        'write_blackboard',
        'Write a note to the shared blackboard. Notes are visible to all agents (main loop and daemons) in the session. Use for inter-agent coordination (e.g. daemon posting test results for the main model).',
        _writeBlackboard,
        {
            'type': 'object',
            'properties': {
                'key': {'type': 'string', 'description': 'Note key (e.g. test_result, file_change).'},
                'value': {'type': 'string', 'description': 'Note content (plain text or JSON).'},
                'priority': {'type': 'integer', 'description': 'Priority (0-10, higher = more urgent). Default 0.'},
            },
            'required': ['key', 'value'],
        },
    )
    tool_registry.register(
        'read_blackboard',
        'Read notes from the shared blackboard, filtered by agent and/or key. Returns all notes if no filters provided.',
        _readBlackboard,
        {
            'type': 'object',
            'properties': {
                'agent': {'type': 'string', 'description': 'Filter by agent name (optional).'},
                'key': {'type': 'string', 'description': 'Filter by key (optional).'},
            },
            'required': [],
        },
    )
    tool_registry.register(
        'clear_blackboard',
        'Clear notes from the shared blackboard, optionally scoped to a specific agent.',
        _clearBlackboard,
        {
            'type': 'object',
            'properties': {'agent': {'type': 'string', 'description': 'Only clear notes from this agent (optional).'}},
            'required': [],
        },
    )
    tool_registry.register(
        'spawn_subagent',
        'Dispatch a sub-agent for a focused task. Give it a clear goal and context; optionally specify an agentId (from create_agent) to use a specialized agent, otherwise a general-purpose agent runs.',
        _spawnSubagent,
        {
            'type': 'object',
            'properties': {
                'goal': {'type': 'string', 'description': 'The task goal for the sub-agent.'},
                'agentId': {
                    'type': 'string',
                    'description': 'Agent id to run (from create_agent). Defaults to a general agent.',
                },
                'context': {'type': 'string', 'description': 'Background context for the sub-agent.'},
                'toolsets': {
                    'type': 'array',
                    'items': {'type': 'string'},
                    'description': 'Tool sets to grant the sub-agent (optional).',
                },
            },
            'required': ['goal'],
        },
    )
    tool_registry.register(
        'load_skill',
        "Load a skill's full instructions by name. Use list_skills first to discover available skill names.",
        _loadSkill,
        {
            'type': 'object',
            'properties': {'name': {'type': 'string', 'description': 'The skill name to load.'}},
            'required': ['name'],
        },
    )
    tool_registry.register(
        'list_skills',
        "List available skills with optional search query. Use load_skill to load a skill's full instructions.",
        _listSkills,
        {
            'type': 'object',
            'properties': {'query': {'type': 'string', 'description': 'Optional search query.'}},
            'required': [],
        },
    )
    tool_registry.register(
        'skill_manage',
        'Author and maintain skills: create a new skill, patch an existing one, write/remove support files (scripts/, references/, templates/), or delete. Captured lessons live as skills the model loads via load_skill.',
        _skillManage,
        {
            'type': 'object',
            'properties': {
                'action': {
                    'type': 'string',
                    'enum': ['create', 'patch', 'write_file', 'remove_file', 'delete'],
                    'description': 'What to do.',
                },
                'name': {'type': 'string', 'description': 'Skill name (lowercase, dotted/hyphenated).'},
                'body': {'type': 'string', 'description': 'SKILL.md body markdown (create/patch).'},
                'description': {'type': 'string', 'description': 'One-sentence description ≤ 60 chars (create/patch).'},
                'trigger': {'type': 'string', 'description': 'Optional trigger phrase (create/patch).'},
                'category': {'type': 'string', 'description': 'Skill category (create/patch).'},
                'filePath': {
                    'type': 'string',
                    'description': 'Relative path within the skill dir (write_file/remove_file).',
                },
                'content': {'type': 'string', 'description': 'File contents (write_file).'},
            },
            'required': ['action', 'name'],
        },
    )
    tool_registry.register(
        'delete_session',
        'Delete a chat session by its session ID (e.g. sess_abc123). Messages are also deleted. Use brain_query(store=sessions) to list sessions first. IMPORTANT: Before calling this tool, list the sessions, present to the user exactly which session(s) you intend to delete, and wait for explicit user confirmation ("yes", "go ahead", "delete it") before proceeding. Never delete without confirmation.',
        _deleteSession,
        {
            'type': 'object',
            'properties': {'sessionId': {'type': 'string', 'description': 'The session ID to delete.'}},
            'required': ['sessionId'],
        },
    )
    tool_registry.register(
        'delete_folder',
        'Delete all sessions in a folder by folder ID. All messages in those sessions are also deleted. Use brain_query(store=sessions) to list sessions and their folderId values first. IMPORTANT: Before calling this tool, list the folder contents, present to the user exactly which folder and sessions you intend to delete, and wait for explicit user confirmation ("yes", "go ahead", "delete it") before proceeding. Never delete without confirmation.',
        _deleteFolder,
        {
            'type': 'object',
            'properties': {'folderId': {'type': 'string', 'description': 'The folder ID whose sessions to delete.'}},
            'required': ['folderId'],
        },
    )
    from app.services import self_config_tools

    self_config_tools.register()
    from app.services import provider_setup_tool

    provider_setup_tool.register()
