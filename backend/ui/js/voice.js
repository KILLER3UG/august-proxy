// August Voice Assistant
// Wake word + STT in the browser, backed by the Workbench SSE stream so
// transcript, AI text, and tool/command activity stay visible.

let voiceRecognition = null;
let voiceIsListening = false;
let voiceIsProcessing = false;
const WAKE_WORD = 'august';
let voiceWakeDetected = false;
let voiceIdleTimeout = null;
let voiceSession = null;
let voiceResponseText = '';
let voiceThinkingShown = false;

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
            const transcript = event.results[i][0].transcript.trim();
            if (event.results[i].isFinal) {
                fullTranscript += ' ' + transcript;
            } else {
                showVoiceBubble(transcript, null);
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
            restartVoice();
        } else {
            setVoiceStatus('idle');
            setVoiceStatusText('Voice paused');
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
    setVoiceStatusText('Listening for August');
    showVoiceBubble('Listening for "August"...', '');
    try { voiceRecognition.start(); } catch (e) { /* already started */ }
}

function stopVoice() {
    voiceIsListening = false;
    voiceIsProcessing = false;
    voiceWakeDetected = false;
    setVoiceStatus('idle');
    setVoiceStatusText('Voice off');
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

function setVoiceStatusText(text) {
    const el = document.getElementById('voiceStatusText');
    if (el) el.textContent = text;
}

function showVoiceBubble(transcript, response, options = {}) {
    document.getElementById('voiceBubble')?.classList.remove('hidden');
    if (transcript !== null && transcript !== undefined) {
        document.getElementById('voiceTranscript').textContent = transcript;
    }
    if (response !== null && response !== undefined) {
        document.getElementById('voiceResponse').textContent = response;
    }
    if (options.clearActivity) {
        const activity = document.getElementById('voiceActivity');
        if (activity) activity.innerHTML = '';
    }
}

function appendVoiceActivity(kind, title, detail = '') {
    const activity = document.getElementById('voiceActivity');
    if (!activity) return;
    const item = document.createElement('div');
    item.className = `voice-activity-item is-${kind || 'info'}`;
    item.innerHTML = `
        <div class="voice-activity-title">${escapeVoiceHtml(title || '')}</div>
        ${detail ? `<div class="voice-activity-detail">${escapeVoiceHtml(detail)}</div>` : ''}
    `;
    activity.appendChild(item);
    activity.scrollTop = activity.scrollHeight;
}

function escapeVoiceHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    }[ch]));
}

function summarizeVoicePayload(value) {
    if (typeof value === 'string') return value.slice(0, 600);
    if (!value || typeof value !== 'object') return '';
    const direct = value.command || value.path || value.query || value.url || value.name;
    if (direct) return String(direct).slice(0, 600);
    try { return JSON.stringify(value, null, 2).slice(0, 900); } catch (e) { return String(value).slice(0, 600); }
}

function summarizeVoiceResult(content) {
    const text = typeof content === 'string' ? content : JSON.stringify(content || {}, null, 2);
    try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object') {
            const output = [parsed.stdout, parsed.stderr].filter(Boolean).join('\n').trim();
            if (output) return output.slice(0, 900);
            if (parsed.exitCode !== undefined) return `Exit code ${parsed.exitCode}`;
        }
    } catch (e) { /* plain text */ }
    return text.slice(0, 900);
}

async function ensureVoiceWorkbenchSession() {
    if (typeof ensureWorkbenchSession === 'function') {
        voiceSession = await ensureWorkbenchSession();
        return voiceSession;
    }
    if (voiceSession?.id) return voiceSession;
    const res = await fetch('/ui/workbench/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'claude', agentId: 'build' })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not create Workbench session');
    voiceSession = data;
    return voiceSession;
}

function mirrorVoiceUserMessage(text) {
    if (typeof renderWorkbenchMessage !== 'function') return;
    const workbench = document.getElementById('workbenchMessages');
    if (!workbench) return;
    renderWorkbenchMessage('user', `Voice: ${text}`, null, { typing: false });
}

function mirrorVoiceAssistantText(text) {
    if (typeof renderWorkbenchMessage !== 'function' || !text) return;
    const workbench = document.getElementById('workbenchMessages');
    if (!workbench) return;
    renderWorkbenchMessage('assistant', text);
}

function updateVoiceSession(data) {
    if (!data) return;
    voiceSession = data;
    try {
        workbenchSession = data;
        if (typeof renderWorkbenchPlan === 'function') renderWorkbenchPlan();
        if (typeof renderWorkbenchGoal === 'function') renderWorkbenchGoal();
        if (typeof renderWorkbenchTodos === 'function') renderWorkbenchTodos(data);
        if (typeof loadWorkbenchAgentsUI === 'function') loadWorkbenchAgentsUI(true).catch(() => {});
    } catch (e) { /* Workbench globals may not exist yet. */ }
}

