// August Immersive Full-Screen Voice Overlay
// Fully continuous wake word "August" listening, voice-first control,
// dynamic states (idle, listening, paused, thinking, speaking),
// action chips (running -> done), voice profiles, and keyboard accessibility.

(function () {
    // ── CONSTANTS & CONFIGS ──
    const WAKE_WORD = 'august';
    const CLOSE_PHRASES = [
        "that's all", "thank you", "thanks", "close", "exit", 
        "go away", "stop listening", "goodbye", "bye", "dismiss", 
        "shut up", "nevermind", "never mind", "i'm done", "done", 
        "quit", "leave", "go to sleep", "sleep"
    ];

    const TOOL_PRESENT_MAP = {
        'read_file': 'Reading file',
        'write_to_file': 'Writing to file',
        'replace_file_content': 'Editing file',
        'multi_replace_file_content': 'Editing file',
        'list_dir': 'Analyzing directory',
        'run_command': 'Running command',
        'search_web': 'Searching the web',
        'read_url_content': 'Reading web page',
        'define_subagent': 'Defining subagent',
        'invoke_subagent': 'Invoking subagent',
        'manage_subagents': 'Managing subagents',
        'manage_task': 'Managing background task',
        'schedule': 'Scheduling timer',
        'ask_permission': 'Asking permission',
        'ask_question': 'Asking a question'
    };

    const TOOL_PAST_MAP = {
        'read_file': 'Read file',
        'write_to_file': 'Wrote to file',
        'replace_file_content': 'Edited file',
        'multi_replace_file_content': 'Edited file',
        'list_dir': 'Analyzed directory',
        'run_command': 'Ran command',
        'search_web': 'Searched the web',
        'read_url_content': 'Read web page',
        'define_subagent': 'Defined subagent',
        'invoke_subagent': 'Invoked subagent',
        'manage_subagents': 'Managed subagents',
        'manage_task': 'Managed background task',
        'schedule': 'Scheduled timer',
        'ask_permission': 'Asked permission',
        'ask_question': 'Asked a question'
    };

    // SVG Mic paths
    const SVG_MIC_PATH = "M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z";
    const SVG_MUTED_PATH = "M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z M3 3l18 18";

    // ── STATE VARIABLES ──
    let overlayOpen = false;
    let voiceRecognition = null;
    let micState = 'idle'; // idle | listening | paused | thinking | speaking
    let isProcessing = false;
    let wakeDetected = false;
    let activeSession = null;
    let currentAssistantText = '';
    let currentAssistantBubble = null;
    let currentAssistantTextContainer = null;
    let activeActionChips = {}; // toolId -> chip element
    let errorTimeout = null;

    // Web Speech Synthesis
    let availableVoices = [];
    let selectedVoiceName = localStorage.getItem('august_voice_preference') || '';

    // DOM Elements
    let overlayEl, closeBtn, chatArea, wakeFlash, micContainer, micBtn, micIconPath, statusLine, voiceDropdown;

    // ── INITIALIZATION ──
    function init() {
        overlayEl = document.getElementById('augustOverlay');
        closeBtn = document.getElementById('augustCloseBtn');
        chatArea = document.getElementById('augustChatArea');
        wakeFlash = document.getElementById('augustWakeFlash');
        micContainer = document.getElementById('augustMicContainer');
        micBtn = document.getElementById('augustMicBtn');
        micIconPath = document.getElementById('augustMicIconPath');
        statusLine = document.getElementById('augustStatusLine');
        voiceDropdown = document.getElementById('augustVoiceDropdown');

        if (!overlayEl || !micBtn) {
            console.error('[VoiceOverlay] Critical DOM elements missing.');
            return;
        }

        // Initialize Speech Recognition
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SpeechRecognition) {
            updateStatusLine("Speech recognition not supported in this browser.");
            micContainer.style.display = 'none';
            return;
        }

        voiceRecognition = new SpeechRecognition();
        voiceRecognition.continuous = true;
        voiceRecognition.interimResults = true;
        voiceRecognition.lang = 'en-US';

        setupRecognitionHandlers();
        setupUIHandlers();
        setupVoiceSynthesis();

        // Start background listening (mic always active)
        startRecognition();
        setMicState('idle');
    }

    // ── STATE MACHINE CONTROL ──
    function setMicState(state) {
        micState = state;
        
        // Remove all states classes from mic button
        micBtn.classList.remove('is-idle', 'is-listening', 'is-paused', 'is-thinking', 'is-speaking');
        micBtn.classList.remove('speech-active');
        
        // Apply state specific configuration
        switch (state) {
            case 'idle':
                micBtn.classList.add('is-idle');
                micContainer.classList.remove('is-overlay');
                micContainer.classList.add('is-mini');
                setMuteIcon(false);
                updateStatusLine("Voice Control Off");
                break;
            case 'listening':
                micBtn.classList.add('is-listening');
                micContainer.classList.remove('is-mini');
                micContainer.classList.add('is-overlay');
                setMuteIcon(false);
                updateStatusLine("Listening…");
                break;
            case 'paused':
                micBtn.classList.add('is-paused');
                micContainer.classList.remove('is-mini');
                micContainer.classList.add('is-overlay');
                setMuteIcon(true);
                updateStatusLine("Paused — tap to resume");
                break;
            case 'thinking':
                micBtn.classList.add('is-thinking');
                micContainer.classList.remove('is-mini');
                micContainer.classList.add('is-overlay');
                setMuteIcon(false);
                updateStatusLine("Processing…");
                break;
            case 'speaking':
                micBtn.classList.add('is-speaking');
                micContainer.classList.remove('is-mini');
                micContainer.classList.add('is-overlay');
                setMuteIcon(false);
                updateStatusLine("Speaking… (Click anywhere to interrupt)");
                break;
        }

        // Control Speech Recognition based on state
        if (state === 'listening' || state === 'idle' || state === 'speaking') {
            startRecognition();
        } else {
            try {
                voiceRecognition.stop();
            } catch (e) {}
        }
    }

    function setMuteIcon(muted) {
        if (micIconPath) {
            micIconPath.setAttribute('d', muted ? SVG_MUTED_PATH : SVG_MIC_PATH);
        }
    }

    function updateStatusLine(text, isError = false) {
        if (statusLine) {
            statusLine.textContent = text;
        }
        if (isError) {
            if (errorTimeout) clearTimeout(errorTimeout);
            errorTimeout = setTimeout(() => {
                if (micState === 'listening') updateStatusLine("Listening…");
                else if (micState === 'paused') updateStatusLine("Paused — tap to resume");
                else if (micState === 'idle') updateStatusLine("Voice Control Off");
            }, 3000);
        }
    }

    // ── SPEECH RECOGNITION HANDLERS ──
    function startRecognition() {
        try {
            voiceRecognition.start();
        } catch (e) {
            // Already running
        }
    }

    function restartRecognitionSilently() {
        if (voiceRecognition) {
            try {
                voiceRecognition.stop();
            } catch (e) {}
            setTimeout(() => {
                startRecognition();
            }, 200);
        }
    }

    function isEcho(transcript, assistantText) {
        if (!transcript) return true;
        if (!assistantText) return false;

        const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
        const normTrans = norm(transcript);
        const normAsst = norm(assistantText);
        
        if (normAsst.includes(normTrans)) return true;
        
        const transWords = transcript.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(Boolean);
        const asstWords = assistantText.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(Boolean);
        
        if (transWords.length === 0) return true;
        
        let matches = 0;
        for (const w of transWords) {
            if (asstWords.includes(w)) {
                matches++;
            }
        }
        const overlapRatio = matches / transWords.length;
        return overlapRatio > 0.7;
    }

    function setupRecognitionHandlers() {
        voiceRecognition.onresult = (event) => {
            let interimTranscript = '';
            let finalTranscript = '';

            for (let i = event.resultIndex; i < event.results.length; ++i) {
                const transcript = event.results[i][0].transcript;
                if (event.results[i].isFinal) {
                    finalTranscript += transcript;
                } else {
                    interimTranscript += transcript;
                }
            }

            const currentSpeech = (finalTranscript || interimTranscript).trim();
            if (!currentSpeech) return;

            // If the assistant is speaking, check if the user is interrupting
            if (micState === 'speaking') {
                if (!isEcho(currentSpeech, currentAssistantText)) {
                    console.log('[VoiceOverlay] User interrupted speaking:', currentSpeech);
                    stopSpeaking();
                    setMicState('listening');
                }
                return;
            }

            // Visual indicator of speech volume/activity
            if (micState === 'listening' && interimTranscript) {
                micBtn.classList.add('speech-active');
            } else {
                micBtn.classList.remove('speech-active');
            }

            // A. Wake word detection when closed or not yet activated
            if (!wakeDetected) {
                const lowerSpeech = currentSpeech.toLowerCase();
                const wakeIndex = lowerSpeech.indexOf(WAKE_WORD);
                if (wakeIndex !== -1) {
                    triggerWakeWordActivation();
                    
                    // Extract any command spoken immediately after the wake word
                    const remainingCommand = currentSpeech.slice(wakeIndex + WAKE_WORD.length).trim().replace(/^[,.:;\s]+/, '');
                    if (remainingCommand) {
                        handleCommand(remainingCommand);
                    }
                }
            } else {
                // B. Already open and listening
                if (finalTranscript) {
                    micBtn.classList.remove('speech-active');
                    handleCommand(finalTranscript.trim());
                } else {
                    // Update the interim user bubble in real-time
                    showUserInterimBubble(interimTranscript);
                }
            }
        };

        voiceRecognition.onerror = (event) => {
            console.warn('[VoiceOverlay] Error:', event.error);
            if (event.error === 'not-allowed') {
                updateStatusLine("Microphone access denied.", true);
                setMicState('idle');
                closeOverlay();
            } else if (event.error === 'no-speech') {
                // Keep listening silently
            } else {
                updateStatusLine("Couldn't hear that — try again", true);
            }
        };

        voiceRecognition.onend = () => {
            // Re-activate continuous background listening
            if (micState === 'listening' || micState === 'idle' || micState === 'speaking') {
                startRecognition();
            }
        };
    }

    function triggerWakeWordActivation() {
        wakeDetected = true;
        
        // Play wake beep
        playWakeNotification();

        // Trigger Wake label Flash
        if (wakeFlash) {
            wakeFlash.classList.remove('flash-active');
            void wakeFlash.offsetWidth; // Trigger reflow
            wakeFlash.classList.add('flash-active');
        }

        // Open Overlay and switch to listening
        openOverlay();
    }

    function playWakeNotification() {
        if (window.AudioContext || window.webkitAudioContext) {
            try {
                const AudioCtx = window.AudioContext || window.webkitAudioContext;
                const ctx = new AudioCtx();
                
                // Play double high beep
                const playBeep = (freq, duration, delay) => {
                    setTimeout(() => {
                        const osc = ctx.createOscillator();
                        const gain = ctx.createGain();
                        osc.connect(gain);
                        gain.connect(ctx.destination);
                        osc.frequency.setValueAtTime(freq, ctx.currentTime);
                        gain.gain.setValueAtTime(0.08, ctx.currentTime);
                        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
                        osc.start();
                        osc.stop(ctx.currentTime + duration);
                    }, delay);
                };

                playBeep(880, 0.08, 0);
                playBeep(1108, 0.08, 90);
            } catch (e) {
                // Ignore audio ctx failures
            }
        }
    }

    // ── CLOSE TRIGGERS & ACTIONS ──
    function setupUIHandlers() {
        // Close Button click
        if (closeBtn) {
            closeBtn.onclick = () => {
                closeOverlay();
            };
        }

        // Mic Button click (controls overlay/mic state machine)
        if (micBtn) {
            micBtn.onclick = () => {
                handleMicClick();
            };
        }

        // Click anywhere on overlay to interrupt speaking
        if (overlayEl) {
            overlayEl.onclick = (e) => {
                // Ignore clicks on control elements so they handle their own actions
                if (e.target.closest('#augustCloseBtn') || e.target.closest('#augustMicBtn') || e.target.closest('#augustVoiceDropdown')) {
                    return;
                }
                if (micState === 'speaking') {
                    stopSpeaking();
                    setMicState('listening');
                }
            };
        }

        // Keyboard triggers
        window.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                if (overlayOpen) {
                    closeOverlay();
                }
            } else if (micState === 'speaking') {
                // Any key interrupts speaking and returns to listening
                stopSpeaking();
                setMicState('listening');
                e.preventDefault();
            }
        });
    }

    function handleMicClick() {
        if (micState === 'idle') {
            // Wake word-like manual trigger
            triggerWakeWordActivation();
        } else if (micState === 'listening') {
            // Pause
            setMicState('paused');
            try { voiceRecognition.stop(); } catch(e) {}
        } else if (micState === 'paused') {
            // Resume
            setMicState('listening');
            startRecognition();
        } else if (micState === 'speaking') {
            // Interrupt speech synthesis
            stopSpeaking();
            setMicState('listening');
            startRecognition();
        }
    }

    function openOverlay() {
        if (overlayOpen) return;
        overlayOpen = true;
        
        overlayEl.classList.remove('is-closing');
        overlayEl.classList.add('is-open');
        overlayEl.setAttribute('aria-hidden', 'false');

        // Transition Mic to overlay mode
        setMicState('listening');
        
        // Add greeting message if chat area is empty
        if (chatArea.children.length === 0) {
            addAssistantMessage("August is listening. What can I do for you?");
        }
    }

    function closeOverlay() {
        if (!overlayOpen) return;
        overlayOpen = false;

        overlayEl.classList.remove('is-open');
        overlayEl.classList.add('is-closing');
        overlayEl.setAttribute('aria-hidden', 'true');

        // Stop speaking if active
        stopSpeaking();

        // Reset mic state
        wakeDetected = false;
        setMicState('idle');
        startRecognition();
    }

    // Parse commands for close phrases or voice changes
    function parseLocalCommand(text) {
        const cleaned = text.toLowerCase().trim().replace(/[.,/#!$%^&*;:{}=\-_`~()]/g,"");
        
        // 1. Close overlay commands
        if (CLOSE_PHRASES.includes(cleaned)) {
            addSystemMessage("Goodbye");
            setTimeout(() => {
                closeOverlay();
            }, 800);
            return true;
        }

        // 2. Change voice command parsing
        if (cleaned.includes("change voice") || cleaned.includes("use voice") || cleaned.includes("switch voice") || cleaned.includes("different voice")) {
            // Try to match voice names
            const voiceMatch = availableVoices.find(v => {
                const name = v.name.toLowerCase();
                return cleaned.includes(name) || 
                       (name.includes('google') && cleaned.includes('google')) ||
                       (name.includes('david') && cleaned.includes('david')) ||
                       (name.includes('zira') && cleaned.includes('zira')) ||
                       (name.includes('samantha') && cleaned.includes('samantha')) ||
                       (name.includes('hazel') && cleaned.includes('hazel'));
            });

            if (voiceMatch) {
                selectVoiceByName(voiceMatch.name);
                addAssistantMessage(`Voice updated. I will now speak using ${voiceMatch.name}.`);
                speakResponse(`Voice updated. I will now speak using ${voiceMatch.name}.`);
                return true;
            } else if (cleaned.includes("male") || cleaned.includes("guy") || cleaned.includes("man")) {
                const maleVoice = availableVoices.find(v => v.name.toLowerCase().includes('male') || v.name.toLowerCase().includes('david') || v.name.toLowerCase().includes('microsoft david'));
                if (maleVoice) {
                    selectVoiceByName(maleVoice.name);
                    addAssistantMessage(`Voice updated. Selected ${maleVoice.name}.`);
                    speakResponse(`Voice updated.`);
                    return true;
                }
            } else if (cleaned.includes("female") || cleaned.includes("girl") || cleaned.includes("woman")) {
                const femaleVoice = availableVoices.find(v => v.name.toLowerCase().includes('female') || v.name.toLowerCase().includes('zira') || v.name.toLowerCase().includes('samantha'));
                if (femaleVoice) {
                    selectVoiceByName(femaleVoice.name);
                    addAssistantMessage(`Voice updated. Selected ${femaleVoice.name}.`);
                    speakResponse(`Voice updated.`);
                    return true;
                }
            }

            // General voice cycling
            if (availableVoices.length > 1) {
                const curIdx = availableVoices.findIndex(v => v.name === selectedVoiceName);
                const nextIdx = (curIdx + 1) % availableVoices.length;
                const nextVoice = availableVoices[nextIdx];
                selectVoiceByName(nextVoice.name);
                addAssistantMessage(`Voice changed to ${nextVoice.name}.`);
                speakResponse(`Voice changed.`);
                return true;
            }
        }

        return false;
    }

    // ── COMMAND SUBMISSION & PROXY SSE STREAM ──
    async function handleCommand(text) {
        if (!text || isProcessing) return;

        // Strip wake word if present in command text
        let commandText = text;
        const lower = text.toLowerCase();
        if (lower.startsWith(WAKE_WORD)) {
            commandText = text.slice(WAKE_WORD.length).trim().replace(/^[,.:;\s]+/, '');
        }

        if (!commandText) return;

        // Clear interim bubbles and create permanent user message bubble
        clearInterimBubbles();
        addUserMessage(commandText);
        
        // Mirror to main Dashboard console if layout has renderWorkbenchMessage
        if (typeof renderWorkbenchMessage === 'function') {
            renderWorkbenchMessage('user', `Voice: ${commandText}`, null, { typing: false });
        }

        // Check if command is fully resolved locally (e.g. close, change voice)
        if (parseLocalCommand(commandText)) {
            return;
        }

        // Dispatch command to proxy
        isProcessing = true;
        setMicState('thinking');
        currentAssistantText = '';
        currentAssistantBubble = createAssistantStreamBubble();

        try {
            const session = await ensureVoiceSession();
            const provider = document.getElementById('workbenchProvider')?.value || session.provider || 'claude';
            const agentId = document.getElementById('workbenchAgent')?.value || session.agentId || 'build';
            
            const res = await fetch('/ui/workbench/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    sessionId: session.id,
                    provider,
                    agentId,
                    message: commandText
                })
            });

            if (!res.ok) {
                const errText = await res.text();
                let errMsg = errText || 'Request failed';
                try { errMsg = JSON.parse(errText).error || errMsg; } catch (e) {}
                throw new Error(errMsg);
            }

            await readSSEStream(res.body.getReader());
            
            // On completion, speak response
            const finalText = currentAssistantText || '(no response)';
            setMicState('speaking');
            speakResponse(finalText);

        } catch (e) {
            updateStatusLine("Connection error", true);
            addErrorMessage(e.message || "Network error occurred.");
            setMicState('listening');
        } finally {
            isProcessing = false;
            // State is returned to listening after speaking finishes, or right away if no speech output
            if (micState === 'thinking') {
                setMicState('listening');
            }
        }
    }

    async function ensureVoiceSession() {
        if (typeof ensureWorkbenchSession === 'function') {
            activeSession = await ensureWorkbenchSession();
            return activeSession;
        }
        if (activeSession?.id) return activeSession;
        const res = await fetch('/ui/workbench/session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ provider: 'claude', agentId: 'build' })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Could not create session');
        activeSession = data;
        return activeSession;
    }

    async function readSSEStream(reader) {
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
                    handleSSEEvent(eventName, parsed);
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
            handleSSEEvent(eventName, parsed);
        }
    }

    function handleSSEEvent(event, data) {
        if (event === 'thinking') {
            setMicState('thinking');
            return;
        }
        if (event === 'tool_use') {
            const toolId = data?.id;
            const toolName = data?.name;
            const input = data?.input;
            
            // Build visual chip in stream
            addActionChip(toolId, toolName, input);
            
            if (typeof renderToolLine === 'function') {
                renderToolLine(toolId, toolName, input);
            }
            return;
        }
        if (event === 'tool_result') {
            const toolId = data?.id;
            const isError = data?.is_error;
            
            // Complete visual chip
            resolveActionChip(toolId, isError);

            if (typeof updateToolLine === 'function') {
                updateToolLine(toolId, data?.content, isError);
            }
            return;
        }
        if (event === 'text') {
            const content = data?.content || '';
            streamAssistantText(content);

            // Mirror to console
            if (typeof renderWorkbenchMessage === 'function') {
                renderWorkbenchMessage('assistant', content);
            }
            return;
        }
        if (event === 'session') {
            if (data) {
                activeSession = data;
                try {
                    workbenchSession = data;
                    if (typeof renderWorkbenchPlan === 'function') renderWorkbenchPlan();
                    if (typeof renderWorkbenchGoal === 'function') renderWorkbenchGoal();
                    if (typeof renderWorkbenchTodos === 'function') renderWorkbenchTodos(data);
                } catch (e) {}
            }
            return;
        }
        if (event === 'error') {
            addErrorMessage(data?.message || 'Unknown error');
        }
    }

    // ── CHAT BUBBLE RENDERING ──
    function clearInterimBubbles() {
        const interims = chatArea.querySelectorAll('.is-interim');
        interims.forEach(el => el.remove());
    }

    function addUserMessage(text) {
        const bubble = document.createElement('div');
        bubble.className = 'august-msg is-user';
        bubble.innerHTML = `
            <div class="august-msg-label">You</div>
            <div class="august-msg-content">${escapeHTML(text)}</div>
        `;
        chatArea.appendChild(bubble);
        scrollToBottom();
    }

    function showUserInterimBubble(text) {
        clearInterimBubbles();
        const bubble = document.createElement('div');
        bubble.className = 'august-msg is-user is-interim';
        bubble.innerHTML = `
            <div class="august-msg-label">You</div>
            <div class="august-msg-content">${escapeHTML(text)}</div>
        `;
        chatArea.appendChild(bubble);
        scrollToBottom();
    }

    function addAssistantMessage(text) {
        const bubble = document.createElement('div');
        bubble.className = 'august-msg is-assistant';
        bubble.innerHTML = `
            <div class="august-msg-label">August</div>
            <div class="august-msg-content">${escapeHTML(text)}</div>
        `;
        chatArea.appendChild(bubble);
        scrollToBottom();
    }

    function createAssistantStreamBubble() {
        const bubble = document.createElement('div');
        bubble.className = 'august-msg is-assistant';
        bubble.innerHTML = `
            <div class="august-msg-label">August</div>
            <div class="august-action-chips-container"></div>
            <div class="august-msg-content">
                <span class="august-stream-text"></span>
                <span class="august-cursor"></span>
            </div>
        `;
        chatArea.appendChild(bubble);
        currentAssistantTextContainer = bubble.querySelector('.august-stream-text');
        scrollToBottom();
        return bubble;
    }

    function streamAssistantText(chunk) {
        if (!currentAssistantTextContainer) return;
        currentAssistantText += chunk;
        currentAssistantTextContainer.textContent = currentAssistantText;
        scrollToBottom();
    }

    function addSystemMessage(text) {
        const bubble = document.createElement('div');
        bubble.className = 'august-msg';
        bubble.style.alignItems = 'center';
        bubble.style.alignSelf = 'center';
        bubble.innerHTML = `
            <div class="august-msg-content" style="background: rgba(255,255,255,0.02); border-radius: 12px; color: var(--august-text-muted); font-size: 13px; padding: 6px 12px;">
                ${escapeHTML(text)}
            </div>
        `;
        chatArea.appendChild(bubble);
        scrollToBottom();
    }

    function addErrorMessage(text) {
        const bubble = document.createElement('div');
        bubble.className = 'august-msg';
        bubble.style.alignItems = 'center';
        bubble.style.alignSelf = 'center';
        bubble.innerHTML = `
            <div class="august-msg-content" style="background: rgba(239, 68, 68, 0.1); border: 1px solid rgba(239, 68, 68, 0.2); border-radius: 12px; color: #ef4444; font-size: 13px; padding: 6px 12px;">
                ${escapeHTML(text)}
            </div>
        `;
        chatArea.appendChild(bubble);
        scrollToBottom();
    }

    function addActionChip(toolId, toolName, input) {
        if (!currentAssistantBubble || !toolId) return;
        const container = currentAssistantBubble.querySelector('.august-action-chips-container');
        if (!container) return;

        const displayName = TOOL_PRESENT_MAP[toolName] || `Running ${toolName}`;
        
        const chip = document.createElement('div');
        chip.className = 'august-action-chip';
        chip.id = `chip-${toolId}`;
        chip.innerHTML = `
            <div class="august-chip-spinner">
                <span></span>
                <span></span>
                <span></span>
            </div>
            <span class="august-chip-check">✓</span>
            <span class="august-chip-label">${escapeHTML(displayName)}</span>
        `;
        container.appendChild(chip);
        activeActionChips[toolId] = {
            el: chip,
            toolName: toolName
        };
        scrollToBottom();
    }

    function resolveActionChip(toolId, isError) {
        const chipData = activeActionChips[toolId];
        if (!chipData) return;
        
        const chip = chipData.el;
        const toolName = chipData.toolName;
        const pastName = TOOL_PAST_MAP[toolName] || `Finished ${toolName}`;

        chip.classList.add('is-done');
        const check = chip.querySelector('.august-chip-check');
        const label = chip.querySelector('.august-chip-label');

        if (isError) {
            if (check) {
                check.textContent = '✗';
                check.style.color = '#ef4444';
            }
            if (label) label.textContent = `Failed ${toolName}`;
        } else {
            if (check) check.style.color = '#4ade80';
            if (label) label.textContent = pastName;
        }

        delete activeActionChips[toolId];
    }

    function scrollToBottom() {
        chatArea.scrollTop = chatArea.scrollHeight;
    }

    function escapeHTML(str) {
        return str.replace(/[&<>'"]/g, 
            tag => ({
                '&': '&amp;',
                '<': '&lt;',
                '>': '&gt;',
                "'": '&#39;',
                '"': '&quot;'
            }[tag] || tag)
        );
    }

    // ── TEXT TO SPEECH (TTS) & VOICE SYNTHESIS ──
    function setupVoiceSynthesis() {
        if (!window.speechSynthesis) return;

        // Load voices initially
        loadVoices();
        if (window.speechSynthesis.onvoiceschanged !== undefined) {
            window.speechSynthesis.onvoiceschanged = loadVoices;
        }

        // Listener for voice picker changes
        if (voiceDropdown) {
            voiceDropdown.onchange = (e) => {
                selectVoiceByName(e.target.value);
            };
        }
    }

    function loadVoices() {
        if (!window.speechSynthesis) return;
        
        availableVoices = window.speechSynthesis.getVoices();
        
        if (!voiceDropdown) return;
        voiceDropdown.innerHTML = '';

        // Prioritize specific high-quality engines
        availableVoices.sort((a, b) => {
            const score = (v) => {
                let s = 0;
                const name = v.name.toLowerCase();
                if (name.includes('google')) s += 10;
                if (name.includes('natural')) s += 20;
                if (name.includes('en-us') || name.includes('en-gb')) s += 5;
                return s;
            };
            return score(b) - score(a);
        });

        // Add options
        availableVoices.forEach(voice => {
            if (!voice.lang.startsWith('en')) return; // Filter English only for better results
            const option = document.createElement('option');
            option.value = voice.name;
            option.textContent = `${voice.name} (${voice.lang})`;
            if (voice.name === selectedVoiceName) {
                option.selected = true;
            }
            voiceDropdown.appendChild(option);
        });

        // Default auto selection if nothing matches saved preference
        if (!selectedVoiceName && availableVoices.length > 0) {
            const defaultVoice = availableVoices.find(v => v.lang.startsWith('en')) || availableVoices[0];
            if (defaultVoice) {
                selectVoiceByName(defaultVoice.name);
            }
        }
    }

    function selectVoiceByName(name) {
        selectedVoiceName = name;
        localStorage.setItem('august_voice_preference', name);
        if (voiceDropdown) {
            voiceDropdown.value = name;
        }
        console.log(`[VoiceOverlay] Voice profile set to: ${name}`);
    }

    function speakResponse(text) {
        if (!window.speechSynthesis) return;
        if (!text || text === '(no response)' || text.length < 2) {
            setMicState('listening');
            return;
        }

        stopSpeaking(); // Cancel any existing speech
        
        // Clean text of markdown syntax for speech synthesis
        const cleanText = text.replace(/[*#`_\-]/g, '').trim();

        const utterance = new SpeechSynthesisUtterance(cleanText);
        utterance.rate = 1.05;
        utterance.pitch = 1.0;
        utterance.volume = 1.0;

        const voiceObj = availableVoices.find(v => v.name === selectedVoiceName);
        if (voiceObj) {
            utterance.voice = voiceObj;
        }

        utterance.onend = () => {
            // Hide streaming blinking cursor once completed
            if (currentAssistantBubble) {
                const cursor = currentAssistantBubble.querySelector('.august-cursor');
                if (cursor) cursor.style.display = 'none';
            }
            setMicState('listening');
            startRecognition();
        };

        utterance.onerror = (e) => {
            console.warn('[VoiceOverlay] TTS Error:', e.error);
            setMicState('listening');
            startRecognition();
        };

        window.speechSynthesis.speak(utterance);
    }

    function stopSpeaking() {
        if (window.speechSynthesis) {
            window.speechSynthesis.cancel();
        }
    }

    // Initialize on page load
    document.addEventListener('DOMContentLoaded', () => {
        init();
    });

})();
