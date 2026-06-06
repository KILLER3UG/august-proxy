"""
August Voice Assistant — Desktop Background Agent
Always-on wake word detection. Sends commands to localhost:8085 proxy.
Runs in system tray. No browser needed.
"""
import os
import sys
import json
import threading
import queue
import time
import logging
import io
import base64
import tkinter as tk
import textwrap

import sounddevice as sd
import numpy as np
import requests
import pyttsx3
import pystray
from PIL import Image, ImageDraw

CAPABILITIES_TEXT = """Here's what I can do for you, Sir:

🗣️ General Commands:
  "What time is it?" • "Tell me a joke"

📧 Gmail — Search, read, send emails
📅 Calendar — List events, create, update, delete
📁 Drive — Search files, upload, manage permissions
📄 Docs — Create, read, edit documents
📊 Sheets — Read/write spreadsheets, create tables
🖼️ Slides — Create presentations
📋 Forms — Create and manage forms
✅ Tasks — Manage task lists, add/complete tasks
👤 Contacts — Search and manage contacts
💬 Chat — Send messages, search chat history
📜 Apps Script — Run scripts, manage projects
🔍 Web Search — Google Custom Search

🛠️ System Commands:
  "August, run a diagnostic" • "August, check health"

Just say "August, [command]" anytime I'm listening."""

