/* ── SkillSuggestionChip — proactive suggestion to save episode as skill ──── */
/* Listens to brain event SSE for skill_suggestion events and allows the      */
/* user to preview/save the completed workstream episode as a permanent skill. */

import { useEffect, useRef, useState } from 'react';
import { BookmarkPlus, Check, Sparkles, X, Loader2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { openBrainEventStream, type BrainEvent } from '@/api/api-client';
import * as subagents from '@/api/subagents';
import { cn } from '@/lib/utils';

export interface SkillSuggestionData {
  workstream: string;
  suggestedName: string;
  sessionId: string;
  seq?: number;
}

export function SkillSuggestionChip({ currentSessionId }: { currentSessionId?: string | null }) {
  const navigate = useNavigate();
  const [suggestion, setSuggestion] = useState<SkillSuggestionData | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [preview, setPreview] = useState<subagents.SkillPreview | null>(null);
  const [showModal, setShowModal] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const es = openBrainEventStream();
    es.onmessage = (ev: MessageEvent) => {
      try {
        const brainEvent: BrainEvent = JSON.parse(ev.data);
        if (brainEvent.category === 'skill_suggestion') {
          const meta = brainEvent.meta as Record<string, unknown> | undefined;
          const sessId = (meta?.sessionId as string) || '';
          if (currentSessionId && sessId && sessId !== currentSessionId) {
            return;
          }
          const workstream = (meta?.workstream as string) || '';
          const suggestedName = (meta?.suggestedName as string) || `lane-${workstream}`;
          const seq = typeof meta?.seq === 'number' ? meta.seq : undefined;

          setSuggestion({
            workstream,
            suggestedName,
            sessionId: sessId || currentSessionId || '',
            seq,
          });
          setSaved(false);
        }
      } catch {
        /* ignore malformed frames */
      }
    };
    return () => {
      es.close();
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [currentSessionId]);

  if (!suggestion) return null;

  const dismiss = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setSuggestion(null);
    setPreview(null);
    setShowModal(false);
  };

  const handlePreview = async () => {
    try {
      setSaving(true);
      const prev = await subagents.previewSkillFromEpisode(
        suggestion.sessionId,
        suggestion.workstream,
        suggestion.seq,
      );
      setPreview(prev);
      setShowModal(true);
    } catch {
      // Fallback: save directly if preview fails
      await handleSave();
    } finally {
      setSaving(false);
    }
  };

  const handleSave = async () => {
    try {
      setSaving(true);
      await subagents.saveSkillFromEpisode(
        suggestion.sessionId,
        suggestion.workstream,
        suggestion.seq,
      );
      setSaved(true);
      timerRef.current = setTimeout(() => {
        dismiss();
        void navigate('/skills');
      }, 1500);
    } catch {
      setSaving(false);
    }
  };

  return (
    <>
      <div
        className="px-4 pb-2 animate-in fade-in slide-in-from-bottom-2 duration-200"
        role="status"
        aria-label="Skill suggestion notification"
        data-testid="skill-suggestion-chip"
      >
        <div className="inline-flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-[11px] transition-colors">
          <BookmarkPlus className="size-3 text-amber-400" />
          <span className="text-foreground/85">
            Lane <span className="font-medium text-amber-300">{suggestion.workstream}</span> completed with 4+ tools. Save as skill?
          </span>

          {saved ? (
            <span className="inline-flex items-center gap-1 text-[10px] font-medium text-emerald-400">
              <Check className="size-3" /> Saved!
            </span>
          ) : (
            <div className="flex items-center gap-1.5 ml-1">
              <button
                type="button"
                onClick={handlePreview}
                disabled={saving}
                className="inline-flex items-center gap-1 rounded bg-amber-500/20 px-2 py-0.5 text-[10px] font-medium text-amber-300 hover:bg-amber-500/30 transition-colors disabled:opacity-50"
                data-testid="skill-preview-save-btn"
              >
                {saving ? (
                  <Loader2 className="size-2.5 animate-spin" />
                ) : (
                  <Sparkles className="size-2.5" />
                )}
                <span>Preview & Save</span>
              </button>

              <button
                type="button"
                onClick={handleSave}
                disabled={saving}
                className="text-[10px] text-amber-400/80 hover:text-amber-300 underline underline-offset-2"
                data-testid="skill-quick-save-btn"
              >
                Quick save
              </button>

              <button
                type="button"
                onClick={dismiss}
                className="ml-0.5 p-0.5 rounded hover:bg-white/10 text-muted-foreground/70 hover:text-foreground"
                aria-label="Dismiss skill suggestion"
              >
                <X size={11} />
              </button>
            </div>
          )}
        </div>
      </div>

      {showModal && preview && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4"
          data-testid="skill-preview-modal"
        >
          <div className="flex max-h-[85vh] w-full max-w-lg flex-col rounded-xl border border-border bg-background p-4 shadow-xl">
            <div className="flex items-center justify-between border-b border-border/40 pb-3">
              <div className="flex items-center gap-2 font-medium text-sm">
                <Sparkles className="size-4 text-amber-400" />
                <span>Save Workstream as Skill</span>
              </div>
              <button
                type="button"
                onClick={() => setShowModal(false)}
                className="rounded p-1 text-muted-foreground hover:text-foreground"
              >
                <X className="size-4" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto py-3 space-y-3 text-xs">
              <div>
                <label className="font-semibold text-muted-foreground text-[10px] uppercase tracking-wide">
                  Skill Name
                </label>
                <div className="font-mono text-sm font-medium text-foreground mt-0.5">
                  {preview.name}
                </div>
              </div>

              <div>
                <label className="font-semibold text-muted-foreground text-[10px] uppercase tracking-wide">
                  Description
                </label>
                <div className="text-muted-foreground mt-0.5">{preview.description}</div>
              </div>

              <div>
                <label className="font-semibold text-muted-foreground text-[10px] uppercase tracking-wide">
                  Procedure & Verification
                </label>
                <div className="mt-1 rounded-md border border-border/50 bg-muted/30 p-2.5 font-mono text-[11px] whitespace-pre-wrap">
                  {preview.body}
                </div>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-border/40 pt-3">
              <button
                type="button"
                onClick={() => setShowModal(false)}
                className="rounded px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted/50 transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={async () => {
                  setShowModal(false);
                  await handleSave();
                }}
                disabled={saving}
                className="inline-flex items-center gap-1.5 rounded-md bg-amber-500 px-3 py-1.5 text-xs font-medium text-black hover:bg-amber-400 transition-colors disabled:opacity-50"
              >
                {saving && <Loader2 className="size-3 animate-spin" />}
                <span>Save Skill</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export default SkillSuggestionChip;
