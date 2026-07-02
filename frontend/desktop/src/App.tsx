import { Navigate, Route, Routes } from 'react-router-dom';
import { ChatLayout } from '@/components/shell/ChatLayout';
import { ALL_ROUTES, SECTION_ROUTES, SETTINGS_ROUTES } from '@/routes';
import { CommandPalette } from '@/components/overlays/CommandPalette';
import { ProviderOnboardingModal } from '@/components/overlays/ProviderOnboardingModal';

export default function App() {
  return (
    <>
      <Routes>
        <Route element={<ChatLayout />}>
          {SECTION_ROUTES.map((route) => (
            <Route key={route.path} path={route.path} element={route.element} />
          ))}
          {SETTINGS_ROUTES.map((route) => (
            <Route key={route.path} path={route.path} element={route.element} />
          ))}
          {ALL_ROUTES.filter((r) => r.path === '/_design').map((route) => (
            <Route key={route.path} path={route.path} element={route.element} />
          ))}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
      <CommandPalette />
      <ProviderOnboardingModal />
    </>
  );
}