# ── Desktop Notification Overlay ──
class NotificationOverlay:
    """A sleek popup overlay showing voice input and AI response."""

    def __init__(self):
        self._root = None
        self._frame = None
        self._input_label = None
        self._response_label = None
        self._capabilities_text = None
        self._capabilities_container = None
        self._timer_id = None
        self._shown = False
        self._mode = 'standard'
        self._lock = threading.Lock()
        # Thread-safe command queue for Tkinter calls
        self._cmd_queue = queue.Queue()
        # Start tkinter in its own thread
        self._tk_thread = threading.Thread(target=self._tk_loop, daemon=True)
        self._tk_thread.start()
        # Wait for tk to init
        time.sleep(0.3)

    def _dispatch(self, fn, *args, **kwargs):
        """Queue a callable to run on the Tkinter main thread."""
        self._cmd_queue.put((fn, args, kwargs))

    def _tk_loop(self):
        self._root = tk.Tk()
        self._root.withdraw()  # Hidden until needed
        self._root.overrideredirect(True)  # No window decorations
        self._root.attributes('-topmost', True)
        self._root.attributes('-alpha', 0.0)  # Start invisible

        # Get screen dimensions
        self._screen_w = self._root.winfo_screenwidth()
        self._screen_h = self._root.winfo_screenheight()

        # Window size
        self._win_w = 380
        self._win_h = 160

        # Position: bottom-right, with 20px margin
        self._x = self._screen_w - self._win_w - 20
        self._y = self._screen_h - self._win_h - 60

        self._root.geometry(f'{self._win_w}x{self._win_h}+{self._x}+{self._y}')

        # Main frame with border and background
        self._frame = tk.Frame(
            self._root,
            bg='#1e1e2e',
            highlightbackground='#45475a',
            highlightthickness=1,
            padx=16, pady=12
        )
        self._frame.pack(fill='both', expand=True)

        # Title bar
        title_frame = tk.Frame(self._frame, bg='#1e1e2e')
        title_frame.pack(fill='x', pady=(0, 8))

        dot = tk.Canvas(title_frame, width=10, height=10, bg='#1e1e2e',
                        highlightthickness=0)
        dot.pack(side='left', padx=(0, 8))
        dot.create_oval(2, 2, 10, 10, fill='#a6e3a1', outline='')

        tk.Label(
            title_frame, text='August',
            font=('Segoe UI', 11, 'bold'), fg='#cdd6f4', bg='#1e1e2e'
        ).pack(side='left')

        # Input / Your command
        self._input_label = tk.Label(
            self._frame,
            text='',
            font=('Segoe UI', 10), fg='#a6adc8', bg='#1e1e2e',
            wraplength=340, justify='left', anchor='w'
        )
        self._input_label.pack(fill='x', pady=(0, 6))

        # Separator
        sep = tk.Frame(self._frame, height=1, bg='#45475a')
        sep.pack(fill='x', pady=(0, 6))

        # Response
        self._response_label = tk.Label(
            self._frame,
            text='',
            font=('Segoe UI', 10), fg='#cdd6f4', bg='#1e1e2e',
            wraplength=340, justify='left', anchor='w'
        )
        self._response_label.pack(fill='x')

        # Capabilities container (hidden by default)
        self._capabilities_container = tk.Frame(self._frame, bg='#1e1e2e')
        # Greeting header
        greeting_frame = tk.Frame(self._capabilities_container, bg='#1e1e2e')
        greeting_frame.pack(fill='x', pady=(0, 8))
        dot = tk.Canvas(greeting_frame, width=12, height=12, bg='#1e1e2e',
                        highlightthickness=0)
        dot.pack(side='left', padx=(0, 8))
        dot.create_oval(1, 1, 12, 12, fill='#a6e3a1', outline='#a6e3a1', width=2)
        tk.Label(
            greeting_frame, text='AUGUST',
            font=('Segoe UI', 14, 'bold'), fg='#cdd6f4', bg='#1e1e2e'
        ).pack(side='left')
        tk.Label(
            greeting_frame, text='— ready to serve',
            font=('Segoe UI', 10), fg='#a6adc8', bg='#1e1e2e'
        ).pack(side='left', padx=(8, 0))
        # Capabilities text
        self._capabilities_text = tk.Text(
            self._capabilities_container,
            font=('Segoe UI', 9), fg='#a6adc8', bg='#1e1e2e',
            wrap='word', height=15, width=44,
            highlightthickness=0, bd=0,
            relief='flat', padx=0, pady=4
        )
        self._capabilities_text.pack(fill='both', expand=True)
        self._capabilities_text.insert('1.0', CAPABILITIES_TEXT)
        self._capabilities_text.config(state='disabled')

        self._root.bind('<Button-1>', lambda e: self.hide())

        # Poll command queue every 50ms and start main loop
        self._poll_queue()
        self._root.mainloop()

    def show_splash(self):
        """Show capabilities splash when 'August' is heard but no command."""
        with self._lock:
            self._mode = 'splash'
            self._dispatch(lambda:self._input_label.config(text=''))
            self._dispatch(lambda:self._response_label.config(text=''))
            self._dispatch(lambda:self._response_label.pack_forget())
            self._dispatch(lambda:self._capabilities_container.pack(
                fill='both', expand=True, pady=(4, 0)))
            # Larger window for the splash
            self._dispatch(lambda:self._root.geometry('380x340'))
            self._dispatch(lambda:self._root.geometry(
                f'380x340+{self._x}+{max(30, self._screen_h - 340 - 60)}'))
            self._dispatch(self._animate_in)

    def show_input(self, text):
        """Show overlay with the user's command."""
        with self._lock:
            self._mode = 'standard'
            # Hide capabilities if showing
            self._dispatch(lambda:self._capabilities_container.pack_forget())
            self._dispatch(lambda:self._response_label.pack(fill='x'))
            self._dispatch(lambda:self._root.geometry(
                f'{self._win_w}x{self._win_h}+{self._x}+{self._y}'))
            wrapped = '\n'.join(textwrap.wrap(text, width=55)) if text else ''
            self._dispatch(lambda:self._input_label.config(
                text=f'🎤 {wrapped}'))
            self._dispatch(lambda:self._response_label.config(text='⏳ Thinking...'))
            self._dispatch(self._animate_in)

    def show_response(self, text):
        """Update overlay with AI response."""
        with self._lock:
            if self._mode == 'splash':
                return  # Don't overlay response on splash
            wrapped = '\n'.join(textwrap.wrap(text, width=55)) if text else '(empty)'
            self._dispatch(lambda:self._response_label.config(text=f'💬 {wrapped}'))
            # Auto-hide after 6 seconds
            self._dispatch(lambda:self._schedule_auto_hide())

    def _schedule_auto_hide(self):
        if self._timer_id:
            self._root.after_cancel(self._timer_id)
        self._timer_id = self._root.after(6000, self._animate_out)

    def _animate_in(self):
        """Slide in with bounce and glow."""
        if self._shown:
            if self._timer_id:
                self._root.after_cancel(self._timer_id)
            self._timer_id = self._root.after(8000, self._animate_out)
            # Glow pulse on re-show
            self._glow_pulse(0)
            return

        self._shown = True
        self._root.deiconify()

        # Determine window dimensions based on mode
        if self._mode == 'splash':
            start_y = self._screen_h  # Start from bottom
        else:
            start_y = self._y + 40

        self._root.attributes('-alpha', 0.0)

        def slide_in(y_pos, frames_left):
            if frames_left <= 0:
                final_y = max(30, self._screen_h - 340 - 60) if self._mode == 'splash' else self._y
                self._root.geometry(
                    f'{self._win_w if self._mode != "splash" else 380}x'
                    f'{self._win_h if self._mode != "splash" else 340}+'
                    f'{self._x}+{final_y}')
                self._root.attributes('-alpha', 1.0)
                # Start glow pulse
                self._glow_pulse(0)
                # Auto-hide timer based on mode
                hide_ms = 10000 if self._mode == 'splash' else 6000
                self._timer_id = self._root.after(hide_ms, self._animate_out)
                return
            progress = 1 - (frames_left / 20)
            ease_out = 1 - (1 - progress) ** 2  # Ease out quad
            new_alpha = min(1.0, ease_out * 1.2)
            current_h = self._win_h if self._mode != 'splash' else 340
            current_w = self._win_w if self._mode != 'splash' else 380
            new_y = int(self._y - (self._y - start_y) * ease_out) if self._mode == 'splash' else int(max(self._y, start_y - (start_y - self._y) * ease_out))
            self._root.attributes('-alpha', new_alpha)
            self._root.geometry(f'{current_w}x{current_h}+{self._x}+{new_y}')
            self._root.after(20, lambda: slide_in(new_y, frames_left - 1))

        slide_in(start_y, 20)

    def _glow_pulse(self, step_count):
        """Subtle opacity pulse for visual attention."""
        if not self._shown:
            return
        pulse = 0.85 + 0.15 * abs(0.5 - (step_count % 20) / 20) * 2
        try:
            self._root.attributes('-alpha', pulse)
        except:
            pass
        if step_count < 60:  # Pulse for about 3 seconds
            self._root.after(50, lambda: self._glow_pulse(step_count + 1))

    def _poll_queue(self):
        """Process queued GUI calls from other threads."""
        try:
            while True:
                fn, args, kwargs = self._cmd_queue.get_nowait()
                fn(*args, **kwargs)
        except queue.Empty:
            pass
        self._root.after(50, self._poll_queue)

    def _animate_out(self):
        """Fade out and hide."""
        if not self._shown:
            return

        def step(alpha, frames_left):
            if frames_left <= 0:
                self._shown = False
                self._root.withdraw()
                self._root.attributes('-alpha', 0.0)
                return
            new_alpha = max(0.0, alpha - 0.1)
            self._root.attributes('-alpha', new_alpha)
            self._root.after(30, lambda: step(new_alpha, frames_left - 1))

        step(1.0, 10)

    def hide(self):
        """Immediately hide the overlay."""
        with self._lock:
            if self._timer_id:
                self._root.after_cancel(self._timer_id)
                self._timer_id = None
            self._root.after(0, self._animate_out)

