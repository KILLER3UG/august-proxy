import { useEffect, useState } from 'react';
import { Check, ChevronDown, Monitor, Moon, Sun } from 'lucide-react';
import { useThemeStore, setThemeMode, setSurfaceFontSize } from '@/lib/theme';
import type { SurfaceFontKey, ThemeMode } from '@/lib/theme';
import { useCollapseThinking } from '@/hooks/useThinkingPreference';
import { setCollapseThinkingEnabled } from '@/lib/thinking-preference';
import { applyExternalCustomization, resetAppliedCustomization, THEME_PRESETS } from '@/lib/ui-customization';
import { cn } from '@/lib/utils';
import { UiDesignerSection } from './UiDesignerSection';
import { SectionHeader } from '@/components/SectionHeader';
import { ValuePill } from '@/components/ui/ValuePill';
import type { SettingsSection } from '@/settings/settings-registry';

type AppearanceTheme = { id: string; label: string; swatches: [string, string]; mode: ThemeMode; preset?: string };
const APPEARANCE_THEMES: AppearanceTheme[] = [
  { id: 'haze', label: 'Haze', swatches: ['bg-background', 'bg-card'], mode: 'dark' },
  { id: 'graphite', label: 'Graphite', swatches: ['bg-muted', 'bg-card'], mode: 'dark', preset: 'carbon' },
  { id: 'paper', label: 'Paper', swatches: ['bg-card', 'bg-background'], mode: 'light' },
  { id: 'midnight', label: 'Midnight', swatches: ['bg-secondary', 'bg-primary/40'], mode: 'dark', preset: 'midnight' },
  { id: 'sage', label: 'Sage', swatches: ['bg-success/20', 'bg-muted'], mode: 'dark', preset: 'forest' },
];

const FONT_ROWS: Array<{ key: SurfaceFontKey; label: string; values: number[] }> = [
  { key: 'interface', label: 'Interface', values: [12, 13, 14, 15, 16, 18, 20, 22] },
  { key: 'chat', label: 'Chat messages', values: [13, 14, 15, 16, 18, 20, 22] },
  { key: 'input', label: 'Chat input', values: [16, 17, 18, 20, 22] },
  { key: 'code', label: 'Code', values: [12, 13, 14, 15, 16, 18, 20] },
];

