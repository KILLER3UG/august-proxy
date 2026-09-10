/* ── Evidence chips (UI suggestion 3) ───────────────────────────────────── */
/* The inbox detail card must render structured evidence (the "Header:" +
 * "- bullet" shape the scheduled passes write) as chips, and must NOT touch
 * prose evidence — a human decides on the exact text shown. */

import { describe, it, expect, vi } from 'vitest';

vi.mock('@/api/client', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), message: vi.fn() },
}));

import { parseEvidence } from '../HarnessImprovementsSection';

const SCHEDULED = [
  'Recurring failure fingerprints (seen >=2x, last 90d):',
  '- tool-error:edit-without-read: 4 episodes, status=open',
  '- user-correction:overlong-answer: 2 episodes, status=resolved',
  'Guardrail block hot-spots (last 7d) — repeated blocks are harness-shape signal:',
  '- run_command x12: blocked: identical call repeats across turns',
].join('\n');

describe('parseEvidence', () => {
  it('parses the scheduled-pass section/bullet shape into sections', () => {
    const { sections, structured } = parseEvidence(SCHEDULED);
    expect(structured).toBe(true);
    expect(sections).toHaveLength(2);
    expect(sections[0].title).toBe('Recurring failure fingerprints (seen >=2x, last 90d)');
    expect(sections[0].items).toHaveLength(2);
    expect(sections[0].items[0]).toContain('edit-without-read');
    expect(sections[1].items[0]).toContain('run_command x12');
  });

  it('keeps bare bullet lists structured without headers', () => {
    const { sections, structured } = parseEvidence('- broken registrations: foo\n- long descriptions: bar');
    expect(structured).toBe(true);
    expect(sections).toHaveLength(1);
    expect(sections[0].title).toBe('');
    expect(sections[0].items).toHaveLength(2);
  });

  it('prose is NOT restructured — evidence text must never be eaten', () => {
    const prose =
      'The fact "prefers tabs" has not been recalled in 210 days and was never quoted ' +
      'by the model, so it is proposed for retirement. Use counts live in the facts table.';
    const { structured } = parseEvidence(prose);
    expect(structured).toBe(false);
  });

  it('mixed mostly-prose with one bullet stays unstructured (conservative)', () => {
    const mixed =
      'A very long human-written explanation of why this observation matters that clearly ' +
      'dominates the text volume of anything else present here.\n- one stray bullet';
    const { structured } = parseEvidence(mixed);
    expect(structured).toBe(false);
  });

  it('empty/whitespace input yields nothing', () => {
    expect(parseEvidence('').structured).toBe(false);
    expect(parseEvidence('   \n  ').sections).toHaveLength(0);
  });
});
