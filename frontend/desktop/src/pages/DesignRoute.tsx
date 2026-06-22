/* ── Design tokens inspector (dev-only) ─────────────────────────── */
/* Renders every CSS variable + Tailwind theme.extend token at         */
/* `/_design` so designers and contributors can audit the system.      */
/* Gated by `import.meta.env.DEV` in routes.ts — never included in    */
/* production builds.                                                  */

import { useStore } from '@nanostores/react';
import { $themeMode, $textSize, setThemeMode, setTextSize } from '@/lib/theme';
import type { ThemeMode, TextSize } from '@/lib/theme';

interface ColorToken {
  name: string;
  cssVar: string;
  preview?: boolean;
}

interface SpacingToken {
  name: string;
  value: string;
}

interface TypeToken {
  name: string;
  className: string;
  sample: string;
}

const COLORS: ColorToken[] = [
  // Surfaces
  { name: 'background',     cssVar: '--dt-background' },
  { name: 'foreground',     cssVar: '--dt-foreground' },
  { name: 'card',           cssVar: '--dt-card' },
  { name: 'card-foreground',cssVar: '--dt-card-foreground' },
  { name: 'muted',          cssVar: '--dt-muted' },
  { name: 'muted-foreground', cssVar: '--dt-muted-foreground' },
  { name: 'popover',        cssVar: '--dt-popover' },
  { name: 'popover-foreground', cssVar: '--dt-popover-foreground' },
  { name: 'elevated',       cssVar: '--dt-elevated' },
  // Brand
  { name: 'primary',        cssVar: '--dt-primary' },
  { name: 'primary-foreground', cssVar: '--dt-primary-foreground' },
  { name: 'secondary',      cssVar: '--dt-secondary' },
  { name: 'secondary-foreground', cssVar: '--dt-secondary-foreground' },
  { name: 'accent',         cssVar: '--dt-accent' },
  { name: 'accent-foreground', cssVar: '--dt-accent-foreground' },
  { name: 'ring',           cssVar: '--dt-ring' },
  { name: 'border',         cssVar: '--dt-border' },
  { name: 'input',          cssVar: '--dt-input' },
  // Status
  { name: 'success',        cssVar: '--dt-success' },
  { name: 'success-fg',     cssVar: '--dt-success-fg' },
  { name: 'warning',        cssVar: '--dt-warning' },
  { name: 'warning-fg',     cssVar: '--dt-warning-fg' },
  { name: 'info',           cssVar: '--dt-info' },
  { name: 'info-fg',        cssVar: '--dt-info-fg' },
  { name: 'danger',         cssVar: '--dt-danger' },
  { name: 'danger-fg',      cssVar: '--dt-danger-fg' },
  { name: 'destructive',    cssVar: '--dt-destructive' },
  { name: 'destructive-foreground', cssVar: '--dt-destructive-foreground' },
  // Code
  { name: 'code-inline',    cssVar: '--dt-code-inline' },
  { name: 'code-block-bg',  cssVar: '--dt-code-block-bg' },
  { name: 'code-block-fg',  cssVar: '--dt-code-block-fg' },
  // Sidebar
  { name: 'sidebar',          cssVar: '--dt-sidebar' },
  { name: 'sidebar-foreground', cssVar: '--dt-sidebar-foreground' },
  { name: 'sidebar-primary',    cssVar: '--dt-sidebar-primary' },
  { name: 'sidebar-accent',     cssVar: '--dt-sidebar-accent' },
];

const RADII: SpacingToken[] = [
  { name: 'xs',  value: '4px' },
  { name: 'sm',  value: '6px' },
  { name: 'md',  value: '8px' },
  { name: 'lg',  value: '12px' },
  { name: 'xl',  value: '16px' },
  { name: '2xl', value: '20px' },
];

const SHADOWS: SpacingToken[] = [
  { name: 'overlay', value: '0 24px 48px -12px rgb(0 0 0 / 0.45)' },
  { name: 'soft',    value: '0 1px 2px rgb(0 0 0 / 0.06), 0 1px 3px rgb(0 0 0 / 0.10)' },
  { name: 'ring',    value: '0 0 0 4px rgb(74 138 255 / 0.18)' },
];

const TYPE_TOKENS: TypeToken[] = [
  { name: 'hero-display',   className: 'hero-display',         sample: 'August' },
  { name: 'hero-subtitle',  className: 'hero-subtitle',        sample: 'Ask August anything. Same tools, memory, and skills as the CLI.' },
  { name: 'bubble-body',    className: 'bubble-body',          sample: 'Read README.md to understand the project structure.' },
  { name: 'bubble-footer',  className: 'bubble-footer-text',   sample: '06:43 PM' },
  { name: 'tool-row-text',  className: 'tool-row-text',        sample: 'Reading README.md' },
  { name: 'tool-row-meta',  className: 'tool-row-meta',        sample: 'DONE' },
  { name: 'chat-message',   className: 'chat-message-text',    sample: 'I read the README and it looks straightforward.' },
  { name: 'chat-thought',   className: 'chat-thought-text',    sample: 'Let me look at the project structure first.' },
  { name: 'drawer-section', className: 'drawer-section-text',  sample: 'Section heading for drawer content' },
  { name: 'drawer-muted',   className: 'drawer-muted-text',    sample: 'Secondary drawer text' },
  { name: 'plan-section',   className: 'plan-section-text',    sample: 'Plan section body text' },
  { name: 'session-title',  className: 'session-list-title',   sample: 'Refactor Subagent Tool UI Readability' },
  { name: 'session-meta',   className: 'session-list-meta',    sample: 'DeepSeek V4-Flash' },
];

