"""Desktop automation — real screen, mouse, keyboard via pyautogui.

This is the *desktop* computer-use layer: it controls the user's actual
physical desktop (captures the screen, moves/clicks the real mouse, types
on the real keyboard). It is distinct from the headless browser automation
in ``app.services.browser``, which drives a headless Playwright page.

pyautogui / pygetwindow are imported lazily so the proxy boots even when the
desktop engine isn't installed; tools then return a clear ``{"error": ...}``.

Camera capture (Windows) uses the ffmpeg binary bundled by
``imageio-ffmpeg`` against the DirectShow (``dshow``) input. Captured
frames live in a temporary file that is deleted before the function
returns; the resulting vision description is the only output.
"""

from __future__ import annotations

import os


async def takeScreenshot() -> dict[str, object]:
    """Capture the real desktop as a PNG file, returning its path + size.

    Writes to the data dir (mirroring ``browser_screenshot``) instead of
    returning a multi-MB base64 blob — a base64 dict gets ``str()``-repr'd
    and boundary-truncated in the tool loop, corrupting the payload the UI
    and model see (audit finding).
    """
    try:
        import time

        import pyautogui

        from app.lib.paths import dataPath
        from app.services.workbench.context import currentSessionId

        screenshot = pyautogui.screenshot()
        sid = currentSessionId.get() or 'default'
        folder = dataPath('desktop_screenshots', sid)
        folder.mkdir(parents=True, exist_ok=True)
        filename = f'{int(time.time() * 1000)}.png'
        path = folder / filename
        screenshot.save(str(path), format='PNG')
        w, h = screenshot.size
        return {'path': str(path), 'width': w, 'height': h, 'format': 'png'}
    except ImportError:
        return {'error': 'pyautogui not installed. Run `uv sync --extra desktop`.'}


async def getMousePosition() -> dict[str, object]:
    """Return the current real cursor position."""
    try:
        import pyautogui

        x, y = pyautogui.position()
        return {'x': x, 'y': y}
    except ImportError:
        return {'error': 'pyautogui not installed. Run `uv sync --extra desktop`.'}


async def getScreenSize() -> dict[str, object]:
    """Return the real screen dimensions in pixels."""
    try:
        import pyautogui

        w, h = pyautogui.size()
        return {'width': w, 'height': h}
    except ImportError:
        return {'error': 'pyautogui not installed. Run `uv sync --extra desktop`.'}


async def clickMouse(x: int, y: int, button: str = 'left') -> dict[str, object]:
    """Move the real mouse to (x, y) and click."""
    try:
        import pyautogui

        pyautogui.click(x, y, button=button)
        return {'x': x, 'y': y, 'button': button}
    except ImportError:
        return {'error': 'pyautogui not installed. Run `uv sync --extra desktop`.'}


async def typeText(text: str) -> dict[str, object]:
    """Type ``text`` on the real keyboard."""
    try:
        import pyautogui

        pyautogui.write(text)
        return {'typed': len(text)}
    except ImportError:
        return {'error': 'pyautogui not installed. Run `uv sync --extra desktop`.'}


async def pressKey(key: str) -> dict[str, object]:
    """Press a single real keyboard key (e.g. ``enter``, ``escape``)."""
    try:
        import pyautogui

        pyautogui.press(key)
        return {'key': key}
    except ImportError:
        return {'error': 'pyautogui not installed. Run `uv sync --extra desktop`.'}


async def listWindows() -> list[dict[str, object]]:
    """List visible desktop windows (title + geometry)."""
    windows: list[dict[str, object]] = []
    try:
        import pygetwindow as gw

        for w in gw.getWindowsWithTitle(''):
            windows.append({'title': w.title, 'left': w.left, 'top': w.top, 'width': w.width, 'height': w.height})
    except ImportError:
        return [{'note': 'pygetwindow not installed. Run `uv sync --extra desktop`.'}]
    return windows


async def openUrl(url: str) -> dict[str, object]:
    """Open ``url`` in the user's default *visible* browser (not headless).

    This launches the OS default browser window — use the headless
    ``browser_open`` tool instead for background page inspection.
    """
    import webbrowser

    webbrowser.open(url)
    return {'url': url, 'status': 'opened'}


# ── Camera (transient webcam capture) ─────────────────────────────────────


def _ffmpeg_exe() -> str | None:
    """Resolve the ffmpeg binary — prefer the bundled imageio-ffmpeg copy
    so we don't depend on the user having ffmpeg on PATH."""
    import shutil

    bundled = shutil.which('ffmpeg')
    if bundled:
        return bundled
    try:
        import imageio_ffmpeg

        path = imageio_ffmpeg.get_ffmpeg_exe()
        if path and os.path.isfile(path):
            return path
    except Exception:
        return None
    return None


