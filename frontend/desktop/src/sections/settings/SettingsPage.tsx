/* ── SettingsPage — full-screen settings page (replaces modal) ───────── */
/* Mounted by ChatLayout at /settings/* routes. Renders the same dark,
 * left-rail + content layout as the workspace panel, but lives at the
 * /settings path so deep links, the command palette, and the titlebar
 * Settings button all route here. Section id is resolved via the same
 * legacy alias map used by the previous modal (so old /settings/:tab
 * URLs continue to resolve).
 *
 * Tab switches keep this page (and the left rail) mounted. Only the
 * active section component remounts so it can refetch live data. */

import React, { useEffect, useRef } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { useQueryClient } from '@tanstack/react-query';
import {
  resolveLegacyTab,
  SETTINGS_SECTIONS,
  SETTINGS_CATEGORIES,
  railCanonicalId,
  getSection,
  sectionsForCategory,
  type SettingsSection,
} from '@/settings/settings-registry';
import { WorkspaceShell, type WorkspaceSectionMeta } from '@/components/workspace/WorkspaceShell';
import { useProviderOnboardingState } from '@/hooks/useProviderOnboardingState';

/** Hub IA: 8 category hubs (clean, related data per hub). Rail shows hubs, not 32 rows. */
const HUB_CATEGORY_IDS = new Set(SETTINGS_CATEGORIES.map((c) => c.id));
const LEGACY_HUB_MAP: Record<string, string> = {
  general: 'system',
  intelligence: 'models',
  tools: 'tools',
  activity: 'insights',
  security: 'access',
};
function isHubId(id: string | null | undefined): boolean {
  return !!id && HUB_CATEGORY_IDS.has(id);
}

/** The default section when no :section param is present. Hub IA: System hub first. */
const DEFAULT_SECTION_ID = 'system';

/** While first-run setup is incomplete (no provider + workspace yet),
 *  bare /settings lands on the guided AI Setup wizard instead. */
function useLandingSectionId(): string {
  const onboarding = useProviderOnboardingState();
  const setupPending = !onboarding.dismissed && !onboarding.isLoading && !onboarding.allCoreDone;
  return setupPending ? 'ai-setup' : DEFAULT_SECTION_ID;
}

/** First-element query keys owned by settings sections — tab switches
 *  invalidate only these, not the whole app cache. */
const SETTINGS_QUERY_DOMAINS = new Set([
  'audit',
  'brain-config',
  'ci-conversations',
  'ci-details',
  'computer-apps',
  'computer-roots',
  'external-access',
  'feature-flow-events',
  'feature-inventory',
  'gateway-status',
  'harness-evals',
  'harness-trends',
  'health',
  'host-agent',
  'host-agent-status',
  'inject-aug-on-proxy',
  'integrations',
  'integrations-connections',
  'integrations-mcp',
  'models',
  'mp-aggregated-models',
  'mp-providers',
  'observability',
  'observations',
  'privacy-summary',
  'providers',
  'quota',
  'recurring-tasks',
  'rollback',
  'routing-best-by-task',
  'routing-decisions',
  'ta-activity',
  'ta-requests',
  'ta-stats',
  'tc-connections',
  'tc-host-agent',
  'usage',
]);

