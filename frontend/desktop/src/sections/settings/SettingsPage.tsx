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

import { useEffect, useRef } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { useQueryClient } from '@tanstack/react-query';
import {
  resolveLegacyTab,
  SETTINGS_SECTIONS,
  type SettingsSection,
} from '@/settings/settings-registry';
import { WorkspaceShell, type WorkspaceSectionMeta } from '@/components/workspace/WorkspaceShell';
import { WorkspaceUsageSection } from '@/sections/workspace/WorkspaceUsageSection';
import { WorkspaceMemorySection } from '@/sections/workspace/WorkspaceMemorySection';
import { WorkspaceInspectorSection } from '@/sections/workspace/WorkspaceInspectorSection';
import { WorkspaceModelsSection } from '@/sections/workspace/WorkspaceModelsSection';
import { WorkspaceGeneralSection } from '@/sections/workspace/WorkspaceGeneralSection';
import { BrainSettings } from '@/sections/overview/BrainSettings';
import { SystemHealthSection } from './SystemHealthSection';
import { IntegrationsSection } from './IntegrationsSection';
import { ConversationsHistorySection } from './ConversationsHistorySection';
import { AgentsAutomationSection } from './AgentsAutomationSection';
import { DeveloperConsoleSection } from './DeveloperConsoleSection';
import { ComputerAccessSettings } from './ComputerAccessSettings';
import { ObservabilitySection } from './ObservabilitySection';
import { BackendMonitorSection } from './BackendMonitorSection';
import { FeatureFlowSection } from './FeatureFlowSection';
import { SkillsSection } from './SkillsSection';
import { ComputerUseSection } from './ComputerUseSection';
import { ExternalAccessSection } from './ExternalAccessSection';
import { PlansSection } from './PlansSection';
import { UiDesignerSection } from './UiDesignerSection';
import { ToolGrantsSection } from './ToolGrantsSection';
import { KanbanSection } from './KanbanSection';
import { PythonSandboxSection } from './PythonSandboxSection';
import { AgentSandboxSection } from './AgentSandboxSection';
import { AccountSection } from './AccountSection';
import { UpdateSection } from './UpdateSection';
import { RecalledMemorySection } from './RecalledMemorySection';
import { AddedMemorySection } from './AddedMemorySection';

/** The default section when no :section param is present. The user
 *  said clicking Settings should land on Model settings. */
const DEFAULT_SECTION_ID = 'model-providers';

export function SettingsPage() {
  const params = useParams<{ section?: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const rawSection = params.section;
  const activeId = rawSection ? resolveLegacyTab(rawSection) : DEFAULT_SECTION_ID;
  const active: SettingsSection =
    SETTINGS_SECTIONS.find((s) => s.id === activeId) ?? SETTINGS_SECTIONS[0];
  const prevSectionRef = useRef(active.id);

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
      void navigate(`/settings/${DEFAULT_SECTION_ID}`, { replace: true });
      return;
    }
    // Rewrite legacy aliases in the URL (e.g. /settings/traffic → traffic-activity).
    if (rawSection !== active.id) {
      const qs = sectionQuery ? `?section=${encodeURIComponent(sectionQuery)}` : '';
      void navigate(`/settings/${active.id}${qs}`, { replace: true });
    }
  }, [rawSection, active.id, navigate, searchParams]);

  // Tab switch: remounted section queries may still be within the global
  // 5s staleTime. Invalidate so the newly active tab always hits the network
  // for real-time data without reloading the settings shell.
  useEffect(() => {
    if (prevSectionRef.current === active.id) return;
    prevSectionRef.current = active.id;
    void queryClient.invalidateQueries();
  }, [active.id, queryClient]);

  const SectionComponent = SECTION_COMPONENTS[active.id] ?? SettingsStub;

  return (
    <WorkspaceShell
      sections={SETTINGS_SECTIONS as unknown as WorkspaceSectionMeta[]}
      active={active.id}
    >
      {/* Content-only transition: shell/rail stay put; section remounts
          (via key) so each tab's useEffect / react-query runs for fresh data. */}
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={active.id}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={{ duration: 0.15, ease: [0.16, 1, 0.3, 1] }}
          className="h-full min-h-0"
        >
          <SectionComponent active={active} />
        </motion.div>
      </AnimatePresence>
    </WorkspaceShell>
  );
}

interface SectionProps {
  active: SettingsSection;
}

const SECTION_COMPONENTS: Record<string, React.ComponentType<SectionProps>> = {
  usage: UsageWrapper,
  memory: MemoryWrapper,
  'memory-knowledge': MemoryWrapper,
  'recalled-memory': RecalledMemoryWrapper,
  'added-memory': AddedMemoryWrapper,
  'conversation-inspector': InspectorWrapper,
  'model-providers': ModelsWrapper,
  'brain-orchestrator': BrainWrapper,
  account: AccountWrapper,
  'profile-preferences': GeneralWrapper,
  'ui-designer': UiDesignerWrapper,
  'system-health': SystemHealthWrapper,
  'tools-connections': ToolsConnectionsWrapper,
  'conversations-history': ConversationsHistoryWrapper,
  'agents-automation': AgentsAutomationWrapper,
  'developer-console': DeveloperConsoleWrapper,
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
  plans: PlansWrapper,
  'tool-grants': ToolGrantsWrapper,
  'agent-board': KanbanWrapper,
  'python-sandbox': PythonSandboxWrapper,
  'agent-sandbox': AgentSandboxWrapper,
  'app-updates': AppUpdatesWrapper,
};

function ComputerAccessSettingsWrapper() { return <ComputerAccessSettings />; }
function ObservabilitySectionWrapper() { return <ObservabilitySection />; }
function BackendMonitorWrapper() { return <BackendMonitorSection />; }
function FeatureFlowWrapper() { return <FeatureFlowSection />; }
function ExternalAccessWrapper() { return <ExternalAccessSection />; }
function AppUpdatesWrapper() { return <UpdateSection />; }

function UsageWrapper() { return <WorkspaceUsageSection />; }
function MemoryWrapper() { return <WorkspaceMemorySection />; }
function RecalledMemoryWrapper() { return <RecalledMemorySection />; }
function AddedMemoryWrapper() { return <AddedMemorySection />; }
function InspectorWrapper() { return <WorkspaceInspectorSection />; }
function ModelsWrapper() { return <WorkspaceModelsSection />; }
function BrainWrapper() { return <BrainSettings />; }
function AccountWrapper() { return <AccountSection />; }
function GeneralWrapper() { return <WorkspaceGeneralSection />; }
function UiDesignerWrapper() { return <UiDesignerSection />; }
function SystemHealthWrapper() { return <SystemHealthSection />; }
function ToolsConnectionsWrapper() { return <IntegrationsSection />; }
function ConversationsHistoryWrapper() { return <ConversationsHistorySection />; }
function AgentsAutomationWrapper() { return <AgentsAutomationSection />; }
function DeveloperConsoleWrapper() { return <DeveloperConsoleSection />; }
function SkillsWrapper() { return <SkillsSection />; }
function ComputerUseWrapper() { return <ComputerUseSection />; }
function PlansWrapper() { return <PlansSection />; }
function ToolGrantsWrapper() { return <ToolGrantsSection />; }
function KanbanWrapper() { return <KanbanSection />; }
function PythonSandboxWrapper() { return <PythonSandboxSection />; }
function AgentSandboxWrapper() { return <AgentSandboxSection />; }

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
