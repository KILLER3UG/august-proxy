import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearLiveActivity,
  publishLiveActivity,
  selectSessionLiveActivity,
  useLiveActivityStore,
} from '../liveActivity';

describe('liveActivity per-session store', () => {
  beforeEach(() => {
    clearLiveActivity();
  });

  it('keeps concurrent sessions independent', () => {
    publishLiveActivity({
      sessionId: 'sess_a',
      headline: 'Reading a…',
      items: [
        {
          id: '1',
          kind: 'view',
          label: 'Read',
          status: 'running',
          at: 1,
        },
      ],
    });
    publishLiveActivity({
      sessionId: 'sess_b',
      headline: 'Editing b…',
      items: [
        {
          id: '2',
          kind: 'edit',
          label: 'Edit',
          status: 'running',
          at: 2,
        },
      ],
    });

    const state = useLiveActivityStore.getState();
    expect(selectSessionLiveActivity(state, 'sess_a').headline).toBe('Reading a…');
    expect(selectSessionLiveActivity(state, 'sess_b').headline).toBe('Editing b…');
    expect(selectSessionLiveActivity(state, 'sess_a').items).toHaveLength(1);
    expect(selectSessionLiveActivity(state, 'sess_b').items[0].id).toBe('2');
  });

  it('clears only the requested session', () => {
    publishLiveActivity({
      sessionId: 'sess_a',
      headline: 'A',
      items: [],
    });
    publishLiveActivity({
      sessionId: 'sess_b',
      headline: 'B',
      items: [],
    });
    clearLiveActivity('sess_a');
    const state = useLiveActivityStore.getState();
    expect(selectSessionLiveActivity(state, 'sess_a').headline).toBe('');
    expect(selectSessionLiveActivity(state, 'sess_b').headline).toBe('B');
  });
});