const TRACKING_TOKENS: { name: string; value: string }[] = [
  { name: 'tightest', value: '-0.04em' },
  { name: 'display',  value: '-0.022em' },
  { name: 'body',     value: '-0.011em' },
  { name: 'caps',     value: '0.08em' },
];

function ColorSwatch({ token }: { token: ColorToken }) {
  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden">
      <div
        className="h-16"
        style={{ background: `var(${token.cssVar})` }}
      />
      <div className="px-3 py-2 text-xs">
        <p className="font-medium text-foreground">{token.name}</p>
        <p className="font-mono text-[10px] text-muted-foreground">{token.cssVar}</p>
      </div>
    </div>
  );
}

function SwatchGrid() {
  const surfaces = COLORS.filter(c => c.name.startsWith('background') || c.name.startsWith('card') || c.name.startsWith('muted') || c.name.startsWith('popover') || c.name.startsWith('elevated'));
  const brand = COLORS.filter(c => ['primary','secondary','accent','ring','border','input'].includes(c.name));
  const status = COLORS.filter(c => ['success','warning','info','danger','destructive'].some(p => c.name.startsWith(p)));
  const code = COLORS.filter(c => c.name.startsWith('code-'));
  const sidebar = COLORS.filter(c => c.name.startsWith('sidebar'));

  const Section = ({ title, items }: { title: string; items: ColorToken[] }) => (
    <section className="space-y-3">
      <h3 className="text-[11px] font-semibold uppercase tracking-caps text-muted-foreground">{title}</h3>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
        {items.map(token => <ColorSwatch key={token.cssVar} token={token} />)}
      </div>
    </section>
  );

  return (
    <div className="space-y-8">
      <Section title="Surfaces" items={surfaces} />
      <Section title="Brand" items={brand} />
      <Section title="Status" items={status} />
      <Section title="Code surfaces" items={code} />
      <Section title="Sidebar" items={sidebar} />
    </div>
  );
}

function RadiiGrid() {
  return (
    <div className="grid grid-cols-3 sm:grid-cols-6 gap-3">
      {RADII.map(r => (
        <div key={r.name} className="rounded-lg border border-border bg-card p-4 text-center">
          <div className="mx-auto mb-3 size-12 bg-primary/20 border border-primary/40" style={{ borderRadius: r.value }} />
          <p className="text-sm font-medium text-foreground">{r.name}</p>
          <p className="font-mono text-[10px] text-muted-foreground">{r.value}</p>
        </div>
      ))}
    </div>
  );
}

function ShadowsGrid() {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
      {SHADOWS.map(s => (
        <div key={s.name} className="rounded-lg border border-border bg-card p-6">
          <div className="mx-auto mb-4 size-16 rounded-md bg-card" style={{ boxShadow: s.value }} />
          <p className="text-sm font-medium text-foreground">{s.name}</p>
          <p className="font-mono text-[10px] text-muted-foreground break-all">{s.value}</p>
        </div>
      ))}
    </div>
  );
}

function TypeScale() {
  return (
    <div className="space-y-4">
      {TYPE_TOKENS.map(token => (
        <div key={token.name} className="rounded-lg border border-border bg-card px-4 py-3 grid grid-cols-[12rem_1fr] gap-4 items-baseline">
          <div>
            <p className="text-sm font-medium text-foreground">{token.name}</p>
            <p className="font-mono text-[10px] text-muted-foreground">.{token.className}</p>
          </div>
          <p className={token.className}>{token.sample}</p>
        </div>
      ))}
    </div>
  );
}

function TrackingTokens() {
  return (
    <div className="space-y-3">
      {TRACKING_TOKENS.map(t => (
        <div key={t.name} className="rounded-lg border border-border bg-card px-4 py-3 grid grid-cols-[10rem_8rem_1fr] gap-4 items-baseline">
          <p className="text-sm font-medium text-foreground">{t.name}</p>
          <p className="font-mono text-[11px] text-muted-foreground">{t.value}</p>
          <p className="text-lg" style={{ letterSpacing: t.value }}>The quick brown fox jumps over the lazy dog</p>
        </div>
      ))}
    </div>
  );
}

