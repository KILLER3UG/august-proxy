/* ── Conversation Inspector — deeply consolidated debug surface ────── */
/* Replaces the 3 old top-level sections (Inspector, Conversations,
 * Thinking) with one section that:
 *   • owns a single selected-request state, so all three subtabs show
 *     the same request when you click a row
 *   • fetches /ui/details + /ui/conversations once (via
 *     useConversationInspector) — not 3 independent polls
 *   • renders Readable / Raw / Thinking as subtabs using the new shared
 *     SettingsCard / SettingsTabs / SettingsEmptyState primitives
 *   • keeps the original semantic: Readable = transcript,
 *     Raw = sanitized request/response bodies, Thinking = traces */

import { useMemo, useState } from 'react';
import {
  MessagesSquare,
  Search,
  Brain,
  Inbox,
  type LucideIcon,
} from 'lucide-react';
import { SettingsCard } from '@/components/settings/SettingsCard';
import { SettingsTabs } from '@/components/settings/SettingsTabs';
import { SettingsTooltip } from '@/components/settings/SettingsTooltip';
import { SettingsEmptyState } from '@/components/settings/SettingsEmptyState';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { StatusPill } from '@/components/StatusPill';
import { PageLoader } from '@/components/PageLoader';
import { formatTimeAgo, cn } from '@/lib/utils';
import { type Period } from '@/api/api-client';
import {
  useConversationInspector,
  type InspectorRow,
  type MessageItem,
  type ThinkingTrace,
  type ConversationItem,
} from './useConversationInspector';

/* ── Shared chrome — period filter ──────────────────────────────────── */

const PERIODS: { key: Period; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: 'week', label: '7d' },
  { key: 'all', label: 'All' },
];

const TABS: { key: 'readable' | 'raw' | 'thinking'; label: string; icon: LucideIcon }[] = [
  { key: 'readable', label: 'Readable', icon: MessagesSquare },
  { key: 'raw',      label: 'Raw',      icon: Search },
  { key: 'thinking', label: 'Thinking', icon: Brain },
];

/* ── Top-level section ──────────────────────────────────────────────── */

