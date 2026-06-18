/* ── Memory & Knowledge — wraps the existing Memory section ─────────── */
/* The Memory section already has rich sub-tabs (overview, vectors, facts,
 * graph, search, prompt). We host it under a unified shell header so it
 * reads as part of the redesigned settings; the body component is reused
 * verbatim to preserve its polling and rendering. */

import { Brain } from 'lucide-react';
import { Memory } from '@/sections/memory/Memory';

export function MemoryKnowledgeSection() {
  return (
    <div className="flex h-full flex-col">
      <header className="px-6 pt-5 pb-3 shrink-0">
        <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight text-foreground">
          <Brain className="size-4 text-muted-foreground" />
          Memory &amp; Knowledge
        </h2>
        <p className="mt-1 text-sm leading-5 text-muted-foreground">
          Self-evolving knowledge graph, semantic facts, vector search, and the system prompt.
        </p>
      </header>
      <div className="flex-1 overflow-auto">
        <Memory />
      </div>
    </div>
  );
}
