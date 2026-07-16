import { useState, useCallback } from 'react';

export type LiveState =
  | 'idle'
  | 'listening'
  | 'thinking'
  | 'tool-running'
  | 'awaiting-approval'
  | 'speaking';

export interface ToolEvent {
  id: string;
  name: string;
  args: Record<string, unknown>;
  status: 'running' | 'done' | 'error';
  result?: unknown;
}

export interface PendingMutation {
  id: string;
  description: string;
  spokenPrompt?: string;
}

export interface UseLiveSession {
  state: LiveState;
  transcript: string;
  partialTranscript: string;
  toolEvents: ToolEvent[];
  pendingMutations: PendingMutation[];
  isMuted: boolean;
  start: () => void;
  stop: () => void;
  toggleMute: () => void;
  onPartial: (text: string) => void;
  onFinal: (text: string) => void;
  addToolEvent: (event: ToolEvent) => void;
  updateToolEvent: (id: string, patch: Partial<ToolEvent>) => void;
  addPendingMutation: (mutation: PendingMutation) => void;
  approve: (id: string) => void;
  deny: (id: string) => void;
  reset: () => void;
}

export function useLiveSession(): UseLiveSession {
  const [state, setState] = useState<LiveState>('idle');
  const [transcript, setTranscript] = useState('');
  const [partialTranscript, setPartialTranscript] = useState('');
  const [toolEvents, setToolEvents] = useState<ToolEvent[]>([]);
  const [pendingMutations, setPendingMutations] = useState<PendingMutation[]>([]);
  const [isMuted, setIsMuted] = useState(false);

  const start = useCallback(() => setState('listening'), []);
  const stop = useCallback(() => {
    setState('idle');
    setTranscript('');
    setPartialTranscript('');
    setToolEvents([]);
    setPendingMutations([]);
  }, []);
  const toggleMute = useCallback(() => setIsMuted((m) => !m), []);

  const onPartial = useCallback((text: string) => {
    if (state !== 'listening') setState('listening');
    setPartialTranscript(text);
  }, [state]);

  const onFinal = useCallback((text: string) => {
    setTranscript(text);
    setPartialTranscript('');
    setState('thinking');
  }, []);

  const addToolEvent = useCallback((event: ToolEvent) => {
    setToolEvents((prev) => [...prev, event]);
    if (event.status === 'running') setState('tool-running');
  }, []);

  const updateToolEvent = useCallback((id: string, patch: Partial<ToolEvent>) => {
    setToolEvents((prev) =>
      prev.map((e) => (e.id === id ? { ...e, ...patch } : e)),
    );
  }, []);

  const addPendingMutation = useCallback((mutation: PendingMutation) => {
    setPendingMutations((prev) => [...prev, mutation]);
    setState('awaiting-approval');
  }, []);

  const approve = useCallback((id: string) => {
    setPendingMutations((prev) => {
      const next = prev.filter((m) => m.id !== id);
      setState((s) => {
        if (s !== 'awaiting-approval') return s;
        return next.length > 0 ? 'awaiting-approval' : 'thinking';
      });
      return next;
    });
  }, []);

  const deny = useCallback((id: string) => {
    setPendingMutations((prev) => {
      const next = prev.filter((m) => m.id !== id);
      setState((s) => {
        if (s !== 'awaiting-approval') return s;
        return next.length > 0 ? 'awaiting-approval' : 'thinking';
      });
      return next;
    });
  }, []);

  const reset = useCallback(() => stop(), [stop]);

  return {
    state,
    transcript,
    partialTranscript,
    toolEvents,
    pendingMutations,
    isMuted,
    start,
    stop,
    toggleMute,
    onPartial,
    onFinal,
    addToolEvent,
    updateToolEvent,
    addPendingMutation,
    approve,
    deny,
    reset,
  };
}
