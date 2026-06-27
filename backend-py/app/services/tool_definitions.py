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
import re
from pathlib import Path
from typing import Any

from app.services import tool_registry

# ── Safety constants ─────────────────────────────────────────────────

_MAX_FILE_SIZE = 10 * 1024 * 1024  # 10 MB
_MAX_SEARCH_RESULTS = 100
_MAX_COMMAND_TIMEOUT = 300  # seconds
_ALLOWED_COMMAND_PREFIXES = [
    "git", "python", "node", "npm", "npx", "pip", "cargo", "rustc",
    "ls", "cat", "head", "tail", "wc", "sort", "uniq", "grep", "find",
    "echo", "printf", "date", "pwd", "which", "whoami", "id",
    "mkdir", "cp", "mv", "rm", "touch", "chmod", "chown",
    "curl", "wget",
    "docker", "podman",
    "cd", ".", "./",
]


# ── File tools ───────────────────────────────────────────────────────


async def _read_file(path: str) -> str:
    """Read a file from the filesystem."""
    file_path = Path(path).resolve()

    if not file_path.exists():
        return f"Error: File not found: {path}"
    if not file_path.is_file():
        return f"Error: Not a file: {path}"

    size = file_path.stat().st_size
    if size > _MAX_FILE_SIZE:
        return f"Error: File too large ({size} bytes). Maximum: {_MAX_FILE_SIZE} bytes."

    try:
        import aiofiles
        async with aiofiles.open(str(file_path), "r", encoding="utf-8", errors="replace") as f:
            content = await f.read()
        return content
    except Exception as exc:
        return f"Error reading file: {exc}"


async def _write_file(path: str, content: str) -> str:
    """Write content to a file."""
    file_path = Path(path).resolve()

    try:
        file_path.parent.mkdir(parents=True, exist_ok=True)
        import aiofiles
        async with aiofiles.open(str(file_path), "w", encoding="utf-8") as f:
            await f.write(content)
        return f"Successfully wrote {len(content)} bytes to {path}"
    except Exception as exc:
        return f"Error writing file: {exc}"


async def _list_directory(path: str) -> str:
    """List files and directories."""
    dir_path = Path(path).resolve()

    if not dir_path.exists():
        return f"Error: Path not found: {path}"
    if not dir_path.is_dir():
        return f"Error: Not a directory: {path}"

    try:
        entries = []
        for entry in sorted(dir_path.iterdir()):
            entry_type = "dir" if entry.is_dir() else "file"
            size = entry.stat().st_size if entry.is_file() else 0
            entries.append(f"{entry_type:4s} {entry.name:50s} {size:>10,} bytes")
        return "\n".join(entries) if entries else "(empty directory)"
    except Exception as exc:
        return f"Error listing directory: {exc}"


async def _search_files(query: str, path: str = ".") -> str:
    """Search file contents using ripgrep or fallback grep."""
    search_path = Path(path).resolve()

    if not search_path.exists():
        return f"Error: Path not found: {path}"

    try:
        # Try ripgrep first
        proc = await asyncio.create_subprocess_exec(
            "rg", "-n", "--max-count", "5", "-i", query, str(search_path),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            limit=_MAX_FILE_SIZE,
        )
        stdout, stderr = await asyncio.wait_for(
            proc.communicate(), timeout=30
        )

        if proc.returncode == 0:
            output = stdout.decode("utf-8", errors="replace")
            lines = output.split("\n")
            if len(lines) > _MAX_SEARCH_RESULTS:
                lines = lines[:_MAX_SEARCH_RESULTS]
                lines.append(f"... and {len(lines) - _MAX_SEARCH_RESULTS} more results")
            return "\n".join(lines)

        # Fallback: Python-based search
        return await _py_search_files(query, search_path)
    except asyncio.TimeoutError:
        return "Error: Search timed out"
    except Exception as exc:
        return f"Error searching files: {exc}"


