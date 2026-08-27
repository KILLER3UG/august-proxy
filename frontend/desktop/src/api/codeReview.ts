/* ── code-review-api ─ typed client for /api/code-review/* (Part 10 R-A) ── */

import { api } from './client';

export interface ReviewFinding {
  severity: number;
  tag: string;
  title: string;
  body: string;
  file: string;
  line: number;
  failSafe: boolean;
  /** kept | rehomed (Layer-1 grounding; dropped findings never arrive). */
  status: string;
  groundedPath: string;
  /** Layer-2 judge confidence 0..1 when an independent judge ran. */
  confidence?: number | null;
}

export interface ReviewCounts {
  p0: number;
  p1: number;
  p2: number;
  p3: number;
}

export interface ReviewJudgeReport {
  ran: boolean;
  reason: string;
  judgeModel?: string;
  discarded?: number;
  clusteredDuplicates?: number;
}

export interface CodeReviewResult {
  /** Advisory only — a skipped review is a notice, never an error gate. */
  skipped: boolean;
  notice: string;
  model?: string;
  counts: ReviewCounts;
  findings: ReviewFinding[];
  droppedUngrounded?: number;
  /** R-B Layer-2 independent-model judge report (absent on older backends). */
  judge?: ReviewJudgeReport;
  passes?: number;
}

export const codeReviewApi = {
  run: (opts: { sessionId?: string; workspace?: string; diffText?: string; modelHint?: string }) =>
    api.post<CodeReviewResult>('/api/code-review/run', {
      sessionId: opts.sessionId || '',
      workspace: opts.workspace || '',
      diffText: opts.diffText || '',
      modelHint: opts.modelHint || '',
    }),
  rubric: () => api.get<{ rubric: string; conventionsDirective: string }>('/api/code-review/rubric'),
};
