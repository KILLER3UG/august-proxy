/* ── useLogStream — WebSocket subscriber for Settings → Backend Monitor */
/* Connects to /ui/logs/stream, backfills from /api/logs/recent, appends
 * live frames, dedupes by event id, and exposes pause/resume/clear.
 * Reconnects with exponential backoff (1s → 30s). Capped at MAX_EVENTS. */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { atom, onMount } from 'nanostores';
import { useStore } from '@nanostores/react';
import { getRecentLogs, type LogEvent } from '@/api/api-client';
import { whenReady } from '@/api/client';

const MAX_EVENTS = 10_000;
const BACKFILL_LIMIT = 500;

export type StreamStatus = 'connecting' | 'live' | 'disconnected' | 'paused';

interface WSFrame {
    type: 'snapshot' | 'event';
    event?: LogEvent;
    events?: LogEvent[];
}

interface StreamState {
    events: LogEvent[];
    status: StreamStatus;
    lastError: string | null;
    retryInMs: number | null;
}

const streamAtom = atom<StreamState>({
    events: [],
    status: 'connecting',
    lastError: null,
    retryInMs: null,
});

const pausedAtom = atom<boolean>(false);

let _socket: WebSocket | null = null;
let _retryTimer: ReturnType<typeof setTimeout> | null = null;
let _retryDelay = 1000;
let _mountedSubscribers = 0;

function pushEvents(newEvents: LogEvent[]) {
    const prev = streamAtom.get().events;
    const seen = new Set(prev.map((e) => e.id));
    const merged: LogEvent[] = [];
    for (let i = newEvents.length - 1; i >= 0; i--) {
        const e = newEvents[i];
        if (!seen.has(e.id)) {
            seen.add(e.id);
            merged.push(e);
        }
    }
    if (merged.length === 0) return;
    const next = [...merged.reverse(), ...prev].slice(0, MAX_EVENTS);
    streamAtom.set({ ...streamAtom.get(), events: next });
}

function pushEvent(event: LogEvent) {
    const prev = streamAtom.get().events;
    if (prev.some((e) => e.id === event.id)) return;
    streamAtom.set({ ...streamAtom.get(), events: [event, ...prev].slice(0, MAX_EVENTS) });
}

function scheduleRetry() {
    if (_retryTimer) return;
    const delay = _retryDelay;
    streamAtom.set({ ...streamAtom.get(), status: 'disconnected', retryInMs: delay });
    _retryTimer = setTimeout(() => {
        _retryTimer = null;
        _retryDelay = Math.min(_retryDelay * 2, 30_000);
        void connect();
	    }, delay);
	}

	async function connect() {
	    if (_socket && (_socket.readyState === WebSocket.OPEN || _socket.readyState === WebSocket.CONNECTING)) return;
    // Tauri desktop: connect directly to the backend (loopback HTTP → ws).
    // Browser dev: same-origin; Vite proxy handles the WS upgrade.
    let wsUrl: string;
    const baseUrl = await whenReady();
    if (baseUrl) {
        const host = baseUrl.replace(/^https?:\/\//, '');
        wsUrl = `ws://${host}/api/logs/stream`;
    } else {
        const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        wsUrl = `${proto}//${window.location.host}/api/logs/stream`;
    }
    let ws: WebSocket;
    try {
        ws = new WebSocket(wsUrl);
    } catch (err) {
        streamAtom.set({ ...streamAtom.get(), lastError: String(err), status: 'disconnected' });
        scheduleRetry();
        return;
    }
    _socket = ws;
    streamAtom.set({ ...streamAtom.get(), status: 'connecting', lastError: null });

    ws.onopen = async () => {
        _retryDelay = 1000;
        streamAtom.set({ ...streamAtom.get(), status: 'live', retryInMs: null });
        try {
            const backfill = await getRecentLogs(BACKFILL_LIMIT);
            pushEvents(backfill.events || []);
        } catch (e) {
            // Backfill is best-effort; live stream still works
        }
    };
    ws.onmessage = (msg) => {
        if (pausedAtom.get()) return;
        let frame: WSFrame;
        try { frame = JSON.parse(msg.data); } catch { return; }
        if (frame.type === 'snapshot' && Array.isArray(frame.events)) {
            pushEvents(frame.events);
        } else if (frame.type === 'event' && frame.event) {
            pushEvent(frame.event);
        }
    };
    ws.onerror = () => {
        streamAtom.set({ ...streamAtom.get(), lastError: 'WebSocket error' });
    };
    ws.onclose = () => {
        _socket = null;
        if (_mountedSubscribers > 0) scheduleRetry();
        else streamAtom.set({ ...streamAtom.get(), status: 'disconnected', retryInMs: null });
    };
}

function disconnect() {
    if (_retryTimer) { clearTimeout(_retryTimer); _retryTimer = null; }
    if (_socket) {
        const s = _socket;
        _socket = null;
        try { s.close(); } catch { /* ignore */ }
    }
}

export function useLogStream() {
    const state = useStore(streamAtom);
    const paused = useStore(pausedAtom);
    const isMounted = useRef(false);

    useEffect(() => {
        if (isMounted.current) return;
        isMounted.current = true;
        _mountedSubscribers += 1;
        if (!_socket) void connect();
        return () => {
            _mountedSubscribers -= 1;
            if (_mountedSubscribers <= 0) {
                _mountedSubscribers = 0;
                disconnect();
            }
        };
    }, []);

    const pause = useCallback(() => pausedAtom.set(true), []);
    const resume = useCallback(() => pausedAtom.set(false), []);
    const clear = useCallback(() => {
        streamAtom.set({ ...streamAtom.get(), events: [] });
    }, []);

    const status: StreamStatus = paused ? 'paused' : state.status;

    return useMemo(
        () => ({ events: state.events, status, lastError: state.lastError, retryInMs: state.retryInMs, pause, resume, clear }),
        [state.events, status, state.lastError, state.retryInMs, pause, resume, clear],
    );
}

// Mount-once: ensure the atom is hot so first consumer gets a fast render.
// Not required but useful for tests.
onMount(streamAtom, () => () => { /* nothing to clean on unmount */ });