export function ConversationInspectorSection() {
  const [period, setPeriod] = useState<Period>('today');
  const [tab, setTab] = useState<string>('readable');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  const data = useConversationInspector(period);

  const visibleRows = useMemo<InspectorRow[]>(() => {
    const f = filter.trim().toLowerCase();
    if (!f) return data.rows;
    return data.rows.filter((r) => {
      return (
        r.reqId.toLowerCase().includes(f) ||
        r.clientType.toLowerCase().includes(f) ||
        r.model.toLowerCase().includes(f) ||
        r.status.toLowerCase().includes(f)
      );
    });
  }, [data.rows, filter]);

  const selected = data.select(selectedId);

  if (data.isLoading) return <PageLoader label="Loading inspector…" />;

  return (
    <div className="flex h-full">
      {/* ── Left rail: request list ────────────────────────────── */}
      <aside className="w-80 shrink-0 border-r border-border flex flex-col">
        <div className="px-4 pt-4 pb-3 border-b border-border space-y-2 shrink-0">
          <div className="flex flex-wrap items-center gap-1 text-[10px]">
            <span className="flex items-center gap-1 px-1 text-muted-foreground/70 uppercase tracking-wider">
              Period
              <SettingsTooltip content="The time window applied to every tab in this section." />
            </span>
            {PERIODS.map((p) => (
              <button
                key={p.key}
                onClick={() => setPeriod(p.key)}
                className={cn(
                  'rounded-md px-2 py-1 font-mono transition',
                  period === p.key
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:bg-accent',
                )}
              >
                {p.label}
              </button>
            ))}
          </div>
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter by id, client, model…"
              aria-label="Filter requests"
              className="w-full pl-7 pr-2 py-1.5 text-xs bg-secondary rounded-md border border-transparent focus:border-border focus:bg-background outline-none transition"
            />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {visibleRows.length === 0 ? (
            <div className="grid place-items-center py-8 text-center text-xs text-muted-foreground">
              {filter
                ? `No requests match "${filter}"`
                : 'No requests captured in this period yet.'}
            </div>
          ) : (
            visibleRows.map((r) => (
              <RequestListButton
                key={r.reqId}
                row={r}
                active={selectedId === r.reqId}
                onSelect={() => setSelectedId(r.reqId)}
              />
            ))
          )}
        </div>
        <div className="border-t border-border px-3 py-1.5 text-[10px] text-muted-foreground font-mono shrink-0">
          {visibleRows.length} of {data.rows.length} requests
        </div>
      </aside>

      {/* ── Right pane: subtabs for the selected request ─────── */}
      <div className="flex-1 flex flex-col min-w-0">
        <header className="flex flex-col gap-3 px-6 pt-5 pb-3 shrink-0">
          <div>
            <h2 className="text-lg font-semibold tracking-tight text-foreground">Conversation Inspector</h2>
            <p className="mt-1 text-sm leading-5 text-muted-foreground">
              Pick a request on the left to read it as a conversation, view the raw bodies, or see its thinking.
            </p>
          </div>
          <SettingsTabs value={tab} onChange={setTab} items={TABS} label="Inspector views" />
        </header>
        <div className="min-h-0 flex-1 overflow-auto px-6 pb-6">
          {!selectedId || (!selected.detail && !selected.conversation) ? (
            <SettingsEmptyState
              icon={Inbox}
              title="Select a request"
              description="Click a row on the left to inspect its transcript, raw bodies, or thinking trace."
              className="mt-12"
            />
          ) : (
            <>
              <SelectedMeta
                row={data.rows.find((r) => r.reqId === selectedId) ?? null}
                conversation={selected.conversation}
                detail={selected.detail}
              />
              {tab === 'readable' && <ReadableTab conversation={selected.conversation} />}
              {tab === 'raw'      && <RawTab detail={selected.detail} safeStringify={data.safeStringify} />}
              {tab === 'thinking' && <ThinkingTab trace={selected.trace} safeStringify={data.safeStringify} />}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Left-rail request button ──────────────────────────────────────── */

function RequestListButton({
  row,
  active,
  onSelect,
}: {
  row: InspectorRow;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      className={cn(
        'w-full text-left rounded-md border px-2.5 py-2 transition',
        active
          ? 'border-primary bg-primary/5'
          : 'border-transparent hover:bg-accent/40',
      )}
    >
      <div className="flex items-center gap-2">
        <StatusPill
          tone={row.isError ? 'bad' : row.status === 'completed' ? 'good' : 'muted'}
          label={row.status.slice(0, 8)}
        />
        <span className="text-sm font-medium truncate flex-1">{row.clientType}</span>
        {row.hasThinking && <Brain className="size-3 text-warning shrink-0" />}
      </div>
      <p className="text-[10px] text-muted-foreground font-mono truncate mt-1">{row.reqId}</p>
      <div className="flex items-center gap-1.5 mt-0.5 text-[10px] text-muted-foreground">
        <span>{row.date ? formatTimeAgo(row.date) : '—'}</span>
        <span>·</span>
        <span className="truncate">{row.model}</span>
        {row.requestType && (
          <>
            <span>·</span>
            <span className="truncate">{row.requestType}</span>
          </>
        )}
      </div>
    </button>
  );
}

/* ── Selected-request metadata strip ────────────────────────────────── */

function SelectedMeta({
  row,
  conversation,
  detail,
}: {
  row: InspectorRow | null;
  conversation: ConversationItem | null;
  detail: import('@/api/api-client').RequestDetailEntry | null;
}) {
  const fin = conversation?.finishReason ?? detail?.finishReason;
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2 text-xs">
      <StatusPill
        tone={row?.isError ? 'bad' : row?.status === 'completed' ? 'good' : 'muted'}
        label={row?.status ?? 'unknown'}
      />
      <Badge variant="outline" className="font-mono">{row?.reqId}</Badge>
      <span className="text-muted-foreground">{row?.date ? formatTimeAgo(row.date) : '—'}</span>
      {row?.model && row.model !== 'unknown' && <Badge variant="secondary">{row.model}</Badge>}
      {row?.requestType && <Badge variant="outline">{row.requestType}</Badge>}
      {fin && <Badge variant="outline" className="font-mono">finish: {fin}</Badge>}
      {detail?.inputTokens != null && (
        <span className="text-muted-foreground font-mono">
          in {detail.inputTokens.toLocaleString()} · out {(detail.outputTokens ?? 0).toLocaleString()}
        </span>
      )}
    </div>
  );
}

/* ── Subtab: Readable transcript ────────────────────────────────────── */

function ReadableTab({ conversation }: { conversation: ConversationItem | null }) {
  if (!conversation) {
    return (
      <SettingsEmptyState
        icon={Inbox}
        title="No transcript captured"
        description="The request has no readable messages yet — try the Raw tab or wait for the request to finish."
      />
    );
  }
  if (conversation.messages.length === 0) {
    return (
      <SettingsEmptyState
        icon={Inbox}
        title="No message bodies captured"
        description="The detail log was available but the message bodies were not recorded for this request."
      />
    );
  }
  return (
    <div className="space-y-3">
      {conversation.error && <ErrorBlock text={conversation.error} />}
      <div className="space-y-2.5">
        {conversation.messages.map((m, i) => (
          <MessageBubble key={i} msg={m} />
        ))}
      </div>
      {conversation.finishReason && (
        <p className="text-[10px] text-muted-foreground font-mono px-1">
          finish_reason: {conversation.finishReason}
        </p>
      )}
    </div>
  );
}

function MessageBubble({ msg }: { msg: MessageItem }) {
  return (
    <div className={cn('flex', msg.role === 'user' ? 'justify-end' : 'justify-start')}>
      <Card className={cn('max-w-[85%]', msg.role === 'user' ? 'bg-secondary' : 'bg-card')}>
        <CardContent className="py-2.5 px-3">
          <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground mb-1 font-mono">
            <span className="font-semibold">{msg.role}</span>
          </div>
          <p className="text-sm whitespace-pre-wrap break-words">{msg.content}</p>
        </CardContent>
      </Card>
    </div>
  );
}

/* ── Subtab: Raw request/response bodies ────────────────────────────── */

function RawTab({
  detail,
  safeStringify,
}: {
  detail: import('@/api/api-client').RequestDetailEntry | null;
  safeStringify: (v: unknown) => string;
}) {
  if (!detail) {
    return (
      <SettingsEmptyState
        icon={Inbox}
        title="No captured detail for this request"
        description="The request didn't make it into the detail log. Older requests may have aged out of the period."
      />
    );
  }
  const reqBody = safeStringify(detail.requestBody);
  const resBody = safeStringify(detail.responseBody);

  return (
    <div className="space-y-3">
      {detail.error && <ErrorBlock text={detail.error} />}
      <SettingsCard
        title="Request body"
        description="Sanitized request payload as sent to the upstream provider."
      >
        {reqBody ? (
          <pre className="text-[11px] font-mono whitespace-pre-wrap break-all bg-muted p-3 rounded">
            {reqBody}
          </pre>
        ) : (
          <p className="text-[11px] text-muted-foreground italic">Not captured</p>
        )}
      </SettingsCard>
      <SettingsCard
        title="Response body"
        description="Sanitized response payload returned to the client."
      >
        {resBody ? (
          <pre className="text-[11px] font-mono whitespace-pre-wrap break-all bg-muted p-3 rounded">
            {resBody}
          </pre>
        ) : (
          <p className="text-[11px] text-muted-foreground italic">Pending or not captured</p>
        )}
      </SettingsCard>
      <SettingsCard
        title="Tool calls"
        description="Any tool/function invocations the model made during this request."
      >
        {detail.toolCalls != null ? (
          <pre className="text-[11px] font-mono whitespace-pre-wrap break-all bg-muted p-3 rounded">
            {safeStringify(detail.toolCalls)}
          </pre>
        ) : (
          <p className="text-[11px] text-muted-foreground italic">No tool calls</p>
        )}
      </SettingsCard>
      <p className="text-[9px] text-muted-foreground font-mono px-1">
        🔒 Secrets are redacted server-side before display.
      </p>
    </div>
  );
}

/* ── Subtab: Thinking trace ─────────────────────────────────────────── */

function ThinkingTab({
  trace,
  safeStringify,
}: {
  trace: ThinkingTrace | null;
  safeStringify: (v: unknown) => string;
}) {
  if (!trace) {
    return (
      <SettingsEmptyState
        icon={Brain}
        title="No thinking trace for this request"
        description="Reasoning traces appear when a provider returns them. Send a message with a reasoning model to populate this view."
      />
    );
  }
  const isActive = !trace.finishReason;
  return (
    <SettingsCard
      icon={Brain}
      title={isActive ? 'Thinking (in progress)' : 'Thinking trace'}
      description={
        isActive
          ? 'The model is still reasoning — this trace will update until the request completes.'
          : 'The reasoning the model produced before its final answer.'
      }
      status={
        isActive ? (
          <Badge variant="warning" className="text-[9px]">active</Badge>
        ) : (
          <Badge variant="success" className="text-[9px]">done</Badge>
        )
      }
    >
      <pre className="text-xs font-mono whitespace-pre-wrap break-words bg-muted p-3 rounded leading-relaxed">
        {safeStringify(trace.thinking)}
      </pre>
      {trace.finishReason && (
        <p className="mt-2 text-[10px] text-muted-foreground font-mono">
          finish_reason: {trace.finishReason}
        </p>
      )}
    </SettingsCard>
  );
}

function ErrorBlock({ text }: { text: string }) {
  return (
    <Card className="border-destructive/50">
      <CardContent className="p-3">
        <p className="text-[10px] uppercase tracking-wider text-destructive mb-1 font-semibold">Error</p>
        <pre className="text-[11px] font-mono whitespace-pre-wrap break-all bg-destructive/5 text-destructive p-2 rounded">
          {text}
        </pre>
      </CardContent>
    </Card>
  );
}
