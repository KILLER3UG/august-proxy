import * as React from 'react';
import { type ReactNode } from 'react';
import { Navigate, useParams } from 'react-router-dom';
import {
  LayoutDashboard,
  MessageSquare,
  Settings,
  type LucideIcon,
} from 'lucide-react';
import { ChatThread } from '@/sections/chat/ChatThread';
import { SettingsPage } from '@/sections/settings/SettingsPage';
import { SETTINGS_SECTIONS } from '@/settings/settings-registry';

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
  { path: '/dashboard', label: 'Dashboard', Icon: LayoutDashboard, element: React.createElement(Navigate, { to: '/settings/traffic-activity', replace: true }), nav: false },
] as const;

/* Settings tabs are derived from the reduced settings registry so the
 * sidebar, routes, and command palette all stay in sync. The legacy 18
 * tab keys still resolve via the registry's LEGACY_TAB_MAP (see
 * resolveLegacyTab) — we just expose the 10 canonical entries here. */
export const SETTINGS_TABS: readonly SettingsTab[] = SETTINGS_SECTIONS.map((section) => ({
  key: section.id,
  label: section.label,
  Icon: section.icon,
  path: `/settings/${section.id}`,
})) as readonly SettingsTab[];

/* Settings is now a FULL-SCREEN page (no modal). The SettingsPage
 * component owns the left rail + content area; ChatLayout renders it
 * full-width and hides the chat thread + right drawer when the path is
 * /settings or /settings/:section. The :section param is resolved via
 * the existing legacy alias map so old URLs (e.g. /settings/traffic)
 * continue to work. */
export const SETTINGS_ROUTES: readonly SectionRoute[] = [
  { path: '/settings', label: 'Settings', Icon: Settings, element: React.createElement(SettingsPage) },
  { path: '/settings/:section', label: 'Settings', Icon: Settings, element: React.createElement(SettingsPage) },
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
