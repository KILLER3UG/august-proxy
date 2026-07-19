import { beforeEach, describe, expect, it } from 'vitest';
import { useSessionsStore } from '@/store/sessions';
import {
  resolveUiSessionId,
  resolveWorkbenchSessionId,
} from '../session-id-map';

describe('session-id-map', () => {
  beforeEach(() => {
    useSessionsStore.setState({
      sessions: [
        {
          id: 'sess_a',
          title: 'A',
          startedAt: new Date().toISOString(),
          messageCount: 1,
          lastMessage: 'hi',
          workbenchSessionId: 'wb_a',
        },
        {
          id: 'sess_b',
          title: 'B',
          startedAt: new Date().toISOString(),
          messageCount: 0,
          lastMessage: '',
          workbenchSessionId: 'wb_b',
        },
      ],
      folders: [],
      sessionStates: {},
    });
  });

  it('maps workbench id to UI session id', () => {
    expect(resolveUiSessionId('wb_a')).toBe('sess_a');
    expect(resolveUiSessionId('sess_a')).toBe('sess_a');
  });

  it('maps UI id to workbench id', () => {
    expect(resolveWorkbenchSessionId('sess_b')).toBe('wb_b');
    expect(resolveWorkbenchSessionId('wb_b')).toBe('wb_b');
  });

  it('keeps unknown ids as-is', () => {
    expect(resolveUiSessionId('wb_unknown')).toBe('wb_unknown');
    expect(resolveWorkbenchSessionId('sess_unknown')).toBe('sess_unknown');
  });
});