function ThemeSwitcher() {
  const mode = useStore($themeMode);
  const size = useStore($textSize);
  const modes: { id: ThemeMode; label: string }[] = [
    { id: 'light', label: 'Light' },
    { id: 'dark', label: 'Dark' },
    { id: 'system', label: 'System' },
  ];
  const sizes: { id: TextSize; label: string }[] = [
    { id: 'compact', label: 'Small' },
    { id: 'default', label: 'Default' },
    { id: 'comfortable', label: 'Large' },
    { id: 'spacious', label: 'Extra Large' },
  ];
  return (
    <div className="rounded-xl border border-border bg-card p-4 space-y-4">
      <div>
        <p className="text-[11px] uppercase tracking-caps font-semibold text-muted-foreground mb-2">Theme</p>
        <div className="flex gap-2">
          {modes.map(m => (
            <button
              key={m.id}
              onClick={() => setThemeMode(m.id)}
              className={mode === m.id ? 'rounded-md border border-primary bg-primary/5 px-3 py-1.5 text-sm font-medium' : 'rounded-md border border-border px-3 py-1.5 text-sm text-muted-foreground hover:bg-muted/40'}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>
      <div>
        <p className="text-[11px] uppercase tracking-caps font-semibold text-muted-foreground mb-2">Text size — current: {size} (×{size === 'compact' ? '0.92' : size === 'default' ? '1.00' : size === 'comfortable' ? '1.08' : '1.18'})</p>
        <div className="flex gap-2">
          {sizes.map(s => (
            <button
              key={s.id}
              onClick={() => setTextSize(s.id)}
              className={size === s.id ? 'rounded-md border border-primary bg-primary/5 px-3 py-1.5 text-sm font-medium' : 'rounded-md border border-border px-3 py-1.5 text-sm text-muted-foreground hover:bg-muted/40'}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export function DesignRoute() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-6xl px-6 py-10 space-y-10">
        <header className="space-y-3">
          <p className="text-[11px] uppercase tracking-caps font-semibold text-muted-foreground">Dev only</p>
          <h1 className="hero-display font-light">August Design System</h1>
          <p className="hero-subtitle text-muted-foreground max-w-2xl">
            Live inspector for every token in <code className="text-code-inline">styles.css</code> and <code className="text-code-inline">tailwind.config.cjs</code>.
            Use the controls below to flip theme and text size — every value on this page is computed from the live CSS variables.
          </p>
        </header>

        <ThemeSwitcher />

        <section className="space-y-3">
          <h2 className="text-2xl font-semibold tracking-display">Color tokens</h2>
          <p className="text-sm text-muted-foreground">Surface, brand, status, code, and sidebar swatches. Values shown are the resolved CSS variables.</p>
          <SwatchGrid />
        </section>

        <section className="space-y-3">
          <h2 className="text-2xl font-semibold tracking-display">Border radius</h2>
          <RadiiGrid />
        </section>

        <section className="space-y-3">
          <h2 className="text-2xl font-semibold tracking-display">Shadows</h2>
          <ShadowsGrid />
        </section>

        <section className="space-y-3">
          <h2 className="text-2xl font-semibold tracking-display">Letter spacing</h2>
          <TrackingTokens />
        </section>

        <section className="space-y-3">
          <h2 className="text-2xl font-semibold tracking-display">Type scale</h2>
          <p className="text-sm text-muted-foreground">
            Every shared typography helper, rendered at its real size. Resize the page or pick a different text size above to verify scaling.
          </p>
          <TypeScale />
        </section>

        <section className="space-y-3">
          <h2 className="text-2xl font-semibold tracking-display">Live preview</h2>
          <p className="text-sm text-muted-foreground">
            Mini composer + bubble + tool row in a single card so the scale, density, and color relationships are visible side-by-side.
          </p>
          <div className="rounded-xl border border-border bg-card p-4 space-y-3">
            <div className="flex items-center justify-end">
              <div className="group rounded-xl border border-border/60 bg-card px-3.5 py-2 max-w-[80%] shadow-xs">
                <p className="bubble-body">Can you summarize the changes you made to the design system?</p>
                <div className="flex items-center justify-between gap-2 mt-2 pt-1.5 border-t border-border/30">
                  <span className="bubble-footer-text text-muted-foreground/70 font-medium">06:43 PM</span>
                  <span className="text-[10px] text-muted-foreground/70">copied</span>
                </div>
              </div>
            </div>
            <div className="ml-3 pl-3 border-l-2 border-foreground/15 space-y-1.5">
              <div className="flex items-center gap-2">
                <span className="tool-row-text text-info">Searching</span>
                <span className="tool-row-meta text-muted-foreground/85 truncate">design-tokens.md</span>
                <span className="inline-flex items-center gap-1 ml-auto">
                  <span className="inline-block size-1.5 rounded-full bg-warning" />
                  <span className="tool-row-meta text-warning">RUNNING</span>
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span className="tool-row-text text-foreground/85">Searched</span>
                <span className="tool-row-meta text-muted-foreground/85 truncate">theme.ts</span>
                <span className="inline-flex items-center gap-1 ml-auto">
                  <span className="inline-block size-1.5 rounded-full bg-success" />
                  <span className="tool-row-meta text-success">DONE</span>
                </span>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
