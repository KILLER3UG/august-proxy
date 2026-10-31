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
import json
import logging
import os
import re
import shutil
from pathlib import Path

from app.json_narrowing import as_dict
from app.services.sandbox.paths import bind_path

logger = logging.getLogger(__name__)


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
    env_exe = os.environ.get('HARNESS_ARDUINO_CLI', '').strip()
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
    env_exe = os.environ.get('HARNESS_AVR_GCC', '').strip()
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
    'HARNESS_NODE_EXE. The emulator itself is avr8js (MIT) under '
    'backend-py/sidecar/node_modules — npm install inside backend-py/sidecar '
    'restores it.'
)


def _resolve_node() -> str | None:
    """Node runtime for the sidecar: env override → bundled tauri binary → PATH."""
    env_exe = os.environ.get('HARNESS_NODE_EXE', '').strip()
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


def board_fqbn(board: str) -> str:
    """The FQBN a board argument names, or '' when the name is not one we know.

    ONE rule for every tool that takes a board. ``board=uno`` and
    ``board=arduino:avr:uno`` are the same board, and the compile path, the
    flash path and the stimulus path each re-derived that on their own — so
    the third one to be written is the one that decides which board a
    3.3 V part is measured against. The FQBN is what arduino-cli takes AND
    what the pin map is filed under, so it is the join between the two.
    """
    raw = str(board or '').strip()
    if ':' in raw:
        return raw
    return _FQBN_GUESSES.get(raw.lower(), '')


def board_base_fqbn(board: str) -> str:
    """The ``vendor:arch:board`` part of an FQBN, with any menu segments dropped.

    ``arduino:avr:pro:cpu=8MHzatmega328`` is one board to the pin map and two
    boards to the compiler: the ``k=v`` tail is arduino-cli's variant selector,
    so the compile and flash paths must keep the FULL string while the board's
    FACTS are filed under the first three segments. Reading the tail as a board
    name is what made a qualified FQBN miss both tables — the 3.3 V Pro Mini
    then fell through to the 5 V default, and a deck named its SPICE block after
    the menu instead of the board.
    """
    raw = str(board or '').strip()
    if not raw or ':' not in raw:
        return raw
    parts = [seg for seg in raw.split(':') if '=' not in seg]
    return ':'.join(parts[:3])


def board_short_name(board: str) -> str:
    """The short name a board is filed under in the pin and logic-level tables.

    ``uno`` -> ``uno``; the ``r4`` alias -> ``unor4`` (the name
    ``_FQBN_GUESSES`` maps it to); a full FQBN -> its board segment
    (``arduino:renesas_uno:unor4`` -> ``unor4``, and a menu-qualified
    ``arduino:avr:pro:cpu=8MHzatmega328`` -> ``pro``, NOT ``cpu=8mhzatmega328``
    — a variant selector is not a board). A name we do not know
    comes back as it was given, so a board outside the tables (esp32) still
    resolves to itself.
    """
    raw = str(board or '').strip().lower()
    if not raw:
        return 'uno'
    if ':' in raw:
        segs = [seg for seg in raw.split(':') if '=' not in seg]
        return segs[-1] if segs else raw
    fqbn = _FQBN_GUESSES.get(raw)
    if fqbn:
        return fqbn.rsplit(':', 1)[-1].lower()
    return raw


_SKETCH_RE = re.compile(r'setup\s*\(\s*\)|loop\s*\(\s*\)', re.S)


def _looks_like_ino(source: str) -> bool:
    """Arduino sketches define setup()/loop() — even when C++-shorthand
    (no #include, bare functions)."""
    return bool(_SKETCH_RE.search(source))


async def _spawn(
    exe: str, *args: str, cwd: str | None = None, timeout: float = 180.0,
    timeout_message: str = '(compile timed out)',
) -> tuple[int | None, str]:
    """Run a compiler with bounded time; stdout+stderr merged.

    ``timeout_message`` is what a caller that was NOT compiling wants to
    read when the child was killed for running too long - the serial
    monitor is stopped on purpose, and "compile timed out" would be a lie
    about what happened.

    Reads line by line instead of ``communicate()``. A killed child's output
    lives only in the pipe buffer, and cancelling ``communicate()`` throws
    everything it had accumulated away — so ``board_monitor``, which is
    DESIGNED to end on the timeout, discarded the whole serial window every
    single time and returned the stop notice as if it were the data. The
    partial read is the result here, with the notice appended.
    """
    proc = await asyncio.create_subprocess_exec(
        exe, *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
        cwd=cwd,
    )
    chunks: list[bytes] = []

    async def _drain() -> None:
        stream = proc.stdout
        if stream is None:  # pragma: no cover -- PIPE above guarantees it
            return
        while True:
            line = await stream.readline()
            if not line:
                break
            chunks.append(line)

    reader = asyncio.create_task(_drain())
    timed_out = False
    try:
        await asyncio.wait_for(reader, timeout=timeout)
    except asyncio.TimeoutError:
        timed_out = True
        reader.cancel()
        try:
            await reader
        except asyncio.CancelledError:
            pass
        proc.kill()
    # Await the child even after the kill: the previous path returned without
    # reaping, which left the process holding the COM port it was monitoring.
    await proc.wait()
    if timed_out and proc.stdout is not None:
        # `readline()` returns a partial line only at EOF; cancelling it while
        # the child is killed discards whatever was buffered without a newline.
        # That is exactly `Serial.print()` — the board's last message has no
        # terminator — so drain the remaining bytes now that the pipe is closed.
        try:
            tail = await asyncio.wait_for(proc.stdout.read(), timeout=2.0)
            if tail:
                chunks.append(tail)
        except (asyncio.TimeoutError, OSError, ValueError):
            logger.debug('firmware spawn: final partial-line drain failed', exc_info=True)

    text = b''.join(chunks).decode('utf-8', errors='replace')
    if timed_out:
        return None, f'{text}\n{timeout_message}' if text else timeout_message
    return proc.returncode, text


