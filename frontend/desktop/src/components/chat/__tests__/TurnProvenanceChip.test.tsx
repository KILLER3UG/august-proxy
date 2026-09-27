/* ── TurnProvenanceChip test (audit A6 / #15) ───────────────────────────
 * Two rules the transcript depends on: a turn that reported nothing renders
 * NOTHING (so the chip never becomes decoration on every message), and the
 * detail — names, fact count, failure families — is in the tooltip rather
 * than in the label, so the transcript stays scannable.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { TurnProvenanceChip } from '../TurnProvenanceChip';

describe('TurnProvenanceChip', () => {
  it('renders nothing when the turn injected nothing and hit nothing', () => {
    const { container } = render(<TurnProvenanceChip />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for empty lists — the omitted-key case, not a "0" chip', () => {
    const { container } = render(
      <TurnProvenanceChip provenance={{ skillsInjected: [], factsInjected: [], errorFamilies: [] }} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('names only what was injected', () => {
    render(<TurnProvenanceChip provenance={{ skillsInjected: ['reviewer'] }} />);
    expect(screen.getByTestId('provenance-skills').textContent).toBe('1 skill');
    expect(screen.queryByTestId('provenance-facts')).toBeNull();
    expect(screen.queryByTestId('provenance-errors')).toBeNull();
  });

  it('pluralizes and counts facts and failure families', () => {
    render(
      <TurnProvenanceChip
        provenance={{
          skillsInjected: ['a', 'b'],
          factsInjected: ['k1', 'k2', 'k3'],
          errorFamilies: ['timeout', 'auth'],
        }}
      />,
    );
    expect(screen.getByTestId('provenance-skills').textContent).toBe('2 skills');
    expect(screen.getByTestId('provenance-facts').textContent).toBe('3 facts');
    expect(screen.getByTestId('provenance-errors').textContent).toBe('2 failures');
  });

  it('reveals the names, the fact keys and the families on hover', () => {
    render(
      <TurnProvenanceChip
        provenance={{
          skillsInjected: ['quartus-flow'],
          factsInjected: ['user.timezone', 'user.editor'],
          errorFamilies: ['rate_limit'],
        }}
      />,
    );
    expect(screen.queryByTestId('turn-provenance-detail')).toBeNull();

    fireEvent.mouseEnter(screen.getByTestId('turn-provenance-chip'));
    const detail = screen.getByTestId('turn-provenance-detail');
    expect(within(detail).getByText('quartus-flow')).toBeInTheDocument();
    expect(detail.textContent).toContain('2 facts recalled from memory');
    expect(detail.textContent).toContain('user.timezone, user.editor');
    expect(detail.textContent).toContain('1 failure hit this turn');
    expect(detail.textContent).toContain('rate_limit');
  });

  it('keeps the bubble keyboard-reachable and Escape-dismissible', () => {
    render(<TurnProvenanceChip provenance={{ skillsInjected: ['a'] }} />);
    const chip = screen.getByTestId('turn-provenance-chip');
    fireEvent.focus(chip);
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    fireEvent.keyDown(chip, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('summarises a large fact set by count alone rather than dumping every key', () => {
    render(
      <TurnProvenanceChip
        provenance={{ factsInjected: ['k1', 'k2', 'k3', 'k4', 'k5', 'k6'] }}
      />,
    );
    fireEvent.mouseEnter(screen.getByTestId('turn-provenance-chip'));
    const detail = screen.getByTestId('turn-provenance-detail');
    expect(detail.textContent).toContain('6 facts recalled from memory');
    expect(detail.textContent).not.toContain('k6');
  });
});
