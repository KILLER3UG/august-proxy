import { describe, expect, it } from 'vitest';
import { buildProcessSummaryLine, summarizeThoughtHeader } from '../process-summary';

describe('buildProcessSummaryLine', () => {
  it('returns a short first-sentence gist from thinking', () => {
    const line = buildProcessSummaryLine([
      'I am weighing mixed performance metrics and questioning module effectiveness. Then more detail follows here.',
    ]);
    expect(line).toMatch(/weighing mixed performance metrics/i);
    expect(line!.length).toBeLessThan(160);
  });

  it('returns null for empty or tiny thinking', () => {
    expect(buildProcessSummaryLine([])).toBeNull();
    expect(buildProcessSummaryLine(['ok'])).toBeNull();
  });

  it('strips code fences and markdown noise', () => {
    const line = buildProcessSummaryLine([
      '```ts\nconst x = 1\n``` Looking up the antirez MTP flash notes next.',
    ]);
    expect(line).toMatch(/Looking up the antirez/i);
    expect(line).not.toMatch(/const x/);
  });
});

describe('summarizeThoughtHeader', () => {
  it('extracts intent and converts to present participle header', () => {
    const text =
      'The user is asking about "circuit-sim". This is likely referring to a skill. Let me load the circuit-sim skill to see what it offers, then try to use it.';
    const header = summarizeThoughtHeader(text);
    expect(header).toBe('Loading the circuit-sim skill to see what it offers.');
  });

  it('filters out technical noise such as SPICE netlists', () => {
    const text = [
      'V1 in 0 AC 1.',
      'R1 in out 1k.',
      'C1 out 0 1u.',
      '.ac dec 10 1 1Meg.',
      '.control.',
      'run.',
      '.endc.',
      "I'll run a tiny demo so you can see it working.",
    ].join('\n');
    const header = summarizeThoughtHeader(text);
    expect(header).toBe('Running a tiny demo so you can see it working.');
  });

  it('preserves existing natural participle headers', () => {
    const text = 'Weighing real statistics against pitch length and time limits.';
    expect(summarizeThoughtHeader(text)).toBe(
      'Weighing real statistics against pitch length and time limits.',
    );
  });

  it('handles web search intent', () => {
    const text =
      'I need to search the web for statistics on student neck pain prevalence and screen time.';
    const header = summarizeThoughtHeader(text);
    expect(header).toMatch(/^Searching the web/i);
  });

  it('returns Thinking… when generating with empty text', () => {
    expect(summarizeThoughtHeader('', true)).toBe('Thinking…');
  });
});

