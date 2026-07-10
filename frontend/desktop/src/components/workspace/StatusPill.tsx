/* eslint-disable react-refresh/only-export-components */

/* ── StatusPill — small status badge used across Observability ────────── */
/* Variants:
 *   ok       — green dot  (audit 'ok', connected)
 *   warn     — amber dot  (ask, disconnected, available)
 *   danger   — red dot    (denied, failed, error)
 *   muted    — slate dot  (unknown, blocked, idle)
 *
 * Used in:
 *   - Overview stat cards (host-agent health, allowlist counts)
 *   - Audit timeline badges (result, critical, blocked)
 *   - Rollback rows (status)
 *   - Observation gallery (focused app presence)
 */

import { cn } from '@/lib/utils';

export type StatusPillVariant = 'ok' | 'warn' | 'danger' | 'muted';

const VARIANT_CLS: Record<StatusPillVariant, string> = {
    ok: 'bg-success/15 text-success ring-success/30',
    warn: 'bg-warning/15 text-warning ring-warning/30',
    danger: 'bg-danger/15 text-danger ring-danger/30',
    muted: 'bg-white/[0.06] text-muted-foreground ring-white/10'
};

const DOT_CLS: Record<StatusPillVariant, string> = {
    ok: 'bg-success',
    warn: 'bg-warning',
    danger: 'bg-danger',
    muted: 'bg-muted-foreground/60'
};

export function StatusPill({
    variant = 'muted',
    label,
    className,
    dot = true
}: {
    variant?: StatusPillVariant;
    label: string;
    className?: string;
    dot?: boolean;
}) {
    return (
        <span
            className={cn(
                'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-medium ring-1 ring-inset',
                VARIANT_CLS[variant],
                className
            )}
        >
            {dot && <span className={cn('inline-block size-1.5 rounded-full', DOT_CLS[variant])} />}
            {label}
        </span>
    );
}

export function variantForResult(result: string | null | undefined): StatusPillVariant {
    switch (String(result || '')) {
        case 'ok':
            return 'ok';
        case 'blocked':
            return 'warn';
        case 'error':
            return 'danger';
        default:
            return 'muted';
    }
}

export function variantForRollbackStatus(status: string | null | undefined): StatusPillVariant {
    switch (String(status || '')) {
        case 'available':
            return 'warn';
        case 'undone':
            return 'ok';
        case 'failed':
            return 'danger';
        default:
            return 'muted';
    }
}

export function variantForAppPolicy(policy: string | null | undefined): StatusPillVariant {
    switch (String(policy || '')) {
        case 'allow':
            return 'ok';
        case 'ask':
            return 'warn';
        case 'deny':
            return 'danger';
        default:
            return 'muted';
    }
}

export function variantForHostStatus(status: string | null | undefined): StatusPillVariant {
    switch (String(status || '')) {
        case 'connected':
            return 'ok';
        case 'error':
            return 'danger';
        case 'disconnected':
        default:
            return 'muted';
    }
}
