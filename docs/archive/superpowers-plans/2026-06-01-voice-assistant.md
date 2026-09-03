# August Voice Assistant Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a wake-word activated voice assistant to the proxy dashboard. Saying "August" activates speech recognition, transcribes to text, sends to the proxy AI (which has access to all tools — Google, MCP, filesystem, etc.), and speaks the response aloud.

**Architecture:** The browser uses `webkitSpeechRecognition` for wake word + STT, posts to the existing `/v1/messages` endpoint (same origin, localhost auto-auth), and uses `SpeechSynthesis` for TTS. A floating mic panel overlays the dashboard. No new backend routes needed — the existing AI API already injects all tools and memory.

**Tech Stack:** Web Speech API (`SpeechRecognition`, `SpeechSynthesis`), vanilla JS, existing proxy `/v1/messages` endpoint, CSS custom properties

---

### Task 1: Voice panel HTML & floating mic button

**Files:**
- Create: `ui/partials/voice.html`
- Modify: `ui/css/styles.css` (add voice panel styles)
- Modify: `ui/pages/ui.html` (add include)

- [ ] **Step 1: Create `ui/partials/voice.html`**

```html
    <!-- ═══ VOICE ASSISTANT PANEL ═══ -->
    <div id="voicePanel" class="fixed bottom-6 right-6 z-50 flex flex-col items-end gap-3">
        <!-- Transcript bubble -->
        <div id="voiceBubble" class="hidden max-w-sm rounded-2xl bg-white dark:bg-slate-800 shadow-lg border border-slate-200 dark:border-slate-700 p-4 text-xs text-slate-700 dark:text-slate-200 transition-all duration-300">
            <p id="voiceTranscript" class="font-medium mb-2"></p>
            <p id="voiceResponse" class="text-slate-500 dark:text-slate-400"></p>
        </div>
        <!-- Mic button -->
        <button id="voiceMicBtn" class="voice-mic-btn flex h-14 w-14 items-center justify-center rounded-full text-white shadow-xl transition-all duration-300"
                onclick="toggleVoice()" title="Click or say 'August' to activate">
            <svg id="voiceMicIcon" class="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path id="voiceMicPath" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z"/>
            </svg>
        </button>
    </div>
```

- [ ] **Step 2: Add voice panel styles to `ui/css/styles.css`**

Append at the end of the file:

```css
/* ── Voice Assistant ── */
.voice-mic-btn {
    background: linear-gradient(135deg, #6366f1, #8b5cf6);
    box-shadow: 0 4px 24px rgba(99, 102, 241, 0.4);
}
.voice-mic-btn:hover {
    box-shadow: 0 6px 32px rgba(99, 102, 241, 0.55);
    transform: scale(1.05);
}
.voice-mic-btn:active {
    transform: scale(0.95);
}
.voice-mic-btn.listening {
    background: linear-gradient(135deg, #ef4444, #f43f5e);
    animation: voice-pulse 1.5s ease-in-out infinite;
}
.voice-mic-btn.processing {
    background: linear-gradient(135deg, #f59e0b, #f97316);
    pointer-events: none;
}
@keyframes voice-pulse {
    0%, 100% { box-shadow: 0 4px 24px rgba(239, 68, 68, 0.4); }
    50% { box-shadow: 0 4px 40px rgba(239, 68, 68, 0.7); }
}
```

- [ ] **Step 3: Add include to `ui/pages/ui.html`**

Before the closing `</body>` tag area. After the `<!-- @include ../partials/modals.html -->` line, add:
```html
<!-- @include ../partials/voice.html -->
```

### Task 2: Voice assistant JavaScript

**Files:**
- Create: `ui/js/voice.js`
- Modify: `ui/partials/scripts.html` (add script include)

- [ ] **Step 1: Create `ui/js/voice.js`**

