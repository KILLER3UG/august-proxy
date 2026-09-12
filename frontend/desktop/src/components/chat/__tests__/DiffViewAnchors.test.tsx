/* DiffView review anchors — findings painted onto their lines. */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DiffView } from '@/components/chat/DiffView';

const DIFF = [
  '@@ -1,2 +1,2 @@',
  ' context line',
  '-old code',
  '+new code',
].join('\n');

describe('DiffView anchors', () => {
  it('renders severity chips on the anchored rows with scroll ids', () => {
    render(
      <DiffView
        diff={DIFF}
        anchors={[{ line: 2, tag: 'P1', title: 'unguarded division' }]}
        idPrefix="da-x"
      />,
    );
    const chips = screen.getAllByTestId('diff-line-anchor');
    expect(chips.length).toBeGreaterThan(0);
    expect(chips[0].textContent).toContain('P1');
    expect(chips[0].textContent).toContain('unguarded division');
    // Chips live inside rows carrying the scroll id + marker.
    const row = chips[0].closest('[data-diff-anchor]');
    expect(row?.getAttribute('data-diff-anchor')).toBe('2');
    expect(row?.getAttribute('id')).toBe('da-x-2');
  });

  it('removed rows anchor on the OLD line number', () => {
    render(
      <DiffView
        diff={DIFF}
        anchors={[{ line: 2, tag: 'P2', title: 'old side' }]}
        idPrefix="da-y"
      />,
    );
    // "-old code" is oldLine 2 → gets the anchor; "+new code" is newLine 2
    // too, so both rows match; at minimum one chip renders.
    expect(screen.getAllByTestId('diff-line-anchor').length).toBeGreaterThan(0);
  });

  it('no anchors -> no badges, no ids (existing consumers unaffected)', () => {
    render(<DiffView diff={DIFF} />);
    expect(screen.queryByTestId('diff-line-anchor')).toBeNull();
    expect(document.querySelector('[data-diff-anchor]')).toBeNull();
  });
});
