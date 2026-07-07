/* ── SettingsPage — full-screen settings page (replaces modal) ───────── */
/* Mounted by ChatLayout at /settings/* routes. Renders the same dark,
 * left-rail + content layout as the workspace panel, but lives at the
 * /settings path so deep links, the command palette, and the titlebar
 * Settings button all route here. Section id is resolved via the same
 * legacy alias map used by the previous modal (so old /settings/:tab
 * URLs continue to resolve). */

import { useParams } from 'react-router-dom';
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
import { ToolsConnectionsSection } from './ToolsConnectionsSection';
import { ConversationsHistorySection } from './ConversationsHistorySection';
import { AgentsAutomationSection } from './AgentsAutomationSection';
import { DeveloperConsoleSection } from './DeveloperConsoleSection';
import { ComputerAccessSettings } from './ComputerAccessSettings';
import { ObservabilitySection } from './ObservabilitySection';
import { BackendMonitorSection } from './BackendMonitorSection';
import { CuratorSection } from './CuratorSection';
import { SkillsAuthoringSection } from './SkillsAuthoringSection';
import { ComputerUseSection } from './ComputerUseSection';
import { ExternalAccessSection } from './ExternalAccessSection';

/** The default section when no :section param is present. The user
 *  said clicking Settings should land on Model settings. */
const DEFAULT_SECTION_ID = 'model-providers';

export function SettingsPage() {
  const params = useParams<{ section?: string }>();
  const activeId = params.section ? resolveLegacyTab(params.section) : DEFAULT_SECTION_ID;
  const active: SettingsSection =
    SETTINGS_SECTIONS.find((s) => s.id === activeId) ?? SETTINGS_SECTIONS[0];

  const SectionComponent = SECTION_COMPONENTS[active.id] ?? SettingsStub;

  return (
    <WorkspaceShell
      sections={SETTINGS_SECTIONS as unknown as WorkspaceSectionMeta[]}
      active={active.id}
    >
      <SectionComponent active={active} />
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
  'conversation-inspector': InspectorWrapper,
  'model-providers': ModelsWrapper,
  'brain-orchestrator': BrainWrapper,
  'profile-preferences': GeneralWrapper,
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
  'skill-curator': CuratorWrapper,
  'skills-authoring': SkillsAuthoringWrapper,
  'computer-use': ComputerUseWrapper,
  'api-access': ExternalAccessWrapper,
};

function ComputerAccessSettingsWrapper() { return <ComputerAccessSettings />; }
function ObservabilitySectionWrapper() { return <ObservabilitySection />; }
function BackendMonitorWrapper() { return <BackendMonitorSection />; }
function ExternalAccessWrapper() { return <ExternalAccessSection />; }

function UsageWrapper() { return <WorkspaceUsageSection />; }
function MemoryWrapper() { return <WorkspaceMemorySection />; }
function InspectorWrapper() { return <WorkspaceInspectorSection />; }
function ModelsWrapper() { return <WorkspaceModelsSection />; }
function BrainWrapper() { return <BrainSettings />; }
function GeneralWrapper() { return <WorkspaceGeneralSection />; }
function SystemHealthWrapper() { return <SystemHealthSection />; }
function ToolsConnectionsWrapper() { return <ToolsConnectionsSection />; }
function ConversationsHistoryWrapper() { return <ConversationsHistorySection />; }
function AgentsAutomationWrapper() { return <AgentsAutomationSection />; }
function DeveloperConsoleWrapper() { return <DeveloperConsoleSection />; }
function CuratorWrapper() { return <CuratorSection />; }
function SkillsAuthoringWrapper() { return <SkillsAuthoringSection />; }
function ComputerUseWrapper() { return <ComputerUseSection />; }

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
