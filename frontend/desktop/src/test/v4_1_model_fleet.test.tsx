/* v4.1 — Model Fleet subtab: one field per role the SERVER lists, and a PUT that
   carries each role's gateway alongside its model. */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ModelFleetTab } from '@/sections/workspace/ModelFleetTab';

function withQuery(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

// Deliberately only FOUR roles: the tab used to render a hardcoded list of eleven,
// five of which the backend rejected — and a rejected role 400ed the whole patch,
// so none of the other six saved either.
const FLEET = {
  models: {
    cortex: '',
    cerebellum: 'claude-3-haiku-20240307',
    hippocampus: 'gpt-4o-mini',
    prefrontal: 'claude-3-5-sonnet-20240620',
    chat_chain: 'a,b',
    chat_context_promotion: 'gpt-4o-mini',
  },
  providers: {
    cortex: '',
    cerebellum: 'anthropic',
    hippocampus: 'openai',
    prefrontal: 'anthropic',
    chat_chain: '',
    chat_context_promotion: 'openai',
  },
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

const putBody = async (fetchMock: ReturnType<typeof mockFetchStandard>) => {
  // The save is fire-and-forget from the click's perspective, so poll for the
  // PUT instead of assuming the mock has seen it yet.
  let body: Record<string, Record<string, string>> = {};
  await waitFor(() => {
    const call = fetchMock.mock.calls.find(([u, init]) => {
      const url = u as string;
      return url.includes('/api/config/model-fleet') && (init as RequestInit | undefined)?.method === 'PUT';
    });
    if (!call) throw new Error('no PUT to /api/config/model-fleet');
    body = JSON.parse((call[1] as RequestInit).body as string);
  });
  return body;
};

describe('v4.1 — ModelFleetTab', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders one field per role the server returns, and no others', async () => {
    global.fetch = mockFetchStandard();
    withQuery(<ModelFleetTab />);
    await waitFor(() => {
      expect(screen.getByTestId('fleet-cortex-field')).toBeTruthy();
      expect(screen.getByTestId('fleet-cerebellum-field')).toBeTruthy();
      expect(screen.getByTestId('fleet-hippocampus-field')).toBeTruthy();
      expect(screen.getByTestId('fleet-prefrontal-field')).toBeTruthy();
    });
    // A role the workbench resolves as a (model, gateway) pair cannot be a
    // free-text box — the gateway half would be unsavable. Only the chain, which
    // is a list of ids meant to cross gateways, stays text.
    expect(document.querySelector('[data-testid="fleet-chat_chain-input"]')).toBeTruthy();
    expect(document.querySelector('[data-testid="fleet-chat_context_promotion-input"]')).toBeNull();
    // A role the server did not return renders nothing at all.
    expect(screen.queryByTestId('fleet-chat_smol-field')).toBeNull();
    expect(screen.queryByTestId('fleet-chat_vision-field')).toBeNull();
  });

  it('clearing a role clears its gateway too, and the PUT carries both maps', async () => {
    const fetchMock = mockFetchStandard();
    global.fetch = fetchMock;
    withQuery(<ModelFleetTab />);
    await waitFor(() => screen.getByTestId('fleet-save'));

    const saveBtn = screen.getByTestId<HTMLButtonElement>('fleet-save');
    expect(saveBtn.disabled).toBe(true);

    const clearHippocampus = screen.getByTestId<HTMLButtonElement>('fleet-hippocampus-clear');
    expect(clearHippocampus.disabled).toBe(false); // hippocampus starts non-empty
    fireEvent.click(clearHippocampus);

    await waitFor(() => {
      expect(screen.getByTestId<HTMLButtonElement>('fleet-save').disabled).toBe(false);
    });
    fireEvent.click(screen.getByTestId('fleet-save'));

    const body = await putBody(fetchMock);
    expect(body.models.hippocampus).toBe('');
    // The stale half of the pair is the bug: an empty model with a provider left
    // behind reads as "no gateway configured for the session model".
    expect(body.providers.hippocampus).toBe('');
    expect(body.providers.cerebellum).toBe('anthropic');
  });

  it('Reset to defaults empties both maps for every rendered role', async () => {
    const fetchMock = mockFetchStandard();
    global.fetch = fetchMock;
    withQuery(<ModelFleetTab />);
    await waitFor(() => screen.getByTestId('fleet-reset'));
    fireEvent.click(screen.getByTestId('fleet-reset'));
    await waitFor(() => {
      expect(screen.getByTestId<HTMLButtonElement>('fleet-save').disabled).toBe(false);
    });
    fireEvent.click(screen.getByTestId('fleet-save'));
    const body = await putBody(fetchMock);
    expect(Object.values(body.models)).toEqual(['', '', '', '', '', '']);
    expect(Object.values(body.providers)).toEqual(['', '', '', '', '', '']);
  });
});
