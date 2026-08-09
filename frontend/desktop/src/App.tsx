import { useEffect } from 'react';
import { Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { ChatLayout } from '@/components/shell/ChatLayout';
import { ALL_ROUTES, SECTION_ROUTES, SETTINGS_PAGE_ELEMENT } from '@/routes';
import { CommandPalette } from '@/components/overlays/CommandPalette';
import { ShortcutsModal } from '@/components/overlays/ShortcutsModal';
import { ConversationSearchModal } from '@/components/overlays/ConversationSearchModal';
import { OnboardingTour } from '@/components/overlays/OnboardingTour';
import { ProviderOnboardingModal } from '@/components/overlays/ProviderOnboardingModal';
import { BackendBootstrapGate } from '@/components/overlays/BackendBootstrapGate';
import { QuitConfirmModal } from '@/components/overlays/QuitConfirmModal';
import { UpdateRelaunchOverlay } from '@/components/overlays/UpdateRelaunchOverlay';
import { useStartupProviderRefresh } from '@/hooks/useStartupProviderRefresh';
import { useUiCustomizationSync } from '@/hooks/useUiCustomizationSync';
import { registerStreamResync } from '@/sections/chat/stream/session-subscriber';
import { toggleCommandPalette } from '@/store/command-palette';
import { toggleShortcutsModal } from '@/store/shortcuts-modal';

/** True when keystrokes belong to a text-editing surface (skip global hotkeys). */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT' ||
    target.isContentEditable
  );
}

export default function App() {
  const navigate = useNavigate();
  // Sync provider model lists from upstream once per launch so the model
  // dropdown reflects models added/removed since the app last ran.
  useStartupProviderRefresh();
  // Server-stored UI colors (model's customize_ui tool) win over the local cache.
  useUiCustomizationSync();

  // App-global SSE resync (idempotent): on focus/visibility/online, reconnect
  // any session the backend reports as streaming — covers backend-started
  // auto-turns while the user is on a non-chat route where ChatThread is not
  // mounted (its own resync effect covers the visible thread).
  useEffect(() => {
    registerStreamResync(() => Promise.resolve(null));
  }, []);

  // Global hotkeys: ⌘/Ctrl+K|P palette, `?` shortcuts reference, `,` settings.
  // (Formerly lived in the never-mounted AppShell — mounted here so they work.)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const cmd = e.metaKey || e.ctrlKey;
      if (cmd && !e.altKey && !e.shiftKey && (e.key === 'k' || e.key === 'p')) {
        e.preventDefault();
        toggleCommandPalette();
        return;
      }
      if (cmd || e.altKey || e.metaKey) return;
      if (isTypingTarget(e.target)) return;
      if (e.key === '?') {
        e.preventDefault();
        toggleShortcutsModal();
      } else if (e.key === ',') {
        e.preventDefault();
        void navigate('/settings');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate]);

  return (
    <>
      <BackendBootstrapGate>
        <Routes>
          <Route element={<ChatLayout />}>
            {SECTION_ROUTES.map((route) => (
              <Route key={route.path} path={route.path} element={route.element} />
            ))}
            {/* Single parent keeps SettingsPage mounted across tab changes.
                Child routes only update :section via useParams — no shell remount. */}
            <Route path="/settings" element={SETTINGS_PAGE_ELEMENT}>
              <Route index element={null} />
              <Route path=":section" element={null} />
            </Route>
            {ALL_ROUTES.filter((r) => r.path === '/_design').map((route) => (
              <Route key={route.path} path={route.path} element={route.element} />
            ))}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
        <CommandPalette />
        <ShortcutsModal />
        <ConversationSearchModal />
        <OnboardingTour />
        <ProviderOnboardingModal />
        <QuitConfirmModal />
      </BackendBootstrapGate>
      {/* Outside the gate so a stopped backend during update can't hide it. */}
      <UpdateRelaunchOverlay />
    </>
  );
}
