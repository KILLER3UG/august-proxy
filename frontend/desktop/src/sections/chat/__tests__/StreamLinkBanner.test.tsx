import { afterEach, describe, expect, it } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { StreamLinkBanner } from '../StreamLinkBanner';
import {
  clearStreamReconnecting,
  markStreamReconnecting,
} from '@/store/streamLink';

describe('StreamLinkBanner', () => {
  afterEach(() => {
    clearStreamReconnecting('wb_ui');
    clearStreamReconnecting('wb_other');
  });

  it('stays out of the way while the link is healthy', () => {
    render(<StreamLinkBanner sessionId="wb_ui" />);
    expect(screen.queryByTestId('stream-reconnecting')).not.toBeInTheDocument();
  });

  it('names the session that dropped, not every chat', () => {
    markStreamReconnecting('wb_other', 2);
    render(<StreamLinkBanner sessionId="wb_ui" />);
    expect(screen.queryByTestId('stream-reconnecting')).not.toBeInTheDocument();
  });

  it('reports the attempt while retrying and disappears once reconnected', () => {
    render(<StreamLinkBanner sessionId="wb_ui" />);

    act(() => markStreamReconnecting('wb_ui', 3));
    const banner = screen.getByTestId('stream-reconnecting');
    expect(banner).toHaveTextContent('attempt 3');
    // The turn is not lost — the copy has to say so, or "interrupted" reads
    // like a failure the user must redo.
    expect(banner).toHaveTextContent('keeps running');

    act(() => clearStreamReconnecting('wb_ui'));
    expect(screen.queryByTestId('stream-reconnecting')).not.toBeInTheDocument();
  });
});
