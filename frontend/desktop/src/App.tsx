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
import { UpdateConversation } from '@/components/overlays/UpdateConversation';
import { QuitConfirmModal } from '@/components/overlays/QuitConfirmModal';
import { UpdateRelaunchOverlay } from '@/components/overlays/UpdateRelaunchOverlay';
import { useStartupProviderRefresh } from '@/hooks/useStartupProviderRefresh';
import { useUiCustomizationSync } from '@/hooks/useUiCustomizationSync';
import { registerStreamResync } from '@/sections/chat/stream/session-subscriber';
import { resolveShortcut } from '@/lib/shortcuts';
import { toggleCommandPalette } from '@/store/command-palette';
import { toggleShortcutsModal } from '@/store/shortcuts-modal';
import { createSession } from '@/store/sessions';

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

  // Global hotkeys come from lib/shortcuts.ts — the registry carries the
  // combo AND the action, so the modal cannot document a key App.tsx never
  // wires, and a binding cannot ship without an action.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const hit = resolveShortcut(e);
      if (!hit?.action) return;
      // Keys typed into a field belong to that field, unless the binding opts
      // in (palette + pane toggles do; Ctrl+N and `?`/`,` do not).
      if (!hit.allowWhileTyping && isTypingTarget(e.target)) return;
      e.preventDefault();
      switch (hit.action) {
        case 'palette':
          toggleCommandPalette();
          break;
        case 'new-chat': {
          // ZCode-parity Ctrl+N: new chat, same path as the sidebar button
          // (creates a Tasks-home session and opens it).
          const session = createSession(null);
          void navigate(`/c/${session.id}`);
          break;
        }
        case 'toggle-sidebar':
        case 'toggle-right-drawer':
          // Claude/Hermes pane toggles (spec §3.6): Ctrl+B sidebar, Ctrl+J
          // right panel. ChatLayout owns both states, so it listens.
          window.dispatchEvent(
            new CustomEvent(
              hit.action === 'toggle-sidebar'
                ? 'august:toggle-sidebar'
                : 'august:toggle-right-drawer',
            ),
          );
          break;
        case 'settings':
          void navigate('/settings');
          break;
        case 'shortcuts':
          toggleShortcutsModal();
          break;
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
        {/* First launch after a version bump: animated "what's new" chat. */}
        <UpdateConversation />
      </BackendBootstrapGate>
      {/* Outside the gate: the native close handler defers to the webview, so a
          quit prompt rendered inside it could not be reached when the backend
          failed to start — the window had no way to close. Same reason as
          UpdateRelaunchOverlay below. */}
      <QuitConfirmModal />
      {/* Outside the gate so a stopped backend during update can't hide it. */}
      <UpdateRelaunchOverlay />
    </>
  );
}
