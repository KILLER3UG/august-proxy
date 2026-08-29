"""Firmware workbench — sketch/C compilation for in-loop simulation (Phase 3).

Tools here compile microcontroller firmware into artifacts the rest of the
circuit workbench can consume:

* ``firmware_compile`` — Arduino sketches (.ino) via arduino-cli (HEX),
  plain C for AVR via avr-gcc, and .uf2 for RP2040 when a pico toolchain
  exists. The HEX feeds ``firmware_run`` (avr8js emulation + pin timeline
  export into ngspice decks).

Everything is environment-detected and degrades to actionable install
guidance (the same posture as circuit_env): a missing toolchain is never
an error wall.
"""

from __future__ import annotations

import asyncio
import os
import re
import shutil
from pathlib import Path

from app.services.sandbox.paths import bind_path


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


# ── toolchain discovery ───────────────────────────────────────────────────

_ARDUINO_CLI_HINT = (
    'arduino-cli is not installed. Install it from https://arduino.github.io/'
    'arduino-cli/ (winget install ArduinoSA.CLIArduinoAutomation or scoop '
    'install arduino-cli), then `arduino-cli core install arduino:avr` for '
    'UNO/Nano/Mega support. Alternative: avr-gcc (MSYS2 mingw-w64-x86_64-'
    'avr-gcc) compiles plain C sketches without the Arduino framework.'
)
_AVR_GCC_HINT = (
    'avr-gcc is not installed. Install it via MSYS2 (mingw-w64-x86_64-avr-'
    'gcc) or the Microchip toolchain. avr-gcc compiles plain C firmware '
    '(.c) without the Arduino framework; .ino sketches need arduino-cli.'
)


def _resolve_arduino_cli() -> str | None:
    env_exe = os.environ.get('AUGUST_ARDUINO_CLI', '').strip()
    if env_exe and os.path.isfile(env_exe):
        return env_exe
    for name in ('arduino-cli', 'arduino-cli.exe'):
        exe = shutil.which(name)
        if exe:
            return exe
    candidates = [
        r'C:\Program Files\Arduino CLI\arduino-cli.exe',
        r'C:\Program Files (x86)\Arduino CLI\arduino-cli.exe',
        os.path.expanduser(r'~\AppData\Local\Programs\Arduino CLI\arduino-cli.exe'),
        '/usr/local/bin/arduino-cli',
        '/usr/bin/arduino-cli',
    ]
    for c in candidates:
        if os.path.isfile(c):
            return c
    return None


def _resolve_avr_gcc() -> str | None:
    env_exe = os.environ.get('AUGUST_AVR_GCC', '').strip()
    if env_exe and os.path.isfile(env_exe):
        return env_exe
    for name in ('avr-gcc', 'avr-gcc.exe'):
        exe = shutil.which(name)
        if exe:
            return exe
    for root in (r'C:\msys64\mingw64', r'C:\msys64\ucrt64', r'C:\msys64'):
        for sub in ('bin', 'mingw64/bin'):
            c = os.path.join(root, sub, 'avr-gcc.exe')
            if os.path.isfile(c):
                return c
    return None


# ── firmware_run — avr8js Node sidecar (P3.2) ─────────────────────────────

_SIDECAR_DIR = Path(__file__).resolve().parent.parent.parent.parent / 'sidecar'
_SIDECAR_RUNNER = _SIDECAR_DIR / 'firmware-runner.mjs'

_NODE_INSTALL_HINT = (
    'No Node.js runtime found for the firmware emulator sidecar. The '
    'desktop bundle ships node (frontend/desktop/src-tauri/binaries); for '
    'backend-only dev install Node from https://nodejs.org or set '
    'AUGUST_NODE_EXE. The emulator itself is avr8js (MIT) under '
    'backend-py/sidecar/node_modules — npm install inside backend-py/sidecar '
    'restores it.'
)


