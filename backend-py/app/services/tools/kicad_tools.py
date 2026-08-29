"""KiCad workbench — ERC/DRC gates + real board renders (Phase 5, P5.1).

When kicad-cli is installed, ``kicad_checks`` runs ``kicad-cli sch erc``
and ``kicad-cli pcb drc --format json --exit-code-violations`` as
agent-verifiable correctness gates, and ``kicad_render`` produces
headless 3D PNGs (``pcb render``) and GLB exports (``pcb export glb``)
for real designs — replacing the matplotlib placeholder in
circuit_tools for that path (the placeholder stays as the
zero-dependency fallback). Absent kicad-cli: install guidance only.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import tempfile
from pathlib import Path

from app.services.sandbox.paths import bind_path
from app.services.tools.circuit_tools import _versioned_dirs

_KICAD_INSTALL_HINT = (
    'kicad-cli is not installed. Install KiCad 8+ (https://www.kicad.org/'
    'download/ — winget install KiCad.KiCad or the OS package manager); '
    'the CLI ships with the desktop app. Then kicad_checks (ERC/DRC) and '
    'kicad_render (3D PNG / GLB) come alive for real .kicad_sch/.kicad_pcb '
    'designs.'
)


def _bind(path: str, workspace: str, for_write: bool):
    bound, err = bind_path(path, workspace, for_write=for_write)
    if err or bound is None:
        raise ValueError(err or f'Invalid path: {path}')
    return bound


def _workspace(session: object | None = None) -> str:
    if session is not None:
        ws = str(getattr(session, 'workspacePath', '') or '')
        if ws:
            return ws
    try:
        from app.services.workbench.context import currentSessionId
        from app.services.workbench.sessions import get_workbench_session

        sid = currentSessionId.get()
        if sid:
            sess = get_workbench_session(sid)
            if sess is not None:
                return str(getattr(sess, 'workspacePath', '') or '')
    except Exception:
        pass
    return ''


_kicad_cache: str | None = None


def resolve_kicad_cli() -> str | None:
    """kicad-cli path: env override → PATH → Program Files versioned trees.

    Cached after first hit (the probe is not free).
    """
    global _kicad_cache
    if _kicad_cache:
        return _kicad_cache
    env_exe = os.environ.get('AUGUST_KICAD_CLI', '').strip()
    if env_exe and os.path.isfile(env_exe):
        _kicad_cache = env_exe
        return env_exe
    exe = shutil.which('kicad-cli')
    if exe:
        _kicad_cache = exe
        return exe
    for d in _versioned_dirs((r'C:\Program Files\KiCad',), 'bin'):
        cand = os.path.join(d, 'kicad-cli.exe')
        if os.path.isfile(cand):
            _kicad_cache = cand
            return cand
    return None


async def _run(argv: list[str], timeout: float = 120.0):
    proc = await asyncio.create_subprocess_exec(
        *argv,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )
    try:
        out_b, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except TimeoutError:
        proc.kill()
        await proc.communicate()
        return (124, '')
    return (proc.returncode or 0, (out_b or b'').decode('utf-8', 'replace'))


def _resolve_design(path: str, workspace: str, kinds: tuple[str, ...]) -> Path:
    """Bind a workspace .kicad_sch/.kicad_pcb path or raise ValueError."""
    stripped = (path or '').strip()
    if not stripped:
        raise ValueError(f'path is empty — pass the workspace {" or ".join(kinds)} file')
    p = _bind(stripped, workspace, for_write=False) if workspace else Path(stripped)
    if not p.is_file():
        raise ValueError(f'design file not found: {stripped}')
    if p.suffix.lower() not in kinds:
        raise ValueError(f'expected a {" or ".join(kinds)} file, got: {p.suffix}')
    return p


def _parse_violation_json(text: str) -> dict[str, object]:
    """kicad-cli --format json output → {violations: [...], count}.

    The schema (KiCad 8): {"severity": ..., "type": "schematic_erc", ...}
    under "violations", plus "unconnected" in erc output. Be tolerant:
    any JSON with a list under violations counts; non-JSON falls back to
    a text scan of '(N)' counts.
    """
    try:
        data = json.loads(text)
    except ValueError:
        # Non-JSON (older CLI or human output): "Found N ..." count line.
        m = re.search(r'Found\s+(\d+)', text, re.I)
        if m:
            n = int(m.group(1))
        elif re.search(r'\b(?:no|0)\s+(?:issues|violations|errors)\b', text, re.I):
            n = 0
        else:
            n = 1 if text.strip() else 0
        return {'violations': [], 'count': n, 'format': 'text'}
    if isinstance(data, dict):
        sev_map = {'error': 'error', 'warning': 'warning', 'ignore': 'ignore'}
        viols = data.get('violations', [])
        if not isinstance(viols, list):
            viols = []
        out = []
        for v in viols:
            if not isinstance(v, dict):
                continue
            out.append({
                'severity': sev_map.get(str(v.get('severity', '')).lower(), 'warning'),
                'type': v.get('type', ''),
                'description': v.get('description', ''),
                'items': v.get('items', []),
            })
        return {'violations': out, 'count': len(out), 'format': 'json'}
    return {'violations': [], 'count': 0, 'format': 'json'}


async def kicad_checks(
    sch: str = '',
    pcb: str = '',
    workspace: str = '',
    session: object | None = None,
) -> dict[str, object]:
    """Agent-verifiable correctness gates on real KiCad designs (P5.1):

    ``sch`` (.kicad_sch) → ``kicad-cli sch erc`` (electrical rules);
    ``pcb`` (.kicad_pcb) → ``kicad-cli pcb drc --format json
    --exit-code-violations`` (design rules). Pass either or both.
    Returns parsed violations (severity/type/description/items) and a
    machine-readable ``passed`` per input — the ERC/DRC gate that
    replaces eyeballing for real boards.
    """
    ws = workspace or _workspace(session)
    if not (sch or '').strip() and not (pcb or '').strip():
        raise ValueError('pass sch (.kicad_sch) and/or pcb (.kicad_pcb) to check')
    # Validate both inputs (existence + suffix) before probing the CLI so
    # arg errors surface even on machines without kicad-cli installed.
    if (sch or '').strip():
        sch_path = _resolve_design(sch, ws, ('.kicad_sch',))
    if (pcb or '').strip():
        pcb_path = _resolve_design(pcb, ws, ('.kicad_pcb',))
    cli = resolve_kicad_cli()
    if cli is None:
        return {'installed': False, 'error': _KICAD_INSTALL_HINT}

    result: dict[str, object] = {'installed': True, 'ok': True}
    if (sch or '').strip():
        rc, out = await _run([cli, 'sch', 'erc', '--exit-code-violations', str(sch_path)])
        parsed = _parse_violation_json(out)
        parsed['exitCode'] = rc
        parsed['passed'] = rc == 0 and parsed['count'] == 0
        result['erc'] = parsed
        if not parsed['passed']:
            result['ok'] = False
    if (pcb or '').strip():
        rc, out = await _run([
            cli, 'pcb', 'drc', '--format', 'json',
            '--exit-code-violations', str(pcb_path)])
        parsed = _parse_violation_json(out)
        parsed['exitCode'] = rc
        parsed['passed'] = rc == 0 and parsed['count'] == 0
        result['drc'] = parsed
        if not parsed['passed']:
            result['ok'] = False
    return result


async def kicad_render(
    pcb: str = '',
    format: str = 'png',  # noqa: A002 — matches the CLI's own arg name
    name: str = 'board',
    workspace: str = '',
    session: object | None = None,
) -> dict[str, object]:
    """Real-board visuals from a .kicad_pcb via kicad-cli (P5.1):
    ``pcb render`` (headless 3D PNG) or ``pcb export glb`` (interactive
    3D model). The artifact lands in the workspace as <name>.png / .glb
    and appears in the right-drawer Circuit panel. This is the real
    replacement for the zero-dependency matplotlib placeholder — which
    stays available when kicad-cli is absent.
    """
    ws = workspace or _workspace(session)
    fmt = (format or 'png').strip().lower()
    if fmt not in ('png', 'glb'):
        raise ValueError('format must be "png" (headless 3D render) or "glb" (3D model)')
    if not ws:
        raise ValueError('no workspace — kicad_render needs a session workspace')
    cli = resolve_kicad_cli()
    if cli is None:
        return {'installed': False, 'error': _KICAD_INSTALL_HINT}
    pcb_path = _resolve_design(pcb, ws, ('.kicad_pcb',))

    stem = re.sub(r'[^A-Za-z0-9_\-]', '_', (name or 'board').strip()) or 'board'
    out_path = _bind(f'{stem}.{fmt}', ws, for_write=True)
    tmpdir = tempfile.mkdtemp(prefix='aug_kicad_')
    try:
        if fmt == 'png':
            rc, out = await _run([
                cli, 'pcb', 'render', '--output', str(out_path), str(pcb_path)],
                180.0)
        else:
            rc, out = await _run([
                cli, 'pcb', 'export', 'glb', '--output', str(out_path),
                str(pcb_path)], 180.0)
        if rc != 0:
            return {
                'installed': True, 'ok': False, 'exitCode': rc,
                'logTail': '\n'.join(out.splitlines()[-20:]),
            }
        return {
            'installed': True, 'ok': True, 'exitCode': rc,
            'format': fmt, 'renderedFile': str(out_path),
            'bytes': out_path.stat().st_size if out_path.is_file() else 0,
        }
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)