def _resolve_source(
    source: str, ws: str,
) -> tuple[str, Path | None, Path | None]:
    """Resolve a source argument into (text, sketch folder, sketch file).

    Inline text, a workspace .ino sketch folder, or a single .c/.ino file.
    Shared by firmware_compile and the board flash, because the board flash
    has to build the SAME tree arduino-cli will upload from.
    """
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
    return src_text, sketch_dir, src_file


async def _build_sketch(
    cli: str,
    tmpdir: str | Path,
    base: str,
    src_text: str,
    sketch_dir: Path | None,
    src_file: Path | None,
    fqbn: str,
) -> tuple[int | None, str, Path]:
    """Materialize the sketch layout arduino-cli needs and compile it.

    Returns (exit code, log, build dir). The build dir is what
    `arduino-cli upload` reads from - it needs the whole tree (the .hex AND
    the .elf for the bootloader variants), not a single artifact.
    """
    tmpdir = Path(tmpdir)
    sketch_root = tmpdir / base
    sketch_root.mkdir(parents=True, exist_ok=True)
    if sketch_dir is not None and src_file is not None:
        shutil.copytree(sketch_dir, sketch_root, dirs_exist_ok=True)
    else:
        # Inline: write as <name>.ino. Function prototypes are
        # auto-generated by arduino-cli's preprocessor.
        (sketch_root / f'{base}.ino').write_text(src_text, encoding='utf-8')
    build_dir = tmpdir / 'build'
    rc, log = await _spawn(
        cli, 'compile', '--fqbn', fqbn,
        '--output-dir', str(build_dir),
        str(sketch_root),
        timeout=240.0,
    )
    return rc, log, build_dir


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
    # `base` becomes a PATH COMPONENT (sketch_root / f'{base}.ino' below), so it
    # must not be able to carry a separator or drive letter: an absolute name
    # wins outright in `Path(tmpdir) / base`, and `..\` escapes the temp tree —
    # planting model-controlled C at a path that write_file and run_command
    # would both refuse. Same sanitiser the sibling HDL tools use
    # (fpga_tools.py, hdl_tools.py, kicad_tools.py).
    base = re.sub(r'[^A-Za-z0-9_\-]', '_', str(name or '').strip()) or 'firmware'

    # Resolve the source: inline text vs workspace path.
    src_text, sketch_dir, src_file = _resolve_source(source, ws)
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

            fqbn = board_fqbn(board) or 'arduino:avr:uno'
            rc, log, build_dir = await _build_sketch(
                cli, tmpdir, base, src_text, sketch_dir, src_file, fqbn,
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
            mcu = os.environ.get('HARNESS_FIRMWARE_MCU', 'atmega328p')
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
            if not shutil.which('avr-objcopy'):
                # A missing tool is NOT a successful no-op. Returning (0, '')
                # here claimed objcopy had run, so the code fell through to
                # copyfile() on a .hex that was never produced and the user got
                # an opaque errno instead of the _AVR_GCC_HINT the module
                # docstring promises for a partial MSYS2 toolchain.
                return {
                    'installed': True,
                    'ok': False,
                    'error': 'avr-objcopy not found on PATH',
                    'hint': _AVR_GCC_HINT,
                }
            rc2, log2 = await _spawn(
                'avr-objcopy', '-O', 'ihex', '-R', '.eeprom',
                str(hex_tmp.with_suffix('.elf')), str(hex_tmp),
                timeout=30.0,
            )
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
        if not hex_tmp.exists():
            return {
                'installed': True,
                'ok': False,
                'error': f'no .hex artifact was produced at {hex_tmp.name}',
                'hint': _AVR_GCC_HINT,
            }
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
            'board': fqbn if is_ino else os.environ.get('HARNESS_FIRMWARE_MCU', 'atmega328p'),
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
    # Boards with NO pin map here. Every board that has one carries its rail
    # in `_BOARD_PINS['logic']`, which `board_logic_level` reads first — two
    # tables saying what voltage one board sits at is exactly how a 3.3 V board
    # got measured at 5 V once before.
    'esp32': 3.3, 'esp8266': 3.3, 'pico': 3.3,
}

_MENU_VOLTS_RE = re.compile(r'(\d+(?:\.\d+)?)\s*V\b', re.I)
# (boards.txt mtime_ns, size) → volts, so a core upgrade cannot leave a stale
# rail cached. Only a POSITIVE read is stored: no-platform and no-voltage are
# both "ask again later", not facts about this board.
_menu_volts_cache: dict[str, tuple[tuple[int, int], float]] = {}


