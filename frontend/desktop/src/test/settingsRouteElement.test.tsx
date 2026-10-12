/** The settings dialog's route plumbing, measured — and the two invented
 *  mechanisms it used to carry.
 *
 *  The rail-not-switching P1 was real and was fixed by dropping the
 *  `AnimatePresence mode="wait"` gate inside SettingsPage (measured in the
 *  running app; jsdom does not reproduce the stalled exit, so nothing here
 *  claims to guard that). What these tests DO guard is the route shape the
 *  dialog ships with, and they record the measurements that kill the two
 *  explanations that were written into the comments as fact:
 *
 *    1. "a hoisted module-level element is referentially identical every
 *       render, so React bails out of re-rendering the subtree" — false: the
 *       subtree re-renders and `useParams()` updates.
 *    2. "a parent element never sees a param matched by its CHILD route" —
 *       false: with `:section` as a child, the parent element reads the param.
 *
 *  Both are pinned so neither story gets re-invented the next time the panel
 *  misbehaves and someone reaches for the nearest plausible-sounding React rule.
 */

import { useEffect } from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate, useParams } from 'react-router-dom';

function Probe() {
  return <div data-testid="probe">{useParams().section ?? 'none'}</div>;
}

/** Moves the router once, after the first paint, so the test watches a real
 *  location change instead of clicking a widget the product does not have. */
function NavigateOnce({ to }: { to: string }) {
  const nav = useNavigate();
  useEffect(() => {
    void nav(to);
  }, [to, nav]);
  return null;
}

/** One hoisted element object, shared by both routes — the shape the bailout
 *  story claimed would freeze. */
const HOISTED = <Probe />;

function at(path: string, ui: React.ReactNode) {
  return render(<MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>);
}

describe('the settings dialog route shape', () => {
  it('switches the matched section through the shipped two-flat-routes shape', async () => {
    at(
      '/settings/general',
      <>
        <NavigateOnce to="/settings/appearance" />
        <Routes>
          <Route path="/settings" element={<Probe />} />
          <Route path="/settings/:section" element={<Probe />} />
        </Routes>
      </>,
    );
    await waitFor(() =>
      expect(screen.getByTestId('probe').textContent).toBe('appearance'),
    );
  });

  it('a referentially identical hoisted element still re-renders', async () => {
    at(
      '/settings/general',
      <>
        <NavigateOnce to="/settings/appearance" />
        <Routes>
          <Route path="/settings" element={HOISTED} />
          <Route path="/settings/:section" element={HOISTED} />
        </Routes>
      </>,
    );
    // No bailout. The comment that said otherwise described a rule React does
    // not apply here.
    await waitFor(() =>
      expect(screen.getByTestId('probe').textContent).toBe('appearance'),
    );
  });

  it('a PARENT element does see the param matched by its CHILD route', async () => {
    at(
      '/settings/general',
      <>
        <NavigateOnce to="/settings/appearance" />
        <Routes>
          <Route path="/settings" element={HOISTED}>
            <Route index element={null} />
            <Route path=":section" element={null} />
          </Route>
        </Routes>
      </>,
    );
    // This is the shape that shipped broken — and it reads the param fine, so
    // the shape was never what broke. Stated with its limit: jsdom could not
    // reproduce the stalled exit that DID break it (a test written against the
    // bug passed with the bug re-applied), so this proves the claim in the
    // comment was not a rule React applies, not that the nested shape was
    // safe in the app. The app measurement is what indicts the presence gate.
    await waitFor(() =>
      expect(screen.getByTestId('probe').textContent).toBe('appearance'),
    );
  });
});