def _resolve_node() -> str | None:
    """Node runtime for the sidecar: env override → bundled tauri binary → PATH."""
    env_exe = os.environ.get('AUGUST_NODE_EXE', '').strip()
    if env_exe and os.path.isfile(env_exe):
        return env_exe
    repo_root = _SIDECAR_DIR.parent.parent
    binaries = repo_root / 'frontend' / 'desktop' / 'src-tauri' / 'binaries'
    if binaries.is_dir():
        candidates: list[Path] = sorted(binaries.glob('node-*.exe'))
        for exe in candidates:
            if exe.is_file() and 'readme' not in exe.name.lower():
                return str(exe)
    node_on_path = shutil.which('node')
    if node_on_path:
        return node_on_path
    return None


def _sidecar_ready() -> bool:
    """Runner script + avr8js dependency present."""
    return (
        _SIDECAR_RUNNER.is_file()
        and (_SIDECAR_DIR / 'node_modules' / 'avr8js' / 'package.json').is_file()
    )


# Default FQBN per board family a model is likely to name.
_FQBN_GUESSES: dict[str, str] = {
    'uno': 'arduino:avr:uno',
    'nano': 'arduino:avr:nano',
    'mega': 'arduino:avr:mega',
    'leonardo': 'arduino:avr:leonardo',
    'micro': 'arduino:avr:micro',
    'pro': 'arduino:avr:pro',
    'r4': 'arduino:renesas_uno:unor4',
    'unor4': 'arduino:renesas_uno:unor4',
}

_SKETCH_RE = re.compile(r'setup\s*\(\s*\)|loop\s*\(\s*\)', re.S)


def _looks_like_ino(source: str) -> bool:
    """Arduino sketches define setup()/loop() — even when C++-shorthand
    (no #include, bare functions)."""
    return bool(_SKETCH_RE.search(source))


async def _spawn(
    exe: str, *args: str, cwd: str | None = None, timeout: float = 180.0,
) -> tuple[int | None, str]:
    """Run a compiler with bounded time; stdout+stderr merged."""
    proc = await asyncio.create_subprocess_exec(
        exe, *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
        cwd=cwd,
    )
    try:
        out_b, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        return None, '(compile timed out)'
    return proc.returncode, out_b.decode('utf-8', errors='replace')


