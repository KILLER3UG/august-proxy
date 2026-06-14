import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import { SectionHeader } from '@/components/SectionHeader';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { StatusPill } from '@/components/StatusPill';
import { RightRail } from '@/components/shell/RightRail';
import { mockRequests, type RequestLog } from '@/lib/mock';
import { formatTimeAgo } from '@/lib/utils';

export function Inspector() {
  const { data } = useQuery({
    queryKey: ['requests'],
    queryFn: async () => {
      try { return await api.get<{ requests: RequestLog[] }>('/api/requests'); }
      catch { return { requests: mockRequests }; }
    },
    refetchInterval: 3_000,
  });
  const requests = data?.requests ?? mockRequests;
  const [selected, setSelected] = useState<RequestLog | null>(requests[0] ?? null);

  return (
    <div className="flex h-full">
      <div className="flex-1 flex flex-col min-w-0">
        <div className="p-6 pb-3">
          <SectionHeader
            title="Inspector"
            subtitle={`${requests.length} requests · click a row for details`}
          />
        </div>
        <div className="flex-1 overflow-auto px-6 pb-3 space-y-1.5">
          {requests.slice(0, 60).map((r) => (
            <button
              key={r.id}
              onClick={() => setSelected(r)}
              className={`w-full text-left rounded-md border border-border bg-card hover:bg-accent/30 transition px-3 py-2 ${
                selected?.id === r.id ? 'ring-1 ring-primary' : ''
              }`}
            >
              <div className="flex items-center gap-3 text-xs font-mono">
                <Badge variant={r.status < 300 ? 'outline' : r.status < 500 ? 'secondary' : 'destructive'} className="w-fit">
                  {r.status}
                </Badge>
                <span className="text-muted-foreground">{r.method}</span>
                <span className="font-semibold flex-1 truncate">{r.path}</span>
                <span className="text-muted-foreground tabular-nums">{r.durationMs}ms</span>
                <span className="text-muted-foreground text-[10px]">{formatTimeAgo(r.timestamp)}</span>
              </div>
            </button>
          ))}
        </div>
      </div>

      {selected && (
        <RightRail title="Request detail" subtitle={selected.id}>
          <RequestDetail r={selected} />
        </RightRail>
      )}
    </div>
  );
}

function RequestDetail({ r }: { r: RequestLog }) {
  return (
    <div className="space-y-3 text-xs">
      <div className="grid grid-cols-2 gap-2">
        <Field label="Status"   value={<StatusPill tone={r.status < 300 ? 'good' : r.status < 500 ? 'warn' : 'bad'} label={String(r.status)} />} />
        <Field label="Method"   value={<span className="font-mono">{r.method}</span>} />
        <Field label="Path"     value={<span className="font-mono">{r.path}</span>} />
        <Field label="Duration" value={<span className="font-mono tabular-nums">{r.durationMs}ms</span>} />
        <Field label="Provider" value={<span className="font-mono">{r.provider}</span>} />
        <Field label="Model"    value={<span className="font-mono">{r.model}</span>} />
        <Field label="Input"    value={<span className="font-mono tabular-nums">{r.inputTokens.toLocaleString()}</span>} />
        <Field label="Output"   value={<span className="font-mono tabular-nums">{r.outputTokens.toLocaleString()}</span>} />
        <Field label="Cost"     value={<span className="font-mono">${r.cost.toFixed(4)}</span>} />
        <Field label="Time"     value={<span className="font-mono">{new Date(r.timestamp).toLocaleString()}</span>} />
      </div>
      <Card>
        <CardContent className="p-3">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">Request body</p>
          <pre className="text-[10px] font-mono whitespace-pre-wrap break-all bg-muted p-2 rounded">
{`POST ${r.path}
Authorization: Bearer sk-cp-•••jYZQ
Content-Type: application/json

{
  "model": "${r.model}",
  "max_tokens": 8192,
  "messages": [
    { "role": "user", "content": "..." }
  ]
}`}
          </pre>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="p-3">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">Response body</p>
          <pre className="text-[10px] font-mono whitespace-pre-wrap break-all bg-muted p-2 rounded">
{`HTTP/1.1 ${r.status} ${r.status < 300 ? 'OK' : r.status < 500 ? 'Client Error' : 'Server Error'}
Content-Type: application/json
x-request-id: ${r.id}
openai-organization: nous-research

{
  "id": "chatcmpl-${r.id}",
  "object": "chat.completion",
  "model": "${r.model}",
  "usage": {
    "prompt_tokens": ${r.inputTokens},
    "completion_tokens": ${r.outputTokens},
    "total_tokens": ${r.inputTokens + r.outputTokens}
  }
}`}
          </pre>
        </CardContent>
      </Card>
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
