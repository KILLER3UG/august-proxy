/* v4.2 — Live settings subtab: 5 fields (stt/tts provider/model + voice) */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LiveSettingsTab } from '@/sections/workspace/LiveSettingsTab';

function withQuery(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

const CONFIG = {
  sttProvider: '',
  sttModel: '',
  ttsProvider: '',
  ttsModel: '',
  ttsVoice: '',
};

const MODELS = { models: [], total: 0 };

function mockFetchStandard() {
  return vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    if (url.includes('/api/config/live') && init?.method === 'PUT') {
      return Promise.resolve({ ok: true, status: 200, json: async () => CONFIG });
    }
    if (url.includes('/api/config/live')) {
      return Promise.resolve({ ok: true, json: async () => CONFIG });
    }
    if (url.includes('/api/models')) {
      return Promise.resolve({ ok: true, json: async () => MODELS });
    }
    return Promise.reject(new Error('unexpected url: ' + url));
  });
}

describe('v4.2 — LiveSettingsTab', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders all five Live config fields', async () => {
    global.fetch = mockFetchStandard();
    withQuery(<LiveSettingsTab />);
    await waitFor(() => {
      expect(screen.getByTestId('live-stt-provider-field')).toBeTruthy();
      expect(screen.getByTestId('live-stt-model-field')).toBeTruthy();
      expect(screen.getByTestId('live-tts-provider-field')).toBeTruthy();
      expect(screen.getByTestId('live-tts-model-field')).toBeTruthy();
      expect(screen.getByTestId('live-tts-voice-field')).toBeTruthy();
    });
  });

  it('Save button PUTs a partial patch to /api/config/live', async () => {
    const fetchMock = mockFetchStandard();
    global.fetch = fetchMock;
    withQuery(<LiveSettingsTab />);
    await waitFor(() => screen.getByTestId('live-save'));

    // Without editing, save should be disabled
    const saveBtn = screen.getByTestId('live-save');
    expect(saveBtn.disabled).toBe(true);

    // Fill the tts voice field via a plain input
    const voiceInput = screen.getByTestId('live-tts-voice-input');
    fireEvent.change(voiceInput, { target: { value: 'alloy' } });

    await waitFor(() => {
      expect((screen.getByTestId('live-save')).disabled).toBe(false);
    });

    fireEvent.click(screen.getByTestId('live-save'));
    await waitFor(() => {
      const putCall = fetchMock.mock.calls.find(
        (call) => {
          const [url, init] = call as unknown as [string, RequestInit | undefined];
          return typeof url === 'string' && url.includes('/api/config/live') && init?.method === 'PUT';
        },
      );
      expect(putCall).toBeDefined();
      const [, putInit] = putCall as unknown as [string, RequestInit];
      const body = JSON.parse(putInit.body as string);
      expect(body.ttsVoice).toBe('alloy');
    });
  });
});
