import { lazy, Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { ChatLayout } from '@/components/shell/ChatLayout';
import { PageLoader } from '@/components/PageLoader';
import { ChatThread } from '@/sections/chat/ChatThread';
import { SettingsOverlay } from '@/components/overlays/SettingsOverlay';
import { CommandPalette } from '@/components/overlays/CommandPalette';

const Overview      = lazy(() => import('@/sections/overview/Overview').then(m => ({ default: m.Overview })));
const Traffic       = lazy(() => import('@/sections/traffic/Traffic').then(m => ({ default: m.Traffic })));
const Inspector     = lazy(() => import('@/sections/inspector/Inspector').then(m => ({ default: m.Inspector })));
const Thinking      = lazy(() => import('@/sections/thinking/Thinking').then(m => ({ default: m.Thinking })));
const Conversations = lazy(() => import('@/sections/conversations/Conversations').then(m => ({ default: m.Conversations })));
const Workbench     = lazy(() => import('@/sections/workbench/Workbench').then(m => ({ default: m.Workbench })));

export default function App() {
  return (
    <>
      <Routes>
        {/* Main chat-first layout */}
        <Route element={<ChatLayout />}>
          {/* Default = chat with the demo session */}
          <Route path="/"         element={<ChatThread sessionId="demo" />} />
          <Route path="/c/:sessionId" element={<ChatThreadWithParams />} />

          {/* Sub-routes (still accessible from settings/command palette) */}
          <Route path="/dashboard"     element={<Suspense fallback={<PageLoader />}><Overview /></Suspense>} />
          <Route path="/traffic"       element={<Suspense fallback={<PageLoader />}><Traffic /></Suspense>} />
          <Route path="/inspector"     element={<Suspense fallback={<PageLoader />}><Inspector /></Suspense>} />
          <Route path="/thinking"      element={<Suspense fallback={<PageLoader />}><Thinking /></Suspense>} />
          <Route path="/conversations" element={<Suspense fallback={<PageLoader />}><Conversations /></Suspense>} />
          <Route path="/workbench"     element={<Suspense fallback={<PageLoader />}><Workbench /></Suspense>} />

          {/* Settings overlay (cmd+, or settings button) */}
          <Route path="/settings" element={<SettingsOverlay />} />
          <Route path="/settings/:tab" element={<SettingsOverlay />} />

          {/* 404 → back to chat */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
      <CommandPalette />
    </>
  );
}

import { useParams } from 'react-router-dom';
function ChatThreadWithParams() {
  const { sessionId } = useParams<{ sessionId: string }>();
  return <ChatThread sessionId={sessionId ?? null} />;
}
