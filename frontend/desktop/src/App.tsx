import { Navigate, Route, Routes } from 'react-router-dom';
import { ChatLayout } from '@/components/shell/ChatLayout';
import { SECTION_ROUTES, SETTINGS_ROUTES } from '@/routes';
import { CommandPalette } from '@/components/overlays/CommandPalette';

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
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
      <CommandPalette />
    </>
  );
}
