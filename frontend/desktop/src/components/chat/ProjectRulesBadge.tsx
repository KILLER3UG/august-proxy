/* ── Project rules chip ───────────────────────────────────────────────── */
/* Shows “Rules from: AUG.md” (or CLAUDE/AGENTS) when present.            */

import { useEffect, useState } from 'react';
import { BookMarked } from 'lucide-react';
import { cn } from '@/lib/utils';
import { discoverProjectRules, type ProjectRulesFile } from '@/lib/project-rules';

export function ProjectRulesBadge({
  workspacePath,
  className,
}: {
  workspacePath?: string | null;
  className?: string;
}) {
  const [rules, setRules] = useState<ProjectRulesFile[]>([]);

  useEffect(() => {
    let cancelled = false;
    void discoverProjectRules(workspacePath).then((list) => {
      if (!cancelled) setRules(list);
    });
    return () => {
      cancelled = true;
    };
  }, [workspacePath]);

  if (rules.length === 0) return null;

  const primary = rules[0];
  const extra = rules.length > 1 ? ` +${rules.length - 1}` : '';
  const title = rules.map((r) => r.path).join('\n');

  return (
    <span
      className={cn(
        'inline-flex max-w-[14rem] items-center gap-1 rounded-md border border-border/60 bg-muted/30 px-1.5 py-0.5 text-[10px] text-muted-foreground',
        className,
      )}
      title={title}
      data-testid="project-rules-badge"
    >
      <BookMarked className="size-3 shrink-0 text-primary" />
      <span className="truncate">
        Rules from: <span className="font-medium text-foreground/80">{primary.name}</span>
        {extra}
      </span>
    </span>
  );
}

export default ProjectRulesBadge;
