import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ModelPickerDropdown } from '../ModelPickerDropdown';
import type { AggregatedModel } from '@/api/api-client';

// The catalog lists `stepfun/step-3.7-flash` under OpenRouter AND KiloCode. The
// dropdown used to resolve `value` by id alone, so an alias aimed at KiloCode
// badge-displayed "OpenRouter" and BOTH rows carried the selected style.

const MODELS = [
  {
    id: 'stepfun/step-3.7-flash',
    name: 'stepfun/step-3.7-flash',
    provider: 'OpenRouter',
    contextWindow: 128000,
  },
  {
    id: 'stepfun/step-3.7-flash',
    name: 'stepfun/step-3.7-flash',
    provider: 'KiloCode',
    contextWindow: 128000,
  },
] as unknown as AggregatedModel[];

const renderWith = (modelProvider?: string) =>
  render(
    <ModelPickerDropdown
      models={MODELS}
      value="stepfun/step-3.7-flash"
      modelProvider={modelProvider}
      onChange={vi.fn()}
    />,
  );

const selectedRows = () =>
  Array.from(document.querySelectorAll('button')).filter((el) =>
    el.className.includes('bg-primary/10'),
  );

describe('ModelPickerDropdown — a value that needs its gateway', () => {
  it('badges the gateway the value belongs to, not the first match', () => {
    renderWith('KiloCode');
    expect(screen.getByText('KiloCode')).toBeTruthy();
    expect(screen.queryByText('OpenRouter')).toBeNull();
  });

  it('marks exactly one row selected once the gateway is known', () => {
    renderWith('KiloCode');
    fireEvent.click(screen.getByRole('button'));
    expect(selectedRows()).toHaveLength(1);
  });

  it('still marks every row sharing the id when the caller stores only an id', () => {
    // Fleet and reflection genuinely persist a bare model id, so this is the
    // honest reading of their state, not a bug: every match is a candidate.
    renderWith(undefined);
    fireEvent.click(screen.getByRole('button'));
    expect(selectedRows()).toHaveLength(2);
  });
});
