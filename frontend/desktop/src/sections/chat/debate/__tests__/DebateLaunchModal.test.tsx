import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { DebateLaunchModal } from '../DebateLaunchModal';
import type { ModelItem } from '../../model-display';

// `stepfun/step-3.7-flash` is listed by OpenRouter AND KiloCode in the real
// catalog. The selects used to carry the bare id, so both options resolved to
// whichever match came first — picking the KiloCode row started the lane on
// OpenRouter — and the two identical ids collided as React keys.

const MODELS: ModelItem[] = [
  { id: 'stepfun/step-3.7-flash', name: 'stepfun/step-3.7-flash', provider: 'OpenRouter', contextWindow: 128000 },
  { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', provider: 'OpenRouter', contextWindow: 128000 },
  { id: 'stepfun/step-3.7-flash', name: 'stepfun/step-3.7-flash', provider: 'KiloCode', contextWindow: 128000 },
];

function pickByLabel(select: HTMLSelectElement, text: string): void {
  const opt = Array.from(select.options).find((o) => (o.textContent ?? '').includes(text));
  if (!opt) throw new Error(`no option containing ${text}`);
  fireEvent.change(select, { target: { value: opt.value } });
}

const laneSelect = (label: string): HTMLSelectElement => {
  const el = document.querySelector<HTMLSelectElement>(`[data-testid="debate-select-${label}"]`);
  if (!el) throw new Error(`no select for ${label}`);
  return el;
};

describe('DebateLaunchModal — one id, two gateways', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('offers both gateways without colliding on a React key', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <DebateLaunchModal
        models={MODELS}
        initialPrompt="compare the two"
        onLaunch={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    // Debater A excludes only B's lane (DeepSeek), so both gateways' copies of
    // the colliding id are offered — and rendered without a key collision.
    const a = laneSelect('debater a');
    const labels = Array.from(a.options).map((o) => o.textContent);
    expect(labels).toContain('stepfun/step-3.7-flash (OpenRouter)');
    expect(labels).toContain('stepfun/step-3.7-flash (KiloCode)');
    expect(new Set(labels).size).toBe(labels.length);
    expect(errors.mock.calls.flat().join(' ')).not.toContain('two children with the same key');
    errors.mockRestore();
  });

  it('launches the gateway the user actually selected, same id and all', () => {
    const onLaunch = vi.fn();
    render(
      <DebateLaunchModal
        models={MODELS}
        initialPrompt="compare the two"
        onLaunch={onLaunch}
        onClose={vi.fn()}
      />,
    );
    const a = laneSelect('debater a');
    const b = laneSelect('debater b');
    pickByLabel(a, '(OpenRouter)');
    pickByLabel(b, '(KiloCode)');
    // Same id on two gateways IS a cross-provider comparison — the old id-only
    // equality check refused to launch it.
    fireEvent.click(screen.getByTestId('debate-launch'));
    expect(onLaunch).toHaveBeenCalledTimes(1);
    const [laneA, laneB] = onLaunch.mock.calls[0];
    expect(laneA).toEqual(
      expect.objectContaining({ modelId: 'stepfun/step-3.7-flash', provider: 'OpenRouter' }),
    );
    expect(laneB).toEqual(
      expect.objectContaining({ modelId: 'stepfun/step-3.7-flash', provider: 'KiloCode' }),
    );
  });

  it('restores a preset stored as a bare id', () => {
    localStorage.setItem(
      'august_debate_last_config',
      JSON.stringify({
        a: 'stepfun/step-3.7-flash',
        b: 'deepseek-v4-flash',
        judge: '',
        rounds: 2,
      }),
    );
    const onLaunch = vi.fn();
    render(
      <DebateLaunchModal
        models={MODELS}
        initialPrompt="compare the two"
        onLaunch={onLaunch}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('debate-resume-last'));
    const a = laneSelect('debater a');
    // The legacy value is a bare id; the options are keyed by gateway, so the
    // select must land on the first match rather than render blank.
    expect(a.options[a.selectedIndex]?.textContent).toContain('stepfun/step-3.7-flash');
    fireEvent.click(screen.getByTestId('debate-launch'));
    expect(onLaunch.mock.calls[0][3]).toBe(2);
  });
});
