"""Office document tools (audit feature) — PowerPoint element inspection +
commenting, workspace-bound.

The descriptions carry the element-targeting guidance: ids come from
``pptx_list_elements`` (the drawing's cNvPr id), comments anchor at the
element's position, and state changes are visible by re-listing.
"""

from __future__ import annotations

import json

from app.services import tool_registry
from app.services.sandbox.paths import bind_path
from app.services.tools import pptx_tools

_WORKSPACE_KEY = '_workspace'


def _workspace() -> str:
    """Resolve the current session workspace (set by the workbench dispatcher)."""
    from app.services.workbench.context import currentSessionId
    from app.services.workbench.sessions import get_workbench_session

    sid = currentSessionId.get()
    if sid and sid != 'default':
        sess = get_workbench_session(sid)
        if sess is not None:
            return str(getattr(sess, 'workspacePath', '') or '')
    return ''


def _resolve_pptx(path: str, for_write: bool) -> tuple[str, str | None]:
    """Bind a pptx path to the workspace (mutating ops need write binding)."""
    if not (path or '').strip():
        return '', 'Error: path is required (a .pptx file in the workspace).'
    bound, err = bind_path(path, _workspace(), for_write=for_write)
    if err or bound is None:
        return '', err or f'Error: invalid path: {path}'
    if not bound.exists():
        return '', f'Error: File not found: {path}'
    if bound.suffix.lower() != '.pptx':
        return '', f'Error: {path} is not a .pptx file.'
    return str(bound), None


async def _listElements(path: str = '', slide: int | None = None) -> str:
    """List slides and their elements (ids, names, types, text, positions)."""
    bound, err = _resolve_pptx(path, for_write=False)
    if err:
        return err
    result = pptx_tools.list_elements(bound, slide=slide)
    return json.dumps(result, default=str)


async def _addComment(path: str = '', slide: int | None = None, elementId: int | None = None, comment: str = '') -> str:
    """Add a comment to one element of a slide (anchored at the element)."""
    bound, err = _resolve_pptx(path, for_write=True)
    if err:
        return err
    if slide is None or elementId is None:
        return 'Error: slide and elementId are required (from pptx_list_elements).'
    result = pptx_tools.add_comment(bound, int(slide), int(elementId), comment)
    return json.dumps(result, default=str)


def register() -> None:
    """Register the PPTX element tools."""
    tool_registry.register(
        'pptx_list_elements',
        'Inspect a PowerPoint (.pptx) file: list every slide with its elements. '
        'Each element reports an integer id (use it with pptx_comment), a name, '
        'a type (title/text/picture/table/chart/connector/group...), its visible '
        'text, and its position. Guidance: call this FIRST to choose targets — '
        'element ids are stable within the file; pass slide to inspect one slide; '
        'the path is relative to the workspace.',
        _listElements,
        {
            'type': 'object',
            'properties': {
                'path': {'type': 'string', 'description': 'Path to the .pptx file (workspace-relative).'},
                'slide': {'type': 'integer', 'description': 'Optional 1-based slide index to inspect (default: all).'},
            },
            'required': ['path'],
        },
        keywords=['pptx', 'powerpoint', 'slides', 'elements', 'shapes'],
    )
    tool_registry.register(
        'pptx_comment',
        'Add a comment to ONE element of a PowerPoint slide, anchored at that '
        'element\'s position. Guidance: use the element id '
        'from pptx_list_elements — the id is the drawing\'s stable cNvPr id, not '
        'a position. One comment per element per call; a new comment id is '
        'returned. Slide is 1-based. The file is modified in place (workspace-'
        'bound; editing requires workspace write access).',
        _addComment,
        {
            'type': 'object',
            'properties': {
                'path': {'type': 'string', 'description': 'Path to the .pptx file (workspace-relative).'},
                'slide': {'type': 'integer', 'description': '1-based slide index containing the element.'},
                'elementId': {'type': 'integer', 'description': 'Element id from pptx_list_elements.'},
                'comment': {'type': 'string', 'description': 'The comment text to attach.'},
            },
            'required': ['path', 'slide', 'elementId', 'comment'],
        },
        keywords=['pptx', 'powerpoint', 'comment', 'review'],
    )
