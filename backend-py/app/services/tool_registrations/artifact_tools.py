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


def _bad_path(path: object) -> str | None:
    """Actionable receipt when a model passes a non-string path — without
    this the deep ``path.strip()`` leaks `'int' object has no attribute
    'strip'` through ``_err`` as unhelpful noise."""
    if not isinstance(path, str):
        return (
            f'Error: path must be a string (got {type(path).__name__}). '
            'Pass the output file path as a plain string, e.g. "report.pptx".'
        )
    return None


async def _createPptx(path: str = '', slides=None) -> str:
    if (bad := _bad_path(path)) is not None:
        return bad
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
    traces=None,
) -> str:
    if (bad := _bad_path(path)) is not None:
        return bad
    try:
        result = artifact_tools.render_chart(
            path, kind, series, labels=labels, title=title,
            xlabel=xlabel, ylabel=ylabel, workspace=_workspace(),
            traces=traces,
        )
        return json.dumps(result)
    except Exception as exc:
        return _err(exc)


async def _renderVideo(path: str = '', frames=None, fps: int = 12, holdLastMs: int = 400) -> str:
    if (bad := _bad_path(path)) is not None:
        return bad
    try:
        result = artifact_tools.render_video(
            path, frames, fps=int(fps or 12), hold_last_ms=int(holdLastMs or 0),
            workspace=_workspace(),
        )
        return json.dumps(result)
    except Exception as exc:
        return _err(exc)


async def _drawCircuit(path: str = '', elements=None, title: str = '') -> str:
    if (bad := _bad_path(path)) is not None:
        return bad
    try:
        result = artifact_tools.draw_circuit(path, elements, title=title, workspace=_workspace())
        return json.dumps(result)
    except Exception as exc:
        return _err(exc)


async def _createHtmlArtifact(path: str = '', html: str = '', title: str = '') -> str:
    if (bad := _bad_path(path)) is not None:
        return bad
    try:
        result = artifact_tools.create_html_artifact(path, html, title=title, workspace=_workspace())
        return json.dumps(result)
    except Exception as exc:
        return _err(exc)


async def _renderPages(path: str = '', pages: str = '', dpi: int = 110) -> str:
    if (bad := _bad_path(path)) is not None:
        return bad
    try:
        from app.services.tools import artifact_judge

        result = artifact_judge.render_pages(path, workspace=_workspace(), pages=pages, dpi=int(dpi or 110))
        return json.dumps(result)
    except Exception as exc:
        return _err(exc)


async def _judgeArtifact(path: str = '', request: str = '', rubric: str = '', pages: str = '') -> str:
    if (bad := _bad_path(path)) is not None:
        return bad
    try:
        from app.services.tools import artifact_judge

        result = await artifact_judge.judge_artifact(
            path, request, rubric=rubric, pages=pages, workspace=_workspace()
        )
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
        'category/x labels for bar/pie. For waveforms from '
        'circuit_simulate, pass its tracesFile path (or the traces dict) '
        'as traces with kind=line — each trace plots as an x/y line with '
        'a legend and unit-labelled axes.',
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
                'traces': {
                    'description': 'Waveform traces from circuit_simulate: its '
                    'tracesFile path (string) or the traces dict. kind must be '
                    'line; overrides series.',
                },
            },
            'required': ['path', 'kind'],
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
        'Draw an electrical schematic PNG (schemdraw). Elements form a left-to-right connected chain: '
        '{"type": "battery"|"resistor"|"capacitor"|"led"|"ground"|"switch"|"opamp"|..., "label": "10V", '
        '"dir": "right|left|up|down"}. End with ground to close the loop. For PSU/divider/driver circuits.',
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
    tool_registry.register(
        'create_html_artifact',
        'Create a self-contained interactive HTML visual/animation opened in '
        'the side panel — use when a VISUAL beats prose: embeddings, attention, '
        'signal timing, physics sims, algorithm animations. ALL CSS/JS inline '
        '(no CDNs), canvas/SVG animation, controls encouraged, dark-friendly.',
        _createHtmlArtifact,
        {
            'type': 'object',
            'properties': {
                'path': {
                    'type': 'string',
                    'description': 'Output path, e.g. embeddings-explainer.html',
                },
                'html': {
                    'type': 'string',
                    'description': 'Complete HTML document with inline CSS/JS',
                },
                'title': {'type': 'string', 'description': 'Document title if missing from html'},
            },
            'required': ['path', 'html'],
        },
    )
    tool_registry.register(
        'render_pages',
        'Render a document (pdf/pptx/docx/xlsx or an image) to PNG page '
        'images in the app render cache. Returns the PNG paths — feed them '
        'to analyze_media for inspection or to judge_artifact for the '
        'acceptance pass. pptx/docx/xlsx need headless LibreOffice; PDF and '
        'images always work.',
        _renderPages,
        {
            'type': 'object',
            'properties': {
                'path': {'type': 'string', 'description': 'Document path (workspace or absolute)'},
                'pages': {
                    'type': 'string',
                    'description': 'Optional 1-based spec like "1-5,8"; default first 8 pages',
                },
                'dpi': {'type': 'integer', 'minimum': 72, 'maximum': 200},
            },
            'required': ['path'],
        },
    )
    tool_registry.register(
        'judge_artifact',
        'Visual acceptance review of a produced document: renders its pages '
        'and asks a vision model for a per-page pass/fail + concrete issues '
        'against the user request (overlaps, cut-off text, empty charts, '
        'off-topic content, placeholders). USE IT after create_pptx and any '
        'pdf/docx/xlsx deliverable: fix what it flags, re-judge, ship only '
        'on overall "pass". The verdict never blocks your answer — it is '
        'your self-review checklist.',
        _judgeArtifact,
        {
            'type': 'object',
            'properties': {
                'path': {'type': 'string', 'description': 'Document to judge (pptx/docx/xlsx/pdf/png)'},
                'request': {
                    'type': 'string',
                    'description': 'What the user asked the artifact to be, verbatim as practical',
                },
                'rubric': {'type': 'string', 'description': 'Optional extra acceptance criteria'},
                'pages': {'type': 'string', 'description': 'Optional page spec like "1-6"; default first 8'},
            },
            'required': ['path', 'request'],
        },
    )
