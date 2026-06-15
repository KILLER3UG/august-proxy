import * as React from 'react';
import { Suspense, lazy, type ReactNode } from 'react';
import { Navigate, useParams } from 'react-router-dom';
import {
  LayoutDashboard,
  Activity,
  MessagesSquare,
  Search,
  Brain,
  MessageSquare,
  Settings,
  type LucideIcon,
} from 'lucide-react';
import { ChatThread } from '@/sections/chat/ChatThread';
import { SettingsOverlay } from '@/components/overlays/SettingsOverlay';

export interface SectionRoute {
  path: string;
  label: string;
  Icon: LucideIcon;
  element: ReactNode;
  nav?: boolean;
}

export interface NavItem {
  to: string;
  label: string;
  Icon: LucideIcon;
  visible?: () => boolean | Promise<boolean>;
}

export interface SettingsTab {
  key: string;
  label: string;
  Icon: LucideIcon;
  path: string;
}

function ChatThreadWithParams() {
  const { sessionId } = useParams<{ sessionId: string }>();
  return React.createElement(ChatThread, { sessionId: sessionId ?? null });
}

export const SECTION_ROUTES: readonly SectionRoute[] = [
  { path: '/', label: 'Chat', Icon: MessageSquare, element: React.createElement(ChatThread, { sessionId: 'demo' }), nav: true },
  { path: '/c/:sessionId', label: 'Chat', Icon: MessageSquare, element: React.createElement(ChatThreadWithParams) },
  { path: '/dashboard', label: 'Dashboard', Icon: LayoutDashboard, element: React.createElement(Navigate, { to: '/settings?tab=overview', replace: true }), nav: false },
] as const;

export const SETTINGS_TABS: readonly SettingsTab[] = [
  { key: 'health', label: 'Health', Icon: Activity, path: '/settings/health' },
  { key: 'providers', label: 'Providers', Icon: LayoutDashboard, path: '/settings/providers' },
  { key: 'mcp', label: 'MCP & Skills', Icon: Settings, path: '/settings/mcp' },
  { key: 'memory', label: 'Memory', Icon: MessagesSquare, path: '/settings/memory' },
  { key: 'overview', label: 'Artifacts', Icon: LayoutDashboard, path: '/settings/overview' },
  { key: 'traffic', label: 'Traffic', Icon: Activity, path: '/settings/traffic' },
  { key: 'inspector', label: 'Inspector', Icon: Search, path: '/settings/inspector' },
  { key: 'conversations', label: 'Conversations', Icon: MessagesSquare, path: '/settings/conversations' },
  { key: 'thinking', label: 'Thinking', Icon: Brain, path: '/settings/thinking' },
  { key: 'logs', label: 'Logs', Icon: Search, path: '/settings/logs' },
  { key: 'models', label: 'Models', Icon: LayoutDashboard, path: '/settings/models' },
  { key: 'agents', label: 'Agents', Icon: Brain, path: '/settings/agents' },
  { key: 'terminal', label: 'Terminal', Icon: Settings, path: '/settings/terminal' },
  { key: 'automations', label: 'Automations', Icon: Settings, path: '/settings/automations' },
  { key: 'connections', label: 'Connections', Icon: Settings, path: '/settings/connections' },
] as const;

export const SETTINGS_ROUTES: readonly SectionRoute[] = [
  { path: '/settings', label: 'Settings', Icon: Settings, element: React.createElement(SettingsOverlay) },
  { path: '/settings/:tab', label: 'Settings', Icon: Settings, element: React.createElement(SettingsOverlay) },
] as const;

export const SECTION_NAV_ITEMS: readonly NavItem[] = SECTION_ROUTES.filter((route) => route.nav).map((route) => ({
  to: route.path,
  label: route.label,
  Icon: route.Icon,
})) as readonly NavItem[];

export const SETTINGS_NAV_ITEMS: readonly NavItem[] = SETTINGS_TABS.map((tab) => ({
  to: tab.path,
  label: tab.label,
  Icon: tab.Icon,
})) as readonly NavItem[];

export const NAV_ITEMS: readonly NavItem[] = SECTION_NAV_ITEMS;

export function resolveRouteLabel(pathname: string) {
  return SECTION_ROUTES.find((route) => pathname === route.path)?.label
    ?? SECTION_ROUTES.find((route) => route.path !== '/' && pathname.startsWith(route.path))?.label
    ?? SETTINGS_ROUTES.find((route) => pathname === route.path || pathname.startsWith(route.path))?.label
    ?? 'August';
}

export const SECTION_PATH = (to: string) => to;
