/* ── useLogStream — WebSocket subscriber for Settings → Backend Monitor */
/* Connects to /ui/logs/stream, backfills from /api/logs/recent, appends
 * live frames, dedupes by event id, and exposes pause/resume/clear.
 * Reconnects with exponential backoff (1s → 30s). Capped at MAX_EVENTS. */

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { create } from 'zustand';
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

interface LogStreamStoreState {
    stream: StreamState;
    paused: boolean;
}

const initialStream: StreamState = {
    events: [],
    status: 'connecting',
    lastError: null,
    retryInMs: null,
};

export const useLogStreamStore = create<LogStreamStoreState>(() => ({
    stream: { ...initialStream },
    paused: false,
}));

let _socket: WebSocket | null = null;
let _retryTimer: ReturnType<typeof setTimeout> | null = null;
let _retryDelay = 1000;
let _mountedSubscribers = 0;

function pushEvents(newEvents: LogEvent[]) {
    const prev = useLogStreamStore.getState().stream.events;
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
    const stream = useLogStreamStore.getState().stream;
    useLogStreamStore.setState({ stream: { ...stream, events: next } });
}

function pushEvent(event: LogEvent) {
    const prev = useLogStreamStore.getState().stream.events;
    if (prev.some((e) => e.id === event.id)) return;
    const stream = useLogStreamStore.getState().stream;
    useLogStreamStore.setState({
        stream: { ...stream, events: [event, ...prev].slice(0, MAX_EVENTS) },
    });
}

function scheduleRetry() {
    if (_retryTimer) return;
    const delay = _retryDelay;
    const stream = useLogStreamStore.getState().stream;
    useLogStreamStore.setState({
        stream: { ...stream, status: 'disconnected', retryInMs: delay },
    });
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
        const stream = useLogStreamStore.getState().stream;
        useLogStreamStore.setState({
            stream: { ...stream, lastError: String(err), status: 'disconnected' },
        });
        scheduleRetry();
        return;
    }
    _socket = ws;
    {
        const stream = useLogStreamStore.getState().stream;
        useLogStreamStore.setState({
            stream: { ...stream, status: 'connecting', lastError: null },
        });
    }

    ws.onopen = async () => {
        _retryDelay = 1000;
        const stream = useLogStreamStore.getState().stream;
        useLogStreamStore.setState({
            stream: { ...stream, status: 'live', retryInMs: null },
        });
        try {
            const backfill = await getRecentLogs(BACKFILL_LIMIT);
            pushEvents(backfill.events || []);
        } catch (_e) {
            // Backfill is best-effort; live stream still works
        }
    };
    ws.onmessage = (msg) => {
        if (useLogStreamStore.getState().paused) return;
        let frame: WSFrame;
        try { frame = JSON.parse(msg.data); } catch { return; }
        if (frame.type === 'snapshot' && Array.isArray(frame.events)) {
            pushEvents(frame.events);
        } else if (frame.type === 'event' && frame.event) {
            pushEvent(frame.event);
        }
    };
    ws.onerror = () => {
        const stream = useLogStreamStore.getState().stream;
        useLogStreamStore.setState({
            stream: { ...stream, lastError: 'WebSocket error' },
        });
    };
    ws.onclose = () => {
        _socket = null;
        if (_mountedSubscribers > 0) scheduleRetry();
        else {
            const stream = useLogStreamStore.getState().stream;
            useLogStreamStore.setState({
                stream: { ...stream, status: 'disconnected', retryInMs: null },
            });
        }
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
    const stream = useLogStreamStore((s) => s.stream);
    const paused = useLogStreamStore((s) => s.paused);
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

    const pause = useCallback(() => useLogStreamStore.setState({ paused: true }), []);
    const resume = useCallback(() => useLogStreamStore.setState({ paused: false }), []);
    const clear = useCallback(() => {
        const current = useLogStreamStore.getState().stream;
        useLogStreamStore.setState({ stream: { ...current, events: [] } });
    }, []);

    const status: StreamStatus = paused ? 'paused' : stream.status;

    return useMemo(
        () => ({ events: stream.events, status, lastError: stream.lastError, retryInMs: stream.retryInMs, pause, resume, clear }),
        [stream.events, status, stream.lastError, stream.retryInMs, pause, resume, clear],
    );
}
