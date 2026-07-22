/* ── SkillEvolvedChip — transient notification when a skill is evolved ──── */
/* Listens to brain event SSE for skill_genesis events and shows a small     */
/* inline chip that auto-dismisses after 8 seconds. Clicking navigates to    */
/* the /skills page. Style consistent with SavePointChip.                    */

import { useEffect, useRef, useState } from 'react';
import { Sparkles, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { openBrainEventStream, type BrainEvent } from '@/api/api-client';
import { cn } from '@/lib/utils';

interface SkillEvent {
  name: string;
  action: string;
}

export function SkillEvolvedChip() {
  const navigate = useNavigate();
  const [event, setEvent] = useState<SkillEvent | null>(null);
  const [fading, setFading] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const es = openBrainEventStream();
    es.onmessage = (ev: MessageEvent) => {
      try {
        const brainEvent: BrainEvent = JSON.parse(ev.data);
        if (brainEvent.category === 'skill_genesis') {
          const name =
            (brainEvent.meta?.name as string) ||
            brainEvent.summary.replace(/^Skill (created|updated): /, '');
          const action = (brainEvent.meta?.action as string) || 'create';
          setEvent({ name, action });
          setFading(false);

          // Clear existing timers
          if (timerRef.current) clearTimeout(timerRef.current);
          if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current);

          // Start fade at 6s, remove at 8s
          fadeTimerRef.current = setTimeout(() => setFading(true), 6000);
          timerRef.current = setTimeout(() => {
            setEvent(null);
            setFading(false);
          }, 8000);
        }
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

  const goToSkills = () => {
    dismiss();
    navigate('/skills');
  };

  return (
    <div
      className={cn(
        'px-4 pb-2 transition-opacity duration-500',
        fading ? 'opacity-0' : 'opacity-100 animate-in fade-in slide-in-from-bottom-2 duration-200',
      )}
      role="status"
      aria-label="Skill evolved notification"
    >
      <div
        className="inline-flex items-center gap-2 rounded-lg border border-violet-500/25 bg-violet-500/5 px-2.5 py-1.5 text-[11px] cursor-pointer hover:bg-violet-500/10 transition-colors"
        onClick={goToSkills}
        data-testid="skill-evolved-chip"
      >
        <Sparkles className="size-3 text-violet-400" />
        <span className="text-foreground/85">
          Skill {event.action === 'create' ? 'created' : 'updated'}:{' '}
          <span className="font-medium text-violet-300">{event.name}</span>
        </span>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            goToSkills();
          }}
          className="ml-1 text-[10px] text-violet-400/80 hover:text-violet-300 underline underline-offset-2"
        >
          View all
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            dismiss();
          }}
          className="ml-0.5 p-0.5 rounded hover:bg-white/10 text-muted-foreground/70 hover:text-foreground"
          aria-label="Dismiss notification"
        >
          <X size={11} />
        </button>
      </div>
    </div>
  );
}

export default SkillEvolvedChip;