export function AppearanceSection({ active }: { active?: SettingsSection }) {
  const themeMode = useThemeStore((s) => s.mode);
  const fontSizes = useThemeStore((s) => s.surfaceFontSizes);
  const collapseThinking = useCollapseThinking();
  const showRawReasoning = !collapseThinking;
  const [designerOpen, setDesignerOpen] = useState(false);
  const [selectedThemeId, setSelectedThemeId] = useState(() => {
    try { return localStorage.getItem('august.appearanceTheme') ?? 'haze'; } catch { return 'haze'; }
  });

  useEffect(() => {
    if (active?.id !== 'ui-designer') return;
    setDesignerOpen(true);
    requestAnimationFrame(() => document.getElementById('settings-colors')?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
  }, [active?.id]);

  const chooseTheme = (theme: AppearanceTheme) => {
    const preset = theme.preset ? THEME_PRESETS.find((item) => item.id === theme.preset) : undefined;
    if (preset) applyExternalCustomization(preset.map);
    else resetAppliedCustomization();
    setThemeMode(theme.mode);
    setSelectedThemeId(theme.id);
    try { localStorage.setItem('august.appearanceTheme', theme.id); } catch { /* ignore */ }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 px-6 pt-5">
        <SectionHeader
          title="Appearance"
          subtitle="Set your theme and tune reading sizes across the app."
          className="mb-3"
        />
      </div>

      {/* ONE container with hairline-separated children, not three bordered
          boxes. Section labels are bare — the reference carries a count or
          nothing, never a sentence. */}
      <div className="flex-1 overflow-auto px-6 pb-7">
        <div className="divide-y divide-border/60 rounded-xl border border-border/70 bg-card/40">
        <section className="px-5 py-4" aria-labelledby="appearance-theme-heading">
          <h3 id="appearance-theme-heading" className="text-sm font-semibold tracking-tight text-foreground">Theme</h3>
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
            {APPEARANCE_THEMES.map((theme) => {
              const selected = selectedThemeId === theme.id;
              return (
                <button
                  key={theme.id}
                  type="button"
                  onClick={() => chooseTheme(theme)}
                  aria-pressed={selected}
                  aria-label={`${theme.label} theme`}
                  className={cn('group rounded-lg border p-2 text-left transition', selected ? 'border-primary ring-1 ring-primary/50' : 'border-border/70 hover:border-border hover:bg-muted/40')}
                  data-testid={`appearance-theme-${theme.id}`}
                >
                  <span className="mb-2 flex h-10 overflow-hidden rounded-md border border-white/10" aria-hidden="true">
                    <span className={cn('flex-1', theme.swatches[0])} />
                    <span className={cn('w-1/2 border-l border-white/10', theme.swatches[1])} />
                  </span>
                  <span className="flex items-center justify-between gap-1 text-xs font-medium">
                    {theme.label}{selected ? <Check className="size-3 text-primary" /> : null}
                  </span>
                </button>
              );
            })}
          </div>

        </section>

        <section className="px-5 py-4" aria-labelledby="appearance-mode-heading">
          <h3 id="appearance-mode-heading" className="text-sm font-semibold tracking-tight text-foreground">Mode</h3>
          {/* The reference stacks the section label ABOVE its control, and the
            segmented control is a group of bare labels with a LIGHTER fill on
            the active one — not a bordered box around three buttons. */}
          <div className="mt-3 inline-flex flex-wrap items-center gap-0.5" role="group" aria-label="Theme mode">
            {([
              ['system', Monitor, 'System'],
              ['light', Sun, 'Light'],
              ['dark', Moon, 'Dark'],
            ] as const).map(([mode, Icon, label]) => (
              <button
                key={mode}
                type="button"
                aria-pressed={themeMode === mode}
                onClick={() => setThemeMode(mode)}
                className={cn('inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm transition', themeMode === mode ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground')}
              >
                <Icon className="size-3" />{label}
              </button>
            ))}
          </div>
        </section>

        <section className="px-5 py-4" aria-labelledby="appearance-thinking-heading">
          <h3 id="appearance-thinking-heading" className="text-sm font-semibold tracking-tight text-foreground">Thinking</h3>
          <div className="mt-3 flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="text-sm">Show raw reasoning</div>
              <p className="mt-1 text-2xs leading-relaxed text-muted-foreground">
                Off by default: thinking cards show one distilled sentence per step. Turn this on to
                read the model&rsquo;s full reasoning behind those lines.
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={showRawReasoning}
              aria-label="Show raw reasoning"
              data-testid="appearance-show-raw-reasoning"
              onClick={() => setCollapseThinkingEnabled(showRawReasoning)}
              className={cn(
                'relative mt-0.5 inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors',
                showRawReasoning
                  ? 'border-primary/50 bg-primary/20'
                  : 'border-border/70 bg-muted/50',
              )}
            >
              <span
                className={cn(
                  'size-3.5 rounded-full bg-foreground/80 transition-transform',
                  showRawReasoning ? 'translate-x-[18px]' : 'translate-x-[3px]',
                )}
              />
            </button>
          </div>
        </section>

        <section className="px-5 py-4" aria-labelledby="appearance-font-heading">
          <h3 id="appearance-font-heading" className="text-sm font-semibold tracking-tight text-foreground">Font size</h3>
          <div className="mt-3 divide-y divide-border/60">
            {FONT_ROWS.map(({ key, label, values }) => (
              <div
                key={key}
                className="flex min-h-11 flex-wrap items-center justify-between gap-x-4 gap-y-1 py-1.5 text-sm"
              >
                <span>{label}</span>
                {/* One pill showing the current value, not a closed <select>:
                    the reference draws `label ....... [13 px]` and the native
                    control renders OS chrome in the middle of a themed pane. */}
                <ValuePill
                  ariaLabel={`${label} font size`}
                  value={fontSizes[key]}
                  options={values.map((size) => ({ value: size, label: `${size} px` }))}
                  onChange={(size) => setSurfaceFontSize(key, size)}
                />
              </div>
            ))}
          </div>
        </section>

        <section id="settings-colors" className="scroll-mt-4">
          <button
            type="button"
            aria-expanded={designerOpen}
            onClick={() => setDesignerOpen((value) => !value)}
            className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left"
          >
            <span className="text-sm font-semibold tracking-tight text-foreground">Colour designer</span>
            <ChevronDown className={cn('size-4 shrink-0 text-muted-foreground transition-transform', designerOpen && 'rotate-180')} />
          </button>
          {designerOpen ? <div className="border-t border-border/60 p-3"><UiDesignerSection /></div> : null}
        </section>
        </div>
      </div>
    </div>
  );
}
