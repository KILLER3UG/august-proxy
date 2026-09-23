import { describe, expect, it } from 'vitest';
import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { ThoughtStep } from '../ThoughtStep';

const LONG_THOUGHT = [
  'The user is asking about "circuit-sim". This is likely referring to a skill.',
  'Let me load the circuit-sim skill to see what it offers, then try to use it.',
  'First I will inspect the SKILL.md frontmatter and available scripts.',
  'After that I will wire the entry point into the harness and verify the output.',
  'Finally I will summarize what changed and note any follow-up risks for review.',
].join(' ');

describe('ThoughtStep — Claude-style collapsed rendering', () => {
  it('renders a distilled one-line header instead of raw prose by default', () => {
    render(
      <ThoughtStep
        content={LONG_THOUGHT}
        collapsedDefault
        onToggle={() => {}}
      />,
    );
    const row = document.querySelector('[data-slot="thought-summary"]');
    expect(row).toBeTruthy();
    // The header is the distilled participle form, not a raw first line.
    expect(row!.textContent).toContain('Loading the circuit-sim skill');
    // The raw chain-of-thought stays mounted only for overflow measurement,
    // inside the visually-hidden clamp container — never rendered as the row.
    const hiddenProse = document.querySelector(
      '.thought-clamp-hide [data-slot="thought-step"] .process-thought-prose, .thought-clamp-hide .process-thought-prose',
    );
    expect(hiddenProse).toBeTruthy();
    expect(hiddenProse!.closest('[aria-hidden="true"]')).toBeTruthy();
    // The visible summary row itself must not contain the raw CoT text.
    expect(row!.textContent).not.toContain('frontmatter and available scripts');
  });

  it('reveals the full reasoning on "Show full reasoning", hides on "Show less"', () => {
    // `showFull` is a controlled prop — the parent owns it, so this wrapper
    // plays that parent. Asserting the button's text alone would pass even if
    // the prose never came back.
    function Controlled() {
      const [full, setFull] = useState(false);
      return (
        <ThoughtStep
          content={LONG_THOUGHT}
          collapsedDefault
          showFull={full}
          onToggle={() => setFull((v) => !v)}
        />
      );
    }
    render(<Controlled />);
    const summary = () => document.querySelector('[data-slot="thought-summary"]');
    const proseHidden = () =>
      !!document
        .querySelector('.process-thought-prose')
        ?.closest('[aria-hidden="true"]');

    // Collapsed: header only, raw chain of thought parked behind aria-hidden.
    expect(summary()).toBeTruthy();
    expect(proseHidden()).toBe(true);
    expect(screen.queryByText('Show less')).toBeNull();

    // Expand: summary row goes away, prose is exposed, control flips.
    fireEvent.click(screen.getByText('Show full reasoning'));
    expect(summary()).toBeNull();
    expect(proseHidden()).toBe(false);
    expect(screen.getByText('Show less')).toBeTruthy();

    // Collapse: everything returns to the header-only view.
    fireEvent.click(screen.getByText('Show less'));
    expect(summary()).toBeTruthy();
    expect(proseHidden()).toBe(true);
    expect(screen.getByText('Show full reasoning')).toBeTruthy();
  });

  it('shows full prose when showFull is set (user expanded)', () => {
    render(
      <ThoughtStep content={LONG_THOUGHT} collapsedDefault showFull onToggle={() => {}} />,
    );
    expect(screen.getByText(/frontmatter and available scripts/)).toBeTruthy();
    expect(screen.queryByText('Show full reasoning')).toBeNull();
  });

  it('rotates the live header to the latest sentence while generating', () => {
    render(
      <ThoughtStep
        content={LONG_THOUGHT}
        isGenerating
        collapsedDefault
        onToggle={() => {}}
      />,
    );
    const row = document.querySelector('[data-slot="thought-summary"]');
    expect(row).toBeTruthy();
    // Generating → the LATEST sentence distilled ("Finally I will
    // summarize what changed…" → "Summarizing what changed…").
    expect(row!.textContent).toMatch(/Summarizing what changed/i);
    expect(row!.textContent).not.toMatch(/Loading the circuit-sim/);
  });

  it('falls back to "Thinking…" for an empty pending thought with no reveal button', () => {
    render(<ThoughtStep content="" isGenerating collapsedDefault />);
    const row = document.querySelector('[data-slot="thought-summary"]');
    expect(row!.textContent).toContain('Thinking…');
    expect(screen.queryByText('Show full reasoning')).toBeNull();
  });

  it('without collapsedDefault keeps the legacy clamped-prose rendering', () => {
    render(<ThoughtStep content={LONG_THOUGHT} onToggle={() => {}} />);
    expect(document.querySelector('[data-slot="thought-summary"]')).toBeNull();
    expect(screen.getByText('Show more')).toBeTruthy();
  });

  it('fireEvent toggle wiring: onToggle fires from the summary button', () => {
    let toggled = 0;
    render(
      <ThoughtStep
        content={LONG_THOUGHT}
        collapsedDefault
        onToggle={() => {
          toggled += 1;
        }}
      />,
    );
    fireEvent.click(screen.getByText('Show full reasoning'));
    expect(toggled).toBe(1);
  });
});
