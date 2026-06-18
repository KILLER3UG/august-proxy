/* ── Developer Console — wraps the August console (experimental) ────── */
/* The August console is a developer/debug surface (mock approval flow).
 * It lives under Advanced and is marked experimental so it's clearly
 * separated from beginner-facing sections. The body component is reused
 * verbatim. */

import { TerminalSquare } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { August } from '@/sections/august/August';

export function DeveloperConsoleSection() {
  return (
    <div className="flex h-full flex-col">
      <header className="px-6 pt-5 pb-3 shrink-0">
        <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight text-foreground">
          <TerminalSquare className="size-4 text-muted-foreground" />
          Developer Console
          <Badge variant="warning" className="text-[9px]">experimental</Badge>
        </h2>
        <p className="mt-1 text-sm leading-5 text-muted-foreground">
          The August approval console and debug surface. Behavior here may be illustrative.
        </p>
      </header>
      <div className="flex-1 overflow-auto">
        <August />
      </div>
    </div>
  );
}
