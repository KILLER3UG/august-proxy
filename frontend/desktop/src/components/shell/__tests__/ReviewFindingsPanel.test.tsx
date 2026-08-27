import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ReviewFindingsPanel } from '../ReviewFindingsPanel';
import type { CodeReviewResult } from '@/api/codeReview';

function result(partial: Partial<CodeReviewResult> = {}): CodeReviewResult {
  return {
    skipped: false,
    notice: '',
    counts: { p0: 0, p1: 0, p2: 0, p3: 0 },
    findings: [],
    droppedUngrounded: 0,
    ...partial,
  };
}

describe('ReviewFindingsPanel (Part 10 R-A, advisory only)', () => {
  it('renders severity counts and findings', () => {
    render(
      <ReviewFindingsPanel
        result={result({
          counts: { p0: 1, p1: 2, p2: 0, p3: 0 },
          findings: [
            {
              severity: 0,
              tag: 'P0',
              title: 'Silent data loss',
              body: 'The save path swallows errors.',
              file: 'src/save.py',
              line: 42,
              failSafe: false,
              status: 'kept',
              groundedPath: 'src/save.py',
            },
            {
              severity: 1,
              tag: 'P1',
              title: 'Untagged one',
              body: '',
              file: '',
              line: 0,
              failSafe: true,
              status: 'kept',
              groundedPath: '',
            },
          ],
        })}
      />,
    );
    expect(screen.getByTestId('review-findings-panel')).toBeTruthy();
    expect(screen.getAllByTestId('review-finding-row')).toHaveLength(2);
    expect(screen.getByText('Silent data loss')).toBeTruthy();
    // file:line anchor is rendered
    expect(screen.getByText(/src\/save\.py:42/)).toBeTruthy();
    // fail-safe badge for the untagged finding
    expect(screen.getByText(/untagged → P1/)).toBeTruthy();
  });

  it('clicking an anchor selects the file', () => {
    const onSelectFile = vi.fn();
    render(
      <ReviewFindingsPanel
        result={result({
          counts: { p0: 0, p1: 1, p2: 0, p3: 0 },
          findings: [
            {
              severity: 1,
              tag: 'P1',
              title: 'Bug',
              body: '',
              file: 'app/a.py',
              line: 7,
              failSafe: false,
              status: 'rehomed',
              groundedPath: 'app/a.py',
            },
          ],
        })}
        onSelectFile={onSelectFile}
      />,
    );
    fireEvent.click(screen.getByTestId('review-finding-anchor'));
    expect(onSelectFile).toHaveBeenCalledWith('app/a.py');
    // rehomed grounding is surfaced, not hidden
    expect(screen.getByText(/rehomed by grounding/)).toBeTruthy();
  });

  it('shows the loud notice for skipped reviews (fail-open)', () => {
    render(
      <ReviewFindingsPanel
        result={result({ skipped: true, notice: 'Changeset too large to review.' })}
      />,
    );
    expect(screen.getByTestId('review-notice').textContent).toContain('too large');
  });

  it('reports dropped ungrounded findings instead of hiding them', () => {
    render(<ReviewFindingsPanel result={result({ droppedUngrounded: 2 })} />);
    expect(screen.getByText(/2 findings dropped/)).toBeTruthy();
  });

  it('states the advisory contract', () => {
    render(<ReviewFindingsPanel result={result()} />);
    expect(screen.getByText(/Advisory only/)).toBeTruthy();
    expect(screen.getByText(/no findings/)).toBeTruthy();
  });

  it('shows the Layer-2 judge report when it ran', () => {
    render(
      <ReviewFindingsPanel
        result={result({
          judge: {
            ran: true,
            reason: '',
            judgeModel: 'judge-model',
            discarded: 2,
            clusteredDuplicates: 1,
          },
        })}
      />,
    );
    const line = screen.getByTestId('review-judge-line');
    expect(line.textContent).toContain('judge-model');
    expect(line.textContent).toContain('dropped 2');
    expect(line.textContent).toContain('clustered 1');
  });

  it('dismiss clears the panel via callback', () => {
    const onDismiss = vi.fn();
    render(<ReviewFindingsPanel result={result()} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByTestId('review-dismiss'));
    expect(onDismiss).toHaveBeenCalled();
  });
});