def _packages_roots() -> list[Path]:
    """The directories arduino-cli may keep installed platforms under."""
    roots: list[Path] = []
    env = os.environ.get('ARDUINO_DIRECTORIES_DATA', '').strip()
    if env:
        roots.append(Path(env) / 'packages')
    local = os.environ.get('LOCALAPPDATA', '').strip()
    if local:
        roots.append(Path(local) / 'Arduino15' / 'packages')
    roots.append(Path.home() / 'Arduino15' / 'packages')
    return [r for r in roots if r.is_dir()]


def _version_key(name: str) -> tuple:
    """Sort a platform version dir so 1.8.10 beats 1.8.8."""
    return tuple((0, int(p)) if p.isdigit() else (1, p) for p in name.split('.'))


def _menu_volts(fqbn: str) -> float | None:
    """Volts a menu option's OWN label claims, read from the installed core.

    ``arduino:avr:pro:cpu=8MHzatmega328`` is a 3.3 V board because the platform
    says so — ``pro.menu.cpu.8MHzatmega328=ATmega328P (3.3V, 8 MHz)``. Reading
    the label is what keeps ``_BOARD_PINS`` an override rather than the only
    source: a variant nobody has typed into the table still gets the rail its own
    platform declares, which is the SimulIDE lesson (its chip definitions are
    data the tool loads, not facts the code re-describes).

    ``None`` means "the label answers nothing here" — no menu in the string, no
    platform installed, or a label with no voltage in it (``ATmega328P (Old
    Bootloader)``). Every one of those falls through to the declared row instead
    of guessing a rail.
    """
    raw = str(fqbn or '').strip()
    menus = [seg for seg in raw.split(':') if '=' in seg]
    if not menus:
        return None
    parts = board_base_fqbn(raw).split(':')
    if len(parts) < 3:
        return None
    vendor, arch, board = parts[0], parts[1], parts[2]
    for root in _packages_roots():
        hw = root / vendor.lower() / 'hardware' / arch.lower()
        if not hw.is_dir():
            continue
        try:
            versions = sorted((p for p in hw.iterdir() if p.is_dir()),
                              key=lambda p: _version_key(p.name), reverse=True)
        except OSError:
            continue
        for version in versions:
            txt = version / 'boards.txt'
            try:
                stamp = txt.stat()
            except OSError:
                continue
            cached = _menu_volts_cache.get(raw)
            if cached and cached[0] == (stamp.st_mtime_ns, stamp.st_size):
                return cached[1]
            try:
                lines = txt.read_text(encoding='utf-8', errors='replace').splitlines()
            except OSError:
                continue
            for seg in menus:
                key, _, value = seg.partition('=')
                needle = f'{board}.menu.{key}.{value}='
                label = next((ln[len(needle):] for ln in lines if ln.startswith(needle)), '')
                found = _MENU_VOLTS_RE.search(label)
                if found:
                    volts = float(found.group(1))
                    _menu_volts_cache[raw] = ((stamp.st_mtime_ns, stamp.st_size), volts)
                    return volts
    return None


# The macros a variant header answers the pin map with. PIN_A0 is THE trap:
# the digital count is where ANALOG numbering starts, not
# ``NUM_DIGITAL_PINS - NUM_ANALOG_INPUTS`` — measured on this machine's
# installed cores, ``NUM_DIGITAL_PINS`` is the count INCLUDING the
# analog-capable pins (standard: 20 with 6 analog, PIN_A0 14 → 14 digital),
# and ``variants/eightanaloginputs`` (nano, pro) only ``#undef``s
# NUM_ANALOG_INPUTS before redefining it — the subtraction would delete
# D12/D13 and the LED pin from every board using that variant.
_PIN_MACRO_RE = re.compile(
    r'^#define\s+(PIN_A0|NUM_DIGITAL_PINS|NUM_ANALOG_INPUTS|LED_BUILTIN)\s+\(?(\d+)[uUlL]*\)?',
    re.M,
)
_PIN_INCLUDE_RE = re.compile(r'^#include\s+"(\.\./[^"]+)"', re.M)
# (header mtime_ns, size) → macros, the same stamp _menu_volts caches by: a
# core upgrade cannot leave a stale pin map cached.
_pin_macros_cache: dict[str, tuple[tuple[int, int], dict[str, int]]] = {}


