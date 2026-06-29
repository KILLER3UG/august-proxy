/* v3 — ExamHost: manages exam lifecycle (generate → fetch → answer → next).
   Wraps the controlled ExamBanner with state for examId, current question,
   total questions, and progression. Used by ChatThread when the user types
   `/Exam` (with optional topic or file paths). */
import { useEffect, useState, useCallback } from 'react';
import { ExamBanner } from './ExamBanner';

interface Question {
  id: number;
  exam_id?: number;
  position?: number;
  stem: string;
  options: string[];
}

interface AnswerResult {
  correct?: boolean;
  is_correct?: boolean;
  correct_index: number;
  rationale: string;
}

interface ExamHostProps {
  topic?: string;
  files?: string[];
  count?: number;
  difficulty?: string;
  onDismiss: () => void;
}

const API_BASE = '/api/exam';

export function ExamHost(props: ExamHostProps) {
  const {
    onDismiss,
  } = props;
  // Stable defaults — default param values like `files = []` would allocate
  // a fresh array on every render and re-fire the bootstrap useEffect,
  // overwriting the user's current question after every answer/next click.
  const [topic] = useState<string>(() => props.topic ?? 'general knowledge');
  const [files] = useState<string[]>(() => props.files ?? []);
  const [count] = useState<number>(() => props.count ?? 5);
  const [difficulty] = useState<string>(() => props.difficulty ?? 'medium');

  const [examId, setExamId] = useState<number | null>(null);
  const [question, setQuestion] = useState<Question | null>(null);
  const [position, setPosition] = useState<number>(1);
  const [totalQuestions, setTotal] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  // Bootstrap: generate the exam. Run exactly once on mount.
  // topic/files/count/difficulty are now state (stable references), so
  // the deps array never changes after first render.
  useEffect(() => {
    let cancelled = false;
    const bootstrap = async () => {
      try {
        const body: Record<string, unknown> = { count, difficulty };
        if (files.length > 0) body.files = files;
        else body.topic = topic;

        const resp = await fetch(`${API_BASE}/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        if (cancelled) return;
        setExamId(data.exam_id);
        setQuestion(data.question);
        setTotal(data.total_questions ?? 0);
        setPosition(1);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    bootstrap();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleAnswer = useCallback(
    async (questionId: number, selectedIndex: number): Promise<AnswerResult> => {
      if (!examId) throw new Error('No exam');
      const resp = await fetch(`${API_BASE}/${examId}/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question_id: questionId, selected_index: selectedIndex }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      // Normalize to AnswerResult (backend uses `is_correct`; banner may use `correct`)
      return {
        is_correct: data.is_correct ?? data.correct ?? false,
        correct_index: data.correct_index,
        rationale: data.rationale ?? '',
      };
    },
    [examId],
  );

  const handleNext = useCallback(async () => {
    if (!examId) return;
    const nextPos = position + 1;
    if (totalQuestions > 0 && nextPos > totalQuestions) {
      // Exam complete — dismiss
      onDismiss();
      return;
    }
    setPosition(nextPos);
    try {
      const resp = await fetch(`${API_BASE}/${examId}/question/${nextPos}`);
      if (!resp.ok) {
        if (resp.status === 404) {
          onDismiss();
          return;
        }
        throw new Error(`HTTP ${resp.status}`);
      }
      const q = await resp.json();
      setQuestion(q);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [examId, position, totalQuestions, onDismiss]);

  const handleAddQuestion = useCallback(
    async (request: string) => {
      if (!examId) return;
      const resp = await fetch(`${API_BASE}/${examId}/questions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ request }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      if (data?.question) {
        setQuestion(data.question);
        setPosition(data.position);
        setTotal((t) => (t > 0 ? t + 1 : t));
      }
    },
    [examId],
  );

  if (loading) {
    return (
      <div className="fixed bottom-0 left-0 right-0 z-50 border-t border-border bg-card shadow-2xl p-4">
        <div className="mx-auto max-w-3xl text-sm text-muted-foreground">Generating exam…</div>
      </div>
    );
  }
  if (error) {
    return (
      <div className="fixed bottom-0 left-0 right-0 z-50 border-t border-border bg-card shadow-2xl p-4">
        <div className="mx-auto max-w-3xl text-sm text-danger">
          Failed to load exam: {error}
          <button onClick={onDismiss} className="ml-3 underline text-xs">
            dismiss
          </button>
        </div>
      </div>
    );
  }
  if (!question || !examId) return null;

  return (
    <ExamBanner
      examId={examId}
      question={question}
      onAnswer={handleAnswer}
      onNext={handleNext}
      onAddQuestion={handleAddQuestion}
      onDismiss={onDismiss}
    />
  );
}