async def _py_search_files(query: str, search_path: Path) -> str:
    """Python fallback file search (no external deps)."""
    results = []
    try:
        for file_path in search_path.rglob("*"):
            if not file_path.is_file():
                continue
            # Skip binary files
            try:
                if file_path.stat().st_size > _MAX_FILE_SIZE:
                    continue
                text = file_path.read_text("utf-8", errors="replace")
                for i, line in enumerate(text.split("\n"), 1):
                    if query.lower() in line.lower():
                        rel = file_path.relative_to(search_path)
                        results.append(f"{rel}:{i}:{line[:200].strip()}")
                        if len(results) >= _MAX_SEARCH_RESULTS:
                            break
            except (UnicodeDecodeError, OSError):
                continue
        return "\n".join(results) if results else "No matches found."
    except Exception as exc:
        return f"Error during search: {exc}"


# ── Shell command tool ───────────────────────────────────────────────


async def _run_command(command: str) -> str:
    """Run a shell command with safety checks."""
    # Safety check
    first_word = command.strip().split()[0].lower() if command.strip() else ""
    if first_word not in _ALLOWED_COMMAND_PREFIXES and not command.startswith("./"):
        return f"Error: Command '{first_word}' is not in the allowed list."

    # Check for dangerous patterns
    dangerous = ["rm -rf /", "rm -rf ~", ":(){ :|:& };:", "dd if=", "> /dev/", "mkfs."]
    for pattern in dangerous:
        if pattern in command:
            return f"Error: Command contains dangerous pattern: {pattern}"

    try:
        proc = await asyncio.create_subprocess_shell(
            command,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=os.getcwd(),
        )
        stdout, stderr = await asyncio.wait_for(
            proc.communicate(), timeout=_MAX_COMMAND_TIMEOUT
        )

        result_parts = []
        if stdout:
            result_parts.append(stdout.decode("utf-8", errors="replace"))
        if stderr:
            result_parts.append(f"STDERR:\n{stderr.decode('utf-8', errors='replace')}")
        if proc.returncode != 0:
            result_parts.append(f"Exit code: {proc.returncode}")
            if not result_parts:
                result_parts.append(f"Command failed with exit code {proc.returncode}")

        return "\n".join(result_parts) if result_parts else "(no output)"
    except asyncio.TimeoutError:
        return f"Error: Command timed out after {_MAX_COMMAND_TIMEOUT}s"
    except Exception as exc:
        return f"Error executing command: {exc}"


# ── Web tools ────────────────────────────────────────────────────────


async def _web_fetch(url: str) -> str:
    """Fetch a URL and return its content as Markdown."""
    import httpx

    # Block private/local addresses
    blocked_prefixes = ["http://localhost", "http://127.0.0.1", "http://10.", "http://172.16.", "http://192.168.", "https://localhost"]
    if any(url.startswith(prefix) for prefix in blocked_prefixes):
        return f"Error: Private/local network addresses are blocked: {url}"

    try:
        async with httpx.AsyncClient(timeout=30.0, follow_redirects=True) as client:
            resp = await client.get(url, headers={
                "User-Agent": "August-Proxy/1.0",
                "Accept": "text/html,text/markdown,text/plain,*/*",
            })
            resp.raise_for_status()

            content_type = resp.headers.get("content-type", "")
            text = resp.text

            # Basic markdown conversion for HTML
            if "text/html" in content_type:
                text = _html_to_markdown(text)

            return f"URL: {url}\nStatus: {resp.status_code}\n\n{text[:50000]}"
    except httpx.HTTPStatusError as exc:
        return f"Error: HTTP {exc.response.status_code} fetching {url}"
    except httpx.RequestError as exc:
        return f"Error: Request failed: {exc}"
    except Exception as exc:
        return f"Error: {exc}"