def listCameraDevices() -> dict[str, object]:
    """Enumerate video input devices via DirectShow (Windows).

    Returns a ``{devices: [...], error?: ...}`` dict — always JSON-safe.
    Non-Windows hosts return an explanatory error.
    """
    import platform
    import re
    import subprocess as sp

    if platform.system() != 'Windows':
        return {'devices': [], 'note': 'camera_list_devices only enumerates DirectShow devices on Windows.'}

    exe = _ffmpeg_exe()
    if not exe:
        return {'error': 'ffmpeg not found. Install imageio-ffmpeg to enumerate cameras.'}

    try:
        proc = sp.run(
            [exe, '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'],
            capture_output=True,
            text=True,
            timeout=15,
        )
    except Exception as exc:
        return {'error': f'ffmpeg list_devices failed: {exc}'}

    text = (proc.stdout or '') + '\n' + (proc.stderr or '')
    devices: list[dict[str, str]] = []
    for line in text.splitlines():
        # DirectShow lists video devices as:  "DeviceName" ("type")
        m = re.search(r'"([^"]+)"\s+\(video\)', line)
        if not m:
            continue
        name = m.group(1).strip()
        if not name or name.lower() == 'dummy':
            continue
        devices.append({'name': name, 'kind': 'video'})
    # Dedupe by name (dshow sometimes reports each device twice).
    seen: set[str] = set()
    unique: list[dict[str, str]] = []
    for d in devices:
        if d['name'] in seen:
            continue
        seen.add(d['name'])
        unique.append(d)
    return {'devices': unique, 'count': len(unique)}


async def captureCameraFrame(device: str = '', question: str = '') -> dict[str, object]:
    """Grab a single webcam frame, describe it, and discard the frame.

    ``device`` is a DirectShow device name (from ``camera_list_devices``);
    an empty value picks the first enumerated device. ``question`` is the
    prompt forwarded to the vision analyzer. The raw PNG lives only in a
    temporary file that is deleted before this function returns; nothing
    is written to memory stores or saved screenshots.
    """
    import platform
    import subprocess as sp
    import tempfile
    from pathlib import Path

    if platform.system() != 'Windows':
        return {'error': 'camera_snapshot only supports DirectShow cameras on Windows.'}

    exe = _ffmpeg_exe()
    if not exe:
        return {'error': 'ffmpeg not found. Install imageio-ffmpeg to capture camera frames.'}

    target_name = (device or '').strip()
    if not target_name:
        listed = listCameraDevices()
        raw_devices: object = listed.get('devices')
        first_list: list[object] = raw_devices if isinstance(raw_devices, list) else []
        if not first_list:
            return {'error': 'No camera device found. Run camera_list_devices to confirm.'}
        first_dev = first_list[0]
        first_name = first_dev.get('name', '') if isinstance(first_dev, dict) else ''
        target_name = str(first_name).strip()
    if not target_name:
        return {'error': 'Camera device name is empty.'}

    tmpdir = Path(tempfile.mkdtemp(prefix='august-cam-'))
    frame_path = tmpdir / 'frame.jpg'
    try:
        try:
            proc = sp.run(
                [
                    exe, '-hide_banner', '-loglevel', 'error',
                    '-f', 'dshow', '-i', f'video={target_name}',
                    '-frames:v', '1', '-q:v', '3',
                    str(frame_path),
                ],
                capture_output=True,
                text=True,
                timeout=20,
            )
        except Exception as exc:
            return {'error': f'ffmpeg capture failed: {exc}'}
        if proc.returncode != 0 or not frame_path.exists() or frame_path.stat().st_size == 0:
            err = (proc.stderr or proc.stdout or '').strip()
            return {'error': f'Camera capture failed (rc={proc.returncode}). {err[:300]}'}

        # Hand the transient frame to the vision analyzer — analyze_media
        # reads the bytes; we delete the file immediately afterwards so it
        # never lands in screenshots/observations or any persistent path.
        from app.services.tools import media_tools

        q = (question or 'Describe what is visible in the camera frame.').strip()
        description = await media_tools.analyze_media(str(frame_path), q)
        return {
            'transient': True,
            'device': target_name,
            'description': description,
            'note': 'Frame is transient and was not persisted to disk or memory stores.',
        }
    finally:
        try:
            frame_path.unlink(missing_ok=True)
        except Exception:
            pass
        try:
            tmpdir.rmdir()
        except Exception:
            pass