def _core_pin_macros(fqbn: str) -> dict[str, int]:
    """Pin facts read from the INSTALLED core's ``variants/<variant>/pins_arduino.h``.

    The chip is a data file the tool loads — the SimulIDE lesson
    (``_menu_volts`` carries the same idea for the rail), applied to the pin
    map: ``boards.txt`` names the board's variant, the variant header names
    its pins. Precedence lives with the CALLER (``_effective_pin_row``): the
    declared ``_BOARD_PINS`` row stays the override, because the 32u4
    silkscreen disagrees with ``PIN_A0`` (Leonardo's header numbers A0 as 18
    while its silkscreen carries 20 digital pins) and the table is where the
    human-readable answer is declared.

    Values come from the file's OWN ``#define``s first; a macro the file does
    not define is filled from the sibling header it ``#include``s (one hop,
    relative to ``variants/`` — ``micro`` carries none of these and includes
    the Leonardo header whole; ``eightanaloginputs`` defines only the analog
    count and includes ``standard`` for the rest). An own-file definition
    always beats an included one, which is what the ``#undef``+``#define``
    pair at the bottom of eightanaloginputs is saying anyway.

    Returns {} when nothing answers: no platform installed, no variant named,
    or a header without ``PIN_A0``. Empty is "ask the declared row", not a
    fact about the board.
    """
    parts = board_base_fqbn(str(fqbn or '').strip()).split(':')
    if len(parts) < 3:
        return {}
    vendor, arch, board = parts[0].lower(), parts[1].lower(), parts[2]
    menus = [seg for seg in str(fqbn or '').split(':') if '=' in seg]
    for root in _packages_roots():
        hw = root / vendor / 'hardware' / arch
        if not hw.is_dir():
            continue
        try:
            versions = sorted((p for p in hw.iterdir() if p.is_dir()),
                              key=lambda p: _version_key(p.name), reverse=True)
        except OSError:
            continue
        for version in versions:
            lines: list[str] | None = None
            if version.name and (version / 'boards.txt').is_file():
                try:
                    lines = (version / 'boards.txt').read_text(
                        encoding='utf-8', errors='replace'
                    ).splitlines()
                except OSError:
                    lines = None
            if lines is None:
                continue
            # The variant is a boards.txt fact, and a menu-qualified FQBN may
            # select a different one (``<board>.menu.<k>.<v>.build.variant=``
            # beats ``<board>.build.variant=``).
            variant = ''
            for seg in menus:
                key, _, value = seg.partition('=')
                needle = f'{board}.menu.{key}.{value}.build.variant='
                variant = next(
                    (ln[len(needle):].strip() for ln in lines if ln.startswith(needle)), ''
                )
                if variant:
                    break
            if not variant:
                needle = f'{board}.build.variant='
                variant = next(
                    (ln[len(needle):].strip() for ln in lines if ln.startswith(needle)), ''
                )
            if not variant:
                continue
            header = version / 'variants' / variant / 'pins_arduino.h'
            try:
                stamp = header.stat()
            except OSError:
                continue
            cached = _pin_macros_cache.get(str(header))
            if cached and cached[0] == (stamp.st_mtime_ns, stamp.st_size):
                return dict(cached[1])
            macros: dict[str, int] = {}

            def _scan(text: str, header_dir: Path, depth: int) -> None:
                if depth > 4:
                    return
                for m in _PIN_MACRO_RE.finditer(text):
                    macros.setdefault(m.group(1), int(m.group(2)))
                for inc in _PIN_INCLUDE_RE.finditer(text):
                    # A variant's `#include "../standard/pins_arduino.h"` is
                    # relative to the INCLUDING FILE's directory, like the
                    # preprocessor's quoted form — not to variants/.
                    target = (header_dir / inc.group(1)).resolve()
                    try:
                        _scan(
                            target.read_text(encoding='utf-8', errors='replace'),
                            target.parent,
                            depth + 1,
                        )
                    except OSError:
                        continue

            try:
                _scan(header.read_text(encoding='utf-8', errors='replace'),
                      header.parent, 0)
            except OSError:
                continue
            if not macros:
                continue
            _pin_macros_cache[str(header)] = (
                (stamp.st_mtime_ns, stamp.st_size), dict(macros)
            )
            return dict(macros)
    return {}


def _effective_pin_row(board: str) -> dict[str, object]:
    """The pin map a board answers with: the declared row, else the core.

    ``_BOARD_PINS`` is the override — the human-declared answer, carrying the
    silkscreen spelling where the header's numbers disagree — and the
    installed core is the fallback for every board nobody filed, the same
    order ``board_logic_level`` reads. The core answers nothing without
    ``PIN_A0``, because a digital count derived any other way is the trap
    recorded above.
    """
    row = _board_row(board)
    if row:
        return row
    macros = _core_pin_macros(board)
    if 'PIN_A0' not in macros:
        return {}
    out: dict[str, object] = {
        'digital': macros['PIN_A0'],
        'analog': macros.get('NUM_ANALOG_INPUTS', 0),
    }
    if 'LED_BUILTIN' in macros:
        out['led'] = macros['LED_BUILTIN']
    return out


def board_logic_level(board: str) -> float:
    """Volts at logic 1 for a board.

    Most specific fact first: a variant row filed under the exact FQBN in
    ``_BOARD_PINS``, then the menu label the installed core declares
    (``_menu_volts``), then the base board's own row, then the short-name map
    for the boards with no pin map, then 5 V — the Arduino default.

    Reading a board at the wrong rail is not cosmetic: every PWL step the
    stimulus writes is scaled by it, so the deck looks right and simulates
    wrong. A 3.3 V board read as 5 V has happened here before (the UNO R4,
    recorded in ``docs/ROADMAP.md``); a menu-qualified FQBN missing both tables
    and landing on the 5 V default was the same failure a second way.
    """
    fqbn = board_fqbn(board)
    exact = _BOARD_PINS.get(fqbn)
    exact_logic = (exact or {}).get('logic')
    if exact_logic not in (None, ''):
        return float(str(exact_logic))
    from_menu = _menu_volts(fqbn)
    if from_menu is not None:
        return from_menu
    logic = _board_row(board).get('logic')
    if logic not in (None, ''):
        return float(str(logic))
    return float(_BOARD_LOGIC_LEVELS.get(board_short_name(board), 5.0))


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


