/* ── ContextBar — feedforward/feedback indicator above assistant messages ── */
/* Shows what context was loaded (rules, skills, memories) before the turn  */
/* and whether the turn's changes were verified after. Part of Phase 4.4.   */

import { Badge } from '@/components/ui/badge';

export interface FeedforwardData {
  rules?: number;
  skills?: number;
  memories?: number;
  heuristics?: number;
}

export interface EvidenceData {
  state: 'verified' | 'unverified' | 'read_only';
  verificationTool?: string | null;
  verificationOutput?: string | null;
}

interface ContextBarProps {
  feedforward?: FeedforwardData | null;
  evidence?: EvidenceData | null;
}

export function ContextBar({ feedforward, evidence }: ContextBarProps) {
  if (!feedforward && !evidence) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5 px-3 py-1 text-[11px] text-muted-foreground">
      {feedforward && (
        <span className="inline-flex items-center gap-1">
          <span className="opacity-60">Loaded:</span>
          {feedforward.rules != null && feedforward.rules > 0 && (
            <span>{feedforward.rules} rules</span>
          )}
          {feedforward.skills != null && feedforward.skills > 0 && (
            <span>{feedforward.skills} skills</span>
          )}
          {feedforward.memories != null && feedforward.memories > 0 && (
            <span>{feedforward.memories} memories</span>
          )}
          {feedforward.heuristics != null && feedforward.heuristics > 0 && (
            <span>{feedforward.heuristics} heuristics</span>
          )}
        </span>
      )}
      {evidence && evidence.state === 'verified' && (
        <Badge variant="outline" className="gap-1 border-green-500/30 text-green-500 text-[10px] px-1.5 py-0">
          ✓ Verified{evidence.verificationTool ? ` (${evidence.verificationTool})` : ''}
        </Badge>
      )}
      {evidence && evidence.state === 'unverified' && (
        <Badge variant="outline" className="gap-1 border-amber-500/30 text-amber-500 text-[10px] px-1.5 py-0">
          ⚠ Unverified
        </Badge>
      )}
    </div>
  );
}
