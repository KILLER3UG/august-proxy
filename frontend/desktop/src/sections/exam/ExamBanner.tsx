import { useState, useCallback } from 'react';
import { X, HelpCircle, CheckCircle2, XCircle, ChevronRight, Lightbulb, Plus } from 'lucide-react';

interface Question {
  id: number;
  stem: string;
  options: string[];
}

interface AnswerResult {
  correct: boolean;
  correct_index: number;
  rationale: string;
}

interface ExamBannerProps {
  examId: number;
  question: Question;
  onAnswer: (questionId: number, selectedIndex: number) => Promise<AnswerResult>;
  onNext: () => void;
  onAddQuestion: (request: string) => Promise<void>;
  onDismiss: () => void;
}

export function ExamBanner({ examId, question, onAnswer, onNext, onAddQuestion, onDismiss }: ExamBannerProps) {
  const [selected, setSelected] = useState<number | null>(null);
  const [answerResult, setAnswerResult] = useState<AnswerResult | null>(null);
  const [helpText, setHelpText] = useState('');
  const [showExplanation, setShowExplanation] = useState(false);
  const [explanation, setExplanation] = useState('');
  const [addRequest, setAddRequest] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSelect = useCallback(async (index: number) => {
    if (answerResult) return; // already answered
    setSelected(index);
    setIsSubmitting(true);
    try {
      const result = await onAnswer(question.id, index);
      setAnswerResult(result);
    } catch {
      setAnswerResult({ correct: false, correct_index: 0, rationale: 'Error checking answer.' });
    }
    setIsSubmitting(false);
  }, [question.id, answerResult, onAnswer]);

  const handleHelp = useCallback(async () => {
    if (!helpText.trim()) return;
    setIsSubmitting(true);
    try {
      const res = await fetch(`/api/exam/${examId}/help`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question_id: question.id, ask: helpText }),
      });
      if (res.ok) {
        const data = await res.json();
        setExplanation(data.explanation || 'No explanation available.');
      } else {
        setExplanation('Unable to get help right now.');
      }
      setShowExplanation(true);
    } catch {
      setExplanation('Unable to get help right now.');
      setShowExplanation(true);
    }
    setIsSubmitting(false);
  }, [examId, question.id, helpText]);

  const handleAddQuestion = useCallback(async () => {
    if (!addRequest.trim()) return;
    setIsSubmitting(true);
    try {
      await onAddQuestion(addRequest);
      setAddRequest('');
    } catch {}
    setIsSubmitting(false);
  }, [addRequest, onAddQuestion]);

  return (
    <>
      {/* Banner */}
      <div className="fixed bottom-0 left-0 right-0 z-50 border-t border-border bg-card shadow-2xl animate-slide-up">
        <div className="mx-auto max-w-3xl p-4 space-y-4">
          {/* Header */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Lightbulb className="size-4 text-warning" />
              <span className="text-sm font-medium">Exam Mode</span>
            </div>
            <button onClick={onDismiss} className="text-muted-foreground hover:text-foreground transition">
              <X className="size-4" />
            </button>
          </div>

          {/* Question stem */}
          <p className="text-sm leading-relaxed">{question.stem}</p>

          {/* Options */}
          <div className="space-y-2">
            {question.options.map((opt, i) => {
              let className = 'w-full text-left px-3 py-2 rounded-lg border text-sm transition-colors ';
              if (answerResult === null) {
                className += 'border-border hover:border-primary hover:bg-accent/30 cursor-pointer';
              } else if (i === answerResult.correct_index) {
                className += 'border-success bg-success/10 text-success';
              } else if (i === selected && !answerResult.correct) {
                className += 'border-danger bg-danger/10 text-danger';
              } else {
                className += 'border-border opacity-50';
              }
              return (
                <button key={i} onClick={() => handleSelect(i)} className={className} disabled={answerResult !== null || isSubmitting}>
                  <span className="flex items-center gap-2">
                    {answerResult !== null && i === answerResult.correct_index && <CheckCircle2 className="size-3.5 shrink-0" />}
                    {answerResult !== null && i === selected && !answerResult.correct && <XCircle className="size-3.5 shrink-0" />}
                    <span className="text-xs font-medium text-muted-foreground w-5">{String.fromCharCode(65 + i)}.</span>
                    {opt}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Result + Next */}
          {answerResult && (
            <div className="flex items-center justify-between">
              <p className={`text-xs ${answerResult.correct ? 'text-success' : 'text-danger'}`}>
                {answerResult.correct ? 'Correct!' : 'Incorrect'}
              </p>
              <button onClick={onNext} className="flex items-center gap-1 text-xs font-medium text-primary hover:underline">
                Next <ChevronRight className="size-3" />
              </button>
            </div>
          )}

          {/* Help input */}
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={helpText}
              onChange={(e) => setHelpText(e.target.value)}
              placeholder="Ask the model for help…"
              className="flex-1 bg-muted border border-border rounded-lg px-3 py-1.5 text-xs outline-none focus:border-ring transition"
              onKeyDown={(e) => e.key === 'Enter' && handleHelp()}
            />
            <button onClick={handleHelp} disabled={isSubmitting || !helpText.trim()} className="text-primary hover:underline text-xs font-medium shrink-0">
              <HelpCircle className="size-4" />
            </button>
          </div>

          {/* Add question input */}
          <div className="flex items-center gap-2 border-t border-border pt-2">
            <input
              type="text"
              value={addRequest}
              onChange={(e) => setAddRequest(e.target.value)}
              placeholder="Add a question about…"
              className="flex-1 bg-transparent text-xs text-muted-foreground outline-none placeholder:text-muted-foreground/50"
              onKeyDown={(e) => e.key === 'Enter' && handleAddQuestion()}
            />
            <button onClick={handleAddQuestion} disabled={isSubmitting || !addRequest.trim()} className="text-primary hover:underline text-xs font-medium shrink-0">
              <Plus className="size-3.5" />
            </button>
          </div>
        </div>
      </div>

      {/* Explanation modal (overlay, non-blocking) */}
      {showExplanation && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30" onClick={() => setShowExplanation(false)}>
          <div className="bg-card border border-border rounded-xl shadow-2xl max-w-lg w-full mx-4 p-5 space-y-3 animate-in fade-in zoom-in-95" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium">Explanation</h3>
              <button onClick={() => setShowExplanation(false)} className="text-muted-foreground hover:text-foreground">
                <X className="size-4" />
              </button>
            </div>
            <div className="text-xs text-muted-foreground leading-relaxed whitespace-pre-wrap">{explanation}</div>
            {answerResult && (
              <p className={`text-xs font-medium ${answerResult.correct ? 'text-success' : 'text-danger'}`}>
                {answerResult.correct ? '✓ You got it right' : '✗ Keep studying'}
              </p>
            )}
            <button onClick={() => setShowExplanation(false)} className="w-full mt-2 py-2 text-xs font-medium bg-primary text-primary-foreground rounded-lg hover:opacity-90 transition">
              Got it
            </button>
          </div>
        </div>
      )}
    </>
  );
}