# ── Config ──
PROXY_URL = os.environ.get('AUGUST_PROXY_URL', 'http://localhost:8085')
AUGUST_MODEL = os.environ.get('AUGUST_MODEL', 'claude-opus-4-7')
WAKE_WORD = 'august'
SAMPLE_RATE = 16000
BLOCK_SIZE = 1600  # 100ms per block at 16kHz
SILENCE_THRESHOLD = 500  # RMS energy threshold
SILENCE_DURATION_MAX = 15  # max silence frames (1.5s) before ending utterance

log = logging.getLogger('august_voice')
logging.basicConfig(level=logging.INFO, format='[August] %(message)s')


class AugustVoiceAgent:
    """Always-on voice assistant running in system tray."""

    def __init__(self):
        self._command_queue = queue.Queue()
        self._response_queue = queue.Queue()
        self._running = False
        self._listening = False
        self._audio_buffer = []
        self._silence_frames = 0
        self._tts_engine = None

        # Audio stream
        self._stream = None

        # Status for tray icon
        self._status = 'idle'  # idle, listening, processing, speaking
        self._status_lock = threading.Lock()

        # Desktop notification overlay
        self._notifier = NotificationOverlay()

    # ── TTS ──
    def _get_tts(self):
        if self._tts_engine is None:
            try:
                self._tts_engine = pyttsx3.init()
                voices = self._tts_engine.getProperty('voices')
                # Prefer a female voice
                for v in voices:
                    if 'female' in v.name.lower() or 'zira' in v.name.lower():
                        self._tts_engine.setProperty('voice', v.id)
                        break
                self._tts_engine.setProperty('rate', 185)
                self._tts_engine.setProperty('volume', 1.0)
            except Exception as e:
                log.warning(f'TTS init failed: {e}')
                self._tts_engine = None
        return self._tts_engine

    def speak(self, text):
        """Speak text using TTS (runs in calling thread)."""
        if not text or len(text) < 3:
            return
        with self._status_lock:
            self._status = 'speaking'
        tts = self._get_tts()
        if tts:
            try:
                tts.say(text)
                tts.runAndWait()
            except Exception as e:
                log.warning(f'TTS error: {e}')
        with self._status_lock:
            self._status = 'listening' if self._listening else 'idle'

    # ── Audio Processing ──
    def _calc_energy(self, block):
        """Calculate RMS energy of audio block."""
        arr = np.frombuffer(block, dtype=np.int16).astype(np.float32)
        if len(arr) == 0:
            return 0
        return np.sqrt(np.mean(arr ** 2))

    def _audio_callback(self, indata, frames, time_info, status):
        """Called for each audio block from sounddevice."""
        if not self._running or not self._listening:
            return

        # Convert to int16
        block = (indata * 32767).astype(np.int16).tobytes()
        energy = self._calc_energy(block)

        if energy > SILENCE_THRESHOLD:
            self._audio_buffer.append(block)
            self._silence_frames = 0
        else:
            if self._audio_buffer:
                self._silence_frames += 1
                if self._silence_frames < SILENCE_DURATION_MAX:
                    self._audio_buffer.append(block)
                else:
                    # End of utterance — process
                    self._process_utterance()
                    self._audio_buffer = []
                    self._silence_frames = 0

    def _process_utterance(self):
        """Transcribe and check for wake word, then send to AI."""
        if not self._audio_buffer:
            return

        # Save audio to WAV for transcription
        raw = b''.join(self._audio_buffer)
        samples = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32767.0

        # Use SpeechRecognition for Google STT
        try:
            import speech_recognition as sr
            recognizer = sr.Recognizer()

            # Convert float samples to WAV bytes
            wav_bytes = self._float_to_wav(samples)

            with io.BytesIO(wav_bytes) as wav_file:
                with sr.AudioFile(wav_file) as source:
                    audio = recognizer.record(source)

            try:
                text = recognizer.recognize_google(audio).lower().strip()
            except sr.UnknownValueError:
                return  # Didn't understand, skip
            except sr.RequestError as e:
                log.warning(f'Google STT error: {e}')
                return

        except Exception as e:
            log.warning(f'STT error: {e}')
            return

        if not text:
            return

        log.info(f'Heard: "{text}"')

        # Check for wake word
        idx = text.find(WAKE_WORD)
        if idx == -1:
            return  # Not for us

        # Extract command after wake word
        command = text[idx + len(WAKE_WORD):].strip()
        if not command:
            log.info('Wake word detected — showing capabilities')
            self._notifier.show_splash()
            try:
                import winsound
                winsound.Beep(880, 100)
                winsound.Beep(1108, 100)
            except:
                pass
            return

        log.info(f'Command: "{command}"')
        self._command_queue.put(command)
        self._notifier.show_input(command)
        threading.Thread(target=self._send_to_proxy, args=(command,), daemon=True).start()

    def _float_to_wav(self, samples):
        """Convert float32 samples [-1,1] to WAV bytes."""
        import struct
        import wave

        buf = io.BytesIO()
        with wave.open(buf, 'wb') as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(SAMPLE_RATE)
            # Convert to int16
            int_samples = (samples * 32767).clip(-32768, 32767).astype(np.int16)
            wf.writeframes(int_samples.tobytes())
        return buf.getvalue()

    # ── AI Proxy Call ──
    def _send_to_proxy(self, command):
        """Send command to proxy and stream response, then speak."""
        with self._status_lock:
            self._status = 'processing'

        try:
            res = requests.post(
                f'{PROXY_URL}/v1/messages',
                json={
                    'model': AUGUST_MODEL,
                    'messages': [{'role': 'user', 'content': command}],
                    'max_tokens': 2000,
                    'stream': False
                },
                headers={'Content-Type': 'application/json'},
                timeout=30
            )

            if res.status_code != 200:
                err = res.text[:200]
                log.error(f'Proxy error {res.status_code}: {err}')
                return

            data = res.json()
            # Extract text from Claude API response format
            response_text = ''
            if isinstance(data, dict):
                for content_block in data.get('content', []):
                    if content_block.get('type') == 'text':
                        response_text += content_block.get('text', '')

            if not response_text:
                # Try OpenAI format
                if 'choices' in data:
                    response_text = data['choices'][0].get('message', {}).get('content', '')

            if response_text:
                log.info(f'Response: {response_text[:100]}...')
                self._notifier.show_response(response_text[:500])
                threading.Thread(target=self.speak, args=(response_text,), daemon=True).start()
            else:
                log.warning('Empty response from proxy')

        except requests.ConnectionError:
            log.warning('Proxy not reachable. Is august-proxy running?')
        except Exception as e:
            log.error(f'Proxy call failed: {e}')

        with self._status_lock:
            self._status = 'listening' if self._listening else 'idle'

    # ── Lifecycle ──
    def start_listening(self):
        """Start continuous audio capture."""
        if self._listening:
            return
        self._listening = True
        self._audio_buffer = []
        self._silence_frames = 0
        with self._status_lock:
            self._status = 'listening'
        log.info('Started listening for "August"...')

    def stop_listening(self):
        """Stop audio capture."""
        self._listening = False
        with self._status_lock:
            if self._status != 'processing' and self._status != 'speaking':
                self._status = 'idle'
        log.info('Stopped listening.')

    def start(self):
        """Start the agent."""
        self._running = True
        self._stream = sd.InputStream(
            samplerate=SAMPLE_RATE,
            channels=1,
            dtype='float32',
            blocksize=BLOCK_SIZE,
            callback=self._audio_callback
        )
        self._stream.start()
        self.start_listening()
        log.info('August Voice Agent started.')
        # Startup chime
        try:
            import winsound
            winsound.Beep(660, 80)
            winsound.Beep(880, 80)
        except:
            pass

    def stop(self):
        """Stop the agent."""
        self._running = False
        self._listening = False
        if self._stream:
            self._stream.stop()
            self._stream.close()
        with self._status_lock:
            self._status = 'idle'
        log.info('August Voice Agent stopped.')

    def get_status(self):
        with self._status_lock:
            return self._status


