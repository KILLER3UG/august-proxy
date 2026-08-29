/* ── Vitest setup ──────────────────────────────────────────────────── */
import '@testing-library/jest-dom/vitest';

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