def _stimulus_node(board: str, pin: object) -> str:
    """The deck node a timeline pin drives: the BOARD's name for that pin.

    ``D5`` for Arduino pin 5 on a board we have a pin map for, so the deck
    names the board's pin and the board component's own pin is the same
    node — one name, one pin, no second spelling to keep in step. A board
    with no pin map here (esp32 and friends) falls back to the numeric
    ``N<pin>``, which is what this tool always used.
    """
    text = str(pin).strip()
    try:
        number = int(text)
    except (TypeError, ValueError):
        return text
    return board_pin_name(board, number) or f'N{number}'


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
    voltage source card ``Vp<pin> <node> 0 PWL(...)`` — 0/.logic-level
    steps at the real edge times (ms → seconds). When ``netlist`` is given
    (inline text or a workspace deck path) the PWL cards are injected
    before the analysis card of a copy saved as ``<name>.cir`` — hand that
    straight to circuit_simulate (e.g. PWM pin → RC filter .tran). Without
    a netlist the tool just returns the cards for inspection.

    The node a pin drives is the BOARD's name for that pin — ``D5`` for
    Arduino pin 5 — so the deck says "D5 drives this filter" instead of
    naming a node the user invented. The names come from the board's pin
    map (``_BOARD_PINS``), the same table the board component is built
    from, and the logic level from the same board→level map the board
    component reports. A board we have no pin map for falls back to the
    numeric node ``N<pin>``.

    Each pin drives that node against ground — connect the analog load
    between it and 0 (e.g. an RC filter: ``R1 D13 out 1k`` /
    ``C1 out 0 100n``).
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

    level = board_logic_level(board)

    wanted: list[str] | None = None
    if pins is not None:
        if isinstance(pins, str):
            wanted = [p.strip() for p in re.split(r'[,\s]+', pins) if p.strip()]
        elif isinstance(pins, (list, tuple)):
            wanted = [str(p) for p in pins]

    cards: list[str] = []
    used_pins: dict[str, object] = {}
    driven: list[tuple[str, str]] = []
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
        node = _stimulus_node(board, pin)
        cards.append(f'Vp{pin} {node} 0 PWL({pairs})')
        driven.append((str(pin), node))
        used_pins[str(pin)] = {
            'count': t.get('count'),
            'edges': real_edges,
            'node': node,
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
        # A deck written against the OLD numeric node names (N13) leaves its
        # load on a node the source never drives: the source follows the
        # BOARD's pin name (D13), so the old name is now a floating node and
        # the filter reads 0 V with no error anywhere. Name the mismatch
        # rather than let the number be quietly wrong.
        stale = [
            (pin, node, f'N{pin}')
            for pin, node in driven
            if node != f'N{pin}'
            and re.search(rf'(?<![\w.])N{re.escape(pin)}(?![\w.])', text, re.I)
        ]
        if stale:
            result['note'] = (
                'the deck names '
                + ', '.join(f'{old} (the board\'s pin is {node})' for _pin, node, old in stale)
                + ' — the PWL source drove the board\'s pin, so those nodes are '
                'not driven. Rename them to the board\'s pin names.'
            )
    return result


# ── the board workbench — a physical board, not a simulated one ─────────────
#
# SimulIDE's appeal is that the thing you are simulating is a board you
# recognise. August already has the OTHER half of that loop — compile with
# arduino-cli, emulate the HEX with avr8js, turn the pin timeline into
# ngspice PWL sources — and none of it needs the board on the desk.
#
# These three tools are the desk half: what is plugged in, how to flash it,
# and what it printed. The engine is `arduino-cli` for the same reason
# ngspice was chosen for the analog half: it is scriptable, it is what
# firmware_compile already drives, and a board the Arduino IDE can flash is
# a board arduino-cli can flash.
#
# Flashing is a HARDWARE action, so `board_flash` is confirm-gated and
# blocked in plan mode — the treatment `fpga_program` was designed for. It
# is never auto-run by the harness loop.

#: Digital/analog pin counts per board family, so a board can be used as a
#: schematic element and not just a name. The PWL stimulus export already
#: speaks in pin numbers; this says which pins the board HAS.
#:
#: These are the SILKSCREEN counts — what a user reads off the board — and
#: every row is checked against an installed platform rather than remembered:
#: ``arduino:avr:pro`` is ``pro.build.variant=eightanaloginputs``, whose header
#: raises ``NUM_ANALOG_INPUTS`` to 8 on top of ``standard``'s 14 digital pins,
#: so it is a 14+8 board like the Nano and NOT the 54+16 it used to carry (that
#: is the Mega's row, and it drew 40 pins the Pro does not have).
#: ``arduino:renesas_uno:unor4`` is ``variants/MINIMA/pins_arduino.h``:
#: ``NUM_DIGITAL_PINS (20u)``, ``NUM_ANALOG_INPUTS (6u)``, ``PIN_A0 (14u)`` —
#: 20 minus the 6 analog-capable pins is 14 digital, not 27. ``arduino:avr:micro``
#: ``#include``s the Leonardo header whole, so it cannot carry a different
#: digital count from the row above it.
#:
#: A menu-qualified FQBN is filed under its own key when the variant changes a
#: fact the deck cares about: the Pro Mini is sold as 5 V/16 MHz and 3.3 V/8 MHz
#: (``pro.menu.cpu.16MHzatmega328=ATmega328P (5V, 16 MHz)``,
#: ``pro.menu.cpu.8MHzatmega328=ATmega328P (3.3V, 8 MHz)``), and the PWL rail a
#: stimulus is stepped at is one of those facts. ``_board_row`` resolves the
#: exact string first and falls back to the three-segment board.
_BOARD_PINS: dict[str, dict[str, object]] = json.loads(
    Path(__file__).with_name('firmware_board_pins.json').read_text(encoding='utf-8')
)


def _board_row(board: str) -> dict[str, object]:
    """The board's row in ``_BOARD_PINS``: exact FQBN first, then its base.

    The exact match comes first so a variant can carry its own facts; a board
    named with a selector nobody filed a variant row under still resolves
    through ``board_base_fqbn`` instead of reporting no pin map at all.
    """
    fqbn = board_fqbn(board)
    return dict(_BOARD_PINS.get(fqbn) or _BOARD_PINS.get(board_base_fqbn(fqbn)) or {})


def _board_pins(fqbn: str) -> dict[str, object]:
    """The pin map for a board, or an empty map for one we do not know.

    The declared row first, the installed core's variant header second — the
    same precedence ``board_pin_list`` renders, so the board list's ``pins``
    payload and the pin LIST cannot disagree about one board.
    """
    return _effective_pin_row(fqbn)


def board_pin_list(board: str) -> list[dict[str, object]]:
    """The board's pins: the declared ``_BOARD_PINS`` row, else the core.

    One entry per pin: ``name`` (D0..Dn, A0..Am — the label on the
    silkscreen, and the name a deck names the node by), ``number`` (the
    Arduino pin number the firmware timeline speaks in), ``kind``, and
    ``led`` on the pin the on-board LED sits on.

    The numbers follow the Arduino convention: the digital pins are 0..n-1
    and the analog pins continue the count, so A0 is digital pin n. Checked
    against the installed cores, that is exactly what ``PIN_A0`` says for
    Uno, Nano, Pro, Mega (14, 14, 14, 54) and for the UNO R4 (14). STATED
    LIMIT: the two 32u4 rows are not — the Leonardo header numbers A0 as 18
    while its silkscreen carries 20 digital pins, because A0/A1 double as
    D18/D19. Nothing can reach that discrepancy through this table: the
    firmware bridge is AVR8-only, because the emulator's pin map is the
    ATmega328P's, so no timeline arrives speaking 32u4 numbers.
    """
    pins = _effective_pin_row(board)
    if not pins:
        return []
    digital = pins.get('digital')
    analog = pins.get('analog')
    digital_count = digital if isinstance(digital, int) else 0
    analog_count = analog if isinstance(analog, int) else 0
    led = pins.get('led')
    out: list[dict[str, object]] = []
    for i in range(digital_count):
        out.append({'name': f'D{i}', 'number': i, 'kind': 'digital', 'led': i == led})
    for j in range(analog_count):
        out.append({'name': f'A{j}', 'number': digital_count + j, 'kind': 'analog', 'led': False})
    return out


def board_pin_name(board: str, number: int) -> str | None:
    """The board's name for an Arduino pin number ('D5'), or None.

    None means this board has no pin map here, so the caller falls back to
    the numeric node name instead of inventing one.
    """
    for pin in board_pin_list(board):
        if pin.get('number') == number:
            return str(pin.get('name'))
    return None


def board_fqbns() -> list[str]:
    """The boards that have a pin map — the boards a deck can name.

    The one table, listed rather than re-described: a second list of
    boards would be a second place for a board to be added to and missed.
    Variant rows resolve through the table but are not listed here, because
    the answer a caller needs is which BOARD it can name, not every spelling
    of it — ``arduino:avr:pro`` is said once, not twice with its menu tail.
    """
    return sorted({board_base_fqbn(key) or key for key in _BOARD_PINS})


def board_names() -> str:
    """The boards a caller can name, as one comma-separated phrase.

    Every tool description that lists boards interpolates this. Written by
    hand, the list went stale the moment a row was added: `micro` and `pro`
    both have correct pin maps now and were still absent from all six
    descriptions, so a model was told they did not exist.
    """
    return ', '.join(board_short_name(f) for f in board_fqbns())


def board_block_name(board: str) -> str:
    """The SPICE block name a board is instantiated under: `arduino:avr:uno` → `UNO`.

    A block name has to be a legal SPICE identifier and the board segment
    already is. The BOARD segment, not the last one:
    `arduino:avr:pro:cpu=8MHzatmega328` is a Pro Mini with a variant selector,
    and naming the block after the selector put the menu on the schematic where
    the board should be.
    """
    base = board_base_fqbn(board_fqbn(board) or board)
    tail = (base or str(board or '')).rsplit(':', 1)[-1]
    return re.sub(r'[^A-Za-z0-9_]', '_', tail).upper() or 'BOARD'


def _as_board_list(value: object) -> list[dict[str, object]]:
    """The `boards` field of a board_list() result, as a list of dicts.

    board_list() returns a plain dict, so the value is `object` to a type
    checker. This narrows it once instead of casting at three call sites.
    """
    if not isinstance(value, list):
        return []
    return [b for b in value if isinstance(b, dict)]


def _port_entries(payload: dict[str, object]) -> tuple[list[object], str | None]:
    """The port array of a `board list` payload, and the key it came from.

    arduino-cli renamed this envelope: 1.5.1 answers `detected_ports` where the
    older CLI answered `ports`. Reading one key alone made a real board inventory
    return `count: 0` with rc=0 — a successful call claiming there was no
    hardware, which is indistinguishable from "nothing is plugged in". The
    cascade tries both, and reports the key it hit so an unrecognised shape is a
    named condition instead of a silent zero.
    """
    for key in ('detected_ports', 'ports'):
        raw = payload.get(key)
        if isinstance(raw, list):
            return raw, key
    return [], None


def _entry_board(entry: dict[str, object]) -> dict[str, object]:
    """The board behind one port, in whichever shape this CLI version uses.

    `board` (a single object) is the old shape; 1.5.1 answers `matching_boards`,
    a list ordered by confidence whose first member is what arduino-cli would
    upload to. An empty dict means the port is real and nothing matched it.
    """
    direct = entry.get('board')
    if isinstance(direct, dict) and direct:
        return direct
    matched = entry.get('matching_boards')
    if isinstance(matched, list):
        for cand in matched:
            if isinstance(cand, dict) and cand:
                return cand
    return {}


async def board_list() -> dict[str, object]:
    """Enumerate the boards attached to this machine, and the cores installed.

    Reads nothing but the USB/serial table. Every field it reports is
    something arduino-cli itself reported — the port, the protocol, the
    FQBN it matched, and the VID/PID that matched it — so a board that is
    plugged in but not recognised shows up as a port with no board, which
    is the truth, rather than being dropped.

    The installed cores come too, because they are the FQBNs that can
    actually be built for: a board whose core is missing cannot be
    compiled for, and that is worth knowing before the compile fails.
    """
    cli = _resolve_arduino_cli()
    if cli is None:
        return {'installed': False, 'error': _ARDUINO_CLI_HINT}

    rc, out = await _spawn(cli, 'board', 'list', '--format', 'json', timeout=45.0)
    if rc not in (0, None):
        return {
            'installed': True,
            'ok': False,
            'error': 'arduino-cli board list failed',
            'exitCode': rc,
            'logTail': '\n'.join(out.splitlines()[-20:]),
        }

    boards: list[dict[str, object]] = []
    parsed = True
    try:
        payload = json.loads(out or '{}')
    except (ValueError, TypeError):
        payload = {}
        parsed = False
    if not isinstance(payload, dict):
        payload = {}
        parsed = False
    entries, shape = _port_entries(payload)
    for raw_entry in entries:
        if not isinstance(raw_entry, dict):
            continue
        port = as_dict(raw_entry.get('port'), {})
        board = _entry_board(raw_entry)
        fqbn = str(board.get('fqbn') or '')
        boards.append({
            'port': str(port.get('address') or port.get('label') or ''),
            'protocol': str(port.get('protocol') or ''),
            'label': str(port.get('label') or ''),
            'fqbn': fqbn,
            'name': str(board.get('name') or ''),
            'vid': str(board.get('vid') or ''),
            'pid': str(board.get('pid') or ''),
            'pins': _board_pins(fqbn),
        })

    cores: list[dict[str, object]] = []
    rc2, out2 = await _spawn(cli, 'core', 'list', '--format', 'json', timeout=45.0)
    if rc2 in (0, None):
        try:
            core_payload = json.loads(out2 or '{}')
        except (ValueError, TypeError):
            core_payload = {}
        if isinstance(core_payload, dict):
            raw_cores = core_payload.get('platforms')
            if not isinstance(raw_cores, list):
                # `core list` is the other command with a renamed envelope.
                raw_cores = core_payload.get('installed')
            for core in raw_cores if isinstance(raw_cores, list) else []:
                if not isinstance(core, dict):
                    continue
                cores.append({
                    'id': str(core.get('id') or ''),
                    'version': str(core.get('installed_version') or core.get('version') or ''),
                    'name': str(core.get('name') or ''),
                })

    result: dict[str, object] = {
        'installed': True,
        'ok': True,
        'boards': boards,
        'count': len(boards),
        'cores': cores,
    }
    if not parsed or (shape is None and payload):
        # Zero boards because the payload was a shape this reader does not know,
        # which is NOT the same claim as zero boards. Name it, and hand back the
        # keys, so the next CLI rename is one glance instead of a code audit.
        # An UNPARSEABLE answer is the same condition: it used to become `{}`,
        # report count 0 and look like "nothing is plugged in".
        result['unknownShape'] = True
        result['payloadKeys'] = sorted(str(k) for k in payload)[:20]
        if not parsed:
            result['logTail'] = '\n'.join((out or '').splitlines()[-20:])
    return result


def _resolve_port(boards: list[dict[str, object]], port: str) -> tuple[str, str]:
    """Pick the port to talk to. Returns (port, error).

    An explicit port wins. Otherwise exactly ONE attached board is the
    obvious target; several is ambiguous, and flashing the wrong one is
    not a recoverable mistake — so the ambiguity is reported instead of
    resolved by guessing.
    """
    explicit = (port or '').strip()
    if explicit:
        return explicit, ''
    ports = [str(b.get('port') or '') for b in boards if b.get('port')]
    if not ports:
        return '', 'no board is attached — plug one in, or pass port=COM3'
    if len(ports) == 1:
        return ports[0], ''
    return '', (
        'several boards are attached (' + ', '.join(ports) + ') — pass port= '
        'to say which one'
    )


async def board_flash(
    source: str,
    board: str = 'uno',
    port: str = '',
    name: str = 'firmware',
    workspace: str = '',
    session: object | None = None,
) -> dict[str, object]:
    """Build a sketch and flash it onto an attached board.

    ``source`` is inline sketch text or a workspace .ino sketch folder, the
    same argument ``firmware_compile`` takes. ``board`` is a friendly name
    (uno/nano/mega/...) or a full FQBN. ``port`` is the serial port; leave it
    empty when exactly one board is attached.

    THIS FLASHES REAL HARDWARE. It is confirm-gated and blocked in plan
    mode for that reason: it changes the state of a physical thing, and
    there is no undo.
    """
    cli = _resolve_arduino_cli()
    if cli is None:
        return {'installed': False, 'error': _ARDUINO_CLI_HINT}

    ws = workspace or _workspace(session)
    base = re.sub(r'[^A-Za-z0-9_\-]', '_', str(name or '').strip()) or 'firmware'
    src_text, sketch_dir, src_file = _resolve_source(source, ws)
    if not src_text:
        raise ValueError('source is empty — pass inline sketch text or a workspace .ino path')

    fqbn = board_fqbn(board) or 'arduino:avr:uno'

    # Which board? The attached list is the truth about what is plugged in.
    listing = await board_list()
    attached = _as_board_list(listing.get('boards'))
    chosen_port, port_error = _resolve_port(attached, port)
    if port_error:
        return {
            'installed': True,
            'ok': False,
            'error': port_error,
            'boards': attached,
        }

    import tempfile

    tmpdir = tempfile.mkdtemp(prefix='aug_bf_')
    try:
        rc, log, build_dir = await _build_sketch(
            cli, tmpdir, base, src_text, sketch_dir, src_file, fqbn,
        )
        hexes = sorted(build_dir.glob('*.hex')) if build_dir.exists() else []
        if rc not in (0, None) or not hexes:
            return {
                'installed': True,
                'ok': False,
                'error': 'compile failed before the flash',
                'exitCode': rc,
                'logTail': '\n'.join(log.splitlines()[-40:]),
            }
        upload_args = [
            'upload', '--fqbn', fqbn, '--input-dir', str(build_dir),
        ]
        if chosen_port:
            upload_args += ['--port', chosen_port]
        urc, ulog = await _spawn(cli, *upload_args, timeout=180.0)
        ok = urc in (0, None)
        return {
            'installed': True,
            'ok': ok,
            'fqbn': fqbn,
            'port': chosen_port,
            'exitCode': urc,
            'error': None if ok else 'upload failed',
            'logTail': '\n'.join(ulog.splitlines()[-40:]),
            'boards': attached,
        }
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


async def board_monitor(
    port: str = '',
    baud: int = 9600,
    duration_ms: int = 3000,
) -> dict[str, object]:
    """Read a board's serial output for a bounded window.

    The other half of "it works": the sketch printed something, and this is
    what it printed. The read is bounded — the monitor is stopped after
    ``duration_ms`` — so a board that never goes quiet does not hang the
    turn.

    The serial line is whatever the sketch prints, which means it can carry
    a WiFi password or a session token. It goes into the transcript and
    from there upstream, exactly like any other tool output.
    """
    cli = _resolve_arduino_cli()
    if cli is None:
        return {'installed': False, 'error': _ARDUINO_CLI_HINT}

    listing = await board_list()
    attached = _as_board_list(listing.get('boards'))
    chosen_port, port_error = _resolve_port(attached, port)
    if port_error:
        return {
            'installed': True,
            'ok': False,
            'error': port_error,
            'boards': attached,
        }

    window = max(200, min(int(duration_ms or 3000), 30000))
    notice = '(monitor stopped after the read window)'
    rc, out = await _spawn(
        cli, 'monitor', '--port', chosen_port,
        '--config', f'baudrate={int(baud or 9600)}',
        timeout=window / 1000.0,
        timeout_message=notice,
    )
    # The monitor ALWAYS ends on the timeout — that is the design — so `rc is
    # None` is not a failure and must not read as one. It is its own verdict:
    # the window closed, and what came back is a prefix of the stream. The stop
    # notice is `_spawn`'s tail, so it is separated out here rather than being
    # counted as a serial line the sketch printed.
    truncated = rc is None
    text = (out or '').strip()
    if truncated and text.endswith(notice):
        text = text[: -len(notice)].strip()
    # arduino-cli's monitor prints its own banner before the serial data.
    if text.startswith('---'):
        text = '\n'.join(text.splitlines()[1:]).strip()
    return {
        'installed': True,
        'ok': True,
        'port': chosen_port,
        'baud': int(baud or 9600),
        'durationMs': window,
        'output': text,
        'truncated': truncated,
        'lineCount': len([ln for ln in text.splitlines() if ln.strip()]),
    }
