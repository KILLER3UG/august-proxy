import { Sparkles, ChevronRight } from 'lucide-react';

const examples = [
  { title: 'Refactor the localhost UI', desc: 'Plan + implement a Tauri-based rewrite' },
  { title: 'Diagnose why Providers tab is empty', desc: 'Investigate the loadProviderList hoisting bug' },
  { title: 'Set up Tailwind v4 with @theme inline', desc: 'Migrate design tokens to the v4 way' },
  { title: 'Add a settings overlay (Cmd+,)', desc: 'Replace 12 top-level routes with one panel' },
];

export function EmptyState({ onPrompt }: { onPrompt: (p: string) => void }) {
  return (
    <div className="max-w-3xl mx-auto px-6 py-16">
      <div className="text-center mb-12">
        <div
          className="inline-flex size-16 rounded-2xl items-center justify-center mb-6 shadow-lg ring-1 ring-white/10"
          style={{
            backgroundImage:
              'linear-gradient(135deg, var(--dt-brand-grad-from) 0%, var(--dt-brand-grad-to) 100%)',
          }}
        >
          <Sparkles className="size-8 text-white" />
        </div>
        <h1 className="hero-display font-light text-foreground">August</h1>
        <p className="hero-subtitle mt-4 text-muted-foreground max-w-md mx-auto">
          Ask August anything. Same tools, memory, and skills as the CLI.
          Press <kbd className="font-mono">⌘K</kbd> for commands.
        </p>
      </div>
      <div className="grid sm:grid-cols-2 gap-2">
        {examples.map((ex) => (
          <button
            key={ex.title}
            onClick={() => onPrompt(ex.title)}
            className="text-left rounded-lg border border-border/60 bg-card hover:bg-accent/30 hover:border-border transition px-4 py-3 group"
          >
            <p className="text-sm font-medium flex items-center gap-1 text-foreground">
              {ex.title}
              <ChevronRight className="size-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition" />
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">{ex.desc}</p>
          </button>
        ))}
      </div>
    </div>
  );
}
