import { Navigate, Route, Routes } from 'react-router-dom';
import { ChatLayout } from '@/components/shell/ChatLayout';
import { ALL_ROUTES, SECTION_ROUTES, SETTINGS_PAGE_ELEMENT } from '@/routes';
import { CommandPalette } from '@/components/overlays/CommandPalette';
import { ConversationSearchModal } from '@/components/overlays/ConversationSearchModal';
import { ProviderOnboardingModal } from '@/components/overlays/ProviderOnboardingModal';
import { BackendBootstrapGate } from '@/components/overlays/BackendBootstrapGate';
import { QuitConfirmModal } from '@/components/overlays/QuitConfirmModal';
import { UpdateRelaunchOverlay } from '@/components/overlays/UpdateRelaunchOverlay';
import { useStartupProviderRefresh } from '@/hooks/useStartupProviderRefresh';
import { useUiCustomizationSync } from '@/hooks/useUiCustomizationSync';

export default function App() {
  // Sync provider model lists from upstream once per launch so the model
  // dropdown reflects models added/removed since the app last ran.
  useStartupProviderRefresh();
  // Server-stored UI colors (model's customize_ui tool) win over the local cache.
  useUiCustomizationSync();
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
        <ConversationSearchModal />
        <ProviderOnboardingModal />
        <QuitConfirmModal />
      </BackendBootstrapGate>
      {/* Outside the gate so a stopped backend during update can't hide it. */}
      <UpdateRelaunchOverlay />
    </>
  );
}