async def firmware_compile(
    source: str,
    name: str = 'firmware',
    board: str = 'uno',
    workspace: str = '',
    session: object | None = None,
) -> dict[str, object]:
    """Compile firmware to a HEX artifact (avr8js/flash input).

    ``source`` is inline sketch/C text OR a workspace path (.ino sketch
    folder or single .c/.ino/.cpp file — auto-detected). ``board`` is a
    friendly board name (uno/nano/mega/leonardo/unor4) or a full FQBN.
    Sketches (setup()/loop() present) compile via arduino-cli; plain C
    via avr-gcc -mmcu with the Arduino core absent.

    Returns the artifact path (hexFile) + build log tail + flash size
    when the toolchain reports it.
    """
    ws = workspace or _workspace(session)
    base = str(name or 'firmware').strip() or 'firmware'

    # Resolve the source: inline text vs workspace path.
    src_text = ''
    sketch_dir: Path | None = None
    src_file: Path | None = None
    stripped = (source or '').strip()
    if '\n' in stripped or _looks_like_ino(stripped):
        src_text = stripped
    elif stripped:
        candidate = _bind(stripped, ws, for_write=False) if ws else Path(stripped)
        if candidate.is_file():
            src_file = candidate
            src_text = candidate.read_text(encoding='utf-8', errors='replace')
        elif candidate.is_dir():
            sketch_dir = candidate
            ino = sorted(candidate.glob('*.ino'))
            if not ino:
                raise ValueError(f'{stripped} has no .ino sketch file')
            src_file = ino[0]
            src_text = src_file.read_text(encoding='utf-8', errors='replace')
        else:
            # Single-line non-path text = a bare sketch name? Treat as
            # inline source (could be a one-liner program).
            src_text = stripped
    if not src_text:
        raise ValueError(
            'source is empty — pass inline sketch/C text or a workspace path'
        )

    is_ino = (
        sketch_dir is not None
        or (src_file is not None and src_file.suffix == '.ino')
        or _looks_like_ino(src_text)
    )

    # Materialize the sketch layout arduino-cli needs: <name>/<name>.ino
    import tempfile

    tmpdir = tempfile.mkdtemp(prefix='aug_fw_')
    try:
        if is_ino:
            cli = _resolve_arduino_cli()
            if cli is None:
                return {'installed': False, 'error': _ARDUINO_CLI_HINT}

            fqbn = board if ':' in board else _FQBN_GUESSES.get(
                board.strip().lower(), 'arduino:avr:uno'
            )
            sketch_root = Path(tmpdir) / base
            sketch_root.mkdir()
            if sketch_dir is not None and src_file is not None:
                shutil.copytree(sketch_dir, sketch_root, dirs_exist_ok=True)
            else:
                # Inline: write as <name>.ino. Function prototypes are
                # auto-generated by arduino-cli's preprocessor.
                (sketch_root / f'{base}.ino').write_text(
                    src_text, encoding='utf-8'
                )

            build_dir = Path(tmpdir) / 'build'
            rc, log = await _spawn(
                cli, 'compile', '--fqbn', fqbn,
                '--output-dir', str(build_dir),
                str(sketch_root),
                timeout=240.0,
            )
            hexes = sorted(build_dir.glob('*.hex')) if build_dir.exists() else []
            if rc not in (0, None) or not hexes:
                return {
                    'installed': True,
                    'ok': False,
                    'error': 'compile failed',
                    'exitCode': rc,
                    'logTail': '\n'.join(log.splitlines()[-40:]),
                }
            hex_tmp = hexes[0]
        else:
            gcc = _resolve_avr_gcc()
            if gcc is None:
                return {'installed': False, 'error': _AVR_GCC_HINT}
            mcu = os.environ.get('AUGUST_FIRMWARE_MCU', 'atmega328p')
            src_path = Path(tmpdir) / f'{base}.c'
            src_path.write_text(src_text, encoding='utf-8')
            hex_tmp = Path(tmpdir) / f'{base}.hex'
            rc, log = await _spawn(
                gcc, '-mmcu=' + mcu, '-DF_CPU=16000000UL', '-Os',
                '-o', str(hex_tmp.with_suffix('.elf')), str(src_path),
                '-Wall', timeout=60.0,
            )
            if rc not in (0, None) or not hex_tmp.with_suffix('.elf').exists():
                return {
                    'installed': True, 'ok': False, 'error': 'compile failed',
                    'exitCode': rc,
                    'logTail': '\n'.join(log.splitlines()[-40:]),
                }
            rc2, log2 = await _spawn(
                'avr-objcopy', '-O', 'ihex', '-R', '.eeprom',
                str(hex_tmp.with_suffix('.elf')), str(hex_tmp),
                timeout=30.0,
            ) if shutil.which('avr-objcopy') else (0, '')
            if rc2 not in (0, None):
                return {
                    'installed': True, 'ok': False, 'error': 'objcopy failed',
                    'exitCode': rc2, 'logTail': log2[-2000:],
                }
            log = f'{log}\n{log2}'

        # Persist the artifact into the workspace.
        hex_name = f'{base}.hex'
        out = _bind(hex_name, ws, for_write=True) if ws else Path(tempfile.gettempdir()) / hex_name
        out.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(hex_tmp, out)

        # Flash size from the log ("Sketch uses 1960 bytes (6%) ...").
        size: dict[str, object] = {}
        m = re.search(r'Sketch uses (\d+) bytes \((\d+)%\)', log)
        if m:
            size = {'bytes': int(m.group(1)), 'percent': int(m.group(2))}
        mem = re.search(r'Global variables use (\d+) bytes \((\d+)%\)', log)
        if mem:
            size['ramBytes'] = int(mem.group(1))
            size['ramPercent'] = int(mem.group(2))

        return {
            'installed': True,
            'ok': True,
            'board': fqbn if is_ino else os.environ.get('AUGUST_FIRMWARE_MCU', 'atmega328p'),
            'hexFile': str(out),
            'path': str(out),
            'flash': size or None,
            'logTail': '\n'.join(log.splitlines()[-40:]),
        }
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


