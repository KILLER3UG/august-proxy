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
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import {
  resolveLegacyTab,
  SETTINGS_SECTIONS,
  SETTINGS_CATEGORIES,
  getSection,
  sectionsForCategory,
  type SettingsSection,
} from '@/settings/settings-registry';
import { WorkspaceShell, type WorkspaceSectionMeta } from '@/components/workspace/WorkspaceShell';
import { MOBILE_QUERY, useMediaQuery } from '@/hooks/useMediaQuery';
import { SectionHeader as PanelHeader } from '@/components/SectionHeader';

/** Header IA: 4 header groups (Setup / Agent / Data / App), the fourth added
 *  after the 2026-08-28 restructure. They head search results; `c5748da0` made
 *  the plain rail a flat list. */
const HUB_CATEGORY_IDS = new Set(SETTINGS_CATEGORIES.map((c) => c.id));
const LEGACY_HUB_MAP: Record<string, string> = {
  settings: 'basics',
  system: 'basics',
  intelligence: 'capabilities',
  insights: 'data',
  tools: 'plugins',
  access: 'agent-sandbox',
  security: 'agent-sandbox',
};
function isHubId(id: string | null | undefined): boolean {
  return !!id && HUB_CATEGORY_IDS.has(id);
}

/** The default section when no :section param is present. General is the
 *  landing page (profile + preferences), mirroring the reference design. */
const DEFAULT_SECTION_ID = 'general';

/** Bare /settings lands on General. It used to detour to the guided AI Setup
 *  wizard while first-run setup was incomplete; that door is gone, and the
 *  checklist it drove is still reachable from the provider card, so the landing
 *  page is now the same for a fresh install and a settled one. */
function useLandingSectionId(): string {
  return DEFAULT_SECTION_ID;
}

/** First-element query keys owned by settings sections — tab switches
 *  invalidate only these, not the whole app cache. */
