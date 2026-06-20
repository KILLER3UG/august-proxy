/* ── ObservabilitySection — Audit / Rollback / Observations / Security ── */
/* One section with subtabs, scrollable, matches the WorkspaceShell pattern.
 *
 * Subtab state is local (useState) so a subtab reset happens only on mount.
 * Uses SettingsTabs (aria-tablist) and renders the matching subtab component.
 */

import { useState } from 'react';
import { LineChart, History, Image, Shield } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { SettingsTabs } from '@/components/settings/SettingsTabs';
import { ObservabilityOverview } from './ObservabilityOverview';
import { AuditTimeline } from './AuditTimeline';
import { RollbackHistory } from './RollbackHistory';
import { ObservationGallery } from './ObservationGallery';

type SubtabId = 'overview' | 'audit' | 'rollback' | 'observations';

interface SubtabDef {
    id: SubtabId;
    label: string;
    icon: LucideIcon;
    description: string;
}

const SUBTABS: SubtabDef[] = [
    { id: 'overview',     label: 'Overview',     icon: LineChart, description: 'At-a-glance health and recent activity' },
    { id: 'audit',        label: 'Audit',        icon: History,  description: 'Full audit log with filters' },
    { id: 'rollback',     label: 'Rollback',     icon: Shield,   description: 'Available and past rollbacks' },
    { id: 'observations', label: 'Observations', icon: Image,    description: 'Post-observation screenshots' }
];

export function ObservabilitySection() {
    const [subtab, setSubtab] = useState<SubtabId>('overview');

    const tabItems = SUBTABS.map(t => ({
        key: t.id,
        label: t.label,
        icon: t.icon
    }));

    return (
        <div className="px-8 py-10 max-w-6xl space-y-8">
            <header>
                <h1 className="text-2xl font-semibold tracking-tight">Observability</h1>
                <p className="mt-2 text-sm text-muted-foreground">
                    Audit log, rollback history, post-observation screenshots, and host-agent health — all in one place.
                </p>
            </header>

            <SettingsTabs
                items={tabItems}
                value={subtab}
                onChange={(id) => setSubtab(id as SubtabId)}
            />

            <div role="tabpanel" aria-label={SUBTABS.find(t => t.id === subtab)?.description}>
                {subtab === 'overview' && <ObservabilityOverview onNavigate={setSubtab} />}
                {subtab === 'audit' && <AuditTimeline />}
                {subtab === 'rollback' && <RollbackHistory />}
                {subtab === 'observations' && <ObservationGallery />}
            </div>
        </div>
    );
}

export default ObservabilitySection;