function handleVoiceSSEEvent(event, data) {
    if (event === 'thinking') {
        if (!voiceThinkingShown) {
            appendVoiceActivity('info', 'Thinking');
            voiceThinkingShown = true;
        }
        return;
    }
    if (event === 'tool_use') {
        const detail = summarizeVoicePayload(data?.input);
        appendVoiceActivity('tool', `Running ${data?.name || 'tool'}`, detail);
        if (typeof renderToolLine === 'function') renderToolLine(data?.id, data?.name, data?.input);
        return;
    }
    if (event === 'tool_result') {
        const detail = summarizeVoiceResult(data?.content);
        appendVoiceActivity(data?.is_error ? 'error' : 'result', data?.is_error ? 'Command failed' : 'Command output', detail);
        if (typeof updateToolLine === 'function') updateToolLine(data?.id, data?.content, data?.is_error);
        return;
    }
    if (event === 'text') {
        const text = data?.content || '';
        voiceResponseText += text;
        document.getElementById('voiceResponse').textContent = voiceResponseText || '(no response)';
        mirrorVoiceAssistantText(text);
        return;
    }
    if (event === 'session') {
        updateVoiceSession(data);
        return;
    }
    if (event === 'goal') {
        if (typeof renderWorkbenchGoal === 'function') renderWorkbenchGoal(data);
        return;
    }
    if (event === 'btw') {
        const answer = data?.answer || '';
        voiceResponseText += answer;
        document.getElementById('voiceResponse').textContent = voiceResponseText;
        return;
    }
    if (event === 'error') {
        appendVoiceActivity('error', 'Request failed', data?.message || 'Unknown error');
        document.getElementById('voiceResponse').textContent = data?.message || 'Unknown error';
    }
}

async function readVoiceSSEStream(reader) {
    const decoder = new TextDecoder();
    let buffer = '';
    let eventName = '';
    let eventData = '';

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
            if (line.startsWith('event: ')) eventName = line.slice(7).trim();
            else if (line.startsWith('data: ')) eventData += line.slice(6).trim();
            else if (line === '' && eventName) {
                let parsed = {};
                if (eventData) {
                    try { parsed = JSON.parse(eventData); } catch (e) { parsed = { raw: eventData }; }
                }
                handleVoiceSSEEvent(eventName, parsed);
                eventName = '';
                eventData = '';
            }
        }
    }

    if (eventName) {
        let parsed = {};
        if (eventData) {
            try { parsed = JSON.parse(eventData); } catch (e) { parsed = { raw: eventData }; }
        }
        handleVoiceSSEEvent(eventName, parsed);
    }
}

async function handleVoiceInput(text) {
    if (!text || voiceIsProcessing) return;

    const lower = text.toLowerCase();
    if (!voiceWakeDetected) {
        const idx = lower.indexOf(WAKE_WORD);
        if (idx === -1) {
            showVoiceBubble('Say "August" to activate', null);
            return;
        }
        voiceWakeDetected = true;
        text = text.slice(idx + WAKE_WORD.length).trim().replace(/^[,.:;\s]+/, '');
        if (!text) {
            showVoiceBubble('August active - give a command', '');
            setVoiceStatusText('Awaiting command');
            return;
        }
    }

    voiceIsProcessing = true;
    voiceResponseText = '';
    voiceThinkingShown = false;
    setVoiceStatus('processing');
    setVoiceStatusText('August is working');
    clearTimeout(voiceIdleTimeout);
    showVoiceBubble(`"${text}"`, '', { clearActivity: true });
    appendVoiceActivity('info', 'Voice input', text);
    mirrorVoiceUserMessage(text);

    try {
        const session = await ensureVoiceWorkbenchSession();
        const provider = document.getElementById('workbenchProvider')?.value || session.provider || 'claude';
        const agentId = document.getElementById('workbenchAgent')?.value || session.agentId || 'build';
        const res = await fetch('/ui/workbench/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                sessionId: session.id,
                provider,
                agentId,
                message: text
            })
        });

        if (!res.ok) {
            const errText = await res.text();
            let errMsg = errText || 'Voice request failed';
            try { errMsg = JSON.parse(errText).error || errMsg; } catch (e) {}
            throw new Error(errMsg);
        }

        await readVoiceSSEStream(res.body.getReader());
        const finalText = voiceResponseText || '(no response)';
        document.getElementById('voiceResponse').textContent = finalText;
        speakResponse(finalText);
    } catch (e) {
        appendVoiceActivity('error', 'Connection error', e.message);
        document.getElementById('voiceResponse').textContent = e.message;
    } finally {
        voiceIsProcessing = false;
        voiceWakeDetected = false;
        if (voiceIsListening) {
            setVoiceStatus('listening');
            setVoiceStatusText('Listening for August');
            restartVoice();
        }
    }
}

function speakResponse(text) {
    if (!window.speechSynthesis) return;
    if (text.length < 3 || text === '(no response)') return;

    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.0;
    utterance.pitch = 1.0;
    utterance.volume = 1.0;

    const voices = window.speechSynthesis.getVoices();
    const preferredVoice = voices.find(v => v.name.includes('Google UK Female') || v.name.includes('Samantha') || v.name.includes('Microsoft Zira'));
    if (preferredVoice) utterance.voice = preferredVoice;

    window.speechSynthesis.speak(utterance);
}

document.addEventListener('DOMContentLoaded', () => {
    initVoice();
    if (window.speechSynthesis) {
        window.speechSynthesis.getVoices();
        window.speechSynthesis.onvoiceschanged = () => window.speechSynthesis.getVoices();
    }
    setTimeout(startVoice, 500);
});