def _html_to_markdown(html: str) -> str:
    """Basic HTML to Markdown conversion."""
    import re

    text = html
    # Remove scripts and styles
    text = re.sub(r'<script[^>]*>.*?</script>', '', text, flags=re.DOTALL)
    text = re.sub(r'<style[^>]*>.*?</style>', '', text, flags=re.DOTALL)

    # Convert headings
    for i in range(6, 0, -1):
        text = re.sub(rf'<h{i}[^>]*>(.*?)</h{i}>', lambda m: '#' * i + ' ' + re.sub(r'<[^>]+>', '', m.group(1)), text, flags=re.DOTALL)

    # Convert links
    text = re.sub(r'<a[^>]*href="([^"]*)"[^>]*>(.*?)</a>', r'[\2](\1)', text)
    # Convert bold/italic
    text = re.sub(r'<(strong|b)[^>]*>(.*?)</\1>', r'**\2**', text, flags=re.DOTALL)
    text = re.sub(r'<(em|i)[^>]*>(.*?)</\1>', r'*\2*', text, flags=re.DOTALL)
    # Convert paragraphs and breaks
    text = re.sub(r'<br\s*/?>', '\n', text)
    text = re.sub(r'</p>', '\n\n', text)
    text = re.sub(r'</(div|tr|li)>', '\n', text)
    text = re.sub(r'<li[^>]*>', '- ', text)

    # Strip remaining tags
    text = re.sub(r'<[^>]+>', '', text)

    # Decode HTML entities
    text = text.replace('&amp;', '&').replace('&lt;', '<').replace('&gt;', '>')
    text = text.replace('&quot;', '"').replace('&#39;', "'").replace('&nbsp;', ' ')

    # Clean up whitespace
    lines = [line.strip() for line in text.split('\n')]
    text = '\n'.join(line for line in lines if line)

    return text[:50000]


async def _web_search(query: str, max_results: int = 10) -> str:
    """Search the web using DuckDuckGo."""
    import httpx

    max_results = min(max_results, 20)
    url = "https://api.duckduckgo.com/"
    params = {
        "q": query,
        "format": "json",
        "no_html": "1",
        "skip_disambig": "1",
    }

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(url, params=params)
            resp.raise_for_status()
            data = resp.json()

            results = []
            for i, topic in enumerate(data.get("RelatedTopics", [])[:max_results]):
                if "Text" in topic and "FirstURL" in topic:
                    results.append(f"[{i + 1}] {topic['Text']}\nURL: {topic['FirstURL']}")
                elif "Topics" in topic:
                    for sub in topic["Topics"][:3]:
                        if "Text" in sub and "FirstURL" in sub:
                            results.append(f"[{i + 1}] {sub['Text']}\nURL: {sub['FirstURL']}")

            if not results:
                # Try abstract
                abstract = data.get("Abstract", "")
                if abstract:
                    return f"Query: {query}\n\n{abstract}\nSource: {data.get('AbstractURL', '')}"

            output = f"Search query: {query}\nResult count: {len(results)}\n\n" + "\n\n".join(results)
            return output if results else f"No results found for: {query}"

    except httpx.HTTPStatusError as exc:
        return f"Error: HTTP {exc.response.status_code} from search API"
    except Exception as exc:
        return f"Error: {exc}"


# ── Memory tools ─────────────────────────────────────────────────────


async def _memory_search(query: str) -> str:
    """Search past conversation memory."""
    from app.services.memory_store import search_memory

    try:
        results = search_memory(query)
        if not results:
            return f"No memory results for: {query}"

        lines = [f"Memory search results for: {query}\n"]
        for r in results:
            key = r.get("key", "")
            value = r.get("value", "")
            if isinstance(value, dict) or isinstance(value, list):
                value = json.dumps(value, indent=2)
            lines.append(f"  [{key}]: {str(value)[:500]}")
        return "\n".join(lines)
    except Exception as exc:
        return f"Error searching memory: {exc}"


async def _fact_search(query: str) -> str:
    """Search semantic facts in memory."""
    # Uses the same search_memory function
    return await _memory_search(query)


async def _context_read() -> str:
    """Read current context/profile from memory."""
    from app.services.memory_store import get_memory

    try:
        profile = get_memory("user_profile")
        context = get_memory("current_context")
        preferences = get_memory("user_preferences")

        parts = []
        if profile:
            parts.append(f"User Profile:\n{json.dumps(profile, indent=2)}")
        if context:
            parts.append(f"Current Context:\n{json.dumps(context, indent=2)}")
        if preferences:
            parts.append(f"Preferences:\n{json.dumps(preferences, indent=2)}")

        return "\n\n".join(parts) if parts else "No context stored yet."
    except Exception as exc:
        return f"Error reading context: {exc}"


# ── Subagent tool ────────────────────────────────────────────────────


