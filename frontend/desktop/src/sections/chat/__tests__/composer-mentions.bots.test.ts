/* ── fetchBotMentions: @-picker bot suggestions (3.4) ──────────────────
 * The bot roster must surface as `kind:'bot'` mention items in the @ picker,
 * filtered by the typed query, and read through the shared getBotRoster cache
 * so the picker does not fire a listBots round trip per keystroke. */

import { describe, expect, it, vi } from 'vitest';
import type { Bot } from '@/api/api-client/bots';

const { listBots } = vi.hoisted(() => ({ listBots: vi.fn() }));
vi.mock('@/api/api-client/bots', async (orig) => {
  const actual = await orig<typeof import('@/api/api-client/bots')>();
  return { ...actual, listBots };
});

import { fetchBotMentions } from '../composer-mentions';

const bot = (name: string, title: string, hidden = false): Bot =>
  ({
    id: `ag_${name}`,
    name,
    description: '',
    uiMeta: { title, avatar: '', hidden, groups: [] },
  });

describe('fetchBotMentions', () => {
  it('maps the roster to kind:bot items, filters by query, hides hidden bots, and caches', async () => {
    listBots.mockResolvedValue({
      bots: [bot('researcher', 'Research Buddy'), bot('coder', 'Coder'), bot('secret', 'Secret', true)],
    });
    const items = await fetchBotMentions('');
    // hidden bot excluded; both visible bots present as kind:'bot'.
    expect(items.map((i) => i.kind)).toEqual(['bot', 'bot']);
    expect(items[0]).toMatchObject({ name: '@researcher', insert: '@researcher ' });
    // Query filters by name/title.
    const filtered = await fetchBotMentions('cod');
    expect(filtered.map((i) => i.name)).toEqual(['@coder']);
    // Both calls shared one cached roster fetch.
    expect(listBots).toHaveBeenCalledTimes(1);
  });
});
