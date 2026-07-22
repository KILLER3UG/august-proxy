"""
Register all built-in tool handlers into the tool registry.

Phase 3 modularization: registration groups live under
``app.services.tool_registrations``. This module remains the public
entry point (``registerAll``) and re-exports handlers used by tests.
"""

from __future__ import annotations

from app.services.tool_html import html_to_markdown, unescape_html  # noqa: F401
from app.services.tool_registrations.agent_tools import (  # noqa: F401
    _spawnDaemon,
    _spawnSubagent,
)
from app.services.tool_registrations.file_tools import (  # noqa: F401
    _listDirectory,
    _readFile,
    _runCommand,
    _searchFiles,
    _writeFile,
)
from app.services.tool_registrations.memory_tools import (  # noqa: F401
    _brainQuery,
    _contextRead,
    _factSearch,
    _memorySearch,
)

# Re-export handlers imported by tests / external callers
from app.services.tool_registrations.skill_tools import (  # noqa: F401
    _listSkills,
    _loadSkill,
    _skillManage,
)
from app.services.tool_registrations.web_tools import (  # noqa: F401
    _webFetch,
    _webSearch,
)

# Private aliases kept for any residual importers
_htmlToMarkdown = html_to_markdown
_unescapeHtml = unescape_html


def registerAll() -> None:
    """Register all core tool definitions with real handlers."""
    from app.services.tool_registrations import register_all

    register_all()
