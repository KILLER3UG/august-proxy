/* ── Vitest setup ──────────────────────────────────────────────────── */
import '@testing-library/jest-dom/vitest';

// jsdom 25 no longer installs `localStorage` on its Window, and vitest runs
// with `globalThis.window === globalThis` — so `localStorage` exists as an
// inherited getter that returns `undefined`. App code and test code alike read
// it as a bare identifier, as in a real browser, and get `undefined` rather
// than a Storage: "Cannot read properties of undefined (reading 'setItem')".
//
// That failure looks like a broken component but is a broken environment, and
// it silently fails ~14 test files. `in`-guarding is useless here — the name IS
// defined, it just resolves to undefined — so this overwrites the dead getter
// unconditionally. In-memory only; every file gets a fresh jsdom, and nothing
// here persists between tests or touches real browser storage.
const store: Record<string, string> = {};
function installStorage(name: 'localStorage' | 'sessionStorage') {
  const probe = window as unknown as Record<string, unknown>;
  if (typeof probe[name] === 'object' && probe[name] !== null) return;
  Object.defineProperty(window, name, {
    writable: true,
    configurable: true,
    value: {
      length: 0,
      clear: () => {
        for (const k of Object.keys(store)) delete store[k];
      },
      getItem: (k: string) => (k in store ? store[k] : null),
      key: (i: number) => Object.keys(store)[i] ?? null,
      removeItem: (k: string) => {
        delete store[k];
      },
      setItem: (k: string, v: string) => {
        store[k] = String(v);
      },
    },
  });
}

installStorage('localStorage');
installStorage('sessionStorage');

// jsdom lacks matchMedia; uPlot queries it at import time (pxRatio).
if (typeof window !== 'undefined' && !window.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}
