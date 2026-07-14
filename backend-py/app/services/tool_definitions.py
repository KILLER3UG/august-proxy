"""
Register all built-in tool handlers into the tool registry.

Phase 3 modularization: registration groups live under
``app.services.tool_registrations``. This module remains the public
entry point (``registerAll``) and re-exports handlers used by tests.
"""

from __future__ import annotations

# Re-export handlers imported by tests / external callers
from app.services.tool_registrations.skill_tools import (  # noqa: F401
    _loadSkill,
    _listSkills,
    _skillManage,
)
from app.services.tool_registrations.file_tools import (  # noqa: F401
    _readFile,
    _writeFile,
    _listDirectory,
    _searchFiles,
    _runCommand,
)
from app.services.tool_registrations.web_tools import (  # noqa: F401
    _webFetch,
    _webSearch,
)
from app.services.tool_registrations.memory_tools import (  # noqa: F401
    _memorySearch,
    _factSearch,
    _contextRead,
    _brainQuery,
)
from app.services.tool_registrations.agent_tools import (  # noqa: F401
    _spawnSubagent,
    _spawnDaemon,
)
from app.services.tool_html import html_to_markdown, unescape_html  # noqa: F401

# Private aliases kept for any residual importers
_htmlToMarkdown = html_to_markdown
_unescapeHtml = unescape_html


def registerAll() -> None:
    """Register all core tool definitions with real handlers."""
    from app.services.tool_registrations import register_all

    register_all()
