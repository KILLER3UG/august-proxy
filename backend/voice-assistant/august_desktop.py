"""
August Desktop — Transparent native overlay using pywebview.
Always-on wake word detection via sounddevice + speech_recognition.
When 'August' is heard, a transparent fullscreen overlay appears
rendering the /voice UI. No browser window — it's a native window.
"""

import os
import sys
import json
import threading
import queue
import time
import logging
import io

import sounddevice as sd
import numpy as np
import pystray
from PIL import Image, ImageDraw

try:
    import webview
    HAS_WEBVIEW = True
except ImportError:
    HAS_WEBVIEW = False

# ── Config ──
PROXY_URL = os.environ.get('AUGUST_PROXY_URL', 'http://localhost:8085')
AUGUST_MODEL = os.environ.get('AUGUST_MODEL', 'claude-opus-4-7')
WAKE_WORD = 'august'
SAMPLE_RATE = 16000
BLOCK_SIZE = 1600
SILENCE_THRESHOLD = 500
SILENCE_DURATION_MAX = 15

log = logging.getLogger('august')
logging.basicConfig(level=logging.INFO, format='[August] %(message)s')


class JSBridge:
    """
    Python ↔ JavaScript bridge exposed to the webview page.
    The JS side calls these via: window.pywebview.api.methodName()
    """

    def __init__(self, app):
        self._app = app

    def hide_overlay(self):
        """Called from JS when user says a close phrase or clicks X."""
        self._app.hide_overlay()

    def is_native(self):
        """JS can check if it's running inside the native overlay."""
        return True


