/* ── Conversations & History — archive + recents on one page ──────── */

import { Archive } from '@/sections/archive/Archive';
import { Conversations } from '@/sections/conversations/Conversations';

export function ConversationsHistorySection() {
  return (
    <div className="px-8 py-6 space-y-8 h-full overflow-auto">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Conversations</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Recent history and archived sessions in one place.
        </p>
      </header>
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-foreground">Recent</h2>
        <Conversations />
      </section>
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-foreground">Archived</h2>
        <Archive />
      </section>
    </div>
  );
}
