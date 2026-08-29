"""FPGA workbench — Quartus CLI compile flow (Phase 4, P4.5).

The agent generates/edits VHDL + the QSF (device, file list, pin map);
``fpga_compile`` runs ``quartus_sh --flow compile`` on a materialized
project and parses the .rpt/.summary files into machine-readable
results: errors/warnings with file:line, logic elements/registers/pins
vs. device capacity, fmax from .sta.rpt, and the .sof artifact path.

Environment-detected like every other EDA engine: no Quartus → install
guidance, never an error wall. (Quartus licensing: this tool only drives
a legitimately installed Quartus — Lite or licensed Standard.)
"""

from __future__ import annotations

import os
import re
import shutil
import tempfile
from pathlib import Path

from app.services.sandbox.paths import bind_path
from app.services.tools.circuit_tools import _versioned_dirs
from app.services.tools.hdl_tools import _is_vhdl, _run

_QUARTUS_INSTALL_HINT = (
    'quartus_sh is not installed. Install Intel Quartus Prime (Lite '
    'edition is free: https://www.intel.com/content/www/us/en/software/'
    'programmable/quartus-prime/ — pick the Cyclone IV E device support '
    'component), or point AUGUST_QUARTUS_SH at an existing quartus_sh.exe.'
)

# Device → family table for the default class-assignment part and friends.
_DEVICE_FAMILY = {
    'EP4CE6E22C6': 'Cyclone IV E',
    'EP4CE6E22C8': 'Cyclone IV E',
    'EP4CE10E22C6': 'Cyclone IV E',
    'EP4CE22F17C6': 'Cyclone IV E',
    'EP4CE115F29C7': 'Cyclone IV E',
    '10M50DAF484C7G': 'MAX 10',
    '5CEBA4F23C8N': 'Cyclone V',
}

# Cyclone IV E EP4CE6 capacity (from the datasheet) for utilization %.
_EP4CE6_CAPACITY = {'logicElements': 6272, 'registers': 6272, 'pins': 92, 'memoryBits': 276480}


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


_quartus_cache: str | None = None


def resolve_quartus_sh() -> str | None:
    """quartus_sh path: env override → PATH → versioned install trees.

    Quartus lives in versioned directories that are rarely on PATH
    (C:\\intelFPGA\\<ver>\\quartus\\bin64). Cached after first hit.
    """
    global _quartus_cache
    if _quartus_cache:
        return _quartus_cache
    env_exe = os.environ.get('AUGUST_QUARTUS_SH', '').strip()
    if env_exe and os.path.isfile(env_exe):
        _quartus_cache = env_exe
        return env_exe
    exe = shutil.which('quartus_sh')
    if exe:
        _quartus_cache = exe
        return exe
    for sub in ('quartus\\bin64', 'quartus\\bin'):
        for d in _versioned_dirs((r'C:\intelFPGA', r'C:\intelFPGA_lite', r'C:\altera'), sub):
            cand = os.path.join(d, 'quartus_sh.exe')
            if os.path.isfile(cand):
                _quartus_cache = cand
                return cand
    return None


# ── report parsing ─────────────────────────────────────────────────────────

_SUMMARY_ROW_RE = re.compile(r'^\s*(.+?)\s*[:;]\s*(.+?)\s*$')


def _parse_summary(text: str) -> dict[str, str]:
    """Quartus .summary files: 'Key : value' lines → dict."""
    out: dict[str, str] = {}
    for ln in text.splitlines():
        m = _SUMMARY_ROW_RE.match(ln)
        if m and not ln.startswith((';', '-', '+')):
            out[m.group(1)] = m.group(2)
    return out


def _parse_int(value: str) -> int:
    m = re.search(r'[\d,]+', value or '')
    return int(m.group(0).replace(',', '')) if m else 0


_RPT_ERROR_RE = re.compile(
    r'^(?:Error|Critical Warning|Warning)\s*\(.*?\)\s*:\s*(.*)$', re.M)


def _parse_rpt_messages(text: str) -> list[dict[str, object]]:
    """Messages table in .rpt files: severity, location file:line, text."""
    diags: list[dict[str, object]] = []
    # Message blocks look like:
    # Error (10500): VHDL syntax error at sheesh.vhd(15) with ...
    for m in re.finditer(
        r'^(Error|Critical Warning|Warning|Info)\s*\(([^)]*)\)\s*:\s*(.+)$',
        text, re.M,
    ):
        sev = m.group(1).lower().replace(' ', '')
        msg = m.group(3).strip()
        loc = re.search(r'at\s+(\S+?)\((\d+)\)', msg)
        diags.append({
            'severity': sev,
            'code': m.group(2),
            'file': loc.group(1) if loc else None,
            'line': int(loc.group(2)) if loc else None,
            'message': msg,
        })
    return diags