async def _spawn_subagent(goal: str, agent_id: str = "", context: str = "", toolsets: list[str] | None = None) -> str:
    """Dispatch a sub-agent for a focused task and return its final answer.

    Resolves the active workbench session via the contextvar, then runs the
    sub-agent to completion. Sub-agent lifecycle/text/tool events are emitted
    to the parent session's SSE stream through the event log.
    """
    from app.services import event_log
    from app.services.workbench import workbench as wb
    from app.services.workbench.context import current_session_id
    from app.services.workbench.subagent import execute_sub_agent

    session_id = current_session_id.get()
    session = wb.get_workbench_session(session_id)
    if not session:
        return "Error: no active workbench session for sub-agent dispatch."

    def _emit(ev: dict) -> None:
        try:
            event_log.event_log.append(session_id, ev.get("type", "subagent_event"), ev)
        except Exception:
            pass

    result = await execute_sub_agent(
        session, agent_id or "general", goal, context or "", emit=_emit
    )
    status = result.get("status", "completed")
    text = result.get("result") or result.get("error") or ""
    return f"Sub-agent '{result.get('agentId', 'general')}' {status}.\n\n{text}"


# ── Skill tools ──────────────────────────────────────────────────────


async def _load_skill(name: str) -> str:
    """Load a skill's full instructions."""
    from app.services import skill_service

    try:
        skill = skill_service.get(name)
        if not skill:
            return f"Error: Skill '{name}' not found."
        return f"# {skill['name']}\n\n{skill.get('description', '')}\n\n{skill.get('instructions', '')}"
    except Exception as exc:
        return f"Error loading skill '{name}': {exc}"


async def _list_skills(query: str = "") -> str:
    """List available skills with optional search."""
    from app.services import skill_service

    try:
        if query:
            skills = skill_service.search(query)
        else:
            skills = skill_service.list_all()

        if not skills:
            return "No skills found." if not query else f"No skills matching '{query}'."

        lines = [f"Available skills ({len(skills)}):\n"]
        for s in skills:
            lines.append(f"  - {s['name']:30s} {s.get('description', '')[:60]}")
        return "\n".join(lines)
    except Exception as exc:
        return f"Error listing skills: {exc}"


async def _skill_manage(
    action: str,
    name: str,
    body: str = "",
    description: str = "",
    trigger: str = "",
    category: str = "uncategorized",
    file_path: str = "",
    content: str = "",
) -> str:
    """Author/maintain skills: create, patch, write_file, remove_file, delete.

    Lessons captured by the background-review reflection loop land here as
    agent-authored skills the model loads via load_skill.
    """
    from app.services import skill_service
    from app.services.skill_service import SkillValidationError

    try:
        if action == "create":
            result = skill_service.create_skill(
                name, description, body,
                trigger=trigger, category=category,
            )
            return f"Created skill '{name}'.\n" + json.dumps(result, default=str)
        if action == "patch":
            result = skill_service.patch_skill(
                name,
                body=body or None,
                description=description or None,
                trigger=trigger or None,
                category=category or None,
            )
            return f"Patched skill '{name}'.\n" + json.dumps(result, default=str)
        if action == "write_file":
            result = skill_service.write_skill_file(name, file_path, content)
            return f"Wrote '{file_path}' into skill '{name}'.\n" + json.dumps(result, default=str)
        if action == "remove_file":
            result = skill_service.remove_skill_file(name, file_path)
            return f"Removed '{file_path}' from skill '{name}'.\n" + json.dumps(result, default=str)
        if action == "delete":
            result = skill_service.delete_skill(name)
            return f"Deleted skill '{name}'.\n" + json.dumps(result, default=str)
        return (
            f"Error: unknown skill_manage action '{action}'. "
            "Use one of: create, patch, write_file, remove_file, delete."
        )
    except SkillValidationError as exc:
        return f"Error: {exc}"
    except Exception as exc:
        return f"Error in skill_manage({action}): {exc}"


# ── Registration ─────────────────────────────────────────────────────