async def firmware_run(
    hex: str,
    ms: object = None,
    expect: object = None,
    fail: object = None,
    pins: object = None,
    timeline: str = '',
    workspace: str = '',
    session: object | None = None,
) -> dict[str, object]:
    """Emulate a compiled AVR firmware (avr8js) and observe its behavior.

    ``hex`` is the artifact firmware_compile produced (path in the
    workspace, or inline Intel-HEX text). Runs the program for ``ms``
    simulated milliseconds (default 2000) and returns: final GPIO state
    per pin, serial monitor capture, per-pin toggle counts + edge
    timeline, and ``expect``/``fail`` text assertions (wokwi-cli
    vocabulary) evaluated against the serial output.

    ``timeline`` (optional name) additionally persists the pin-edge
    timeline as <name>_pins.json in the workspace — the PWL stimulus
    seed for ngspice co-simulation (feed it to circuit_simulate's
    deck-builder step).
    """
    ws = workspace or _workspace(session)

    # Environment first — the guidance is more useful than a path error
    # on a machine that can't run the emulator at all.
    node = _resolve_node()
    if node is None:
        return {'installed': False, 'error': _NODE_INSTALL_HINT}
    if not _sidecar_ready():
        return {
            'installed': False,
            'error': 'avr8js sidecar missing — run npm install inside '
            'backend-py/sidecar to restore the emulator dependency',
        }

    hex_text = ''
    hex_path: Path | None = None
    stripped = (hex or '').strip()
    if stripped.startswith(':'):
        hex_text = stripped
    elif stripped:
        candidate = _bind(stripped, ws, for_write=False) if ws else Path(stripped)
        if candidate.is_file():
            hex_path = candidate
        else:
            raise ValueError(f'hex file not found: {stripped}')
    else:
        raise ValueError('hex is empty — pass the firmware_compile hexFile path')

    import tempfile

    tmpdir = tempfile.mkdtemp(prefix='aug_fwr_')
    try:
        if hex_path is None:
            staged = Path(tmpdir) / 'firmware.hex'
            staged.write_text(hex_text, encoding='utf-8')
            hex_arg = str(staged)
        else:
            hex_arg = str(hex_path)

        ms_val = 2000
        if ms is not None:
            try:
                ms_val = max(10, min(int(str(ms)), 60_000))  # type: ignore[arg-type]
            except (TypeError, ValueError):
                raise ValueError('ms must be an integer of simulated milliseconds')

        def _texts(raw: object) -> list[str]:
            if raw is None:
                return []
            if isinstance(raw, str):
                return [raw]
            if isinstance(raw, (list, tuple)):
                return [str(t) for t in raw if str(t).strip()]
            raise ValueError('expect/fail must be a string or list of strings')

        expect_list = _texts(expect)
        fail_list = _texts(fail)
        pins_list: list[str] = []
        if pins is not None:
            if isinstance(pins, str):
                pins_list = [p.strip() for p in pins.split(',') if p.strip()]
            elif isinstance(pins, (list, tuple)):
                pins_list = [str(p) for p in pins]
            else:
                raise ValueError('pins must be a comma string or list')

        args = [node, str(_SIDECAR_RUNNER), '--hex', hex_arg, '--ms', str(ms_val)]
        for t in expect_list:
            args += ['--expect', t]
        for t in fail_list:
            args += ['--fail', t]
        if pins_list:
            args += ['--pins', ','.join(pins_list)]

        proc = await asyncio.create_subprocess_exec(
            *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        # The runner is pure CPU math: simulated ms / real ms ≈ 40x faster
        # than wall clock on a dev box — bound generously.
        try:
            out_b, _ = await asyncio.wait_for(proc.communicate(), timeout=300.0)
        except asyncio.TimeoutError:
            proc.kill()
            return {'installed': True, 'ok': False, 'error': 'emulation timed out'}

        out_text = out_b.decode('utf-8', errors='replace')
        # The runner prints exactly one JSON line on stdout.
        import json as _json

        for ln in out_text.splitlines():
            ln = ln.strip()
            if not ln.startswith('{'):
                continue
            try:
                result = _json.loads(ln)
            except ValueError:
                continue
            if not result.get('ok'):
                return {
                    'installed': True, 'ok': False,
                    'error': result.get('error', 'emulator error'),
                }
            if timeline and ws:
                tl = {
                    p: t
                    for p, t in result.get('toggles', {}).items()
                    if isinstance(t, dict) and t.get('count')
                }
                tl_name = (
                    timeline if timeline.endswith('_pins.json') else f'{timeline}_pins.json'
                )
                tl_path = _bind(tl_name, ws, for_write=True)
                tl_path.write_text(
                    _json.dumps({'simulatedMs': result.get('simulatedMs'), 'pins': tl}),
                    encoding='utf-8',
                )
                result['timelineFile'] = str(tl_path)
            # The sidecar echoes the staged temp hex path for inline-HEX
            # runs; the workspace artifact contract stays clean of temp
            # dirs, so only keep it when it points at the caller's file.
            if isinstance(result.get('hexFile'), str) and not hex_path:
                result.pop('hexFile')
            result['installed'] = True
            return result
        return {
            'installed': True, 'ok': False,
            'error': 'sidecar produced no result',
            'logTail': '\n'.join(out_text.splitlines()[-15:]),
        }
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


# ── P3.5 rung 1: pin-edge timeline → ngspice PWL stimulus ────────────────

# Arduino pin → logical high level by board family (volts at logic 1).
_BOARD_LOGIC_LEVELS = {
    'uno': 5.0, 'nano': 5.0, 'mega': 5.0, 'leonardo': 5.0, 'micro': 5.0,
    'pro': 5.0, 'unor4': 3.3, 'esp32': 3.3, 'esp8266': 3.3, 'pico': 3.3,
}


def _pwl_points(
    edges: list[object], simulated_ms: float, level: float,
) -> tuple[list[tuple[float, float]], int]:
    """Pin edges → (PWL (time, voltage) pairs, real edge count).

    The firmware boots with pins floating (0 V in SPICE terms), so the
    sequence starts at (0, 0). Each recorded edge ``{t, to}`` becomes a
    (t, to·level) point. The final point pins the waveform flat to the
    end of the simulated window so .tran runs past the last edge don't
    extrapolate.
    """
    pts: list[tuple[float, float]] = [(0.0, 0.0)]
    last_t = 0.0
    last_v = 0.0
    real_edges = 0
    for e in edges:
        if not isinstance(e, dict):
            continue
        try:
            t = float(e.get('t', 0.0))  # ms since boot
        except (TypeError, ValueError):
            continue
        to = e.get('to')
        if not isinstance(to, bool) and not isinstance(to, (int, float)):
            continue
        v = level if to else 0.0
        if t < last_t:
            t = last_t  # never time-travel; sidecar emits monotonic edges
        # Same timestamp as the previous point: REPLACE its voltage instead
        # of stacking a second point at t (an edge at t=0 means the pin was
        # driven from the very first cycle — the boot point becomes (0, v)).
        if abs(t - last_t) < 1e-9:
            if abs(v - last_v) < 1e-12:
                continue
            pts[-1] = (t, v)
            last_v = v
            real_edges += 1
            continue
        pts.append((t, v))
        last_t, last_v = t, v
        real_edges += 1
    pts.append((max(simulated_ms, last_t + 1.0), last_v))
    return pts, real_edges


def firmware_stimulus(
    timeline: str,
    netlist: str = '',
    pins=None,
    board: str = 'uno',
    name: str = 'stim',
    workspace: str = '',
    session: object | None = None,
) -> dict[str, object]:
    """Convert a firmware_run pin timeline into ngspice PWL sources (P3.5
    rung 1 — the one-way firmware→SPICE bridge).

    ``timeline`` is the ``<name>_pins.json`` artifact firmware_run persists
    (pass ``timeline=<name>`` there). Each toggling pin becomes a SPICE
    voltage source card ``Vp<pin> N<pin> 0 PWL(...)`` — 0/.logic-level
    steps at the real edge times (ms → seconds). When ``netlist`` is given
    (inline text or a workspace deck path) the PWL cards are injected
    before the analysis card of a copy saved as ``<name>.cir`` — hand that
    straight to circuit_simulate (e.g. PWM pin → RC filter .tran). Without
    a netlist the tool just returns the cards for inspection.

    Each pin drives deck node ``N<pin>`` (N13 = Arduino pin 13) against
    ground — connect the analog load between ``N<pin>`` and 0 (e.g. an RC
    filter: ``R1 N13 out 1k`` / ``C1 out 0 100n``).
    """
    import json as _json

    ws = workspace or _workspace(session)

    stripped = (timeline or '').strip()
    if not stripped:
        raise ValueError('timeline is empty — pass the timelineFile path from firmware_run')
    tl_path: Path | None = None
    if stripped.endswith('.json'):
        candidate = _bind(stripped, ws, for_write=False) if ws else Path(stripped)
        if candidate.is_file():
            tl_path = candidate
        else:
            raise ValueError(f'timeline file not found: {stripped}')
    else:
        raise ValueError('timeline must be the <name>_pins.json path from firmware_run')
    try:
        tl = _json.loads(tl_path.read_text(encoding='utf-8'))
    except ValueError as exc:
        return {'ok': False, 'error': f'timeline is not valid JSON: {exc}'}

    simulated_ms = tl.get('simulatedMs') or 0.0
    try:
        simulated_ms = float(simulated_ms)
    except (TypeError, ValueError):
        simulated_ms = 0.0
    pins_data = tl.get('pins')
    if not isinstance(pins_data, dict) or not pins_data:
        return {
            'ok': False,
            'error': 'timeline contains no pin data — rerun firmware_run with timeline=<name>',
        }

    level = _BOARD_LOGIC_LEVELS.get((board or 'uno').lower(), 5.0)

    wanted: list[str] | None = None
    if pins is not None:
        if isinstance(pins, str):
            wanted = [p.strip() for p in re.split(r'[,\s]+', pins) if p.strip()]
        elif isinstance(pins, (list, tuple)):
            wanted = [str(p) for p in pins]

    cards: list[str] = []
    used_pins: dict[str, object] = {}
    for pin, t in pins_data.items():
        if wanted is not None and str(pin) not in wanted:
            continue
        if not isinstance(t, dict):
            continue
        edges = t.get('edges') or []
        if not edges:
            continue
        pts, real_edges = _pwl_points(edges, simulated_ms, level)
        pairs = ' '.join(f'{t_ * 1e-3:.6g}s {v:.4g}' for t_, v in pts)
        cards.append(f'Vp{pin} N{pin} 0 PWL({pairs})')
        used_pins[str(pin)] = {
            'count': t.get('count'),
            'edges': real_edges,
        }

    if not cards:
        return {
            'ok': False,
            'error': 'no edges recorded on the selected pins — pick pins the firmware toggles',
            'simulatedMs': simulated_ms,
        }

    result: dict[str, object] = {
        'ok': True,
        'installed': True,
        'board': board,
        'logicLevel': level,
        'simulatedMs': simulated_ms,
        'pins': used_pins,
        'cards': cards,
    }

    if netlist:
        nl_stripped = netlist.strip()
        if '\n' in nl_stripped or len(nl_stripped) >= 260:
            text = nl_stripped
        else:
            cand = _bind(nl_stripped, ws, for_write=False) if ws else Path(nl_stripped)
            if cand.is_file():
                text = cand.read_text(encoding='utf-8', errors='replace')
            else:
                text = nl_stripped
        lines = text.splitlines()
        inject_at = len(lines)
        for idx, ln in enumerate(lines):
            if re.match(r'^\.(tran|ac|dc|op|sp|noise|four|measure)\b', ln.strip(), re.I):
                inject_at = idx
                break
        merged = lines[:inject_at] + cards + lines[inject_at:]
        stem = re.sub(r'\.(cir|net|ckt|sp)?$', '', name) or 'stim'
        out_name = f'{stem}.cir'
        if ws:
            out_path = _bind(out_name, ws, for_write=True)
            out_path.write_text('\n'.join(merged) + '\n', encoding='utf-8')
            result['savedTo'] = str(out_path)
        result['deck'] = '\n'.join(merged)
    return result