const SETTINGS_QUERY_DOMAINS = new Set([
  'audit',
  'brain-config',
  'brain-store',
  'brain-stores',
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
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  // Measured in the running app, not inferred: with the dialog mounted by
  // ChatLayout's NESTED `<Routes>`, `params.section` kept the value the panel
  // first mounted while `location.pathname` moved correctly — so the rail
  // changed the URL and never changed the section. Read the path first and fall
  // back to the param for mounts that rewrite it (bare `/settings`, tests that
  // render this page under their own route).
  // The router matched this page case-INSENSITIVELY (`/Settings/Appearance`
  // reaches it), so every lookup below has to be too — an id keyed on the raw
  // casing fell through `LEGACY_HUB_MAP`, `isHubId`, `resolveLegacyTab` and
  // `getSection` all at once, landed on General, and then rewrote the URL to
  // match. The user's deep link was silently gone with nothing to show it had
  // been read at all. Section ids are lowercase by construction, so normalising
  // here loses nothing and covers the whole chain.
  const rawSection = (
    location.pathname.match(/^\/settings\/([^/?#]+)/i)?.[1] ?? params.section
  )?.toLowerCase();
  const landingSectionId = useLandingSectionId();
  // Hub IA: rawSection can be a category id (e.g. "models") or a legacy section/category.
  const mappedRaw = rawSection ? (LEGACY_HUB_MAP[rawSection] ?? rawSection) : rawSection;
  const rawIsHub = isHubId(mappedRaw ?? null);
  // Hub IA v2: a bare category id resolves to the category's first visible
  // section — the left rail's tree shows all children, and there are no
  // in-page pill tabs anymore.
  const firstSectionOfCategory = (catId: string): string | null =>
    sectionsForCategory(catId).find(
      (s) => s.tier !== 'hidden' && isImplementedSettingsSection(s.id),
    )?.id ?? null;
  const hubTargetId = rawIsHub ? firstSectionOfCategory(mappedRaw!) : null;
  const requestedSectionId = hubTargetId ?? (mappedRaw && !rawIsHub ? resolveLegacyTab(mappedRaw) : null);
  const requestedSection = requestedSectionId ? getSection(requestedSectionId) : undefined;
  const activeId =
    requestedSection && isImplementedSettingsSection(requestedSection.id)
      ? requestedSection.id
      : (requestedSection
          ? firstSectionOfCategory(requestedSection.category)
          : null) ?? landingSectionId;
  const active: SettingsSection =
    SETTINGS_SECTIONS.find((s) => s.id === activeId) ?? SETTINGS_SECTIONS[0];
  const prevSectionRef = useRef(activeId);
  /* The phone tier: `/settings` without a section is the catalog screen, and a
   * section is a pushed view over it. Bound to the same 760px as the shell's
   * phone chrome (hooks/useMediaQuery.ts). */
  const mobile = useMediaQuery(MOBILE_QUERY);
  const mobileHome = mobile && !rawSection;

  // Normalize bare /settings → /settings/<default> so deep links and the
  // left rail stay in sync without remounting this page.
  // Also rewrite legacy ?tab=<id> query links used by older sidebar nav.
  useEffect(() => {
    const tabQuery = searchParams.get('tab');
    // `?section` (scope) and `?field` (control deep link) both survive the
    // query → path rewrite: dropping either would land the user on the right
    // tab with half of what they asked for already gone from the URL.
    const carry = new URLSearchParams();
    for (const key of ['section', 'field'] as const) {
      const value = searchParams.get(key);
      if (value) carry.set(key, value);
    }
    const carried = carry.toString();
    const qs = carried ? `?${carried}` : '';

    if (!rawSection && tabQuery) {
      const id = resolveLegacyTab(tabQuery.toLowerCase());
      void navigate(`/settings/${id}${qs}`, { replace: true });
      return;
    }

    if (!rawSection) {
      // A phone treats /settings as the section catalog; normalising it to the
      // landing section would make the list unreachable (and the back row
      // would bounce straight back into a section).
      if (mobile) return;
      void navigate(`/settings/${landingSectionId}`, { replace: true });
      return;
    }
    // Rewrite legacy aliases in the URL (e.g. /settings/traffic → traffic-activity).
    // Hub ids resolve to their first section — rewrite so the rail tree and
    // URL always point at a real section.
    if (rawSection !== activeId) {
      void navigate(`/settings/${activeId}${qs}`, { replace: true });
    }
  }, [rawSection, activeId, navigate, searchParams, landingSectionId, mobile]);

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

  const SectionComponent = SECTION_COMPONENTS[activeId];
  const implementedSections = SETTINGS_SECTIONS.filter((s) =>
    isImplementedSettingsSection(s.id),
  ) as WorkspaceSectionMeta[];

  return (
    <WorkspaceShell
      sections={implementedSections}
      active={activeId}
      mobile={mobile}
      mobileHome={mobileHome}
    >
      {mobileHome ? null : (
        <>
      {/* The phone's topbar already names the section and the back row says
          where it returns to, so the hero is desktop-only — it would spend a
          third of a 390px screen restating the same thing. */}
      {!mobile && (
      <div className="mx-auto w-full max-w-5xl px-8 pb-1 pt-8">
        {/* The mockup's page head, verbatim: mono eyebrow, serif display
            title, one-line sub. The section content below keeps the app's
            own max-width column. */}
        <header className="page-head">
          <div>
            <div className="page-eyebrow">Workspace / preferences</div>
            <h1 className="page-title">Settings</h1>
            <p className="page-sub">Tune the surface, the models, and how August remembers your work.</p>
          </div>
        </header>
      </div>
      )}
      {/* The 150 ms cross-fade was an `AnimatePresence mode="wait"` around a
          keyed motion.div. `mode="wait"` mounts the incoming section only after
          the outgoing one reports its exit as COMPLETE — and in the settings
          DIALOG mount (ChatLayout's descendant `<Routes>`, under `inert`ed
          shell siblings) that callback never fired, so the panel kept the first
          section it mounted while the URL and `activeId` moved correctly.
          Measured in the running app: click Skills from General and the DOM still
          holds General with no loader and opacity 1, at 700 ms and at 3.2 s.
          The key stays — it is what remounts the section so it refetches on
          entry — the presence gate goes. A section that swaps without fading is
          a smaller loss than one that never swaps. */}
      <div key={activeId} className="h-full min-h-0">
        <div className="min-h-0">
          <SectionHeader active={active} />
          {SectionComponent ? (
            <React.Suspense fallback={<SettingsSectionLoader />}>
              <SectionComponent active={active} />
            </React.Suspense>
          ) : null}
        </div>
      </div>
        </>
      )}
    </WorkspaceShell>
  );
}

/** Compact header for sections that render no heading of their own (the
 *  models tree children, previously titled by the removed wrapper). Every
 *  settings section title is an h2 now (the a11y sweep), so this header —
 *  like the sections' own — anchors at level 2. */
const HEADERLESS_SECTION_IDS = new Set([
  'model-providers',
  'model-catalog',
  'model-aliases',
  'model-fallback',
  'model-reflection',
  'model-fleet',
  'model-live',
  'model-quotas',
  'model-families',
]);

function SectionHeader({ active }: { active: SettingsSection }) {
  if (!HEADERLESS_SECTION_IDS.has(active.id)) return null;
  /* The shipped standard, not a second set of sizes: 20px title, 13px
     muted subtitle, no icon. This header was rolling its own 22px title. */
  return (
    <div className="mx-auto w-full max-w-5xl px-8 pt-6">
      <PanelHeader title={active.label} subtitle={active.description} className="mb-3" />
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
    // Callers pass either a raw module (name lookup) or a pre-mapped
    // { default } — some loaders .then()-map and then still pass the name,
    // so falling back to default keeps both shapes alive. Without this,
    // m[name] on a { default } module resolved to undefined and React
    // threw "Lazy element type must resolve to a class or function"
    // (Subagents/Plugins/Browser tabs, wired 2026-09-07).
    const C = m[name] ?? (m as { default?: React.ComponentType<SectionProps> }).default;
    return { default: C };
  });
}

const ComputerAccessSettingsWrapper = lazySection(() => import('./ComputerAccessSettings'), 'ComputerAccessSettings');
const ObservabilitySectionWrapper = lazySection(() => import('./ObservabilitySection'), 'ObservabilitySection');
const BackendMonitorWrapper = lazySection(() => import('./BackendMonitorSection'), 'BackendMonitorSection');
const FeatureFlowWrapper = lazySection(() => import('./FeatureFlowSection'), 'FeatureFlowSection');
const ExternalAccessWrapper = lazySection(() => import('./ExternalAccessSection'), 'ExternalAccessSection');
const SelfEditWrapper = lazySection(() => import('./SelfEditSection'), 'SelfEditSection');
const AppUpdatesWrapper = lazySection(() => import('./UpdateSection'), 'UpdateSection');
const BrowserUseWrapper = lazySection(
  () => import('./CapabilitySections').then((m) => ({ default: m.BrowserUseSection })),
  'BrowserUseSection',
);
const UsageWrapper = lazySection(() => import('@/sections/workspace/WorkspaceUsageSection'), 'WorkspaceUsageSection');
const RecurringTasksWrapper = lazySection(() => import('./RecurringTasksSection'), 'RecurringTasksSection');
const InspectorWrapper = lazySection(() => import('@/sections/workspace/WorkspaceInspectorSection'), 'WorkspaceInspectorSection');
const ModelProvidersWrapper = lazySection(
  () => import('@/sections/workspace/models/ProvidersTab'),
  'ProvidersTab',
);
const ModelCatalogWrapper = lazySection(
  () => import('@/sections/workspace/models/AllModelsTab'),
  'AllModelsTab',
);
const ModelAliasesWrapper = lazySection(
  () => import('@/sections/workspace/models/AliasesTab'),
  'AliasesTab',
);
const ModelFallbackWrapper = lazySection(
  () => import('@/sections/workspace/models/FallbackTab'),
  'FallbackTab',
);
const ModelReflectionWrapper = lazySection(
  () => import('@/sections/workspace/models/BackgroundReflectionTab'),
  'BackgroundReflectionTab',
);
const ModelFleetWrapper = lazySection(
  () => import('@/sections/workspace/ModelFleetTab'),
  'ModelFleetTab',
);
const ModelQuotasWrapper = lazySection(
  () => import('@/sections/workspace/models/QuotasTab'),
  'QuotasTab',
);
const ModelLiveWrapper = lazySection(
  () => import('@/sections/workspace/LiveSettingsTab'),
  'LiveSettingsTab',
);
const AccountWrapper = lazySection(() => import('./AccountSection'), 'AccountSection');
const GeneralWrapper = lazySection(() => import('./GeneralSection'), 'GeneralSection');
const AppearanceWrapper = lazySection(() => import('./AppearanceSection'), 'AppearanceSection');
const SystemHealthWrapper = lazySection(() => import('./SystemHealthSection'), 'SystemHealthSection');
const ToolsConnectionsWrapper = lazySection(() => import('./IntegrationsSection'), 'IntegrationsSection');
const SkillsWrapper = lazySection(() => import('./SkillsSection'), 'SkillsSection');
const ModelFamiliesWrapper = lazySection(() => import('./ModelFamiliesSection'), 'ModelFamiliesSection');
const ConversationsHistoryWrapper = lazySection(() => import('./ConversationsHistorySection'), 'ConversationsHistorySection');
const AgentsAutomationWrapper = lazySection(() => import('./AgentsAutomationSection'), 'AgentsAutomationSection');
const ComputerUseWrapper = lazySection(() => import('./ComputerUseSection'), 'ComputerUseSection');
const AgentSandboxWrapper = lazySection(() => import('./AccessHubSection'), 'AccessHubSection');
const PromptTemplatesWrapper = lazySection(() => import('./PromptTemplatesSection'), 'PromptTemplatesSection');
const PrivacyWrapper = lazySection(() => import('./PrivacySection'), 'PrivacySection');
const PhonePairingWrapper = lazySection(() => import('./PhonePairingSection'), 'PhonePairingSection');
const MemoryWrapper = lazySection(() => import('./MemorySection'), 'MemorySection');
const LibraryWrapper = lazySection(() => import('./LibrarySection'), 'LibrarySection');
const GoalsWrapper = lazySection(() => import('./GoalsSection'), 'GoalsSection');
const HealthSimulatorWrapper = lazySection(() => import('./HealthSimulatorSection'), 'HealthSimulatorSection');

export const SECTION_COMPONENTS: Record<string, React.ComponentType<SectionProps>> = {
  usage: UsageWrapper,
  'recurring-tasks': RecurringTasksWrapper,
  'conversation-inspector': InspectorWrapper,
  'model-providers': ModelProvidersWrapper,
  'model-catalog': ModelCatalogWrapper,
  'model-aliases': ModelAliasesWrapper,
  'model-fallback': ModelFallbackWrapper,
  'model-reflection': ModelReflectionWrapper,
  'model-fleet': ModelFleetWrapper,
  'model-live': ModelLiveWrapper,
  'model-quotas': ModelQuotasWrapper,
  // Browser Use keeps its door. The subagent limits and the turn bounds lost
  // theirs deliberately: the keys stay live in the backend and are set from the
  // config file, so removing the panel changes no behaviour — it only removes a
  // number most installs should never tune. `plugins` below is the single merged
  // door for plugins and MCP servers.
  'browser-use': BrowserUseWrapper,
  account: AccountWrapper,
  general: GeneralWrapper,
  appearance: AppearanceWrapper,
  'ui-designer': AppearanceWrapper,
  'system-health': SystemHealthWrapper,
  // Merged: the old `tools-connections` door and the read-only plugin
  // roster are one door now, and it is the writable integrations panel.
  plugins: ToolsConnectionsWrapper,
  // The Library is the browse surface for both doors; the old panels stay
  // mounted as the hidden `*-tools` doors so nothing they own is unreachable.
  skills: LibraryWrapper,
  'skills-tools': SkillsWrapper,
  'model-families': ModelFamiliesWrapper,
  'conversations-history': ConversationsHistoryWrapper,
  'agents-automation': AgentsAutomationWrapper,
  'computer-access': ComputerAccessSettingsWrapper,
  observability: ObservabilitySectionWrapper,
  'backend-monitor': BackendMonitorWrapper,
  'feature-flow': FeatureFlowWrapper,
  'computer-use': ComputerUseWrapper,
  'api-access': ExternalAccessWrapper,
  'self-edit': SelfEditWrapper,
  'tool-grants': AgentSandboxWrapper,
  'python-sandbox': AgentSandboxWrapper,
  'kernel-venv': AgentSandboxWrapper,
  'agent-sandbox': AgentSandboxWrapper,
  'app-updates': AppUpdatesWrapper,
  'phone-pairing': PhonePairingWrapper,
  'prompt-templates': PromptTemplatesWrapper,
  privacy: PrivacyWrapper,
  // The Memory door is the grouped list — You / Topics / Areas, the shape the
  // reference shows and the one a person can actually read. The Library table
  // is still the power view behind `memory-facts`, and the Skills door keeps
  // opening it in its own tab.
  'memory-knowledge': MemoryWrapper,
  goals: GoalsWrapper,
  'memory-facts': LibraryWrapper,
  // The switches, the store budget, the consolidation pass and the backups
  // still live on the old page — one implementation, reached from the
  // Library's "All tools" button and from Settings search.
  'memory-tools': MemoryWrapper,
  'health-simulator': HealthSimulatorWrapper,
};

function isImplementedSettingsSection(id: string): boolean {
  return Object.hasOwn(SECTION_COMPONENTS, id);
}
