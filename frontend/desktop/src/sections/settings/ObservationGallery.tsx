/* ── ObservationGallery — screenshot grid of post-observation PNGs ──── */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { SettingsEmptyState } from '@/components/settings/SettingsEmptyState';
import { StatusPill, variantForAppPolicy } from '@/components/workspace/StatusPill';
import { getObservations, getObservationUrl, type PostObservation } from '@/api/api-client';
import { formatTimeAgo } from '@/lib/utils';
import { Backdrop } from '@/components/overlays/Backdrop';
import { Badge } from '@/components/ui/badge';

export function ObservationGallery() {
    const [selected, setSelected] = useState<PostObservation | null>(null);
    const [limit] = useState(60);

    const query = useQuery({
        queryKey: ['observations', { limit }],
        queryFn: () => getObservations({ limit }),
        refetchInterval: 60_000
    });

    const items = query.data?.items ?? [];

    return (
        <div className="space-y-4">
            {query.isLoading ? (
                <SettingsEmptyState title="Loading…" description="Fetching post-observation screenshots." />
            ) : items.length === 0 ? (
                <SettingsEmptyState
                    title="No observations yet"
                    description="Mutating computer_* tool calls capture a screenshot after each action. They will appear here."
                />
            ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                    {items.map(o => <ObservationCard key={o.id} item={o} onOpen={() => setSelected(o)} />)}
                </div>
            )}

            {selected && <ObservationModal item={selected} onClose={() => setSelected(null)} />}
        </div>
    );
}

function ObservationCard({ item, onOpen }: { item: PostObservation; onOpen: () => void }) {
    return (
        <button
            type="button"
            onClick={onOpen}
            className="text-left rounded-xl border border-white/[0.06] bg-card/60 overflow-hidden hover:border-white/20 transition group"
        >
            <div className="aspect-video bg-black/30 overflow-hidden">
                <img
                    src={getObservationUrl(item.id)}
                    alt={item.focusedApp ? `Screenshot of ${item.focusedApp}` : 'Observation screenshot'}
                    loading="lazy"
                    className="w-full h-full object-cover group-hover:scale-105 transition"
                />
            </div>
            <div className="p-3 space-y-1.5">
                <div className="flex items-center gap-2 text-xs">
                    {item.focusedApp ? (
                        <StatusPill label={item.focusedApp} variant={variantForAppPolicy('ask')} />
                    ) : (
                        <StatusPill label="(no focused app)" variant="muted" />
                    )}
                    {item.audit?.action && <Badge variant="outline" className="text-[10px]">{item.audit.action}</Badge>}
                </div>
                <div className="text-[10px] text-muted-foreground font-mono">
                    {formatTimeAgo(new Date(item.capturedAt))}
                </div>
            </div>
        </button>
    );
}

function ObservationModal({ item, onClose }: { item: PostObservation; onClose: () => void }) {
    return (
        <Backdrop onClose={onClose}>
            <div
                onClick={(e) => e.stopPropagation()}
                className="relative max-w-5xl w-[92vw] max-h-[90vh] rounded-2xl border border-white/[0.08] bg-card shadow-2xl overflow-hidden flex flex-col"
            >
                <div className="flex items-center justify-between px-4 py-3 border-b border-white/[0.06]">
                    <div className="flex items-center gap-2 min-w-0">
                        {item.focusedApp && <StatusPill label={item.focusedApp} variant={variantForAppPolicy('ask')} />}
                        {item.audit?.action && <Badge variant="outline">{item.audit.action}</Badge>}
                        <span className="text-xs text-muted-foreground font-mono">
                            {new Date(item.capturedAt).toLocaleString()}
                        </span>
                    </div>
                    <button
                        type="button"
                        onClick={onClose}
                        className="rounded-md p-1.5 text-muted-foreground hover:text-foreground hover:bg-white/[0.06]"
                        aria-label="Close"
                    >
                        <X className="size-4" />
                    </button>
                </div>
                <div className="flex-1 overflow-auto bg-black/40 p-4 flex items-center justify-center">
                    <img
                        src={getObservationUrl(item.id)}
                        alt={item.focusedApp ? `Screenshot of ${item.focusedApp}` : 'Observation'}
                        className="max-w-full max-h-full object-contain"
                    />
                </div>
                {item.audit && (
                    <div className="px-4 py-3 border-t border-white/[0.06] grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
                        <Detail k="Result" v={item.audit.result || '—'} />
                        <Detail k="Target" v={item.audit.target || '—'} />
                        <Detail k="Audit ID" v={item.audit.id} />
                        <Detail k="At" v={new Date(item.audit.at).toLocaleString()} />
                    </div>
                )}
            </div>
        </Backdrop>
    );
}

function Detail({ k, v }: { k: string; v: React.ReactNode }) {
    return (
        <div>
            <div className="text-[10px] uppercase tracking-widest text-muted-foreground">{k}</div>
            <div className="font-mono text-foreground/80 truncate mt-0.5">{v}</div>
        </div>
    );
}