```js
// ── August Voice Assistant ──
// Uses Web Speech API (webkitSpeechRecognition) for wake word "August" + STT,
// posts to /v1/messages for AI processing (full tool support),
// reads response aloud via SpeechSynthesis.

let voiceRecognition = null;
let voiceIsListening = false;
let voiceIsProcessing = false;
const WAKE_WORD = 'august';
let voiceWakeDetected = false;
let voiceIdleTimeout = null;

function initVoice() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
        document.getElementById('voiceMicBtn')?.classList.add('hidden');
        return;
    }
    voiceRecognition = new SpeechRecognition();
    voiceRecognition.continuous = true;
    voiceRecognition.interimResults = true;
    voiceRecognition.lang = 'en-US';

    voiceRecognition.onresult = (event) => {
        let fullTranscript = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
            const transcript = event.results[i][0].transcript.toLowerCase().trim();
            if (event.results[i].isFinal) {
                fullTranscript += ' ' + transcript;
            } else {
                // Show interim results
                document.getElementById('voiceTranscript').textContent = transcript;
            }
        }

        if (fullTranscript) {
            handleVoiceInput(fullTranscript.trim());
        }
    };

    voiceRecognition.onerror = (event) => {
        console.warn('[Voice] Error:', event.error);
        if (event.error === 'not-allowed') {
            setVoiceStatus('idle');
            showVoiceBubble('Microphone access denied. Check browser permissions.', '');
        } else if (event.error === 'no-speech') {
            // Silent restart
            restartVoice();
        } else {
            setVoiceStatus('idle');
        }
    };

    voiceRecognition.onend = () => {
        if (voiceIsListening && !voiceIsProcessing) {
            restartVoice();
        }
    };
}

function restartVoice() {
    try { voiceRecognition?.start(); } catch (e) { /* ignore */ }
}

function toggleVoice() {
    if (voiceIsListening) {
        stopVoice();
    } else {
        startVoice();
    }
}

function startVoice() {
    if (!voiceRecognition) {
        showVoiceBubble('Voice not supported', 'Try Chrome or Edge browser.');
        return;
    }
    voiceIsListening = true;
    voiceWakeDetected = false;
    setVoiceStatus('listening');
    document.getElementById('voiceBubble')?.classList.remove('hidden');
    document.getElementById('voiceTranscript').textContent = 'Listening for "August"...';
    document.getElementById('voiceResponse').textContent = '';
    try { voiceRecognition.start(); } catch (e) { /* already started */ }

    // Auto-stop after 30s idle
    clearTimeout(voiceIdleTimeout);
    voiceIdleTimeout = setTimeout(stopVoice, 30000);
}

function stopVoice() {
    voiceIsListening = false;
    voiceIsProcessing = false;
    setVoiceStatus('idle');
    try { voiceRecognition?.stop(); } catch (e) { /* ignore */ }
    clearTimeout(voiceIdleTimeout);
    setTimeout(() => document.getElementById('voiceBubble')?.classList.add('hidden'), 2000);
}

function setVoiceStatus(status) {
    const btn = document.getElementById('voiceMicBtn');
    const icon = document.getElementById('voiceMicPath');
    if (!btn) return;

    btn.classList.remove('listening', 'processing');

    if (status === 'listening') {
        btn.classList.add('listening');
        btn.title = 'Listening...';
        if (icon) icon.setAttribute('d', 'M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z');
    } else if (status === 'processing') {
        btn.classList.add('processing');
        btn.title = 'Processing...';
        if (icon) icon.setAttribute('d', 'M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15');
    } else {
        btn.title = 'Click or say "August"';
        if (icon) icon.setAttribute('d', 'M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z');
    }
}

function showVoiceBubble(transcript, response) {
    document.getElementById('voiceBubble')?.classList.remove('hidden');
    document.getElementById('voiceTranscript').textContent = transcript;
    document.getElementById('voiceResponse').textContent = response;
}

async function handleVoiceInput(text) {
    if (!text) return;

    // Check for wake word
    if (!voiceWakeDetected) {
        const idx = text.toLowerCase().indexOf(WAKE_WORD);
        if (idx === -1) {
            showVoiceBubble('Say "August" to activate', '');
            return;
        }
        voiceWakeDetected = true;
        // Remove wake word from the command text
        text = text.slice(idx + WAKE_WORD.length).trim();
        // If nothing after wake word, keep listening
        if (!text) {
            showVoiceBubble('August active — give a command', '');
            return;
        }
    }

    voiceIsProcessing = true;
    setVoiceStatus('processing');
    clearTimeout(voiceIdleTimeout);
    showVoiceBubble('"' + text + '"', 'Thinking...');

    try {
        const res = await fetch('/v1/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'claude-opus-4-7',
                messages: [{ role: 'user', content: text }],
                max_tokens: 2000,
                stream: true
            })
        });

        if (!res.ok) {
            const errText = await res.text();
            showVoiceBubble('"' + text + '"', 'Error: ' + (errText.slice(0, 200)));
            voiceIsProcessing = false;
            setVoiceStatus('listening');
            return;
        }

        // Read SSE stream
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let fullResponse = '';
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    const data = line.slice(6).trim();
                    if (data === '[DONE]') continue;
                    try {
                        const parsed = JSON.parse(data);
                        const delta = parsed.choices?.[0]?.delta?.content || parsed.delta?.text || '';
                        if (delta) {
                            fullResponse += delta;
                            document.getElementById('voiceResponse').textContent = fullResponse;
                        }
                    } catch (e) { /* skip non-JSON */ }
                }
            }
        }

        // Final result
        const finalText = fullResponse || '(no response)';
        showVoiceBubble('"' + text + '"', finalText);
        speakResponse(finalText);

    } catch (e) {
        showVoiceBubble('"' + text + '"', 'Connection error: ' + e.message);
    }

    voiceIsProcessing = false;
    if (voiceIsListening) {
        setVoiceStatus('listening');
    }
}

function speakResponse(text) {
    if (!window.speechSynthesis) return;
    // Skip TTS for very short responses or obvious confirmations
    if (text.length < 3 || text === '(no response)') return;

    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.0;
    utterance.pitch = 1.0;
    utterance.volume = 1.0;

    // Use a female voice if available
    const voices = window.speechSynthesis.getVoices();
    const preferredVoice = voices.find(v => v.name.includes('Google UK Female') || v.name.includes('Samantha') || v.name.includes('Microsoft Zira'));
    if (preferredVoice) utterance.voice = preferredVoice;

    window.speechSynthesis.speak(utterance);
}

// Init on page load
document.addEventListener('DOMContentLoaded', () => {
    initVoice();
    // Pre-load voices
    if (window.speechSynthesis) {
        window.speechSynthesis.getVoices();
        window.speechSynthesis.onvoiceschanged = () => window.speechSynthesis.getVoices();
    }
});
```

