"""HDL workbench — VHDL/Verilog lint, simulate, and VCD analysis (Phase 4).

Tools here follow the circuit_env posture: environment-detected with
degrade-to-guidance. GHDL serves VHDL; Icarus Verilog (iverilog+vvp)
serves Verilog; verilator adds lint-only analysis. ``vcd_parse`` is a
pure-Python VCD reader (no engine needed) shared by the HDL and
SPICE-digital workflows.
"""

from __future__ import annotations

import asyncio
import os
import re
import shutil
import tempfile
from pathlib import Path

from app.services.sandbox.paths import bind_path
from app.services.tools.circuit_tools import _probe_binary

_GHDL_INSTALL_HINT = (
    'GHDL is not installed. Install it from https://ghdl.github.io/ghdl/ '
    '(scoop install ghdl, apt install ghdl, or brew install ghdl) for VHDL '
    'analysis/elaboration/simulation.'
)
_ICARUS_INSTALL_HINT = (
    'Icarus Verilog is not installed. Install it from '
    'https://bleyer.org/icarus/ (scoop install iverilog, apt install '
    'iverilog, or brew install icarus-verilog) for Verilog simulation.'
)
_VERILATOR_INSTALL_HINT = (
    'verilator is not installed. Install it from https://www.veripool.org/'
    'verilator/ (apt install verilator / brew install verilator; Windows '
    'via MSYS2: pacman -S mingw-w64-x86_64-verilator) for fast lint-only '
    'Verilog/SystemVerilog analysis.'
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


# ── engine resolution ─────────────────────────────────────────────────────

async def resolve_ghdl() -> str | None:
    """GHDL exe: PATH, then common install roots. None → absent."""
    r = await _probe_binary(
        ('ghdl',), ('--version',), r'GHDL\s+([0-9][^\s(]*)',
        extra_dirs=(
            r'C:\ghdl\bin', r'C:\Program Files\GHDL\bin',
            r'C:\msys64\mingw64\bin', r'C:\msys64\ucrt64\bin',
        ))
    return str(r.get('path', '')) if r.get('installed') else None


async def resolve_iverilog() -> str | None:
    r = await _probe_binary(
        ('iverilog',), ('-V',), r'Icarus Verilog version (\S+)',
        extra_dirs=(
            r'C:\iverilog\bin', r'C:\Program Files\Icarus Verilog\bin',
            r'C:\msys64\mingw64\bin', r'C:\msys64\ucrt64\bin',
        ))
    return str(r.get('path', '')) if r.get('installed') else None


async def resolve_verilator() -> str | None:
    r = await _probe_binary(
        ('verilator',), ('--version',), r'Verilator (\S+)',
        extra_dirs=(
            r'C:\verilator\bin',
            r'C:\msys64\mingw64\bin', r'C:\msys64\ucrt64\bin',
        ))
    return str(r.get('path', '')) if r.get('installed') else None


# ── shared helpers ─────────────────────────────────────────────────────────

def _is_vhdl(text: str) -> bool:
    """VHDL vs Verilog by structural keywords (comments stripped)."""
    t = re.sub(r'--[^\n]*', '', text)
    t = re.sub(r'//[^\n]*|/\*.*?\*/', '', t, flags=re.S)
    if re.search(r'\b(entity|architecture|library\s+ieee)\b', t, re.I):
        return True
    if re.search(r'\b(module|always|initial|endmodule|assign)\b', t, re.I):
        return False
    # Ambiguous → VHDL (the workbench's primary HDL).
    return True


def _sanitize_stem(name: str) -> str:
    return re.sub(r'[^A-Za-z0-9_\-]', '_', (name or 'hdl').strip()) or 'hdl'


async def _run(argv: list[str], timeout: float, cwd: str | None = None):
    """Run a subprocess with timeout; return (rc, stdout+stderr text)."""
    proc = await asyncio.create_subprocess_exec(
        *argv,
        cwd=cwd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )
    try:
        out_b, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except TimeoutError:
        proc.kill()
        await proc.communicate()
        return (124, f'[timed out after {timeout:.0f}s]')
    text = out_b.decode('utf-8', errors='replace') if out_b else ''
    return (proc.returncode or 0, text)


def _load_source(
    source: str, workspace: str,
) -> tuple[str, str, str]:
    """Resolve the ``source`` arg → (text, language, stem).

    Accepts inline HDL text OR a workspace file path (single line, <260
    chars, resolves inside the workspace) — same convention as
    simulate_circuit's netlist arg.
    """
    stripped = (source or '').strip()
    if not stripped:
        raise ValueError(
            'source is empty — pass inline HDL text or a workspace file path')
    if '\n' in stripped or len(stripped) >= 260:
        text = stripped
        stem = 'design'
    else:
        cand = _bind(stripped, workspace, for_write=False) if workspace else Path(stripped)
        if cand.is_file():
            text = cand.read_text(encoding='utf-8', errors='replace')
            stem = cand.stem
        else:
            text = stripped
            stem = stripped.rsplit('.', 1)[0] if '.' in stripped else 'design'
    return text, ('vhdl' if _is_vhdl(text) else 'verilog'), _sanitize_stem(stem)


def _materialize(text: str, language: str, stem: str, tmpdir: str) -> Path:
    """Write the source into a temp dir with the right suffix for the
    engine (ghdl/iverilog/verilator key off .vhd/.v/.sv)."""
    if language == 'vhdl':
        ext = '.vhd'
    elif re.search(r'\b(always_ff|always_comb|logic\b)', text):
        ext = '.sv'
    else:
        ext = '.v'
    p = Path(tmpdir) / f'{stem}{ext}'
    p.write_text(text, encoding='utf-8')
    return p


# HDL file:line forms across the three engines:
#   ghdl        "and.vhd:15:10: error: ..." | "ghdl:1:15:error: entity ..."
#   iverilog    "top.v(7): syntax error"     | "top.v:7: syntax error"
#   verilator   "%Error-WIDTH: top.sv:12: Width mismatch"
#   misc        "design.vhd(23): near ..."   | "file.vhd line 15: ..."
_ERROR_LINE_RE = re.compile(
    r'((?:[\w\-./\\:]*[\\/])?[\w.\-]+\.(?:vhd|vhdl|sv|v))'
    r'(?:\((\d+)\)|(?::|\s+line\s+|\s+)(\d+))',
    re.I,
)


def _parse_hdl_diagnostics(text: str) -> list[dict[str, object]]:
    """Extract file:line diagnostics from ghdl/iverilog/verilator output."""
    diags: list[dict[str, object]] = []
    for ln in text.splitlines():
        s = ln.strip()
        if not s:
            continue
        sev = 'error' if re.search(r'\berror\b|\bfatal\b', s, re.I) else 'warning'
        m = _ERROR_LINE_RE.search(s)
        if m:
            diags.append({
                'file': m.group(1),
                'line': int(m.group(2) or m.group(3)),
                'severity': sev,
                'message': s,
            })
        elif re.match(r'^(ERROR|WARNING|FATAL)\b', s, re.I):
            diags.append({
                'file': None, 'line': None, 'severity': sev, 'message': s,
            })
    return diags


# ── P4.1: hdl_lint ─────────────────────────────────────────────────────────

async def hdl_lint(
    source: str,
    workspace: str = '',
    session: object | None = None,
) -> dict[str, object]:
    """Instant syntax/semantic feedback for VHDL or Verilog — the HDL
    equivalent of netlist lint. Analysis only; no elaboration or sim.

    VHDL → ``ghdl -a --std=08``. Verilog → ``verilator --lint-only
    -Wall`` (falls back to ``iverilog -t null`` when verilator is
    absent). Diagnostics come back with file:line, never a raw wall.
    """
    ws = workspace or _workspace(session)
    text, language, stem = _load_source(source, ws)

    tmpdir = tempfile.mkdtemp(prefix='aug_hdl_lint_')
    try:
        src = _materialize(text, language, stem, tmpdir)
        if language == 'vhdl':
            ghdl = await resolve_ghdl()
            if ghdl is None:
                return {'installed': False, 'error': _GHDL_INSTALL_HINT}
            rc, out = await _run([ghdl, '-a', '--std=08', src.name], 60.0, cwd=tmpdir)
            engine = 'ghdl'
        else:
            ver = await resolve_verilator()
            if ver is not None:
                rc, out = await _run(
                    [ver, '--lint-only', '-Wall', '--top-module', stem, src.name],
                    60.0, cwd=tmpdir)
                engine = 'verilator'
            else:
                iv = await resolve_iverilog()
                if iv is None:
                    return {
                        'installed': False,
                        'error': f'{_VERILATOR_INSTALL_HINT}\nAlso: {_ICARUS_INSTALL_HINT}',
                    }
                rc, out = await _run(
                    [iv, '-t', 'null', '-o', 'null.out', src.name], 60.0, cwd=tmpdir)
                engine = 'iverilog'
        diags = _parse_hdl_diagnostics(out)
        errors = [d for d in diags if d['severity'] == 'error']
        return {
            'installed': True,
            'ok': rc == 0 and not errors,
            'engine': engine,
            'language': language,
            'diagnostics': diags,
            'logTail': '\n'.join(out.splitlines()[-20:]),
        }
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


# ── P4.2: hdl_simulate ─────────────────────────────────────────────────────

def _parse_sim_asserts(text: str) -> list[dict[str, object]]:
    """GHDL/iverilog simulation report lines (assertion failures, notes)."""
    found: list[dict[str, object]] = []
    for ln in text.splitlines():
        m = re.search(
            r'(?:assertion\s+)?(?:\((severity\s+)?(note|warning|error|failure)\)|'
            r'(NOTE|WARNING|ERROR|FAILURE))[:\s]+(.*)', ln, re.I)
        if m:
            sev = (m.group(2) or m.group(3) or 'note').lower()
            found.append({'severity': sev, 'message': m.group(4).strip() or ln.strip()})
    return found


async def hdl_simulate(
    source: str,
    top: str = '',
    name: str = 'sim',
    workspace: str = '',
    session: object | None = None,
) -> dict[str, object]:
    """Simulate an HDL testbench: GHDL ``--elab-run --wave`` for VHDL,
    ``iverilog && vvp`` for Verilog. 60 s timeout ladder.

    Returns exit status, parsed assertion/report lines, and — when a
    waveform was produced — the ``waveFile`` path persisted in the
    workspace (``.vcd``, viewable in the right-drawer Circuit panel) plus
    a vcd_parse summary. The source must be a self-contained testbench
    (a top entity/process that finishes, or $finish).
    """
    ws = workspace or _workspace(session)
    text, language, stem = _load_source(source, ws)

    tmpdir = tempfile.mkdtemp(prefix='aug_hdl_sim_')
    try:
        src = _materialize(text, language, stem, tmpdir)
        timeout = 60.0
        if language == 'vhdl':
            ghdl = await resolve_ghdl()
            if ghdl is None:
                return {'installed': False, 'error': _GHDL_INSTALL_HINT}
            # Analyze → elaborate+run with waveform capture.
            rc_a, out_a = await _run(
                [ghdl, '-a', '--std=08', src.name], 60.0, cwd=tmpdir)
            if rc_a != 0:
                return {
                    'installed': True, 'ok': False,
                    'stage': 'analyze',
                    'diagnostics': _parse_hdl_diagnostics(out_a),
                    'logTail': '\n'.join(out_a.splitlines()[-20:]),
                }
            top_name = (top or '').strip() or stem
            rc, out = await _run(
                [ghdl, '--elab-run', '--std=08',
                 '--wave=wave.vcd', top_name],
                timeout, cwd=tmpdir)
            engine = 'ghdl'
        else:
            iv = await resolve_iverilog()
            if iv is None:
                return {'installed': False, 'error': _ICARUS_INSTALL_HINT}
            rc_c, out_c = await _run(
                [iv, '-o', 'tb.vvp', src.name], 60.0, cwd=tmpdir)
            if rc_c != 0:
                return {
                    'installed': True, 'ok': False,
                    'stage': 'compile',
                    'diagnostics': _parse_hdl_diagnostics(out_c),
                    'logTail': '\n'.join(out_c.splitlines()[-20:]),
                }
            rc, out = await _run(
                [_vvp_for(iv), 'tb.vvp'],
                timeout, cwd=tmpdir)
            engine = 'iverilog'
        asserts = _parse_sim_asserts(out)
        result: dict[str, object] = {
            'installed': True,
            'ok': rc == 0,
            'exitCode': rc,
            'engine': engine,
            'language': language,
            'asserts': asserts,
            'logTail': '\n'.join(out.splitlines()[-30:]),
        }
        # Persist the waveform into the workspace when one was produced.
        wave_tmp = Path(tmpdir) / 'wave.vcd'
        if wave_tmp.is_file() and ws:
            out_name = re.sub(r'\.(vcd|fst|ghw)?$', '', _sanitize_stem(name)) + '.vcd'
            dst = _bind(out_name, ws, for_write=True)
            shutil.copyfile(wave_tmp, dst)
            result['waveFile'] = str(dst)
            summary = vcd_summary(dst.read_text(encoding='utf-8', errors='replace'))
            result['vcd'] = summary
        return result
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


def _vvp_for(iverilog_path: str) -> str:
    """The vvp interpreter sitting next to iverilog (same bindir)."""
    p = Path(iverilog_path)
    vvp = p.with_name('vvp.exe' if os.name == 'nt' else 'vvp')
    return str(vvp) if vvp.is_file() else 'vvp'


# ── P4.3: vcd_parse — pure-Python VCD reader ───────────────────────────────

def _parse_vcd_value_change(tok: str) -> tuple[object, str]:
    """One value-change token → (value, id). value: 'x'/'z'/int/str bits."""
    if tok[0] in '#01xzXZ':
        pass
    # scalar: "0!" / "1clk" ; vector: "b1010 id" / "bX id"
    if tok[0] == 'b' or tok[0] == 'B':
        bits, ident = tok[1:].split(' ', 1) if ' ' in tok[1:] else (tok[1:], '')
        if ident.startswith('#'):
            return (bits, ident)
        return (bits.strip(), ident)
    if tok[0] in '01xXzZ':
        return (tok[0], tok[1:])
    return (None, '')


def vcd_parse(
    path: str,
    at: object = None,
    signal: str = '',
    workspace: str = '',
    session: object | None = None,
) -> dict[str, object]:
    """Parse a VCD waveform file (pure Python — no engine needed): signal
    list with edge counts, min/max pulse widths, value-at-time queries,
    and protocol hints — UART bytes decoded from an RX line (baud
    auto-detected from start-bit spacing, 8N1) — the first protocol-
    analyser slice. Feeds both HDL and SPICE-digital workflows.
    """

    ws = workspace or _workspace(session)
    stripped = (path or '').strip()
    if not stripped:
        raise ValueError('path is empty — pass the workspace .vcd file')
    vcd_path = _bind(stripped, ws, for_write=False) if ws else Path(stripped)
    if not vcd_path.is_file():
        raise ValueError(f'vcd file not found: {stripped}')

    text = vcd_path.read_text(encoding='utf-8', errors='replace')
    summary = vcd_summary(text)

    # Value-at-time queries: at="2ms" / 500us / plain ticks ("4000").
    queries: dict[str, object] = {}
    at_times: list[tuple[float, str]] = []
    if at is not None:
        raw_list = at if isinstance(at, (list, tuple)) else [at]
        ts_raw = summary.get('timescaleSec')
        timescale = float(ts_raw) if isinstance(ts_raw, (int, float)) else 1e-9
        for raw in raw_list:
            s = str(raw)
            m = re.match(r'^([\d.]+)\s*([fpnum])s?$', s, re.I)
            if m:
                # Unit-suffixed → wall-clock seconds → ticks.
                val = float(m.group(1))
                mult = {'f': 1e-15, 'p': 1e-12, 'n': 1e-9,
                        'u': 1e-6, 'm': 1e-3}
                sec = val * mult[m.group(2).lower()]
                at_times.append((sec / timescale, s))
            else:
                try:
                    # Bare number → raw VCD ticks (the schema contract).
                    at_times.append((float(s), s))
                except ValueError:
                    pass
    if at_times:
        # _vcd_states_at walks the file in sorted time order; re-key each
        # snapshot by its tick so the caller's at= order never matters.
        states = _vcd_states_at(text, summary, [t for t, _ in at_times])
        by_tick: dict[float, dict[str, object]] = {}
        tick_seq = sorted({t for t, _ in at_times})
        for tick, state in zip(tick_seq, states):
            by_tick[tick] = state
        for t, label in at_times:
            queries[label] = by_tick[t]

    result: dict[str, object] = dict(summary)
    if queries:
        result['values'] = queries
    if signal:
        # UART hint on the requested line.
        hint = uart_decode(text, signal, summary)
        if hint is not None:
            result['uart'] = hint
    else:
        # Auto: try the first RX-looking scalar.
        sigs = summary.get('signals')
        for sig in (sigs if isinstance(sigs, list) else [])[:8]:
            if not isinstance(sig, dict):
                continue
            hint = uart_decode(text, str(sig.get('name', '')), summary)
            if hint is not None:
                result['uart'] = hint
                break
    return result


def vcd_summary(text: str) -> dict[str, object]:
    """Header + activity summary of a VCD: timescale, duration, per-signal
    edge counts and min/max pulse widths."""
    timescale_sec = 1e-9
    m = re.search(r'\$timescale\s+([^\s$]+)', text)
    if m:
        timescale_sec = _parse_timescale(m.group(1))
    duration = 0.0
    dm = re.findall(r'^#(\d+)', text, re.M)
    if dm:
        duration = float(dm[-1])
    ids: dict[str, str] = {}  # id code → signal name
    for seg in re.finditer(
        r'\$var\s+\w+\s+(\d+)\s+(\S+)\s+([\w.\[\]/]+)', text,
    ):
        ids[seg.group(2)] = seg.group(3)
    signals: list[dict[str, object]] = []
    # Walk value changes once, collecting edges per id.
    edges: dict[str, list[float]] = {}
    prev: dict[str, object] = {}
    t = 0.0
    for tok in text.split():
        if tok.startswith('#'):
            try:
                t = float(tok[1:])
            except ValueError:
                pass
            continue
        if tok.startswith('$') or tok in ('b', 'B', 'r', 'R'):
            continue
        # scalar change token: first char is the value
        val, ident = tok[0], tok[1:]
        if not ident or ident.startswith('$'):
            continue
        if ident not in ids:
            continue
        if val in '01xXzZ' and prev.get(ident) != val:
            prev[ident] = val
            edges.setdefault(ident, []).append(t)
    for ident, name in ids.items():
        es = edges.get(ident, [])
        entry: dict[str, object] = {
            'name': name,
            'edges': len(es),
            'activity': bool(es),
        }
        if len(es) >= 2:
            widths = [b - a for a, b in zip(es, es[1:])]
            entry['minPulse'] = min(widths)
            entry['maxPulse'] = max(widths)
        signals.append(entry)
    return {
        'timescale': timescale_sec,
        'timescaleSec': timescale_sec,
        'durationTicks': duration,
        'durationSec': duration * timescale_sec,
        'signals': signals,
    }


def _parse_timescale(tok: str) -> float:
    m = re.match(r'^(\d+)?\s*([fpnum]?)s?$', tok, re.I)
    if not m:
        return 1e-9
    num = float(m.group(1) or 1)
    unit = (m.group(2) or 'n').lower()
    mult = {'f': 1e-15, 'p': 1e-12, 'n': 1e-9, 'u': 1e-6, 'm': 1e-3}
    return num * mult.get(unit, 1e-9)


def _vcd_states_at(
    text: str, summary: dict[str, object], tick_times: list[float],
) -> list[dict[str, object]]:
    """Snapshot of every scalar signal's value at each requested tick time
    (changes listed after a #T marker are IN effect at T, per the VCD spec's
    change-after-marker ordering).

    Returns snapshots in sorted tick order — callers must re-key by tick
    (``vcd_parse`` does), never zip against their original query order.
    """
    ids: dict[str, str] = {}
    for seg in re.finditer(r'\$var\s+\w+\s+(\d+)\s+(\S+)\s+([\w.\[\]/]+)', text):
        ids[seg.group(2)] = seg.group(3)
    snapshots: list[dict[str, object]] = []
    idx = 0
    t = 0.0
    prev: dict[str, object] = {}
    times = sorted(set(tick_times))

    def _snap() -> dict[str, object]:
        return {ids.get(k, k): v for k, v in prev.items()}

    for tok in text.split():
        if tok.startswith('#'):
            try:
                t_new = float(tok[1:])
            except ValueError:
                continue
            # Queries strictly below the new marker are final now: every
            # change token that follows #t belongs to time t itself (VCD
            # writes changes after their marker), so a query AT t must wait
            # for the next marker to see them.
            t = t_new
            while idx < len(times) and times[idx] < t:
                snapshots.append(_snap())
                idx += 1
            continue
        if tok.startswith('$') or tok in ('b', 'B', 'r', 'R'):
            continue
        val, ident = tok[0], tok[1:]
        if ident and ident in ids:
            prev[ident] = val
    while idx < len(times):
        snapshots.append(_snap())
        idx += 1
    return snapshots


def uart_decode(
    text: str, signal: str, summary: dict[str, object],
) -> dict[str, object] | None:
    """Decode 8N1 UART bytes from one scalar signal's edge times.

    Baud is auto-detected from the shortest pulse (start-bit width).
    Returns None when the line has too little activity or the edges
    don't look like UART (no 8×-wide stop-bit pattern).
    """
    ids: dict[str, str] = {}
    for seg in re.finditer(r'\$var\s+\w+\s+(\d+)\s+(\S+)\s+([\w.\[\]/]+)', text):
        ids[seg.group(2)] = seg.group(3)
    ident = None
    for code, name in ids.items():
        if name == signal:
            ident = code
            break
    if ident is None:
        return None
    edges: list[tuple[float, str]] = []
    t = 0.0
    prev: str | None = None
    for tok in text.split():
        if tok.startswith('#'):
            try:
                t = float(tok[1:])
            except ValueError:
                pass
            continue
        if tok.startswith('$') or tok in ('b', 'B', 'r', 'R'):
            continue
        val, idc = tok[0], tok[1:]
        if idc == ident and val in '01' and val != prev:
            edges.append((t, val))
            prev = val
    if len(edges) < 10:
        return None
    ts_raw = summary.get('timescaleSec')
    timescale = float(ts_raw) if isinstance(ts_raw, (int, float)) else 1e-9
    # Level-per-interval between edges.
    levels: list[tuple[float, float, str]] = []
    for i, (tt, val) in enumerate(edges):
        end = edges[i + 1][0] if i + 1 < len(edges) else tt + 1e12
        levels.append((tt, end, val))
    # Candidate bit period: the shortest LOW interval that repeats.
    lows = [e - s for s, e, v in levels if v == '0' and e > s]
    if not lows:
        return None
    bit_w = min(lows)
    # Reject when the min LOW is <1/8 the median (glitch noise — a real
    # start bit is never 8× narrower than the typical LOW interval).
    sorted_lows = sorted(lows)
    median_low = sorted_lows[len(sorted_lows) // 2]
    if median_low > 0 and bit_w < median_low / 8:
        return None
    # Decode frames: find falling edges (idle HIGH → start-bit LOW), sample
    # the 8 data bits at start + (1.5 .. 8.5)·bit_w, require stop bit HIGH
    # at 9.5·bit_w (the start bit occupies 0..1·bit_w).
    secs = [(s * timescale, e * timescale, v) for s, e, v in levels]
    frames: list[dict[str, object]] = []
    i = 0
    while i < len(edges):
        t0, val = edges[i]
        if val != '0':
            i += 1
            continue
        # Sample data bits in ticks.
        byte = 0
        ok = True
        for bit_i in range(8):
            sample_t = t0 + (bit_i + 1.5) * bit_w
            lvl = _level_at(secs, sample_t * timescale)
            if lvl is None:
                ok = False
                break
            if lvl == '1':
                byte |= 1 << bit_i
        stop_lvl = _level_at(secs, (t0 + 9.5 * bit_w) * timescale)
        if ok and stop_lvl == '1':
            frames.append({
                't': round(t0 * timescale * 1e3, 6),  # ms
                'byte': byte,
                'char': chr(byte) if 32 <= byte < 127 else None,
            })
            i_next = i
            while i_next < len(edges) and edges[i_next][0] < t0 + 9.5 * bit_w:
                i_next += 1
            i = max(i_next, i + 1)
        else:
            i += 1
    if not frames:
        return None
    baud = round(1.0 / (bit_w * timescale))
    byte_list = [int(f['byte']) for f in frames]  # type: ignore[call-overload]
    text_out = ''.join(
        (f['char'] or f'\\x{int(f["byte"]):02x}')  # type: ignore[call-overload, misc]
        for f in frames
    )
    return {
        'signal': signal,
        'baud': baud,
        'bits': '8N1',
        'bytes': byte_list,
        'text': text_out,
        'frames': frames[:64],
    }


def _level_at(
    levels: list[tuple[float, float, str]], t_sec: float,
) -> str | None:
    """Signal level at a wall-clock second (last interval covering it)."""
    lo, hi = 0, len(levels) - 1
    best: str | None = None
    while lo <= hi:
        mid = (lo + hi) // 2
        s, e, v = levels[mid]
        if t_sec < s:
            hi = mid - 1
        elif t_sec >= e:
            lo = mid + 1
        else:
            best = v
            break
    return best


# ── P4.4: hdl_test — cocotb runner ──────────────────────────────────────────

_COCOTB_INSTALL_HINT = (
    'cocotb is not installed. Add it with `uv sync --extra eda` (or pip '
    'install cocotb) — BSD-licensed Python testbenches that run against '
    'GHDL/Icarus via cocotb_tools.runner.'
)


def _junit_xml(verdicts: list[dict[str, object]], name: str) -> str:
    """cocotb test results → JUnit XML (pass/fail per test + traces)."""
    import datetime as _dt

    def _ns(v: dict[str, object]) -> float:
        raw = v.get('simTimeNs', 0)
        return float(raw) if isinstance(raw, (int, float)) else 0.0

    def _esc(s: str) -> str:
        return s.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;').replace('"', '&quot;')

    total = len(verdicts)
    failed = sum(1 for v in verdicts if not v.get('passed'))
    ts = _dt.datetime.now(_dt.UTC).isoformat()
    head = (
        f'<testsuite name="{_esc(name)}" tests="{total}" failures="{failed}" '
        f'time="{sum(_ns(v) for v in verdicts):.1f}" '
        f'timestamp="{ts}">'
    )
    body = []
    for v in verdicts:
        tname = _esc(str(v.get('name', 'test')))
        if v.get('passed'):
            body.append(
                f'<testcase classname="cocotb" name="{tname}" '
                f'time="{_ns(v):.1f}"/>')
        else:
            msg = _esc(str(v.get('failReason') or 'assertion failed'))
            body.append(
                f'<testcase classname="cocotb" name="{tname}" '
                f'time="{_ns(v):.1f}">'
                f'<failure message="{msg}"/></testcase>')
    return head + ''.join(body) + '</testsuite>'


# cocotb per-test verdicts. Two real formats (cocotb 1.8 regression.py):
#   summary table row:  ** tb.test_a      PASS     12.00   0.01   1200.00  **
#   plain pass line:   tb.test_a passed
# Order inside the table row: NAME ... VERDICT ... SIM TIME(ns) ... REAL(s).
_COCOTB_TABLE_RE = re.compile(
    r'\*\*\s*(?P<name>\S+)\s+(?P<verdict>PASS|FAIL|SKIP)\s+'
    r'(?P<time>\d+(?:\.\d+)?)\s+(?P<real>\d+(?:\.\d+)?)',
)
_COCOTB_PLAIN_RE = re.compile(
    r'(?P<name>\S+)\s+(?P<verdict>passed|failed)(?:\s|:|$)',
    re.I,
)


def _parse_cocotb_results(text: str) -> list[dict[str, object]]:
    """cocotb's per-test result lines → verdict dicts.

    The end-of-run summary table is preferred (it carries sim time); the
    plain "test passed/failed" lines are a fallback without sim time.
    """
    out: list[dict[str, object]] = []
    for m in _COCOTB_TABLE_RE.finditer(text):
        out.append({
            'passed': m.group('verdict') == 'PASS',
            'skipped': m.group('verdict') == 'SKIP',
            'simTimeNs': float(m.group('time')),
            'name': m.group('name'),
        })
    if out:
        return out
    for m in _COCOTB_PLAIN_RE.finditer(text):
        out.append({
            'passed': m.group('verdict').lower() == 'passed',
            'skipped': False,
            'simTimeNs': 0.0,
            'name': m.group('name'),
        })
    return out


async def hdl_test(
    module: str,
    sources: object = None,
    top: str = '',
    name: str = 'hdltest',
    workspace: str = '',
    session: object | None = None,
) -> dict[str, object]:
    """Run cocotb Python testbenches against GHDL/Icarus and return a
    JUnit XML verdict (pass/fail per test + failure traces).

    ``module`` is the Python testbench module (inline code OR a workspace
    .py path); ``sources`` lists the HDL files under test (inline text,
    workspace paths, or a list mixing both — objects get str()'d). The
    runner builds a fresh build dir, compiles via the detected engine,
    runs, and scrapes the per-test PASS/FAIL table into verdicts +
    ``junitXml`` (also persisted as <name>.xml in the workspace).
    """
    import importlib.util
    import sys

    ws = workspace or _workspace(session)
    mod_text = ''
    mod_name = (module or '').strip()
    if not mod_name:
        raise ValueError('module is empty — the cocotb testbench module (.py) code or path')
    if '\n' in mod_name or len(mod_name) >= 260:
        mod_text = module
        mod_name = 'testbench'
    else:
        cand = _bind(mod_name, ws, for_write=False) if ws else Path(mod_name)
        if cand.is_file():
            mod_text = cand.read_text(encoding='utf-8', errors='replace')
            mod_name = cand.stem
        elif '\n' in module:
            mod_text = module
            mod_name = 'testbench'
        else:
            raise ValueError(f'testbench file not found: {mod_name}')

    if importlib.util.find_spec('cocotb_tools') is None:
        return {'installed': False, 'error': _COCOTB_INSTALL_HINT}
    ghdl = await resolve_ghdl()
    iv = await resolve_iverilog()
    if ghdl is None and iv is None:
        return {
            'installed': False,
            'error': f'{_GHDL_INSTALL_HINT}\nAlso: {_ICARUS_INSTALL_HINT}',
        }

    # Collect HDL sources under test.
    raw_sources: list[str] = []
    if isinstance(sources, str):
        raw_sources = [sources]
    elif isinstance(sources, (list, tuple)):
        raw_sources = [str(s) for s in sources]
    if not raw_sources:
        raise ValueError('sources is empty — the HDL file(s) under test (inline or workspace paths)')
    tmpdir = tempfile.mkdtemp(prefix='aug_hdl_test_')
    hdl_paths: list[Path] = []
    vhdl_any = False
    try:
        for i, src in enumerate(raw_sources):
            text, lang, stem = _load_source(src, ws)
            p = _materialize(text, lang, f'{stem}_{i}' if i else stem, tmpdir)
            hdl_paths.append(p)
            vhdl_any = vhdl_any or lang == 'vhdl'
        tb_path = Path(tmpdir) / f'{mod_name}.py'
        tb_path.write_text(mod_text, encoding='utf-8')

        # Engine + top module detection.
        if vhdl_any and ghdl is not None:
            engine_name = 'ghdl'
        elif iv is not None and not vhdl_any:
            engine_name = 'iverilog'
        elif ghdl is not None:
            engine_name = 'ghdl'
        else:
            # VHDL sources but only iverilog exists — iverilog cannot
            # compile VHDL; degrade to guidance instead of a confusing
            # compiler error wall.
            return {
                'installed': False,
                'error': 'VHDL sources need GHDL for cocotb runs, but only '
                         f'Icarus Verilog was found. {_GHDL_INSTALL_HINT}',
            }
        first_hdl = hdl_paths[0]
        top_name = (top or '').strip() or first_hdl.stem

        # The runner must own the process (it sets up VPI/LPI binding),
        # so drive it from a child Python and scrape the console table.
        hdl_files = [str(p) for p in hdl_paths]
        vhdl_list = hdl_files if engine_name == 'ghdl' else []
        vlog_list = hdl_files if engine_name != 'ghdl' else []
        build_args = ['--std=08'] if engine_name == 'ghdl' else []
        runner_script = (
            'from pathlib import Path\n'
            'from cocotb_tools import runner as _r\n\n'
            f"rc = _r.get_runner({engine_name!r})\n"
            f'rc.build(vhdl_sources={vhdl_list!r}, verilog_sources={vlog_list!r},\n'
            f"         hdl_toplevel={top_name!r}, build_dir=Path({str(tmpdir)!r}) / 'build',\n"
            f'         build_args={build_args!r}, always=True)\n'
            f"rc.test(test_module={mod_name!r}, hdl_toplevel={top_name!r},\n"
            f"        build_dir=Path({str(tmpdir)!r}) / 'build',\n"
            f"        test_dir=Path({str(tmpdir)!r}) / 'test', waves=True)\n"
        )
        run_py = Path(tmpdir) / '_run.py'
        run_py.write_text(runner_script, encoding='utf-8')
        rc, out = await _run([sys.executable, str(run_py)], 120.0, cwd=tmpdir)
        verdicts = _parse_cocotb_results(out)
        # SKIP is not a failure — ok means "no test failed" (a skipped
        # test neither passes nor breaks the run).
        result: dict[str, object] = {
            'installed': True,
            'ok': rc == 0 and not any(
                not v['passed'] and not v.get('skipped') for v in verdicts
            ) if verdicts else rc == 0,
            'exitCode': rc,
            'engine': engine_name,
            'top': top_name,
            'tests': verdicts,
            'passed': sum(1 for v in verdicts if v.get('passed')),
            'failed': sum(1 for v in verdicts if not v.get('passed')),
            'logTail': '\n'.join(out.splitlines()[-40:]),
        }
        if ws:
            xml = _junit_xml(verdicts, name)
            xml_path = _bind(f'{_sanitize_stem(name)}.xml', ws, for_write=True)
            xml_path.write_text(xml, encoding='utf-8')
            result['junitFile'] = str(xml_path)
            result['junitXml'] = xml
        return result
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)



# ── P4.7: hdl_timing_diagram — WaveDrom WaveJSON → SVG ─────────────────────

_WAVEDROM_INSTALL_HINT = (
    'wavedrom-cli is not installed in backend-py/sidecar — run '
    '`npm install` there to enable local SVG rendering. The url field '
    'still embeds the diagram in markdown answers.'
)


async def _wavedrom_svg(wavejson: object, tmpdir: str) -> str | None:
    """Render WaveJSON → SVG via the bundled wavedrom-cli (Node sidecar).

    Returns the SVG text, or None when the CLI is unavailable (the tool
    then returns the WaveJSON + the markdown-friendly URL form).
    """
    import json as _json

    from app.services.tools.firmware_tools import _SIDECAR_DIR, _resolve_node

    node = _resolve_node()
    if node is None:
        return None
    # The .bin shims are cmd/bash scripts — invoke the JS entry directly
    # with the resolved node executable.
    cli = _SIDECAR_DIR / 'node_modules' / 'wavedrom-cli' / 'wavedrom-cli.js'
    if not cli.is_file():
        return None
    src = Path(tmpdir) / 'wave.json'
    src.write_text(_json.dumps(wavejson), encoding='utf-8')
    out_svg = Path(tmpdir) / 'wave.svg'
    rc, out = await _run([node, str(cli), '-i', str(src), '-s', str(out_svg)], 60.0)
    if rc == 0 and out_svg.is_file():
        return out_svg.read_text(encoding='utf-8')
    return None


async def hdl_timing_diagram(
    wavejson: object,
    name: str = 'timing',
    workspace: str = '',
    session: object | None = None,
) -> dict[str, object]:
    """Turn a signal description into a WaveDrom timing-diagram SVG
    (P4.7): pass a WaveJSON object ({"signal": [{"name": "clk",
    "wave": "p..."}, ...]}) or its JSON text. Renders via the bundled
    wavedrom-cli and saves <name>.timing.svg in the workspace (the
    right-drawer Circuit panel shows it); always returns the WaveJSON
    plus the https://svg.wavedrom.com URL form so the diagram can be
    embedded in chat answers zero-install.
    """
    import json as _json
    import urllib.parse

    ws = workspace or _workspace(session)
    if isinstance(wavejson, str):
        try:
            wavejson = _json.loads(wavejson)
        except ValueError as exc:
            raise ValueError(f'wavejson is not valid JSON: {exc}') from exc
    if not isinstance(wavejson, dict) or not wavejson.get('signal'):
        raise ValueError(
            'wavejson must be an object with a "signal" array — e.g. '
            '{"signal": [{"name": "clk", "wave": "p..."}, {"name": "req", "wave": "01."}]}')

    # Markdown-friendly URL form (works even with no local renderer).
    compact = _json.dumps(wavejson, separators=(',', ':'))
    url = 'https://svg.wavedrom.com/' + urllib.parse.quote(compact)

    result: dict[str, object] = {'ok': True, 'wavejson': wavejson, 'url': url}
    tmpdir = tempfile.mkdtemp(prefix='aug_wavedrom_')
    try:
        svg = await _wavedrom_svg(wavejson, tmpdir)
        if svg is not None and ws:
            out = _bind(f'{_sanitize_stem(name)}.timing.svg', ws, for_write=True)
            out.write_text(svg, encoding='utf-8')
            result['svgFile'] = str(out)
            result['rendered'] = True
        else:
            result['rendered'] = False
            result['note'] = _WAVEDROM_INSTALL_HINT
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)
    return result
