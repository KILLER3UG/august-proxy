/* ── Developer Console — wraps the August console (experimental) ────── */
/* Migrated to the workspace-style chrome (big h1, dark cards, larger
 * padding). Body component (August mock chat) is reused verbatim. */

import { TerminalSquare } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { August } from '@/sections/august/August';

export function DeveloperConsoleSection() {
  return (
    <div className="px-8 py-6 space-y-4 h-full flex flex-col">
      <div className="shrink-0">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight text-foreground">
          <TerminalSquare className="size-5 text-muted-foreground" />
          Developer Console
          <Badge variant="warning" className="text-[9px]">experimental</Badge>
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          The August approval console and debug surface. Behavior here may be illustrative.
        </p>
      </div>
      <div className="flex-1 overflow-auto rounded-xl border border-white/[0.06] bg-card/60">
        <August />
      </div>
    </div>
  );
}