- [ ] **Step 2: Add script include to `ui/partials/scripts.html`**

Append before the closing `</body>` companion area:
```html
    <script defer src="/ui/js/voice.js"></script>
```

### Task 3: Integration & verification

- [ ] **Step 1: Restart proxy**

```bash
cd C:\Users\rober\LocalFolders\DockerContainer\august-proxy && docker compose restart august-proxy
```

- [ ] **Step 2: Verify UI renders**

Open `http://localhost:8085/` — floating mic button should appear at bottom-right of the page.

- [ ] **Step 3: Verify mic button states**

Toggle mic button on and off. When on, it should show red pulse animation. When off, purple default state.

- [ ] **Step 4: Verify voice.html include**

Run: `curl -s http://localhost:8085/ | grep -c "voicePanel"` → Expected: 1

- [ ] **Step 5: Verify voice.js script loads**

Run: `curl -s http://localhost:8085/ui/js/voice.js | head -c 100` → Expected: starts with `// ── August Voice Assistant`

- [ ] **Step 6: Verify no regression on existing pages**

Run: `curl -s http://localhost:8085/api/service-connections` → Expected: JSON with connection statuses

## Self-Review Checklist

1. **Spec coverage:** Wake word detection ✅, speech-to-text ✅, AI execution via /v1/messages (full tool support) ✅, TTS ✅, floating mic UI ✅, listening/processing/idle states ✅.
2. **Placeholder scan:** No TBD/TODO. All code complete.
3. **Type consistency:** All function names consistent between HTML onclick handlers and JS functions. DOM IDs match.