def _parse_fmax(text: str) -> dict[str, object] | None:
    """sta.rpt "Slow 1200mV 85C Model Fmax Summary" table.

    Real Quartus 18.1 layout::

        ; Fmax        ; Restricted Fmax ; Clock Name ; Note ...;
        +-------------+-----------------+------------+--------+
        ; 1322.75 MHz ; 250.0 MHz       ; clk        ; ...    ;

    First row = the worst clock. Returns restricted (the achievable
    frequency honoring I/O constraints) + unrestricted per clock; the
    worst (lowest restricted) is surfaced as ``fmaxMHz``.
    """
    # Bound the search to the first Fmax Summary SECTION — textual hits
    # inside the Table of Contents must be skipped, and the window must
    # stop at the next "; ... Summary ... ;" header so empty later corners
    # can't bleed their "No paths to report" into this section.
    m_start = re.search(
        r'Fmax Summary[^\S\n]*;[^\S\n]*\r?\n\+[-+]+\+', text)
    if m_start is None:
        # Synthetic/plain form: header then a dashed border.
        m_start = re.search(r'Fmax Summary\s*\n\s*[-+]+', text)
        if m_start is None:
            return None
    start = m_start.end()
    m_next = re.search(r'\n;[^\S\n]*\S[^\n]*Summary[^\n]*;[^\S\n]*\r?\n', text[start:])
    end = start + m_next.start() if m_next else start + 4000
    sect = text[start:end]
    # Table rows: ; 1322.75 MHz ; 250.0 MHz ; clk ; ... ;
    rows = re.findall(
        r';\s*([\d.]+)\s*MHz\s*;\s*([\d.]+)\s*MHz\s*;\s*(\w+)\s*;',
        sect,
    )
    clocks: dict[str, dict[str, object]] = {}
    for unrestricted, restricted, name in rows:
        clocks[name] = {
            'clock': name,
            'restrictedFmaxMHz': float(restricted),
            'unrestrictedFmaxMHz': float(unrestricted),
        }
    if not clocks:
        # Fallback: headerless plain "Fmax = X MHz" lines.
        m2 = re.search(r'Fmax\s*=?\s*([\d.]+)\s*MHz', sect, re.I)
        if m2:
            return {'fmaxMHz': float(m2.group(1))}
        return None
    worst = min(clocks.values(), key=lambda c: float(c['restrictedFmaxMHz']))  # type: ignore[arg-type]
    return {
        'fmaxMHz': worst['restrictedFmaxMHz'],
        'clocks': sorted(clocks.values(), key=lambda c: float(c['restrictedFmaxMHz'])),  # type: ignore[arg-type]
    }


# ── fpga_compile ───────────────────────────────────────────────────────────

def _qsf_text(
    project: str,
    top: str,
    hdl_files: list[str],
    device: str,
    family: str,
    pins: dict[str, str],
) -> str:
    lines = [
        f'set_global_assignment -name FAMILY "{family}"',
        f'set_global_assignment -name DEVICE {device}',
        f'set_global_assignment -name TOP_LEVEL_ENTITY {top}',
        'set_global_assignment -name PROJECT_OUTPUT_DIRECTORY output_files',
    ]
    for f in hdl_files:
        kind = 'VHDL_FILE' if f.lower().endswith(('.vhd', '.vhdl')) else 'VERILOG_FILE'
        lines.append(f'set_global_assignment -name {kind} {f}')
    for signal, pin in sorted(pins.items()):
        lines.append(f'set_location_assignment -to {signal} {pin}')
    lines.append(
        'set_global_assignment -name EDA_SIMULATION_TOOL "ModelSim-Altera (VHDL)"')
    return '\n'.join(lines) + '\n'


