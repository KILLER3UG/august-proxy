/* v3 — ExamBanner integration: lifecycle (generate → answer → next) + /Exam slash */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ExamHost } from '@/sections/exam/ExamHost';

const Q1 = {
  exam_id: 1,
  question: { id: 10, exam_id: 1, position: 1, stem: 'What is 2+2?', options: ['3', '4', '5', '6'] },
  total_questions: 2,
};

const Q2_NEXT = {
  id: 11,
  exam_id: 1,
  position: 2,
  stem: 'Capital of France?',
  options: ['Berlin', 'Madrid', 'Paris', 'Rome'],
};

const ANSWER_OK = { is_correct: true, correct_index: 1, rationale: '2+2=4.' };

function mockFetchSequence(responses: Array<{ ok?: boolean; body?: unknown; status?: number }>) {
  let i = 0;
  return vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    const r = responses[Math.min(i++, responses.length - 1)];
    return Promise.resolve({
      ok: r.ok ?? true,
      status: r.status ?? 200,
      json: async () => r.body,
    });
  });
}

describe('v3 — ExamHost', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the question stem + 4 options after /Exam', async () => {
    global.fetch = mockFetchSequence([{ body: Q1 }, { body: Q2_NEXT }]);
    render(<ExamHost onDismiss={() => {}} />);
    await waitFor(() => {
      expect(screen.getByText('What is 2+2?')).toBeTruthy();
      expect(screen.getByText('3')).toBeTruthy();
      expect(screen.getByText('4')).toBeTruthy();
      expect(screen.getByText('5')).toBeTruthy();
      expect(screen.getByText('6')).toBeTruthy();
    });
  });

  it('records answer and advances to next question on Next', async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? 'GET' });
      let body: unknown;
      if (url.includes('/generate')) body = Q1;
      else if (url.includes('/answer')) body = ANSWER_OK;
      else if (url.includes('/question/2')) body = Q2_NEXT;
      else body = Q1;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => body,
      });
    });
    global.fetch = fetchMock;

    render(<ExamHost onDismiss={() => {}} />);
    await waitFor(() => screen.getByText('4'));
    // Select option 1 ("4"), submit
    fireEvent.click(screen.getByText('4'));
    await waitFor(() => screen.getByText('Next'));
    fireEvent.click(screen.getByText('Next'));
    await waitFor(() => {
      expect(screen.getByText('Capital of France?')).toBeTruthy();
    });
    // Should have called /answer then /question/2
    const methods = calls.map((c) => c.url + ':' + c.method);
    expect(methods.some((u) => u.includes('/answer') && u.endsWith('POST'))).toBe(true);
    expect(methods.some((u) => u.includes('/question/2'))).toBe(true);
  });
});