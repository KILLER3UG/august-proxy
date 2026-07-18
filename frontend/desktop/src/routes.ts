/// <reference types="vite/client" />
import * as React from 'react';
import { type ReactNode, lazy, Suspense } from 'react';
import { Navigate, useParams } from 'react-router-dom';
import {
  LayoutDashboard,
  MessageSquare,
  Settings,
  Brain,
  Mic,
  type LucideIcon,
} from 'lucide-react';

import { ChatThread } from '@/sections/chat/ChatThread';
import { SETTINGS_SECTIONS } from '@/settings/settings-registry';
import { PageLoader } from '@/components/PageLoader';

// Lazy-load heavy non-chat surfaces so the chat shell stays on the critical path.
const SettingsPage = lazy(() =>
  import('@/sections/settings/SettingsPage').then((m) => ({ default: m.SettingsPage })),
);
const BrainDashboard = lazy(() =>
  import('@/sections/brain/BrainDashboard').then((m) => ({ default: m.BrainDashboard })),
);
const LiveSurface = lazy(() =>
  import('@/sections/live/LiveSurface').then((m) => ({ default: m.LiveSurface })),
);
const DesignRoute = lazy(() =>
  import('@/pages/DesignRoute').then((m) => ({ default: m.DesignRoute })),
);

function Lazy({ children }: { children: ReactNode }) {
  return React.createElement(Suspense, { fallback: React.createElement(PageLoader) }, children);
}

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
  // ChatLayout redirects `/` to a real session; null avoids a fake "demo" id.
  { path: '/', label: 'Chat', Icon: MessageSquare, element: React.createElement(ChatThread, { sessionId: null }), nav: true },
  { path: '/c/:sessionId', label: 'Chat', Icon: MessageSquare, element: React.createElement(ChatThreadWithParams) },
  {
    path: '/brain',
    label: 'Brain',
    Icon: Brain,
    element: React.createElement(Lazy, null, React.createElement(BrainDashboard)),
    nav: true,
  },
  {
    path: '/live',
    label: 'Live',
    Icon: Mic,
    element: React.createElement(
      Lazy,
      null,
      React.createElement(LiveSurface, { onSwitchToChat: () => { window.location.href = '/'; } }),
    ),
    nav: true,
  },
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
}));

/* Settings is a FULL-SCREEN page (no modal). One shared element is
 * mounted for both /settings and /settings/:section so left-rail tab
 * switches only change the :section param — they do not remount the
 * shell or re-trigger the lazy Suspense boundary. Section content still
 * remounts inside SettingsPage so each tab refetches live data on entry. */
export const SETTINGS_PAGE_ELEMENT: ReactNode = React.createElement(
  Lazy,
  null,
  React.createElement(SettingsPage),
);

/** Flat route descriptors for nav / labels (actual tree is nested in App). */
export const SETTINGS_ROUTES: readonly SectionRoute[] = [
  {
    path: '/settings',
    label: 'Settings',
    Icon: Settings,
    element: SETTINGS_PAGE_ELEMENT,
  },
  {
    path: '/settings/:section',
    label: 'Settings',
    Icon: Settings,
    element: SETTINGS_PAGE_ELEMENT,
  },
] as const;

/* Dev-only design token inspector — tree-shaken out of production. */
const DEV_ROUTES: readonly SectionRoute[] = import.meta.env.DEV
  ? [
      {
        path: '/_design',
        label: 'Design',
        Icon: LayoutDashboard,
        element: React.createElement(Lazy, null, React.createElement(DesignRoute)),
        nav: false,
      },
    ]
  : [];

export const ALL_ROUTES: readonly SectionRoute[] = [
  ...SECTION_ROUTES,
  ...SETTINGS_ROUTES,
  ...DEV_ROUTES,
];

export const SECTION_NAV_ITEMS: readonly NavItem[] = SECTION_ROUTES.filter((route) => route.nav).map((route) => ({
  to: route.path,
  label: route.label,
  Icon: route.Icon,
}));

export const SETTINGS_NAV_ITEMS: readonly NavItem[] = SETTINGS_TABS.map((tab) => ({
  to: tab.path,
  label: tab.label,
  Icon: tab.Icon,
}));

export const NAV_ITEMS: readonly NavItem[] = SECTION_NAV_ITEMS;

export function resolveRouteLabel(pathname: string) {
  return SECTION_ROUTES.find((route) => pathname === route.path)?.label
    ?? SECTION_ROUTES.find((route) => route.path !== '/' && pathname.startsWith(route.path))?.label
    ?? SETTINGS_ROUTES.find((route) => pathname === route.path || pathname.startsWith(route.path))?.label
    ?? 'August';
}

export const SECTION_PATH = (to: string) => to;