class AugustDesktop:
    """
    Native transparent voice overlay.
    - Mic always on, listening for "August"
    - Wake word opens a transparent fullscreen pywebview window
    - The window renders /voice with see-through background
    - System tray icon for manual controls
    """

    def __init__(self):
        self._running = False
        self._listening = True
        self._audio_stream = None
        self._audio_buffer = []
        self._silence_frames = 0
        self._window = None
        self._window_ready = threading.Event()
        self._overlay_visible = False
        self._status = 'idle'
        self._status_lock = threading.Lock()
        self._js_bridge = JSBridge(self)
        self._screen_w = 1920
        self._screen_h = 1080

    # ── Overlay Control ──
    def show_overlay(self):
        """Show the transparent overlay."""
        if self._overlay_visible:
            return
        if not self._window:
            return

        self._overlay_visible = True
        self._listening = False
        log.info('Showing overlay — background listening suspended')

        try:
            self._window.show()
            # Evaluate JS to trigger the overlay open
            self._window.evaluate_js('if(typeof onNativeShow==="function") onNativeShow();')
        except Exception as e:
            log.warning(f'Show overlay error: {e}')

    def hide_overlay(self):
        """Hide the transparent overlay (don't destroy it)."""
        if not self._overlay_visible:
            return

        self._overlay_visible = False
        self._listening = True
        log.info('Hiding overlay — background listening resumed')

        try:
            self._window.hide()
        except Exception as e:
            log.warning(f'Hide overlay error: {e}')

    # ── Audio Capture & Wake Word ──
    def _init_audio(self):
        """Start always-on mic capture for wake word."""
        try:
            self._audio_stream = sd.InputStream(
                samplerate=SAMPLE_RATE,
                channels=1,
                dtype='float32',
                blocksize=BLOCK_SIZE,
                callback=self._audio_callback,
            )
            self._audio_stream.start()
            log.info('Mic active — listening for "August"')
        except Exception as e:
            log.warning(f'Mic unavailable: {e}')

    def _audio_callback(self, indata, frames, time_info, status):
        if not self._listening:
            return

        block = (indata * 32767).astype(np.int16).tobytes()
        energy = np.sqrt(np.mean(
            np.frombuffer(block, dtype=np.int16).astype(np.float32) ** 2
        ))

        if energy > SILENCE_THRESHOLD:
            self._audio_buffer.append(block)
            self._silence_frames = 0
        else:
            if self._audio_buffer:
                self._silence_frames += 1
                if self._silence_frames < SILENCE_DURATION_MAX:
                    self._audio_buffer.append(block)
                else:
                    self._process_utterance()
                    self._audio_buffer = []
                    self._silence_frames = 0

    def _process_utterance(self):
        if not self._audio_buffer:
            return

        raw = b''.join(self._audio_buffer)
        samples = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32767.0

        try:
            import speech_recognition as sr
            recognizer = sr.Recognizer()
            wav_bytes = self._float_to_wav(samples)

            with io.BytesIO(wav_bytes) as wav_file:
                with sr.AudioFile(wav_file) as source:
                    audio = recognizer.record(source)

            text = recognizer.recognize_google(audio).strip().lower()
        except Exception:
            return

        if not text:
            return

        log.info(f'Heard: "{text}"')

        if WAKE_WORD in text:
            log.info('>>> Wake word — showing overlay')

            with self._status_lock:
                self._status = 'processing'

            try:
                import winsound
                winsound.Beep(880, 80)
                winsound.Beep(1108, 80)
            except Exception:
                pass

            # Wait for window to be ready
            self._window_ready.wait(timeout=5)
            self.show_overlay()

            with self._status_lock:
                self._status = 'listening'

    def _float_to_wav(self, samples):
        import wave
        buf = io.BytesIO()
        with wave.open(buf, 'wb') as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(SAMPLE_RATE)
            int_samples = (samples * 32767).clip(-32768, 32767).astype(np.int16)
            wf.writeframes(int_samples.tobytes())
        return buf.getvalue()

    # ── Tray Icon ──
    def _create_tray_image(self, status='idle'):
        img = Image.new('RGBA', (64, 64), (0, 0, 0, 0))
        draw = ImageDraw.Draw(img)
        margin = 4
        bbox = [margin, margin, 64 - margin, 64 - margin]
        colors = {
            'listening': (34, 197, 94, 255),
            'processing': (245, 158, 11, 255),
        }
        fill = colors.get(status, (100, 116, 139, 255))
        draw.ellipse(bbox, fill=fill)
        draw.text((21, 14), 'A', fill=(255, 255, 255, 255))
        return img

    def _run_tray(self, stop_event):
        def on_show(icon, item):
            self.show_overlay()

        def on_hide(icon, item):
            self.hide_overlay()

        def on_quit(icon, item):
            self._running = False
            self._listening = False
            self.hide_overlay()
            if self._audio_stream:
                self._audio_stream.stop()
                self._audio_stream.close()
            stop_event.set()
            icon.stop()
            # Destroy the webview window to exit
            try:
                self._window.destroy()
            except Exception:
                pass

        def update_icon(icon):
            while not stop_event.is_set():
                with self._status_lock:
                    s = self._status
                icon.icon = self._create_tray_image(s)
                time.sleep(1)

        icon_image = self._create_tray_image('listening')
        menu = pystray.Menu(
            pystray.MenuItem('Show Overlay', on_show, default=True),
            pystray.MenuItem('Hide Overlay', on_hide),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem('Quit', on_quit),
        )
        icon = pystray.Icon('august-voice', icon_image, 'August Voice', menu)
        updater = threading.Thread(target=update_icon, args=(icon,), daemon=True)
        updater.start()
        icon.run()

    # ── Webview Startup Callback ──
    def _on_webview_loaded(self):
        """Called once the webview window is fully loaded."""
        self._window_ready.set()
        log.info('Webview ready')
        # Start hidden
        self._window.hide()

    # ── Main ──
    def run(self):
        print('August Desktop — Transparent Voice Overlay')
        print(f'Proxy: {PROXY_URL}  |  Model: {AUGUST_MODEL}')
        print('Say "August" to open the overlay.')
        print()

        if not HAS_WEBVIEW:
            print('ERROR: pywebview is required.')
            print('  pip install pywebview')
            sys.exit(1)

        self._running = True
        stop_event = threading.Event()

        # Start audio
        self._init_audio()

        with self._status_lock:
            self._status = 'listening'

        # Start tray in background
        tray_thread = threading.Thread(target=self._run_tray, args=(stop_event,), daemon=True)
        tray_thread.start()

        # Get screen dimensions
        screens = webview.screens
        width = 1920
        height = 1080
        if screens:
            screen = screens[0]
            width = screen.width
            height = screen.height

        voice_url = f'{PROXY_URL}/voice'
        log.info(f'Creating overlay window -> {voice_url}')

        self._window = webview.create_window(
            title='August',
            url=voice_url,
            js_api=self._js_bridge,
            width=width,
            height=height,
            x=0,
            y=0,
            frameless=True,
            easy_drag=False,
            on_top=True,
            transparent=True,
            hidden=True,
            min_size=(400, 300),
        )

        # Start webview (blocks main thread)
        webview.start(
            self._on_webview_loaded,
            debug=False,
            gui='edgechromium',        # Use Edge WebView2 on Windows
        )

        # Cleanup after webview exits
        self._running = False
        if self._audio_stream:
            self._audio_stream.stop()
            self._audio_stream.close()
        stop_event.set()


if __name__ == '__main__':
    app = AugustDesktop()
    app.run()
