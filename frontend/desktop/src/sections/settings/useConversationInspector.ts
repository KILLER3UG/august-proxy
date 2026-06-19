/* ── useConversationInspector — shared data layer for the merged
 *   Conversation Inspector section ──────────────────────────────────
 * The old Inspector/Conversations/Thinking components each fetched their
 * own slice of /ui/details + /ui/conversations independently — and the old
 * Inspector also issued an extra /ui/detail/:reqId call when a row was
 * selected, even though the same data was already in the list response.
 *
 * This hook fetches /ui/details + /ui/conversations once for the chosen
 * period, exposes the unified row list, the selected request, a normalized
 * transcript for the Readable tab, and an extracted thinking-traces list
 * for the Thinking tab. The three old sub-sections now read from one
 * poll cycle and share a single selected-request state. */

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  getRequestDetails,
  getConversations,
  type RequestDetailEntry,
  type ConversationsResponse,
  type Period,
  type RequestEntry,
} from '@/api/backend-ui';

export interface MessageItem {
  role: string;
  content: string;
}

export interface ConversationItem {
  reqId: string;
  clientType: string;
  model: string;
  status: string;
  date?: string;
  messages: MessageItem[];
  response?: unknown;
  finishReason?: string | null;
  error?: string | null;
}

export interface ThinkingTrace {
  reqId: string;
  date?: string;
  thinking: string;
  finishReason?: string | null;
}

export interface InspectorRow {
  reqId: string;
  clientType: string;
  model: string;
  status: string;
  date?: string;
  requestType?: string;
  /** True if the captured detail includes any non-empty thinking trace. */
  hasThinking: boolean;
  /** True if the detail is in an error state. */
  isError: boolean;
}

function toMessages(raw: unknown): MessageItem[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((m: any) => {
      const role = m?.role || 'unknown';
      let content = '';
      if (typeof m?.content === 'string') content = m.content;
      else if (Array.isArray(m?.content)) {
        content = m.content
          .map((b: any) => (typeof b === 'string' ? b : b?.text || b?.content || b?.type || ''))
          .filter(Boolean)
          .join('\n');
      } else if (m?.content && typeof m.content === 'object') {
        content = String(m.content.text || m.content.content || '');
      }
      return { role, content };
    })
    .filter((m) => m.content);
}

function normalizeConversations(grouped: ConversationsResponse | undefined): ConversationItem[] {
  const items: ConversationItem[] = [];
  for (const [clientType, entries] of Object.entries(grouped || {})) {
    for (const e of entries as Array<RequestEntry & {
      details: { messages: unknown; response: unknown; finishReason?: string | null; error?: string | null } | null;
    }>) {
      items.push({
        reqId: e.reqId,
        clientType,
        model: e.model || 'unknown',
        status: e.status || 'unknown',
        date: e.date,
        messages: toMessages(e.details?.messages),
        response: e.details?.response,
        finishReason: e.details?.finishReason,
        error: e.details?.error,
      });
    }
  }
  return items.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}

function stringifyThinking(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  try {
    if (Array.isArray(v)) {
      // Anthropic thinking blocks: [{ type: 'thinking', thinking: '...' }]
      return v
        .map((b: any) => (typeof b === 'string' ? b : b?.thinking || b?.text || ''))
        .filter(Boolean)
        .join('\n');
    }
    if (typeof v === 'object') {
      const o = v as Record<string, unknown>;
      return String(o.thinking || o.text || o.content || '');
    }
  } catch { /* ignore */ }
  return String(v);
}

function extractTraces(details: RequestDetailEntry[] | undefined): ThinkingTrace[] {
  if (!details) return [];
  const traces: ThinkingTrace[] = [];
  for (const d of details) {
    const text = stringifyThinking(d.thinking);
    if (!text || !text.trim()) continue;
    traces.push({ reqId: d.reqId, date: d.date, thinking: text, finishReason: d.finishReason });
  }
  return traces;
}

/** Safe JSON pretty-printer that never throws and pretty-prints JSON strings. */
function safeStringify(v: unknown): string {
  if (v == null || v === '') return '';
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v);
      return JSON.stringify(parsed, null, 2);
    } catch {
      return v;
    }
  }
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

export function useConversationInspector(period: Period) {
  const detailsQuery = useQuery({
    queryKey: ['ci-details', period],
    queryFn: () => getRequestDetails(period),
    refetchInterval: 3_000,
  });
  const conversationsQuery = useQuery({
    queryKey: ['ci-conversations', period],
    queryFn: () => getConversations(period),
    refetchInterval: 5_000,
  });

  const details = detailsQuery.data ?? [];
  const conversations = useMemo(() => normalizeConversations(conversationsQuery.data), [conversationsQuery.data]);
  const thinking = useMemo(() => extractTraces(details), [details]);

  /** Unified row list: every request that has either detail or a transcript. */
  const rows = useMemo<InspectorRow[]>(() => {
    const byReq = new Map<string, InspectorRow>();
    for (const d of details) {
      byReq.set(d.reqId, {
        reqId: d.reqId,
        clientType: 'unknown',
        model: 'unknown',
        status: d.status || 'unknown',
        date: d.date,
        requestType: d.requestType,
        hasThinking: !!stringifyThinking(d.thinking).trim(),
        isError: d.status === 'error' || !!d.error,
      });
    }
    for (const c of conversations) {
      const existing = byReq.get(c.reqId);
      if (existing) {
        existing.clientType = c.clientType;
        existing.model = c.model;
      } else {
        byReq.set(c.reqId, {
          reqId: c.reqId,
          clientType: c.clientType,
          model: c.model,
          status: c.status,
          date: c.date,
          hasThinking: false,
          isError: c.status === 'error' || !!c.error,
        });
      }
    }
    return Array.from(byReq.values()).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  }, [details, conversations]);

  return {
    rows,
    details,
    conversations,
    thinking,
    isLoading: detailsQuery.isLoading && conversationsQuery.isLoading,
    /** Find the selected detail, conversation, and trace by reqId. */
    select: (reqId: string | null) => {
      const detail = reqId ? details.find((d) => d.reqId === reqId) ?? null : null;
      const conversation = reqId ? conversations.find((c) => c.reqId === reqId) ?? null : null;
      const trace = reqId ? thinking.find((t) => t.reqId === reqId) ?? null : null;
      return { detail, conversation, trace };
    },
    safeStringify,
  };
}
