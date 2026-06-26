/* ── WorkspaceInspectorSection — inspector inside the workspace panel ── */
/* Reuses useConversationInspector hook for shared polling. Two-column
 * layout: left rail of requests, right pane with Readable / Raw /
 * Thinking tabs. */

import { useMemo, useState } from 'react';
import {
  MessagesSquare,
  Search,
  Brain,
  Inbox,
  ScrollText,
  Activity,
} from 'lucide-react';
import { useConversationInspector } from '@/sections/settings/useConversationInspector';
import { SettingsTabs } from '@/components/settings/SettingsTabs';
import { SettingsEmptyState } from '@/components/settings/SettingsEmptyState';
import { SettingsCard } from '@/components/settings/SettingsCard';
import { WorkspaceStatCard } from '@/components/workspace/WorkspaceStatCard';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { StatusPill } from '@/components/StatusPill';
import { formatTimeAgo, cn } from '@/lib/utils';
import { type Period } from '@/api/api-client';

const PERIODS: { key: Period; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: 'week', label: '7d' },
  { key: 'all', label: 'All' },
];

export function WorkspaceInspectorSection() {
  const [period, setPeriod] = useState<Period>('today');
  const [tab, setTab] = useState<string>('readable');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  const data = useConversationInspector(period);

  const rows = useMemo(() => {
    const f = filter.trim().toLowerCase();
    if (!f) return data.rows;
    return data.rows.filter((r) =>
      r.reqId.toLowerCase().includes(f) ||
      r.clientType.toLowerCase().includes(f) ||
      r.model.toLowerCase().includes(f),
    );
  }, [data.rows, filter]);

  const selected = data.select(selectedId);
  const errorCount = data.rows.filter((r) => r.isError).length;
  const thinkingCount = data.rows.filter((r) => r.hasThinking).length;

  return (
    <div className="px-8 py-6 space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Inspector</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Read a request as a conversation, inspect raw bodies, or view the model&apos;s thinking.
          </p>
        </div>
        <div className="flex items-center gap-1 text-[10px]">
          <span className="text-muted-foreground/70 uppercase tracking-wider mr-1">Period</span>
          {PERIODS.map((p) => (
            <button
              key={p.key}
              onClick={() => setPeriod(p.key)}
              className={cn(
                'rounded-md px-2 py-1 font-mono transition',
                period === p.key ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent',
              )}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <WorkspaceStatCard icon={Activity} label="Requests" value={data.rows.length} sub={`${data.details.length} with detail`} accent="blue" />
        <WorkspaceStatCard icon={Inbox} label="Errors" value={errorCount} sub={errorCount > 0 ? 'Investigate on Raw tab' : 'No errors'} accent={errorCount > 0 ? 'amber' : 'default'} />
        <WorkspaceStatCard icon={Brain} label="With thinking" value={thinkingCount} sub="Reasoning traces captured" accent="default" />
      </div>

      <SettingsTabs
        value={tab}
        onChange={setTab}
        items={[
          { key: 'readable', label: 'Conversation', icon: MessagesSquare },
          { key: 'raw', label: 'Raw', icon: Search },
          { key: 'thinking', label: 'Thinking', icon: Brain },
        ]}
        label="Inspector views"
      />

      <div className="flex gap-4 min-h-[400px]">
        {/* Left rail: request list */}
        <aside className="w-72 shrink-0 rounded-xl border border-white/[0.06] bg-card/60 overflow-hidden flex flex-col">
          <div className="p-2 border-b border-white/[0.06]">
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
              <input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter by id, client, model…"
                aria-label="Filter requests"
                className="w-full pl-7 pr-2 py-1.5 text-xs bg-white/[0.04] rounded-md border border-white/[0.06] outline-none focus:border-primary/60"
              />
            </div>
          </div>
          <div className="flex-1 overflow-y-auto p-2 space-y-1">
            {rows.length === 0 ? (
              <div className="grid place-items-center py-8 text-center text-xs text-muted-foreground">
                {filter ? `No requests match "${filter}"` : 'No requests captured.'}
              </div>
            ) : (
              rows.slice(0, 80).map((r) => (
                <button
                  key={r.reqId}
                  onClick={() => setSelectedId(r.reqId)}
                  className={cn(
                    'w-full text-left rounded-md border px-2.5 py-2 transition',
                    selectedId === r.reqId ? 'border-primary bg-primary/5' : 'border-transparent hover:bg-white/[0.04]',
                  )}
                >
                  <div className="flex items-center gap-2">
                    <StatusPill tone={r.isError ? 'bad' : r.status === 'completed' ? 'good' : 'muted'} label={r.status.slice(0, 8)} />
                    <span className="text-sm font-medium truncate flex-1">{r.clientType}</span>
                    {r.hasThinking && <Brain className="size-3 text-warning shrink-0" />}
                  </div>
                  <p className="text-[10px] text-muted-foreground font-mono truncate mt-1">{r.reqId}</p>
                  <div className="flex items-center gap-1.5 mt-0.5 text-[10px] text-muted-foreground">
                    <span>{r.date ? formatTimeAgo(r.date) : '—'}</span>
                    <span>·</span>
                    <span className="truncate">{r.model}</span>
                  </div>
                </button>
              ))
            )}
          </div>
        </aside>

        {/* Right pane: selected request */}
        <div className="flex-1 min-w-0">
          {!selectedId || (!selected.detail && !selected.conversation) ? (
            <SettingsEmptyState icon={Inbox} title="Select a request" description="Click a row on the left to inspect its transcript, raw bodies, or thinking trace." />
          ) : (
            <div className="space-y-4">
              {tab === 'readable' && <ReadableTab conversation={selected.conversation} />}
              {tab === 'raw' && <RawTab detail={selected.detail} safeStringify={data.safeStringify} />}
              {tab === 'thinking' && <ThinkingTab trace={selected.trace} safeStringify={data.safeStringify} />}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ReadableTab({ conversation }: { conversation: import('@/sections/settings/useConversationInspector').ConversationItem | null }) {
  if (!conversation || conversation.messages.length === 0) {
    return <SettingsEmptyState icon={Inbox} title="No transcript captured" description="The request has no readable messages." />;
  }
  return (
    <div className="space-y-3">
      {conversation.error && (
        <Card className="border-destructive/50">
          <CardContent className="p-3">
            <p className="text-[10px] uppercase tracking-wider text-destructive mb-1 font-semibold">Error</p>
            <pre className="text-[11px] font-mono whitespace-pre-wrap break-all bg-destructive/5 text-destructive p-2 rounded">{conversation.error}</pre>
          </CardContent>
        </Card>
      )}
      {conversation.messages.map((m, i) => (
        <div key={i} className={cn('flex', m.role === 'user' ? 'justify-end' : 'justify-start')}>
          <Card className={cn('max-w-[85%]', m.role === 'user' ? 'bg-white/[0.04]' : 'bg-card')}>
            <CardContent className="py-2.5 px-3">
              <div className="text-[10px] text-muted-foreground font-mono mb-1 font-semibold">{m.role}</div>
              <p className="text-sm whitespace-pre-wrap break-words">{m.content}</p>
            </CardContent>
          </Card>
        </div>
      ))}
      {conversation.finishReason && (
        <p className="text-[10px] text-muted-foreground font-mono px-1">finish_reason: {conversation.finishReason}</p>
      )}
    </div>
  );
}

function RawTab({ detail, safeStringify }: { detail: import('@/api/api-client').RequestDetailEntry | null; safeStringify: (v: unknown) => string }) {
  if (!detail) {
    return <SettingsEmptyState icon={Inbox} title="No captured detail" description="The request didn't make it into the detail log." />;
  }
  return (
    <div className="space-y-3">
      {detail.error && (
        <Card className="border-destructive/50">
          <CardContent className="p-3">
            <p className="text-[10px] uppercase tracking-wider text-destructive mb-1 font-semibold">Error</p>
            <pre className="text-[11px] font-mono whitespace-pre-wrap break-all bg-destructive/5 text-destructive p-2 rounded">{detail.error}</pre>
          </CardContent>
        </Card>
      )}
      <SettingsCard title="Request body" description="Sanitized request payload.">
        <pre className="text-[11px] font-mono whitespace-pre-wrap break-all bg-white/[0.04] p-3 rounded">{safeStringify(detail.requestBody) || <span className="text-muted-foreground italic">Not captured</span>}</pre>
      </SettingsCard>
      <SettingsCard title="Response body" description="Sanitized response payload.">
        <pre className="text-[11px] font-mono whitespace-pre-wrap break-all bg-white/[0.04] p-3 rounded">{safeStringify(detail.responseBody) || <span className="text-muted-foreground italic">Pending or not captured</span>}</pre>
      </SettingsCard>
    </div>
  );
}

function ThinkingTab({ trace, safeStringify }: { trace: import('@/sections/settings/useConversationInspector').ThinkingTrace | null; safeStringify: (v: unknown) => string }) {
  if (!trace) {
    return <SettingsEmptyState icon={Brain} title="No thinking trace" description="Reasoning traces appear when a provider returns them." />;
  }
  return (
    <SettingsCard
      icon={Brain}
      title={trace.finishReason ? 'Thinking trace' : 'Thinking (in progress)'}
      description="The reasoning the model produced before its final answer."
      status={<Badge variant={trace.finishReason ? 'success' : 'warning'} className="text-[9px]">{trace.finishReason ? 'done' : 'active'}</Badge>}
    >
      <pre className="text-xs font-mono whitespace-pre-wrap break-words bg-white/[0.04] p-3 rounded leading-relaxed">
        {safeStringify(trace.thinking)}
      </pre>
    </SettingsCard>
  );
}
