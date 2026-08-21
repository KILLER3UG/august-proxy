/* ── SelfImprovementStrip — quiet inline event line between messages ────── */
/* Design reference (user-provided screenshot): after an assistant turn, a   */
/* single muted line — amber "Self-improvement review" label + gray detail   */
/* ("Skill 'x' created." / "Memory review applied: …"). Listens to the brain */
/* SSE stream for skill_genesis and self_improvement events; auto-dismisses. */

import { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { openBrainEventStream, type BrainEvent } from '@/api/api-client';
import { cn } from '@/lib/utils';

interface SiEvent {
  detail: string;
}

export function SelfImprovementStrip() {
  const navigate = useNavigate();
  const [event, setEvent] = useState<SiEvent | null>(null);
  const [fading, setFading] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const es = openBrainEventStream();
    es.onmessage = (ev: MessageEvent) => {
      try {
        const brainEvent: BrainEvent = JSON.parse(ev.data);
        let detail = '';
        if (brainEvent.category === 'skill_genesis') {
          const name =
            (brainEvent.meta?.name as string) ||
            brainEvent.summary.replace(/^Skill (created|updated): /, '');
          const action = (brainEvent.meta?.action as string) || 'create';
          detail = `Skill '${name}' ${action === 'create' ? 'created' : 'updated'}.`;
        } else if (brainEvent.category === 'self_improvement') {
          detail = brainEvent.summary.replace(/^Memory review applied: /, '') + '.';
        } else {
          return;
        }
        setEvent({ detail });
        setFading(false);

        if (timerRef.current) clearTimeout(timerRef.current);
        if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current);

        // Match the SkillEvolvedChip cadence: fade at 6s, gone at 8s
        fadeTimerRef.current = setTimeout(() => setFading(true), 6000);
        timerRef.current = setTimeout(() => {
          setEvent(null);
          setFading(false);
        }, 8000);
      } catch {
        /* ignore malformed frames */
      }
    };
    return () => {
      es.close();
      if (timerRef.current) clearTimeout(timerRef.current);
      if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current);
    };
  }, []);

  if (!event) return null;

  const dismiss = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current);
    setEvent(null);
    setFading(false);
  };

  const openMemoryHub = () => {
    dismiss();
    void navigate('/settings/memory-knowledge');
  };

  return (
    <button
      type="button"
      onClick={openMemoryHub}
      className={cn(
        'flex w-full items-center gap-2 px-4 py-1.5 text-left transition-opacity duration-500 hover:bg-muted/40',
        fading ? 'opacity-0' : 'opacity-100 animate-in fade-in slide-in-from-bottom-2 duration-200',
      )}
      role="status"
      aria-label={`Self-improvement review: ${event.detail}`}
      title="Open memory settings"
    >
      <RefreshCw className="size-3 shrink-0 text-warning" aria-hidden />
      <span className="text-xs font-semibold tracking-tight text-warning">Self-improvement review</span>
      <span className="truncate text-xs text-muted-foreground">{event.detail}</span>
    </button>
  );
}

export default SelfImprovementStrip;