# ── System Tray Icon ──
def create_tray_image(status):
    """Create a 64x64 RGBA tray icon based on status."""
    img = Image.new('RGBA', (64, 64), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Circle
    margin = 4
    bbox = [margin, margin, 64 - margin, 64 - margin]

    if status == 'listening':
        fill = (34, 197, 94, 255)  # green
    elif status == 'processing':
        fill = (245, 158, 11, 255)  # amber
    elif status == 'speaking':
        fill = (99, 102, 241, 255)  # indigo
    else:
        fill = (100, 116, 139, 255)  # slate

    draw.ellipse(bbox, fill=fill)
    draw.ellipse(
        [margin + 8, margin + 8, 64 - margin - 8, 64 - margin - 8],
        fill=(0, 0, 0, 0),
        outline=(255, 255, 255, 60),
        width=2
    )

    # A letter
    draw.text((21, 14), 'A', fill=(255, 255, 255, 255), font=None)
    return img


def run_tray():
    """Run the system tray application."""
    agent = AugustVoiceAgent()

    # Stop event for clean shutdown
    stop_event = threading.Event()

    def on_start(icon, item):
        if not agent._listening:
            agent.start_listening()

    def on_stop(icon, item):
        if agent._listening:
            agent.stop_listening()

    def on_quit(icon, item):
        agent.stop()
        stop_event.set()
        icon.stop()

    def update_icon(icon):
        """Periodically update icon color based on status."""
        while not stop_event.is_set():
            status = agent.get_status()
            icon.icon = create_tray_image(status)
            time.sleep(1)

    icon_image = create_tray_image('idle')
    menu = pystray.Menu(
        pystray.MenuItem('Start Listening', on_start, default=True),
        pystray.MenuItem('Stop Listening', on_stop),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem('Quit', on_quit)
    )
    icon = pystray.Icon('august-voice', icon_image, 'August Voice', menu)

    # Start agent
    agent.start()

    # Start icon updater thread
    updater = threading.Thread(target=update_icon, args=(icon,), daemon=True)
    updater.start()

    # Run tray
    icon.run()

    # Cleanup
    agent.stop()


if __name__ == '__main__':
    print('August Voice Assistant — Desktop Background Agent')
    print(f'Proxy: {PROXY_URL}')
    print(f'Model: {AUGUST_MODEL}')
    print('Say "August" followed by your command.')
    print('The agent runs in your system tray.')
    print('Press Ctrl+C to quit.')
    print()
    run_tray()
