"""Tool registrations for artifact creation (deck/chart/video/circuit).

Thin wrappers around ``app.services.tools.artifact_tools``: resolve the
session workspace, bind output paths, tolerate JSON-string arguments
(models frequently stringify list payloads), and return compact JSON.
"""

from __future__ import annotations

import json

from app.services import tool_registry
from app.services.tools import artifact_tools


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


def _err(exc: Exception) -> str:
    return f'Error: {exc}'


async def _createPptx(path: str = '', slides=None) -> str:
    try:
        result = artifact_tools.create_pptx(path, slides, _workspace())
        return json.dumps(result)
    except Exception as exc:
        return _err(exc)


async def _renderChart(
    path: str = '',
    kind: str = '',
    series=None,
    labels=None,
    title: str = '',
    xlabel: str = '',
    ylabel: str = '',
) -> str:
    try:
        result = artifact_tools.render_chart(
            path, kind, series, labels=labels, title=title,
            xlabel=xlabel, ylabel=ylabel, workspace=_workspace(),
        )
        return json.dumps(result)
    except Exception as exc:
        return _err(exc)


async def _renderVideo(path: str = '', frames=None, fps: int = 12, holdLastMs: int = 400) -> str:
    try:
        result = artifact_tools.render_video(
            path, frames, fps=int(fps or 12), hold_last_ms=int(holdLastMs or 0),
            workspace=_workspace(),
        )
        return json.dumps(result)
    except Exception as exc:
        return _err(exc)


async def _drawCircuit(path: str = '', elements=None, title: str = '') -> str:
    try:
        result = artifact_tools.draw_circuit(path, elements, title=title, workspace=_workspace())
        return json.dumps(result)
    except Exception as exc:
        return _err(exc)


_LIST_OF_OBJ = {
    'type': 'array',
    'items': {'type': 'object'},
}


def register() -> None:
    """Register the artifact creation tools."""
    tool_registry.register(
        'create_pptx',
        'Create a PowerPoint (.pptx) deck in the workspace. Pass slides as a '
        'list of {"title": str, "bullets": [str, ...], "notes": str} objects '
        '(a bare title string also works). Returns the written file path — '
        'the chat shows it as a downloadable file card.',
        _createPptx,
        {
            'type': 'object',
            'properties': {
                'path': {'type': 'string', 'description': 'Output path, e.g. report.pptx'},
                'slides': {**_LIST_OF_OBJ, 'description': 'One object per slide'},
            },
            'required': ['path', 'slides'],
        },
    )
    tool_registry.register(
        'render_chart',
        'Render a chart to PNG with matplotlib. kind: line | bar | pie | '
        'scatter | hist. series is a list of numeric lists; labels are '
        'category/x labels for bar/pie.',
        _renderChart,
        {
            'type': 'object',
            'properties': {
                'path': {'type': 'string', 'description': 'Output PNG path'},
                'kind': {'type': 'string', 'enum': ['line', 'bar', 'pie', 'scatter', 'hist']},
                'series': {
                    'type': 'array',
                    'description': 'Numeric lists; scatter takes [xList, yList]',
                },
                'labels': {'type': 'array', 'description': 'Category/x labels'},
                'title': {'type': 'string'},
                'xlabel': {'type': 'string'},
                'ylabel': {'type': 'string'},
            },
            'required': ['path', 'kind', 'series'],
        },
    )
    tool_registry.register(
        'render_video',
        'Assemble an MP4 video from image files already in the workspace '
        '(one frame per image, equal duration at fps; the last frame holds '
        'holdLastMs). Generate frames first with run_command/code, charts, '
        'or circuit drawings, then pass their paths here.',
        _renderVideo,
        {
            'type': 'object',
            'properties': {
                'path': {'type': 'string', 'description': 'Output MP4 path'},
                'frames': {
                    'type': 'array',
                    'items': {'type': 'string'},
                    'description': 'Ordered image paths',
                },
                'fps': {'type': 'integer', 'minimum': 1, 'maximum': 60},
                'holdLastMs': {'type': 'integer', 'minimum': 0, 'maximum': 5000},
            },
            'required': ['path', 'frames'],
        },
    )
    tool_registry.register(
        'draw_circuit',
        'Draw an electrical schematic PNG (schemdraw). Elements are drawn '
        'left-to-right as a connected chain: {"type": "battery"|"resistor"|'
        '"capacitor"|"led"|"ground"|"switch"|"opamp"|"line"|..., "label": '
        '"10V", "dir": "right|left|up|down"}. End with a ground element to '
        'close the loop. Covers PSU/divider/driver-style series circuits.',
        _drawCircuit,
        {
            'type': 'object',
            'properties': {
                'path': {'type': 'string', 'description': 'Output PNG path'},
                'elements': {**_LIST_OF_OBJ, 'description': 'Ordered components'},
                'title': {'type': 'string'},
            },
            'required': ['path', 'elements'],
        },
    )