async def fpga_compile(
    source: str,
    name: str = 'fpga',
    device: str = 'EP4CE6E22C6',
    top: str = '',
    pins: object = None,
    workspace: str = '',
    session: object | None = None,
) -> dict[str, object]:
    """Compile HDL through the full Quartus flow (map → fit → asm → sta)
    and parse the reports into machine-readable results.

    ``source`` is inline VHDL/Verilog text or a workspace file path.
    ``device`` defaults to the class-workhorse Cyclone IV E EP4CE6E22C6;
    ``pins`` maps signal names to package pins ({"A": "PIN_23", ...}) —
    the agent-side Pin Planner. The compiled ``.sof`` is copied into the
    workspace as <name>.sof; errors/warnings come back with file:line,
    utilization vs. device capacity, and fmax when timing analysis ran.
    """
    ws = workspace or _workspace(session)
    quartus = resolve_quartus_sh()
    if quartus is None:
        return {'installed': False, 'error': _QUARTUS_INSTALL_HINT}

    stripped = (source or '').strip()
    if not stripped:
        raise ValueError('source is empty — pass inline HDL text or a workspace file path')
    if '\n' in stripped or len(stripped) >= 260:
        text = stripped
    else:
        cand = _bind(stripped, ws, for_write=False) if ws else Path(stripped)
        if cand.is_file():
            text = cand.read_text(encoding='utf-8', errors='replace')
        else:
            text = stripped
    vhdl = _is_vhdl(text)
    if vhdl:
        ent = re.search(r'\bentity\s+(\w+)\s+is', text, re.I)
    else:
        ent = re.search(r'\bmodule\s+(\w+)', text, re.I)
    top_name = (top or '').strip() or (ent.group(1) if ent else 'top')
    stem = re.sub(r'[^A-Za-z0-9_\-]', '_', (name or 'fpga').strip()) or 'fpga'

    pin_map: dict[str, str] = {}
    if isinstance(pins, dict):
        pin_map = {str(k): str(v) for k, v in pins.items()}

    family = _DEVICE_FAMILY.get(device.upper(), 'Cyclone IV E')

    tmpdir = tempfile.mkdtemp(prefix='aug_fpga_')
    try:
        src_name = f'{top_name}.vhd' if vhdl else f'{top_name}.v'
        src_path = Path(tmpdir) / src_name
        src_path.write_text(text, encoding='utf-8')
        qsf = _qsf_text(stem, top_name, [src_name], device, family, pin_map)
        Path(tmpdir, f'{stem}.qsf').write_text(qsf, encoding='utf-8')
        Path(tmpdir, f'{stem}.qpf').write_text(
            f'PROJECT_REVISION = "{stem}"\n', encoding='utf-8')

        rc, out = await _run(
            [quartus, '--flow', 'compile', stem], 600.0, cwd=tmpdir)

        outdir = Path(tmpdir, 'output_files')
        result: dict[str, object] = {
            'installed': True,
            'ok': rc == 0,
            'exitCode': rc,
            'device': device,
            'family': family,
            'top': top_name,
            'logTail': '\n'.join(out.splitlines()[-40:]),
        }

        # Fitter utilization from .fit.summary.
        fit = outdir / f'{stem}.fit.summary'
        if fit.is_file():
            fsum = _parse_summary(fit.read_text(encoding='utf-8', errors='replace'))
            le = _parse_int(fsum.get('Total logic elements', '0'))
            regs = _parse_int(fsum.get('Total registers', '0'))
            pins_used = _parse_int(fsum.get('Total pins', '0'))
            result['fit'] = {
                'status': fsum.get('Fitter Status', ''),
                'logicElements': le,
                'registers': regs,
                'pins': pins_used,
                'memoryBits': _parse_int(fsum.get('Total memory bits', '0')),
            }
            cap = _EP4CE6_CAPACITY if device.upper().startswith('EP4CE6') else None
            if cap and cap['logicElements']:
                result['utilization'] = {
                    'logicElementsPct': round(100 * le / cap['logicElements'], 2),
                    'registersPct': round(100 * regs / cap['registers'], 2),
                    'pinsPct': round(100 * pins_used / cap['pins'], 2),
                }

        # Messages with file:line from .map.rpt (+ critical errors in log).
        diag: list[dict[str, object]] = []
        for rpt in (outdir / f'{stem}.map.rpt', outdir / f'{stem}.fit.rpt'):
            if rpt.is_file():
                diag.extend(_parse_rpt_messages(
                    rpt.read_text(encoding='utf-8', errors='replace')))
        errors = [d for d in diag if d['severity'] == 'error']
        result['diagnostics'] = diag
        result['errorCount'] = len(errors)
        result['ok'] = bool(result['ok']) and not errors

        # Timing from .sta.rpt.
        sta = outdir / f'{stem}.sta.rpt'
        if sta.is_file():
            fmax = _parse_fmax(sta.read_text(encoding='utf-8', errors='replace'))
            if fmax:
                result['fmax'] = fmax

        # .sof artifact into the workspace.
        sof = outdir / f'{stem}.sof'
        if sof.is_file() and ws:
            dst = _bind(f'{stem}.sof', ws, for_write=True)
            shutil.copyfile(sof, dst)
            result['sofFile'] = str(dst)
        return result
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)
