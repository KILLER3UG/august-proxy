/* ── CircuitWaveformViewer: an offline machine must not show an empty box ──
 * The Surfer embed is a hosted WASM app, and a cross-origin iframe reports
 * "no network" exactly like it reports "still loading". Offline, the panel
 * showed a blank 240px frame under the line "captures open in the embedded
 * viewer" — which reads as *no data*, not as *no network*. The fallback names
 * the real condition and leaves the capture reachable on disk.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

const revealMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/tauri-shell', () => ({ revealInFolder: revealMock }));
vi.mock('@/api/client', () => ({ whenReady: () => Promise.resolve('http://127.0.0.1:8085') }));

import { CircuitWaveformViewer } from '@/components/shell/CircuitWaveformViewer';

const messages = [
  {
    id: 'm1',
    role: 'assistant',
    content: '',
    timestamp: '2026-10-08T00:00:00Z',
    tools: [
      {
        name: 'circuit_export_vcd',
        id: 't1',
        status: 'done',
        startedAt: 1,
        result: JSON.stringify({ vcdFile: 'sim/counter.vcd' }),
      },
    ],
  },
] as never;

function setOnline(value: boolean) {
  Object.defineProperty(window.navigator, 'onLine', { value, configurable: true });
}

beforeEach(() => {
  setOnline(true);
  revealMock.mockClear();
});

describe('the waveform viewer when the machine is offline', () => {
  it('names the real condition and offers the file instead of a blank frame', () => {
    setOnline(false);
    render(<CircuitWaveformViewer messages={messages} sessionId="s1" />);

    const pane = screen.getByTestId('waveform-viewer-offline');
    expect(pane.textContent).toContain('offline');
    expect(pane.textContent).toContain('sim/counter.vcd');
    expect(screen.queryByTitle('Surfer waveform viewer')).toBeNull();

    fireEvent.click(screen.getByTestId('waveform-reveal'));
    expect(revealMock).toHaveBeenCalledWith('sim/counter.vcd');
  });

  it('swaps to the fallback the moment the connection drops', () => {
    render(<CircuitWaveformViewer messages={messages} sessionId="s1" />);
    expect(screen.getByTitle('Surfer waveform viewer')).toBeTruthy();

    setOnline(false);
    fireEvent(window, new Event('offline'));

    expect(screen.getByTestId('waveform-viewer-offline')).toBeTruthy();
    expect(screen.queryByTitle('Surfer waveform viewer')).toBeNull();

    fireEvent(window, new Event('online'));
    expect(screen.getByTitle('Surfer waveform viewer')).toBeTruthy();
  });

  it('embeds the viewer normally while online', () => {
    render(<CircuitWaveformViewer messages={messages} sessionId="s1" />);
    expect(screen.queryByTestId('waveform-viewer-offline')).toBeNull();
    expect(screen.getByTitle('Surfer waveform viewer')).toBeTruthy();
  });

  it('says nothing about the viewer when there is no capture to show', () => {
    setOnline(false);
    render(<CircuitWaveformViewer messages={[]} sessionId="s1" />);
    expect(screen.getByText(/No waveform captures yet/)).toBeTruthy();
    expect(screen.queryByTestId('waveform-viewer-offline')).toBeNull();
  });
});
