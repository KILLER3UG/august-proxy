export type ChatTransport = 'ws' | 'http' | 'none';
export type ChatTurnStatus = 'pending' | 'streaming' | 'done' | 'error' | 'aborted';

export interface ChatTurnRecord {
  turnId: string;
  sessionId: string | null;
  assistantMsgId: string;
  requestId?: string;
  controller: AbortController;
  transport: ChatTransport;
  status: ChatTurnStatus;
  startedAt: number;
  updatedAt: number;
}

export interface StartTurnInput {
  sessionId: string | null;
  assistantMsgId: string;
  transport?: ChatTransport;
}

export interface ChatRuntimeSnapshot {
  activeTurns: ChatTurnRecord[];
  activeTurnIdsBySession: Record<string, string[]>;
}

type RuntimeSubscriber = () => void;

export interface ChatRuntime {
  canStartTurn(sessionId: string | null): boolean;
  startTurn(input: StartTurnInput): ChatTurnRecord;
  getTurn(turnId: string): ChatTurnRecord | null;
  setRequestId(turnId: string, requestId: string): void;
  setTransport(turnId: string, transport: ChatTransport): void;
  finishTurn(turnId: string, status?: ChatTurnStatus): void;
  abortTurn(turnId: string): void;
  abortSession(sessionId: string | null): void;
  isSessionStreaming(sessionId: string | null): boolean;
  getActiveTurn(sessionId: string | null): ChatTurnRecord | null;
  getLatestActiveTurnId(sessionId: string | null): string | null;
  subscribe(callback: RuntimeSubscriber): () => void;
  snapshot(): ChatRuntimeSnapshot;
}

const GLOBAL_SESSION_KEY = '__global__';

function sessionKey(sessionId: string | null) {
  return sessionId ?? GLOBAL_SESSION_KEY;
}

export function getActiveSessionIds(snapshot: ChatRuntimeSnapshot = chatRuntime.snapshot()) {
  return Array.from(new Set(snapshot.activeTurns.map((turn) => turn.sessionId).filter(Boolean) as string[]));
}

export function subscribeActiveSessions(callback: (sessionIds: string[]) => void) {
  const sync = () => callback(getActiveSessionIds(chatRuntime.snapshot()));
  sync();
  return chatRuntime.subscribe(sync);
}

export function createChatRuntime(): ChatRuntime {
  const turns = new Map<string, ChatTurnRecord>();
  const turnIdsBySession = new Map<string, string[]>();
  const subscribers = new Set<RuntimeSubscriber>();

  const notify = () => {
    Array.from(subscribers).forEach((subscriber) => subscriber());
  };

  const reindexSession = (sessionId: string | null) => {
    turnIdsBySession.set(
      sessionKey(sessionId),
      Array.from(turns.values())
        .filter((turn) => turn.sessionId === sessionId && turn.status === 'streaming')
        .map((turn) => turn.turnId)
    );
  };

  const runtime: ChatRuntime = {
    canStartTurn(sessionId) {
      const activeIds = turnIdsBySession.get(sessionKey(sessionId)) ?? [];
      return !activeIds.some((id) => turns.get(id)?.status === 'streaming');
    },

    startTurn(input) {
      const existing = this.getActiveTurn(input.sessionId);
      if (existing) return existing;

      const controller = new AbortController();
      const now = Date.now();
      const turnId = `${input.sessionId ?? 'global'}:${input.assistantMsgId}:${now}:${Math.random().toString(36).slice(2)}`;
      const turn: ChatTurnRecord = {
        turnId,
        sessionId: input.sessionId,
        assistantMsgId: input.assistantMsgId,
        controller,
        transport: input.transport ?? 'none',
        status: 'streaming',
        startedAt: now,
        updatedAt: now,
      };

      turns.set(turnId, turn);
      const sessionTurns = turnIdsBySession.get(sessionKey(input.sessionId)) ?? [];
      sessionTurns.push(turnId);
      turnIdsBySession.set(sessionKey(input.sessionId), sessionTurns);
      notify();
      return turn;
    },

    getTurn(turnId) {
      return turns.get(turnId) ?? null;
    },

    setRequestId(turnId, requestId) {
      const turn = turns.get(turnId);
      if (!turn) return;
      turn.requestId = requestId;
      turn.updatedAt = Date.now();
      notify();
    },

    setTransport(turnId, transport) {
      const turn = turns.get(turnId);
      if (!turn) return;
      turn.transport = transport;
      turn.updatedAt = Date.now();
      notify();
    },

    finishTurn(turnId, status = 'done') {
      const turn = turns.get(turnId);
      if (!turn) return;
      turn.status = status;
      turn.updatedAt = Date.now();
      reindexSession(turn.sessionId);
      notify();
    },

    abortTurn(turnId) {
      const turn = turns.get(turnId);
      if (!turn) return;
      turn.controller.abort();
      turn.status = 'aborted';
      turn.updatedAt = Date.now();
      reindexSession(turn.sessionId);
      notify();
    },

    abortSession(sessionId) {
      for (const turn of Array.from(turns.values())) {
        if (turn.sessionId === sessionId && turn.status === 'streaming') {
          turn.controller.abort();
          turn.status = 'aborted';
          turn.updatedAt = Date.now();
        }
      }
      reindexSession(sessionId);
      notify();
    },

    isSessionStreaming(sessionId) {
      const activeIds = turnIdsBySession.get(sessionKey(sessionId)) ?? [];
      return activeIds.some((id) => turns.get(id)?.status === 'streaming');
    },

    getActiveTurn(sessionId) {
      const activeIds = turnIdsBySession.get(sessionKey(sessionId)) ?? [];
      return activeIds.map((id) => turns.get(id)).find((turn): turn is ChatTurnRecord => !!turn && turn.status === 'streaming') ?? null;
    },

    getLatestActiveTurnId(sessionId) {
      const activeIds = turnIdsBySession.get(sessionKey(sessionId)) ?? [];
      return activeIds.length > 0 ? activeIds[activeIds.length - 1] : null;
    },

    subscribe(callback) {
      subscribers.add(callback);
      return () => subscribers.delete(callback);
    },

    snapshot() {
      return {
        activeTurns: Array.from(turns.values()).filter((turn) => turn.status === 'streaming'),
        activeTurnIdsBySession: Object.fromEntries(Array.from(turnIdsBySession.entries()) as [string, string[]][]),
      };
    },
  };

  return runtime;
}

export const chatRuntime = createChatRuntime();
