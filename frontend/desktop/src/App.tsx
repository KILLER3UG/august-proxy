import { Navigate, Route, Routes } from 'react-router-dom';
import { ChatLayout } from '@/components/shell/ChatLayout';
import { ALL_ROUTES, SECTION_ROUTES, SETTINGS_PAGE_ELEMENT } from '@/routes';
import { CommandPalette } from '@/components/overlays/CommandPalette';
import { ProviderOnboardingModal } from '@/components/overlays/ProviderOnboardingModal';
import { BackendBootstrapGate } from '@/components/overlays/BackendBootstrapGate';
import { QuitConfirmModal } from '@/components/overlays/QuitConfirmModal';

export default function App() {
  return (
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
      <ProviderOnboardingModal />
      <QuitConfirmModal />
    </BackendBootstrapGate>
  );
}