export function SettingsPage() {
  const params = useParams<{ section?: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const rawSection = params.section;
  const landingSectionId = useLandingSectionId();
  // Hub IA: rawSection can be a category id (e.g. "models") or a legacy section/category.
  const mappedRaw = rawSection ? (LEGACY_HUB_MAP[rawSection] ?? rawSection) : rawSection;
  const rawIsHub = isHubId(mappedRaw ?? null);
  const resolvedSectionId = mappedRaw && !rawIsHub ? resolveLegacyTab(mappedRaw) : null;
  const activeId = rawIsHub ? mappedRaw! : mappedRaw ? resolvedSectionId! : landingSectionId;
  const isHub = isHubId(activeId);
  const active: SettingsSection | null = isHub
    ? null
    : (SETTINGS_SECTIONS.find((s) => s.id === activeId) ?? SETTINGS_SECTIONS[0]);
  const prevSectionRef = useRef(activeId);

  // Normalize bare /settings → /settings/<default> so deep links and the
  // left rail stay in sync without remounting this page.
  // Also rewrite legacy ?tab=<id> query links used by older sidebar nav.
  useEffect(() => {
    const tabQuery = searchParams.get('tab');
    const sectionQuery = searchParams.get('section');

    if (!rawSection && tabQuery) {
      const id = resolveLegacyTab(tabQuery);
      const qs = sectionQuery ? `?section=${encodeURIComponent(sectionQuery)}` : '';
      void navigate(`/settings/${id}${qs}`, { replace: true });
      return;
    }

    if (!rawSection) {
      void navigate(`/settings/${landingSectionId}`, { replace: true });
      return;
    }
    // Rewrite legacy aliases in the URL (e.g. /settings/traffic → traffic-activity).
    // For hubs, rawSection is the hub id itself — no rewrite.
    if (!isHub && rawSection !== activeId) {
      const qs = sectionQuery ? `?section=${encodeURIComponent(sectionQuery)}` : '';
      void navigate(`/settings/${activeId}${qs}`, { replace: true });
    }
  }, [rawSection, activeId, isHub, navigate, searchParams, landingSectionId]);

  // Tab switch: remounted section queries may still be within the global
  // 5s staleTime. Invalidate only the settings-domain keys so the newly
  // active tab hits the network — a bare invalidateQueries() refetched
  // every app query (chat-side hooks included) on each tab switch.
  useEffect(() => {
    if (prevSectionRef.current === activeId) return;
    prevSectionRef.current = activeId;
    void queryClient.invalidateQueries({
      predicate: (q) => SETTINGS_QUERY_DOMAINS.has(String(q.queryKey[0] ?? '')),
    });
  }, [activeId, queryClient]);

  const SectionComponent = SECTION_COMPONENTS[activeId] ?? SettingsStub;

  return (
    <WorkspaceShell
      sections={SETTINGS_SECTIONS as unknown as WorkspaceSectionMeta[]}
      active={activeId}
    >
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={activeId}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={{ duration: 0.15, ease: [0.16, 1, 0.3, 1] }}
          className="h-full min-h-0"
        >
          {isHub ? (
            <CategoryHub categoryId={activeId} />
          ) : (
            <React.Suspense fallback={<SettingsSectionLoader />}>
              <SectionComponent active={active!} />
            </React.Suspense>
          )}
        </motion.div>
      </AnimatePresence>
    </WorkspaceShell>
  );
}

function CategoryHub({ categoryId }: { categoryId: string }) {
  const cat = SETTINGS_CATEGORIES.find((c) => c.id === categoryId);
  const sections = sectionsForCategory(categoryId).filter((s) => s.tier !== 'hidden');
  const [activeTab, setActiveTab] = React.useState<string>(() => sections[0]?.id ?? categoryId);
  React.useEffect(() => {
    if (sections.length > 0 && !sections.some((s) => s.id === activeTab)) {
      setActiveTab(sections[0].id);
    }
  }, [categoryId, sections, activeTab]);
  if (!cat) return null;
  const activeSection = sections.find((s) => s.id === activeTab) ?? sections[0];
  const ActiveComp = activeSection ? SECTION_COMPONENTS[activeSection.id] : null;
  return (
    <div className="min-h-0 max-w-5xl mx-auto px-6 py-6">
      <div className="mb-4">
        <h1 className="text-[22px] font-semibold tracking-tight text-foreground">{cat.label}</h1>
        <p className="mt-1 text-[13px] text-muted-foreground">{cat.description}</p>
      </div>
      {sections.length > 1 && (
        <div className="mb-6 flex gap-1.5 overflow-x-auto pb-1 scrollbar-none" role="tablist">
          {sections.map((s) => {
            const isActive = s.id === activeTab;
            return (
              <button
                key={s.id}
                role="tab"
                aria-selected={isActive}
                onClick={() => setActiveTab(s.id)}
                className={`shrink-0 rounded-full px-3 py-1.5 text-[12px] font-medium whitespace-nowrap transition ${
                  isActive
                    ? 'bg-foreground text-background shadow-sm'
                    : 'bg-muted/40 text-muted-foreground hover:bg-muted hover:text-foreground border border-border/40'
                }`}
              >
                {s.label}
              </button>
            );
          })}
        </div>
      )}
      {activeSection && ActiveComp ? (
        <React.Suspense fallback={<SettingsSectionLoader />}>
          <ActiveComp active={activeSection} />
        </React.Suspense>
      ) : null}
    </div>
  );
}

/** Minimal lazy-section fallback — keeps the rail interactive while the
 *  section chunk loads. */
function SettingsSectionLoader() {
  return (
    <div className="flex h-full min-h-0 items-center justify-center" data-testid="settings-section-loader">
      <div className="size-5 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
    </div>
  );
}

interface SectionProps {
  active: SettingsSection;
}


/** Phase 5: settings sections are lazy-loaded (Suspense below) so the
 *  Settings shell does not pull ~30 section components into the cold path. */
function lazySection(
  load: () => Promise<unknown>,
  name: string,
): React.ComponentType<SectionProps> {
  return React.lazy<React.ComponentType<SectionProps>>(async () => {
    const m = (await load()) as Record<string, React.ComponentType<SectionProps>>;
    const C = m[name];
    return { default: C };
  });
}

const ComputerAccessSettingsWrapper = lazySection(() => import('./ComputerAccessSettings'), 'ComputerAccessSettings');
const ObservabilitySectionWrapper = lazySection(() => import('./ObservabilitySection'), 'ObservabilitySection');
const BackendMonitorWrapper = lazySection(() => import('./BackendMonitorSection'), 'BackendMonitorSection');
const FeatureFlowWrapper = lazySection(() => import('./FeatureFlowSection'), 'FeatureFlowSection');
const ExternalAccessWrapper = lazySection(() => import('./ExternalAccessSection'), 'ExternalAccessSection');
const AppUpdatesWrapper = lazySection(() => import('./UpdateSection'), 'UpdateSection');
const UsageWrapper = lazySection(() => import('@/sections/workspace/WorkspaceUsageSection'), 'WorkspaceUsageSection');
const MemoryHubWrapper = lazySection(() => import('./MemoryHubSection'), 'MemoryHubSection');
const RecurringTasksWrapper = lazySection(() => import('./RecurringTasksSection'), 'RecurringTasksSection');
const InspectorWrapper = lazySection(() => import('@/sections/workspace/WorkspaceInspectorSection'), 'WorkspaceInspectorSection');
const ModelsWrapper = lazySection(() => import('@/sections/workspace/WorkspaceModelsSection'), 'WorkspaceModelsSection');
const AccountWrapper = lazySection(() => import('./AccountSection'), 'AccountSection');
const GeneralWrapper = lazySection(() => import('@/sections/workspace/WorkspaceGeneralSection'), 'WorkspaceGeneralSection');
const ProfilePreferencesWrapper = lazySection(() => import('./ProfilePreferencesSection'), 'ProfilePreferencesSection');
const SystemHealthWrapper = lazySection(() => import('./SystemHealthSection'), 'SystemHealthSection');
const ToolsConnectionsWrapper = lazySection(() => import('./IntegrationsSection'), 'IntegrationsSection');
const ConversationsHistoryWrapper = lazySection(() => import('./ConversationsHistorySection'), 'ConversationsHistorySection');
const AgentsAutomationWrapper = lazySection(() => import('./AgentsAutomationSection'), 'AgentsAutomationSection');
const SkillsWrapper = lazySection(() => import('./SkillsSection'), 'SkillsSection');
const ComputerUseWrapper = lazySection(() => import('./ComputerUseSection'), 'ComputerUseSection');
const KanbanWrapper = lazySection(() => import('./KanbanSection'), 'KanbanSection');
const AgentSandboxWrapper = lazySection(() => import('./AccessHubSection'), 'AccessHubSection');
const PromptTemplatesWrapper = lazySection(() => import('./PromptTemplatesSection'), 'PromptTemplatesSection');
const ReliabilityWrapper = lazySection(() => import('./ReliabilitySection'), 'ReliabilitySection');
const PrivacyWrapper = lazySection(() => import('./PrivacySection'), 'PrivacySection');
const HealthSimulatorWrapper = lazySection(() => import('./HealthSimulatorSection'), 'HealthSimulatorSection');
const AISetupWizardWrapper = lazySection(() => import('./AISetupWizardSection'), 'AISetupWizardSection');

const SECTION_COMPONENTS: Record<string, React.ComponentType<SectionProps>> = {
  usage: UsageWrapper,
  memory: MemoryHubWrapper,
  'memory-knowledge': MemoryHubWrapper,
  'recalled-memory': MemoryHubWrapper,
  'added-memory': MemoryHubWrapper,
  'project-memories': MemoryHubWrapper,
  'recurring-tasks': RecurringTasksWrapper,
  'conversation-inspector': InspectorWrapper,
  'model-providers': ModelsWrapper,
  account: AccountWrapper,
  'profile-preferences': ProfilePreferencesWrapper,
  'ui-designer': ProfilePreferencesWrapper,
  'system-health': SystemHealthWrapper,
  'tools-connections': ToolsConnectionsWrapper,
  'conversations-history': ConversationsHistoryWrapper,
  'agents-automation': AgentsAutomationWrapper,
  'computer-access': ComputerAccessSettingsWrapper,
  // traffic-activity is now an alias for observability (handled by
  // resolveLegacyTab + legacyAliases in the registry), so no entry here.
  observability: ObservabilitySectionWrapper,
  'backend-monitor': BackendMonitorWrapper,
  'feature-flow': FeatureFlowWrapper,
  'skill-curator': SkillsWrapper,
  'skills-authoring': SkillsWrapper,
  skills: SkillsWrapper,
  'computer-use': ComputerUseWrapper,
  'api-access': ExternalAccessWrapper,
  'tool-grants': AgentSandboxWrapper,
  'agent-board': KanbanWrapper,
  'python-sandbox': AgentSandboxWrapper,
  'agent-sandbox': AgentSandboxWrapper,
  'app-updates': AppUpdatesWrapper,
  'prompt-templates': PromptTemplatesWrapper,
  reliability: ReliabilityWrapper,
  'ai-setup': AISetupWizardWrapper,
  privacy: PrivacyWrapper,
  'health-simulator': HealthSimulatorWrapper,
};



/** Placeholder for sections not yet wired. With all 10 entries now
 *  mapped, this only renders for genuinely-unknown :section params. */
function SettingsStub({ active }: SectionProps) {
  return (
    <div className="px-8 py-12 max-w-2xl">
      <h1 className="text-2xl font-semibold tracking-tight text-foreground">{active.label}</h1>
      <p className="mt-2 text-sm text-muted-foreground">{active.description}</p>
      <div className="mt-8 rounded-xl border border-white/[0.06] bg-card/60 p-6">
        <p className="text-sm text-muted-foreground">
          This section hasn&apos;t been migrated to the new visual style yet. Use the left rail to
          switch to one of the available sections.
        </p>
      </div>
    </div>
  );
}
