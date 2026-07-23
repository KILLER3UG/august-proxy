/* ── Starter prompts ───────────────────────────────────────────────────── */
/* First-run suggestion cards above the composer in an empty chat. Clicking */
/* a card sends the prompt immediately.                                     */

import { BookOpen, Bug, TestTube, FileText } from 'lucide-react';

const STARTERS: Array<{
  icon: typeof BookOpen;
  title: string;
  prompt: string;
}> = [
  {
    icon: BookOpen,
    title: 'Explain this codebase',
    prompt: 'Give me a guided tour of this codebase: what it does, the main areas, and where things live.',
  },
  {
    icon: Bug,
    title: 'Fix or improve something',
    prompt: 'Look through the recently changed files, find something worth fixing or improving, and show me a plan before editing.',
  },
  {
    icon: TestTube,
    title: 'Write tests',
    prompt: 'Find the least-tested critical code in this project and write tests for it. Run them and report the results.',
  },
  {
    icon: FileText,
    title: 'Draft AUG.md',
    prompt: 'Draft an AUG.md with the project conventions, directory map, and validation commands for this repo.',
  },
];

export function StarterPrompts({ onPick }: { onPick: (prompt: string) => void }) {
  return (
    <div className="mb-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
      {STARTERS.map(({ icon: Icon, title, prompt }) => (
        <button
          key={title}
          type="button"
          onClick={() => onPick(prompt)}
          className="group flex items-start gap-2.5 rounded-xl border border-border/60 bg-card/40 px-3.5 py-3 text-left transition hover:border-primary/40 hover:bg-card/80"
        >
          <Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground transition group-hover:text-primary" />
          <span className="min-w-0">
            <span className="block text-[13px] font-medium text-foreground/90">
              {title}
            </span>
            <span className="mt-0.5 block truncate text-[11px] text-muted-foreground/80">
              {prompt}
            </span>
          </span>
        </button>
      ))}
    </div>
  );
}
