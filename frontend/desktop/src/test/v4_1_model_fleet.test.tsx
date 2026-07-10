/* v4.1 — Model Fleet subtab: 4 role dropdowns + save PUTs to /api/config/model-fleet */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ModelFleetTab } from '@/sections/workspace/ModelFleetTab';

function withQuery(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

const FLEET = {
  cortex: '',
  cerebellum: 'claude-3-haiku-20240307',
  hippocampus: 'gpt-4o-mini',
  prefrontal: 'claude-3-5-sonnet-20240620',
};

const MODELS = {
  models: [
    { id: 'claude-3-haiku-20240307', name: 'Claude 3 Haiku', provider: 'anthropic' },
    { id: 'gpt-4o-mini', name: 'GPT-4o mini', provider: 'openai' },
    { id: 'claude-3-5-sonnet-20240620', name: 'Claude 3.5 Sonnet', provider: 'anthropic' },
  ],
  total: 3,
};

function mockFetchStandard() {
  return vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    if (url.includes('/api/config/model-fleet') && init?.method === 'PUT') {
      return Promise.resolve({ ok: true, status: 200, json: () => FLEET });
    }
    if (url.includes('/api/config/model-fleet')) {
      return Promise.resolve({ ok: true, json: () => FLEET });
    }
    if (url.includes('/api/models')) {
      return Promise.resolve({ ok: true, json: () => MODELS });
    }
    return Promise.reject(new Error('unexpected url: ' + url));
  });
}

describe('v4.1 — ModelFleetTab', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders one field per cognitive role with its data-testid', async () => {
    global.fetch = mockFetchStandard();
    withQuery(<ModelFleetTab />);
    await waitFor(() => {
      expect(screen.getByTestId('fleet-cortex-field')).toBeTruthy();
      expect(screen.getByTestId('fleet-cerebellum-field')).toBeTruthy();
      expect(screen.getByTestId('fleet-hippocampus-field')).toBeTruthy();
      expect(screen.getByTestId('fleet-prefrontal-field')).toBeTruthy();
    });
  });

  it('Save button is enabled after editing a role, then PUTs the patch', async () => {
    const fetchMock = mockFetchStandard();
    global.fetch = fetchMock;
    withQuery(<ModelFleetTab />);
    await waitFor(() => screen.getByTestId('fleet-save'));

    // The Save button should start disabled (no dirty state).
    const saveBtn = screen.getByTestId<HTMLButtonElement>('fleet-save');
    expect(saveBtn.disabled).toBe(true);

    // Click Clear on hippocampus to set it to '' (use session model).
    // This requires the test to actually be able to mutate state via the
    // Clear button. We can't easily open the ModelPickerDropdown in jsdom,
    // but the Clear button is a plain button that mutates editFleet.
    const clearHippocampus = screen.getByTestId<HTMLButtonElement>('fleet-hippocampus-clear');
    expect(clearHippocampus.disabled).toBe(false); // hippocampus starts non-empty
    fireEvent.click(clearHippocampus);

    await waitFor(() => {
      expect(screen.getByTestId<HTMLButtonElement>('fleet-save').disabled).toBe(false);
    });

    fireEvent.click(screen.getByTestId('fleet-save'));

    await waitFor(() => {
      const putCall = fetchMock.mock.calls.find(
        (call) => {
          const [url, init] = call as unknown as [string, RequestInit | undefined];
          return typeof url === 'string' && url.includes('/api/config/model-fleet') && init?.method === 'PUT';
        },
      );
      expect(putCall).toBeDefined();
      // Verify the PUT URL and that the body mutates hippocampus to ''.
      // (The frontend sends the entire edit state; the backend merges via
      // dict.update so any roles not in the body keep their values.)
      const [putUrl, putInit] = putCall as unknown as [string, RequestInit];
      expect(putUrl).toContain('/api/config/model-fleet');
      const body = JSON.parse(putInit.body as string);
      expect(body.hippocampus).toBe('');
    });
  });

  it('Reset to defaults button populates the fleet with empty + the four known defaults', async () => {
    global.fetch = mockFetchStandard();
    withQuery(<ModelFleetTab />);
    await waitFor(() => screen.getByTestId('fleet-reset'));
    fireEvent.click(screen.getByTestId('fleet-reset'));
    // After Reset, the Save button should become enabled (the form is dirty)
    await waitFor(() => {
      expect(screen.getByTestId<HTMLButtonElement>('fleet-save').disabled).toBe(false);
    });
  });
});
