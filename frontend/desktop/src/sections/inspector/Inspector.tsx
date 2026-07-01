import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { SectionHeader } from '@/components/SectionHeader';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { StatusPill } from '@/components/StatusPill';
import { RightRail } from '@/components/shell/RightRail';
import { PageLoader } from '@/components/PageLoader';
import { formatTimeAgo } from '@/lib/utils';
import {
  getRequestDetails,
  getRequestDetail,
  type RequestDetailEntry,
  type Period,
} from '@/api/api-client';

const PERIODS: { key: Period; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: 'week', label: '7d' },
  { key: 'all', label: 'All' },
];

export function Inspector() {
  const [period, setPeriod] = useState<Period>('today');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const { data: details, isLoading } = useQuery({
    queryKey: ['request-details', period],
    queryFn: () => getRequestDetails(period),
    refetchInterval: 3_000,
  });

  const { data: selectedDetail } = useQuery({
    queryKey: ['request-detail', selectedId],
    queryFn: () => (selectedId ? getRequestDetail(selectedId) : Promise.resolve(null)),
    enabled: !!selectedId,
  });

  const rows = details ?? [];
  const selected = selectedDetail ?? rows.find((d) => d.reqId === selectedId) ?? null;

  if (isLoading) return <PageLoader label="Loading inspector…" />;

  return (
    <div className="flex h-full">
      <div className="flex-1 flex flex-col min-w-0">
        <div className="p-6 pb-3">
          <SectionHeader
            title="Inspector"
            subtitle={`${rows.length} captured requests · click a row for sanitized bodies`}
            actions={
              <div className="flex items-center gap-1 text-[10px]">
                {PERIODS.map((p) => (
                  <button
                    key={p.key}
                    onClick={() => setPeriod(p.key)}
                    className={`rounded-md px-2 py-1 font-mono transition ${
                      period === p.key ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent'
                    }`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            }
          />
        </div>
        <div className="flex-1 overflow-auto px-6 pb-3 space-y-1.5">
          {rows.length === 0 ? (
            <div className="h-full grid place-items-center text-xs text-muted-foreground">
              No captured requests in this period. Send a chat message to populate the inspector.
            </div>
          ) : (
            rows.slice(0, 120).map((d) => (
              <button
                key={d.reqId}
                onClick={() => setSelectedId(d.reqId)}
                className={`w-full text-left rounded-md border border-border bg-card hover:bg-accent/30 transition px-3 py-2 ${
                  selected?.reqId === d.reqId ? 'ring-1 ring-primary' : ''
                }`}
              >
                <div className="flex items-center gap-3 text-xs font-mono">
                  <DetailStatus status={d.status} error={d.error} />
                  <span className="text-muted-foreground">{d.requestType || 'request'}</span>
                  <span className="font-semibold flex-1 truncate">{d.reqId}</span>
                  {d.date && (
                    <span className="text-muted-foreground text-[10px]">{formatTimeAgo(d.date)}</span>
                  )}
                </div>
              </button>
            ))
          )}
        </div>
      </div>

      {selected && (
        <RightRail title="Request detail" subtitle={selected.reqId}>
          <RequestDetail d={selected} />
        </RightRail>
      )}
    </div>
  );
}

function DetailStatus({ status, error }: { status?: string; error?: string | null }) {
  const isError = status === 'error' || !!error;
  return (
    <StatusPill
      tone={isError ? 'bad' : status === 'completed' ? 'good' : 'muted'}
      label={(status || 'unknown').slice(0, 10)}
    />
  );
}

function RequestDetail({ d }: { d: RequestDetailEntry }) {
  const reqBody = safeStringify(d.requestBody);
  const resBody = safeStringify(d.responseBody);

  return (
    <div className="space-y-3 text-xs">
      <div className="grid grid-cols-2 gap-2">
        <Field label="Status" value={<DetailStatus status={d.status} error={d.error} />} />
        <Field label="Type" value={<span className="font-mono">{d.requestType || '—'}</span>} />
        {d.date && <Field label="Time" value={<span className="font-mono">{new Date(d.date).toLocaleString()}</span>} />}
        {d.finishReason && <Field label="Finish" value={<span className="font-mono">{d.finishReason}</span>} />}
        <Field label="Input tok" value={<span className="font-mono tabular-nums">{(d.inputTokens || 0).toLocaleString()}</span>} />
        <Field label="Output tok" value={<span className="font-mono tabular-nums">{(d.outputTokens || 0).toLocaleString()}</span>} />
      </div>

      {d.error && (
        <Card>
          <CardContent className="p-3">
            <p className="text-[10px] uppercase tracking-wider text-destructive mb-1">Error</p>
            <pre className="text-[10px] font-mono whitespace-pre-wrap break-all bg-destructive/5 text-destructive p-2 rounded">
              {d.error}
            </pre>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="p-3">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">Request body</p>
          {reqBody ? (
            <pre className="text-[10px] font-mono whitespace-pre-wrap break-all bg-muted p-2 rounded">
              {reqBody}
            </pre>
          ) : (
            <p className="text-[10px] text-muted-foreground italic">Not captured</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-3">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">Response body</p>
          {resBody ? (
            <pre className="text-[10px] font-mono whitespace-pre-wrap break-all bg-muted p-2 rounded">
              {resBody}
            </pre>
          ) : (
            <p className="text-[10px] text-muted-foreground italic">Pending or not captured</p>
          )}
        </CardContent>
      </Card>

      {d.thinking != null && (
        <Card>
          <CardContent className="p-3">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">Thinking</p>
            <pre className="text-[10px] font-mono whitespace-pre-wrap break-all bg-muted p-2 rounded">
              {safeStringify(d.thinking)}
            </pre>
          </CardContent>
        </Card>
      )}

      {d.toolCalls != null && (
        <Card>
          <CardContent className="p-3">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">Tool calls</p>
            <pre className="text-[10px] font-mono whitespace-pre-wrap break-all bg-muted p-2 rounded">
              {safeStringify(d.toolCalls)}
            </pre>
          </CardContent>
        </Card>
      )}

      <p className="text-[9px] text-muted-foreground font-mono px-1">
        🔒 Secrets are redacted server-side before display.
      </p>
    </div>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <div className="mt-0.5">{value}</div>
    </div>
  );
}

/** Stringify a possibly-object/already-string value, never throwing. */
function safeStringify(v: unknown): string {
  if (v == null || v === '') return '';
  if (typeof v === 'string') {
    // Already-stringified (e.g. sanitizeForDisplay output); pretty-print if JSON.
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
