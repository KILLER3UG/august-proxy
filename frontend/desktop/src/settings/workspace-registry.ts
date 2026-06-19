/* ── workspace-registry — IA for the chat-side workspace panel ───────── */
/* Mirrors settings-registry.ts shape. Drives the WorkspaceShell nav and
 * route resolution. Sections here are the data-dense ones from the
 * screenshot — non-data sections (Skills, MCP Servers, Plugins, etc.)
 * stay in the modal SettingsOverlay for this round. */

import type { LucideIcon } from 'lucide-react';
import {
  BarChart3,
  Activity,
  Brain,
  Search,
  SlidersHorizontal,
  Boxes,
} from 'lucide-react';

export interface WorkspaceSectionMeta {
  id: string;
  label: string;
  description: string;
  icon: LucideIcon;
  category: string;
  /** Default sub-tab for the section's subnav (if it has one). */
  defaultSubtab?: string;
}

export const WORKSPACE_SECTIONS: readonly WorkspaceSectionMeta[] = [
  {
    id: 'usage',
    label: 'Usage',
    description: 'Token usage, sessions, activity heatmap, and per-model breakdown.',
    icon: BarChart3,
    category: 'general',
    defaultSubtab: 'app',
  },
  {
    id: 'memory',
    label: 'Memory',
    description: 'Knowledge graph, semantic facts, vector entries, and the system prompt.',
    icon: Brain,
    category: 'general',
  },
  {
    id: 'traffic',
    label: 'Traffic',
    description: 'Live request stream, errors, and average duration.',
    icon: Activity,
    category: 'monitoring',
  },
  {
    id: 'inspector',
    label: 'Inspector',
    description: 'Read a request as a conversation, view raw bodies, or see its thinking.',
    icon: Search,
    category: 'monitoring',
  },
  {
    id: 'models',
    label: 'Model settings',
    description: 'Manage custom model providers and their models.',
    icon: Boxes,
    category: 'chat',
  },
  {
    id: 'general',
    label: 'General',
    description: 'Theme, experience presets, keyboard shortcuts, and onboarding.',
    icon: SlidersHorizontal,
    category: 'general',
  },
] as const;

export const WORKSPACE_CATEGORIES: readonly { id: string; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'chat', label: 'Chat' },
  { id: 'monitoring', label: 'Monitoring' },
] as const;

export function getWorkspaceSection(id: string | null | undefined): WorkspaceSectionMeta {
  return (
    WORKSPACE_SECTIONS.find((s) => s.id === id) ??
    WORKSPACE_SECTIONS[0]
  );
}