def register_all() -> None:
    """Register all core tool definitions with real handlers."""

    # ── File tools ──
    tool_registry.register(
        "read_file",
        "Read a file from the filesystem.",
        _read_file,
        {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Absolute path to the file to read."},
            },
            "required": ["path"],
        },
    )
    tool_registry.register(
        "write_file",
        "Write content to a file. Creates parent directories if needed.",
        _write_file,
        {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Absolute path to the file to write."},
                "content": {"type": "string", "description": "The content to write."},
            },
            "required": ["path", "content"],
        },
    )
    tool_registry.register(
        "list_directory",
        "List files and directories in a given path.",
        _list_directory,
        {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Absolute path to the directory."},
            },
            "required": ["path"],
        },
    )
    tool_registry.register(
        "search_files",
        "Search file contents using ripgrep or fallback grep.",
        _search_files,
        {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "The text to search for."},
                "path": {"type": "string", "description": "Directory to search in (default: current)."},
            },
            "required": ["query"],
        },
    )

    # ── Shell tools ──
    tool_registry.register(
        "run_command",
        "Run a shell command. Only allowed commands are permitted.",
        _run_command,
        {
            "type": "object",
            "properties": {
                "command": {"type": "string", "description": "The command to execute."},
            },
            "required": ["command"],
        },
    )

    # ── Web tools ──
    tool_registry.register(
        "web_fetch",
        "Fetch a URL and return its content as clean Markdown.",
        _web_fetch,
        {
            "type": "object",
            "properties": {
                "url": {"type": "string", "description": "The URL to fetch."},
            },
            "required": ["url"],
        },
    )
    tool_registry.register(
        "web_search",
        "Search the web for information using DuckDuckGo.",
        _web_search,
        {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "The search query."},
                "max_results": {"type": "integer", "description": "Maximum results (max 20)."},
            },
            "required": ["query"],
        },
    )

    # ── Browser tools ──
    from app.services.browser import handlers as _browser

    tool_registry.register(
        "browser_open",
        "Open a URL in the headless browser and return the page title plus an "
        "interactive-element snapshot (use the [@eN] refs for clicks/types).",
        _browser.browser_open,
        {
            "type": "object",
            "properties": {
                "url": {"type": "string", "description": "The URL to open."},
                "wait_until": {
                    "type": "string",
                    "enum": ["load", "domcontentloaded", "networkidle", "commit"],
                    "description": "When navigation is considered complete (default: load).",
                },
            },
            "required": ["url"],
        },
    )
    tool_registry.register(
        "browser_click",
        "Click an element. Locate it by ref (e.g. '@e3'), CSS/XPath selector, "
        "or visible text.",
        _browser.browser_click,
        {
            "type": "object",
            "properties": {
                "ref": {"type": "string", "description": "Snapshot ref like '@e3'."},
                "selector": {"type": "string", "description": "CSS selector or XPath (//...)."},
                "text": {"type": "string", "description": "Visible text of the element."},
            },
        },
    )
    tool_registry.register(
        "browser_type",
        "Type text into a field located by ref or selector, optionally pressing Enter to submit.",
        _browser.browser_type,
        {
            "type": "object",
            "properties": {
                "ref": {"type": "string", "description": "Snapshot ref like '@e3'."},
                "selector": {"type": "string", "description": "CSS selector or XPath."},
                "text": {"type": "string", "description": "The text to type into the field."},
                "submit": {"type": "boolean", "description": "Press Enter after typing (default false)."},
            },
            "required": ["text"],
        },
    )
    tool_registry.register(
        "browser_select",
        "Select an option value from a <select> dropdown located by ref or selector.",
        _browser.browser_select,
        {
            "type": "object",
            "properties": {
                "ref": {"type": "string", "description": "Snapshot ref like '@e3'."},
                "selector": {"type": "string", "description": "CSS selector or XPath."},
                "value": {"type": "string", "description": "The option value to select."},
            },
            "required": ["value"],
        },
    )
    tool_registry.register(
        "browser_scroll",
        "Scroll the page by a number of pixels, or scroll an element into view.",
        _browser.browser_scroll,
        {
            "type": "object",
            "properties": {
                "direction": {"type": "string", "enum": ["up", "down"], "description": "Scroll direction (default down)."},
                "amount": {"type": "integer", "description": "Pixels to scroll (default 400)."},
                "selector": {"type": "string", "description": "Scroll this element into view instead of the page."},
            },
        },
    )
    tool_registry.register(
        "browser_wait",
        "Wait for an element to appear, a load state, or a fixed timeout.",
        _browser.browser_wait,
        {
            "type": "object",
            "properties": {
                "strategy": {
                    "type": "string",
                    "enum": ["selector", "load", "networkidle", "timeout"],
                    "description": "What to wait for (default selector).",
                },
                "selector": {"type": "string", "description": "Required when strategy=selector."},
                "timeout": {"type": "integer", "description": "Seconds before giving up (default 30)."},
            },
        },
    )
    tool_registry.register(
        "browser_screenshot",
        "Take a screenshot, save it to disk, and return the file path + dimensions.",
        _browser.browser_screenshot,
        {
            "type": "object",
            "properties": {
                "full_page": {"type": "boolean", "description": "Capture the full scrollable page (default false)."},
            },
        },
    )
    tool_registry.register(
        "browser_evaluate",
        "Execute JavaScript in the page and return the JSON-serialised result.",
        _browser.browser_evaluate,
        {
            "type": "object",
            "properties": {
                "script": {"type": "string", "description": "JavaScript expression or function body to evaluate."},
            },
            "required": ["script"],
        },
    )
    tool_registry.register(
        "browser_get_content",
        "Extract page content. format: html | text | markdown | elements "
        "(elements returns the interactive-element snapshot).",
        _browser.browser_get_content,
        {
            "type": "object",
            "properties": {
                "format": {
                    "type": "string",
                    "enum": ["html", "text", "markdown", "elements"],
                    "description": "What to extract (default text).",
                },
            },
        },
    )

    # ── Memory tools ──
    tool_registry.register(
        "memory_search",
        "Search past conversation memory for relevant context.",
        _memory_search,
        {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Search query."},
            },
            "required": ["query"],
        },
    )
    tool_registry.register(
        "fact_search",
        "Search semantic facts in memory.",
        _fact_search,
        {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Search query."},
            },
            "required": ["query"],
        },
    )
    tool_registry.register(
        "context_read",
        "Read current user context and profile from memory.",
        _context_read,
        {"type": "object", "properties": {}, "required": []},
    )

    # ── Agent tools ──
    tool_registry.register(
        "spawn_subagent",
        "Dispatch a sub-agent for a focused task. Give it a clear goal and "
        "context; optionally specify an agent_id (from create_agent) to use a "
        "specialized agent, otherwise a general-purpose agent runs.",
        _spawn_subagent,
        {
            "type": "object",
            "properties": {
                "goal": {"type": "string", "description": "The task goal for the sub-agent."},
                "agent_id": {"type": "string", "description": "Agent id to run (from create_agent). Defaults to a general agent."},
                "context": {"type": "string", "description": "Background context for the sub-agent."},
                "toolsets": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Tool sets to grant the sub-agent (optional).",
                },
            },
            "required": ["goal"],
        },
    )

    # ── Skill tools ──
    tool_registry.register(
        "load_skill",
        "Load a skill's full instructions by name.",
        _load_skill,
        {
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "The skill name to load."},
            },
            "required": ["name"],
        },
    )
    tool_registry.register(
        "list_skills",
        "List available skills with optional search query.",
        _list_skills,
        {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Optional search query."},
            },
            "required": [],
        },
    )
    tool_registry.register(
        "skill_manage",
        "Author and maintain skills: create a new skill, patch an existing one, "
        "write/remove support files (scripts/, references/, templates/), or delete. "
        "Captured lessons live as skills the model loads via load_skill.",
        _skill_manage,
        {
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["create", "patch", "write_file", "remove_file", "delete"],
                    "description": "What to do.",
                },
                "name": {"type": "string", "description": "Skill name (lowercase, dotted/hyphenated)."},
                "body": {"type": "string", "description": "SKILL.md body markdown (create/patch)."},
                "description": {"type": "string", "description": "One-sentence description ≤ 60 chars (create/patch)."},
                "trigger": {"type": "string", "description": "Optional trigger phrase (create/patch)."},
                "category": {"type": "string", "description": "Skill category (create/patch)."},
                "file_path": {"type": "string", "description": "Relative path within the skill dir (write_file/remove_file)."},
                "content": {"type": "string", "description": "File contents (write_file)."},
            },
            "required": ["action", "name"],
        },
    )

    # ── Self-configuration tools (alias, fallback) ──
    from app.services import self_config_tools
    self_config_tools.register()
