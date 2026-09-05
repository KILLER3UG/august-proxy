/**
 * Bot Mode Phase A frontend — identicon determinism + BotsRail rendering.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { botAvatarSvg } from '@/lib/bot-avatar';

// ── Identicon avatar ───────────────────────────────────────────────────────

describe('botAvatarSvg', () => {
  it('is deterministic per name', () => {
    const a = botAvatarSvg('Researcher');
    const b = botAvatarSvg('Researcher');
    expect(a).toBe(b);
    expect(botAvatarSvg('Critic')).not.toBe(a);
  });

  it('salt changes bytes, salt is deterministic', () => {
    const base = botAvatarSvg('Researcher');
    const salted = botAvatarSvg('Researcher', 'x1');
    expect(salted).not.toBe(base);
    expect(botAvatarSvg('Researcher', 'x1')).toBe(salted);
  });

  it('matches the backend roster.avatar_svg hash (SHA-256 of salt:name)', () => {
    // Reference digests computed in Python: hashlib.sha256(f'{salt}:{name}'.encode()).
    // Palette index = floor(point0 * 8); point0 = first 16 bits of the digest / 0xffff.
    // '' → 46112512… → idx 2 ('#b45309'); 'x1' → 06639193… → idx 0 ('#6d28d9').
    const unsalted = botAvatarSvg('Researcher', '');
    expect(unsalted).toContain('#b45309');
    expect(unsalted).toContain('#fcd34d');
    const salted = botAvatarSvg('Researcher', 'x1');
    expect(salted).toContain('#6d28d9');
  });

  it('emits a self-contained SVG', () => {
    const svg = botAvatarSvg('Scribe');
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg.trimEnd().endsWith('</svg>')).toBe(true);
    expect(svg).not.toContain('undefined');
    expect(svg).not.toContain('NaN');
  });

  it('escapes hostile names (no markup injection)', () => {
    const svg = botAvatarSvg('"><script>alert(1)</script>');
    expect(svg).not.toContain('<script');
  });
});

// ── BotsRail ───────────────────────────────────────────────────────────────

vi.mock('@/api/api-client', () => ({
  listBots: vi.fn().mockResolvedValue({
    bots: [
      {
        id: 'agent_aaa1',
        name: 'Researcher',
        description: 'Finds sources',
        uiMeta: { title: 'Research Buddy', avatar: '', hidden: false, groups: [] },
      },
      {
        id: 'agent_bbb2',
        name: 'Critic',
        description: 'Red team',
        uiMeta: { title: 'Red Team', avatar: '', hidden: true, groups: [] },
      },
    ],
  }),
  ensureBotChat: vi.fn().mockResolvedValue({
    sessionId: 'wb_bot1',
    title: 'Bot Chat',
    agentId: 'agent_aaa1',
  }),
  createBot: vi.fn(),
  deleteBot: vi.fn(),
  updateBotUiMeta: vi.fn(),
}));

vi.mock('@/store/chat-active-streams', () => ({
  useActiveChatStreamsStore: (sel: (s: { active: Record<string, string> }) => unknown) =>
    sel({ active: {} }),
}));

// Session summaries feed the roster rows (preview + timestamp) and the
// "Active now" strip. Researcher chatted "now"; Critic 2h ago.
vi.mock('@/api/workbench', () => ({
  getWorkbenchSessions: vi.fn().mockResolvedValue([
    {
      id: 'wb_bot1',
      title: 'Bot Chat',
      agentId: 'agent_aaa1',
      canonicalBotChat: true,
      lastPreview: 'Found three sources on caching.',
      updatedAt: new Date().toISOString(),
    },
    {
      id: 'wb_bot2',
      title: 'Bot Chat',
      agentId: 'agent_bbb2',
      canonicalBotChat: true,
      lastPreview: 'Watched the deploy.',
      updatedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    },
  ]),
}));

import { BotsRail } from '../BotsRail';

function withProviders(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe('BotsRail', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders every roster Bot with its display title', async () => {
    withProviders(<BotsRail onOpenSession={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Research Buddy')).toBeTruthy());
    expect(screen.getByText('Red Team')).toBeTruthy();
  });

  it('opens the Bot profile on row click, then the chat from the profile (Part 27 F5)', async () => {
    const onOpen = vi.fn();
    withProviders(<BotsRail onOpenSession={onOpen} />);
    await waitFor(() => expect(screen.getByText('Research Buddy')).toBeTruthy());
    fireEvent.click(screen.getByText('Research Buddy'));
    // Row click now lands on the profile landing, not the chat directly.
    const profile = await screen.findByTestId('bot-profile');
    expect(profile.textContent).toContain('Research Buddy');
    expect(onOpen).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('bot-profile-open-chat'));
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith('wb_bot1'));
  });

  it('shows the last-message preview on the row', async () => {
    withProviders(<BotsRail onOpenSession={vi.fn()} />);
    await waitFor(() =>
      expect(screen.getByText('Found three sources on caching.')).toBeTruthy(),
    );
  });

  it('shows an "Active now" chip for recent Bots only', async () => {
    withProviders(<BotsRail onOpenSession={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('bots-active-now')).toBeTruthy());
    const strip = screen.getByTestId('bots-active-now');
    expect(strip.textContent).toContain('Research Buddy');
    // Critic wrote 2h ago — not in the strip (hidden anyway).
    expect(strip.textContent).not.toContain('Red Team');
  });

  it('randomize avatar updates uiMeta.avatar (new deterministic face)', async () => {
    const { updateBotUiMeta } = await import('@/api/api-client');
    withProviders(<BotsRail onOpenSession={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Research Buddy')).toBeTruthy());
    fireEvent.click(screen.getAllByLabelText('Bot actions')[0]);
    fireEvent.click(screen.getByTitle('New deterministic face for this Bot'));
    await waitFor(() =>
      expect(updateBotUiMeta).toHaveBeenCalledWith('agent_aaa1', expect.objectContaining({ avatar: expect.any(String) })),
    );
  });

  it('duplicate passes cloneFrom so the copy inherits role/model/toolsets', async () => {
    const { createBot } = await import('@/api/api-client');
    (createBot as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'agent_copy1',
      name: 'research-buddy-copy',
      uiMeta: { title: 'Research Buddy (copy)', avatar: '', hidden: false, groups: [] },
    });
    withProviders(<BotsRail onOpenSession={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Research Buddy')).toBeTruthy());
    fireEvent.click(screen.getAllByLabelText('Bot actions')[0]);
    fireEvent.click(screen.getByText('Duplicate Bot'));
    await waitFor(() =>
      expect(createBot).toHaveBeenCalledWith(expect.objectContaining({ cloneFrom: 'agent_aaa1' })),
    );
  });
});
