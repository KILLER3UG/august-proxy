import { useEffect, useState } from 'react';
import { Check, ChevronDown, Monitor, Moon, Sun } from 'lucide-react';
import { useThemeStore, setThemeMode, setSurfaceFontSize } from '@/lib/theme';
import type { SurfaceFontKey, ThemeMode } from '@/lib/theme';
import { applyExternalCustomization, resetAppliedCustomization, THEME_PRESETS } from '@/lib/ui-customization';
import { cn } from '@/lib/utils';
import { UiDesignerSection } from './UiDesignerSection';
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
      <header className="shrink-0 px-6 pb-3 pt-5">
        <h2 className="text-lg font-semibold tracking-tight text-foreground">Appearance</h2>
        <p className="mt-1 text-sm leading-5 text-muted-foreground">Set your theme and tune reading sizes across the app.</p>
      </header>

      <div className="flex-1 space-y-5 overflow-auto px-6 pb-7">
        <section className="rounded-xl border border-border/70 bg-card/40 p-4" aria-labelledby="appearance-theme-heading">
          <h3 id="appearance-theme-heading" className="text-sm font-semibold">Theme</h3>
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

          {/* `flex-wrap` because the segmented control is `shrink-0`: on a row that
            cannot shrink, a narrow content column pushed "Light" and "Dark"
            outside it rather than letting the control wrap to its own line.
            Measured at a 420px panel: the column was 237px and both buttons
            overflowed. Wrapping drops the control below the label, which is
            what the reference's stacked rows do. */}
          <div className="mt-5 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <div>
              <p className="text-sm font-medium">Mode</p>
              <p className="mt-0.5 text-xs text-muted-foreground">Choose how August resolves light and dark surfaces.</p>
            </div>
            {/* `flex-wrap` and NO `shrink-0`. `shrink-0` pinned the group to its
            content width, so the wrap could never engage no matter how narrow
            the column got — the buttons just overflowed instead. Letting it
            shrink is what makes the wrap real; it still sits right-aligned at
            every width where the row fits on one line, which is every width
            above ~480px of column. */}
            <div className="inline-flex flex-wrap rounded-lg border border-border bg-muted/40 p-0.5" role="group" aria-label="Theme mode">
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
                  className={cn('inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs transition', themeMode === mode ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}
                >
                  <Icon className="size-3" />{label}
                </button>
              ))}
            </div>
          </div>
        </section>

        <section className="rounded-xl border border-border/70 bg-card/40 p-4" aria-labelledby="appearance-font-heading">
          <div>
            <h3 id="appearance-font-heading" className="text-sm font-semibold">Font size</h3>
            <p className="mt-1 text-xs text-muted-foreground">Adjust each surface independently. Chat input stays at least 16 px.</p>
          </div>
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
                  label={label}
                  ariaLabel={`${label} font size`}
                  value={fontSizes[key]}
                  options={values.map((size) => ({ value: size, label: `${size} px` }))}
                  onChange={(size) => setSurfaceFontSize(key, size)}
                />
              </div>
            ))}
          </div>
        </section>

        <section id="settings-colors" className="scroll-mt-4 rounded-xl border border-border/70 bg-card/40">
          <button
            type="button"
            aria-expanded={designerOpen}
            onClick={() => setDesignerOpen((value) => !value)}
            className="flex w-full items-center justify-between gap-4 px-4 py-3 text-left"
          >
            <span>
              <span className="block text-sm font-semibold">Colour designer</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">Fine-tune individual interface colours.</span>
            </span>
            <ChevronDown className={cn('size-4 shrink-0 text-muted-foreground transition-transform', designerOpen && 'rotate-180')} />
          </button>
          {designerOpen ? <div className="border-t border-border/60 p-3"><UiDesignerSection /></div> : null}
        </section>
      </div>
    </div>
  );
}
