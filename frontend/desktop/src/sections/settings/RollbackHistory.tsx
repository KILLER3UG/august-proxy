/* ── RollbackHistory — list + undo for declarative rollback entries ─── */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Undo2 } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { SettingsEmptyState } from '@/components/settings/SettingsEmptyState';
import { StatusPill, variantForRollbackStatus } from '@/components/workspace/StatusPill';
import { getRollbackList, getRollbackSummary, undoAugustRollback, type RollbackEntry } from '@/api/api-client';
import { formatTimeAgo } from '@/lib/utils';
import { toast } from 'sonner';

type StatusFilter = 'all' | 'available' | 'undone' | 'failed';

export function RollbackHistory() {
    const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
    const [expanded, setExpanded] = useState<Set<string>>(new Set());

    const qc = useQueryClient();
    const summary = useQuery({ queryKey: ['rollback', 'summary'], queryFn: () => getRollbackSummary() });
    const list = useQuery({
        queryKey: ['rollback', { status: statusFilter }],
        queryFn: () => getRollbackList({ status: statusFilter === 'all' ? undefined : statusFilter, limit: 100 }),
        refetchInterval: 30_000
    });

    const undo = useMutation({
        mutationFn: (id: string) => undoAugustRollback(id),
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: ['rollback'] });
            qc.invalidateQueries({ queryKey: ['audit'] });
            toast.success('Rollback undone');
        },
        onError: (e: any) => toast.error(`Undo failed: ${e?.message || e}`)
    });

    const items = list.data?.items ?? [];
    const s = summary.data;

    return (
        <div className="space-y-4">
            {/* Summary cards */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <SummaryCard label="Available" value={s?.available ?? 0} variant="warn" />
                <SummaryCard label="Undone" value={s?.undone ?? 0} variant="ok" />
                <SummaryCard label="Failed" value={s?.failed ?? 0} variant="danger" />
            </div>

            {/* Filter bar */}
            <Card>
                <CardContent className="py-3 flex items-center gap-2 flex-wrap text-sm">
                    <span className="text-muted-foreground">Filter:</span>
                    {(['all', 'available', 'undone', 'failed'] as const).map(s => (
                        <button
                            key={s}
                            onClick={() => setStatusFilter(s)}
                            className={`px-2 py-1 rounded-md text-xs ${statusFilter === s ? 'bg-foreground/15 text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                        >{s}</button>
                    ))}
                    <span className="ml-auto text-muted-foreground">{items.length} entries</span>
                </CardContent>
            </Card>

            {/* List */}
            {list.isLoading ? (
                <SettingsEmptyState title="Loading…" description="Fetching rollbacks." />
            ) : items.length === 0 ? (
                <SettingsEmptyState title="No rollbacks" description="Mutating tools create rollbacks automatically." />
            ) : (
                <Card>
                    <CardContent className="p-0">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="text-[10px] uppercase tracking-widest text-muted-foreground border-b border-white/[0.06]">
                                    <th className="text-left px-3 py-2 font-medium">Type</th>
                                    <th className="text-left px-3 py-2 font-medium">Target</th>
                                    <th className="text-left px-3 py-2 font-medium">When</th>
                                    <th className="text-left px-3 py-2 font-medium">Status</th>
                                    <th className="text-right px-3 py-2 font-medium">Action</th>
                                </tr>
                            </thead>
                            <tbody>
                                {items.slice().reverse().map(r => (
                                    <RollbackRow
                                        key={r.id}
                                        entry={r}
                                        expanded={expanded.has(r.id)}
                                        onToggle={() => setExpanded(prev => {
                                            const next = new Set(prev);
                                            if (next.has(r.id)) next.delete(r.id); else next.add(r.id);
                                            return next;
                                        })}
                                        onUndo={() => undo.mutate(r.id)}
                                        undoing={undo.isPending && undo.variables === r.id}
                                    />
                                ))}
                            </tbody>
                        </table>
                    </CardContent>
                </Card>
            )}
        </div>
    );
}

function SummaryCard({ label, value, variant }: { label: string; value: number; variant: 'ok' | 'warn' | 'danger' }) {
    return (
        <Card>
            <CardContent className="py-4">
                <div className="text-[10px] uppercase tracking-widest text-muted-foreground">{label}</div>
                <div className="mt-1 flex items-center gap-2">
                    <span className="text-2xl font-semibold">{value}</span>
                    <StatusPill label={variant === 'ok' ? 'ok' : variant} variant={variant} />
                </div>
            </CardContent>
        </Card>
    );
}

function RollbackRow({ entry, expanded, onToggle, onUndo, undoing }: {
    entry: RollbackEntry;
    expanded: boolean;
    onToggle: () => void;
    onUndo: () => void;
    undoing: boolean;
}) {
    return (
        <>
            <tr
                onClick={onToggle}
                className="border-b border-white/[0.04] hover:bg-white/[0.03] cursor-pointer"
            >
                <td className="px-3 py-2 font-mono text-xs">{entry.type}</td>
                <td className="px-3 py-2"><code className="text-xs">{entry.target}</code></td>
                <td className="px-3 py-2 text-xs text-muted-foreground">{formatTimeAgo(new Date(entry.at))}</td>
                <td className="px-3 py-2"><StatusPill label={entry.status} variant={variantForRollbackStatus(entry.status)} /></td>
                <td className="px-3 py-2 text-right">
                    {entry.status === 'available' && (
                        <Button
                            size="sm"
                            variant="ghost"
                            disabled={undoing}
                            onClick={(e) => { e.stopPropagation(); onUndo(); }}
                        >
                            <Undo2 className="size-3.5 mr-1" /> Undo
                        </Button>
                    )}
                </td>
            </tr>
            {expanded && (
                <tr className="bg-white/[0.02]">
                    <td colSpan={5} className="px-3 py-3">
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-xs">
                            <JsonBlock label="before" value={entry.before} />
                            <JsonBlock label="after" value={entry.after} />
                        </div>
                    </td>
                </tr>
            )}
        </>
    );
}

function JsonBlock({ label, value }: { label: string; value: unknown }) {
    return (
        <div className="rounded-md border border-white/[0.06] bg-background/40 p-2">
            <div className="text-[10px] uppercase tracking-widest text-muted-foreground mb-1">{label}</div>
            <pre className="text-[11px] leading-snug whitespace-pre-wrap break-all font-mono">
                {value === null || value === undefined ? '—' :
                    typeof value === 'string' ? value : JSON.stringify(value, null, 2)}
            </pre>
        </div>
    );
}
