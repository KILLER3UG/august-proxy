import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CostCeilingChip } from '../CostCeilingChip';

vi.mock('@/api/workbench', () => ({
  setWorkbenchCostCeiling: vi.fn(async () => ({ ok: true })),
}));

/* The composer chip is the one money figure a user sees every turn. It used to
 * print "$0.041" whether the number came from a price the user set or from
 * August guessing off a model-family table — and the guess was the common
 * case, since no per-model price field existed until now. */
describe('CostCeilingChip — estimate marker', () => {
  it('marks a table-guessed figure with a tilde and says where it came from', () => {
    render(<CostCeilingChip sessionId="wb_1" cost={0.0412} estimated initialCeiling={0} />);
    expect(screen.getByTestId('cost-ceiling-value').textContent).toBe('~$0.041');
    expect(screen.getByTestId('cost-ceiling-chip').getAttribute('title')).toContain(
      'model-family table',
    );
  });

  it('drops the tilde when the price was set on the model', () => {
    render(
      <CostCeilingChip sessionId="wb_1" cost={0.0412} estimated={false} initialCeiling={0} />,
    );
    expect(screen.getByTestId('cost-ceiling-value').textContent).toBe('$0.041');
    expect(screen.getByTestId('cost-ceiling-chip').getAttribute('title')).toContain(
      'prices you set',
    );
  });

  it('treats an absent flag as a guess, not as a fact', () => {
    // A cached usage payload from before costEstimated shipped has no key;
    // reading that as "exact" would print a confident $ over a guess.
    render(<CostCeilingChip sessionId="wb_1" cost={1.5} initialCeiling={0} />);
    expect(screen.getByTestId('cost-ceiling-value').textContent).toBe('~$1.500');
  });

  it('keeps the tilde next to the ceiling it is measuring against', () => {
    render(
      <CostCeilingChip sessionId="wb_1" cost={0.9} estimated initialCeiling={2} />,
    );
    expect(screen.getByTestId('cost-ceiling-value').textContent).toBe('~$0.900');
    expect(screen.getByTestId('cost-ceiling-chip').getAttribute('title')).toContain(
      'of $2.00 used',
    );
  });
});
