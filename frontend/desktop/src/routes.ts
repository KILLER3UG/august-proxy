/// <reference types="vite/client" />
import * as React from 'react';
import { type ReactNode, lazy, Suspense } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import {
  LayoutDashboard,
  MessageSquare,
  Mic,
  Bot,
  History,
  Kanban,
  GraduationCap,
  type LucideIcon,
} from 'lucide-react';

import { ChatThread } from '@/sections/chat/ChatThread';
import { SETTINGS_SECTIONS } from '@/settings/settings-registry';
import { PageLoader } from '@/components/PageLoader';
import { SectionBoundary } from '@/components/SectionBoundary';

// Lazy-load heavy non-chat surfaces so the chat shell stays on the critical path.
const SettingsPage = lazy(() =>
  import('@/sections/settings/SettingsPage').then((m) => ({ default: m.SettingsPage })),
);
const AutomationsPage = lazy(() =>
  import('@/sections/automations/AutomationsPage').then((m) => ({ default: m.AutomationsPage })),
);
const LiveSurface = lazy(() =>
  import('@/sections/live/LiveSurface').then((m) => ({ default: m.LiveSurface })),
);
const RunsPage = lazy(() =>
  import('@/sections/runs/RunsPage').then((m) => ({ default: m.RunsPage })),
);
const BoardPage = lazy(() =>
  import('@/sections/board/BoardPage').then((m) => ({ default: m.BoardPage })),
);
const HistoryPage = lazy(() =>
  import('@/sections/history/HistoryPage').then((m) => ({ default: m.HistoryPage })),
);
const LearningHub = lazy(() =>
  import('@/sections/learning/LearningHub').then((m) => ({ default: m.LearningHub })),
);
const DesignRoute = lazy(() =>
  import('@/pages/DesignRoute').then((m) => ({ default: m.DesignRoute })),
);

function Lazy({ children }: { children: ReactNode }) {
  return React.createElement(Suspense, { fallback: React.createElement(PageLoader) }, children);
}

/** Lazy + SectionBoundary: prevents one crashed section from taking down the app. */
function LazySection({ name, children }: { name: string; children?: ReactNode }) {
  return React.createElement(
    SectionBoundary,
    { name },
    React.createElement(Suspense, { fallback: React.createElement(PageLoader) }, children),
  );
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
    path: '/automations',
    label: 'Automations',
    Icon: Bot,
    element: React.createElement(LazySection, { name: 'Automations' }, React.createElement(AutomationsPage)),
    nav: true,
  },
  {
    path: '/runs',
    label: 'Runs',
    Icon: History,
    element: React.createElement(LazySection, { name: 'Runs' }, React.createElement(RunsPage)),
    nav: true,
  },
  {
    path: '/board',
    label: 'Board',
    Icon: Kanban,
    element: React.createElement(LazySection, { name: 'Board' }, React.createElement(BoardPage)),
    nav: true,
  },
  {
    path: '/live',
    label: 'Live',
    Icon: Mic,
    element: React.createElement(
      LazySection,
      { name: 'Live' },
      React.createElement(() => {
        const navigate = useNavigate();
        return React.createElement(LiveSurface, { onSwitchToChat: () => navigate('/') });
      }),
    ),
    nav: true,
  },
  {
    path: '/history',
    label: 'History',
    Icon: History,
    element: React.createElement(LazySection, { name: 'History' }, React.createElement(HistoryPage)),
    nav: true,
  },
  {
    /* Audit P2#14 — the learning loop as a work surface. Additive: the
     * settings sections this route reuses keep their own entries, and the
     * settings registry is unchanged. */
    path: '/learning',
    label: 'Learning',
    Icon: GraduationCap,
    element: React.createElement(LazySection, { name: 'Learning' }, React.createElement(LearningHub)),
    nav: true,
  },
] as const;

/* Hidden-tier settings stay deep-linkable and searchable, but must not be
 * surfaced by the command palette any more than they are in the rail. */
export const SETTINGS_TABS: readonly SettingsTab[] = SETTINGS_SECTIONS.filter((section) => section.tier !== 'hidden').map((section) => ({
  key: section.id,
  label: section.label,
  Icon: section.icon,
  path: `/settings/${section.id}`,
}));

/* One shared route renders for both /settings and /settings/:section.
 * ChatLayout mounts it as a DIALOG over the background-location chat (see
 * ChatLayout's background/overlay <Routes> split); App.tsx declares the paths
 * with a null element for matching and deep links. Section content remounts
 * inside SettingsPage so each tab refetches live data on entry.
 *
 * The rail-not-switching defect this used to blame on React is not real. A
 * hoisted `React.createElement(...)` element IS referentially identical across
 * renders, and the claim was that React therefore bails out of re-rendering it —
 * measured in `test/settingsRouteElement.test.tsx`: the subtree re-renders and
 * `useParams().section` updates, exactly as it does through this component. What
 * actually froze the panel was the `AnimatePresence mode="wait"` that used to
 * wrap the section body (removed; see SettingsPage's comment). This stays a
 * component because a component is what a route element is, not because a
 * constant would have broken. */
export function SettingsPageRoute(): ReactNode {
  return React.createElement(Lazy, null, React.createElement(SettingsPage));
}

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

/** Everything App.tsx's tree mounts from a flat table: the chat surfaces and
 *  the dev-only inspector. `/settings*` is deliberately NOT here — App.tsx
 *  declares those paths with a null element (for matching and deep links)
 *  while ChatLayout renders the dialog itself; a SETTINGS_ROUTES entry here
 *  was a second, never-mounted declaration of the same paths. */
export const ALL_ROUTES: readonly SectionRoute[] = [
  ...SECTION_ROUTES,
  ...DEV_ROUTES,
];

/** Chat surfaces that keep rendering BEHIND the settings dialog. ChatLayout
 *  mounts these against the BACKGROUND location while /settings/* is open, so
 *  the dialog floats over a live app instead of a route swap that unmounts
 *  the chat. App.tsx's tree still declares everything for matching and deep
 *  links; this list is the background half of that split. */
export const CHAT_SURFACE_ROUTES: readonly SectionRoute[] = [
  ...SECTION_ROUTES,
  ...DEV_ROUTES,
];

export const SECTION_NAV_ITEMS: readonly NavItem[] = SECTION_ROUTES.filter((route) => route.nav).map((route) => ({
  to: route.path,
  label: route.label,
  Icon: route.Icon,
}));
