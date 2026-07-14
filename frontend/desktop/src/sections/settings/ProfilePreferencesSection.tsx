/* ── Profile & Preferences — new beginner-friendly preferences hub ─── */
/* Theme + appearance (backed by the existing $theme store), experience
 * presets (UI-only preview until a backing store exists), keyboard shortcut
 * reference, and an onboarding toggle placeholder. Everything uses the
 * shared primitives so it reads like the rest of the redesigned settings. */

import { useState } from 'react';

import {
  Sun,
  Moon,
  Monitor,
  Keyboard,
  Sparkles,
  GraduationCap,
  Check,
} from 'lucide-react';
import { useThemeStore, setThemeMode, setTextSize } from '@/lib/theme';
import type { ThemeMode, TextSize } from '@/lib/theme';
import { SettingsCard } from '@/components/settings/SettingsCard';
import { SettingsToggle } from '@/components/settings/SettingsToggle';
import { SettingsTooltip } from '@/components/settings/SettingsTooltip';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

const SHORTCUTS: { keys: string[]; label: string }[] = [
  { keys: ['⌘', ','],  label: 'Open Settings' },
  { keys: ['⌘', 'K'],  label: 'Command palette' },
  { keys: ['esc'],     label: 'Close overlay / dialog' },
];

interface Preset {
  id: string;
  name: string;
  description: string;
}

const PRESETS: Preset[] = [
  { id: 'default',  name: 'Default',      description: 'Balanced view with helpful explanations shown.' },
  { id: 'power',    name: 'Power User',   description: 'Denser layouts, raw bodies surfaced, fewer tooltips.' },
  { id: 'privacy',  name: 'Privacy Focused', description: 'Hide usage analytics and history previews.' },
];

const TEXT_SIZE_OPTIONS: { id: TextSize; label: string; scale: string }[] = [
  { id: 'compact',     label: 'Small',      scale: '0.92' },
  { id: 'default',     label: 'Default',    scale: '1.00' },
  { id: 'comfortable', label: 'Large',      scale: '1.08' },
  { id: 'spacious',    label: 'Extra Large', scale: '1.18' },
];

export function ProfilePreferencesSection() {
  const themeMode = useThemeStore((s) => s.mode);
  const textSize = useThemeStore((s) => s.textSize);
  const [activePreset, setActivePreset] = useState<string>('default');
  const [tour, setTour] = useState(true);

  const themeModeIcon =
    themeMode === 'light' ? Sun : themeMode === 'dark' ? Moon : Monitor;

  return (
    <div className="flex h-full flex-col">
      <header className="px-6 pt-5 pb-4 shrink-0">
        <h2 className="text-lg font-semibold tracking-tight text-foreground">Profile &amp; Preferences</h2>
        <p className="mt-1 text-sm leading-5 text-muted-foreground">
          Personalize how August looks and behaves. These are app-level preferences.
        </p>
      </header>

      <div className="flex-1 overflow-auto px-6 pb-6 space-y-4">
        {/* Appearance */}
        <SettingsCard
          icon={themeModeIcon}
          title="Appearance"
          description={
            <span>
              Choose light, dark, or follow your system. Pick a separate text size below.{' '}
              <SettingsTooltip content="System mode follows your operating system's light/dark setting in real time." />
            </span>
          }
          actions={<Badge variant="outline" className="font-mono">{themeMode}</Badge>}
          inert
        >
          <div className="grid grid-cols-3 gap-2">
            <ThemeModeButton mode="light" currentMode={themeMode} onSelect={setThemeMode} Icon={Sun} />
            <ThemeModeButton mode="dark" currentMode={themeMode} onSelect={setThemeMode} Icon={Moon} />
            <ThemeModeButton mode="system" currentMode={themeMode} onSelect={setThemeMode} Icon={Monitor} />
          </div>
        </SettingsCard>

        {/* Text size */}
        <SettingsCard
          icon={Sparkles}
          title="Text size"
          description={
            <span>
              Scales all chat, sidebar, and drawer text proportionally.{' '}
              <SettingsTooltip content="The display heading on the empty chat stays a fixed size so the wordmark is always readable." />
            </span>
          }
          actions={<Badge variant="outline" className="font-mono">{textSize}</Badge>}
          inert
        >
          <div className="space-y-3">
            <div className="grid grid-cols-4 gap-2">
              {TEXT_SIZE_OPTIONS.map((opt) => {
                const active = textSize === opt.id;
                return (
                  <button
                    key={opt.id}
                    onClick={() => setTextSize(opt.id)}
                    className={cn(
                      'flex flex-col items-center justify-center gap-0.5 rounded-lg border px-2 py-3 transition',
                      active
                        ? 'border-primary bg-primary/5 text-foreground'
                        : 'border-border text-muted-foreground hover:bg-muted/40',
                    )}
                  >
                    <span
                      className="font-semibold leading-none"
                      style={{ fontSize: `${parseFloat(opt.scale) * 1.1}rem` }}
                    >
                      Aa
                    </span>
                    <span className="text-[10px] uppercase tracking-caps">{opt.label}</span>
                  </button>
                );
              })}
            </div>

            {/* Live preview block */}
            <div className="rounded-md border border-border bg-background px-3 py-2.5 space-y-1.5">
              <p className="text-foreground font-medium leading-snug">
                August Proxy
              </p>
              <p className="text-muted-foreground leading-relaxed">
                Reads project files, runs commands, and surfaces a clean timeline of what it did.
              </p>
              <p className="text-muted-foreground/80 leading-relaxed">
                Use code, ask questions, or delegate to a sub-agent — every step stays legible.
              </p>
            </div>
          </div>
        </SettingsCard>

        {/* Experience presets */}
        <SettingsCard
          icon={Sparkles}
          title="Experience"
          description={
            <span>
              Start from a preset that matches how you use August.{' '}
              <SettingsTooltip content="Presets are quick starting points. You can fine-tune individual settings afterwards." />
            </span>
          }
        >
          <div className="space-y-2">
            {PRESETS.map((p) => {
              const active = activePreset === p.id;
              return (
                <button
                  key={p.id}
                  onClick={() => setActivePreset(p.id)}
                  className={cn(
                    'flex w-full items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition',
                    active
                      ? 'border-primary bg-primary/5'
                      : 'border-border hover:bg-muted/40',
                  )}
                >
                  <div
                    className={cn(
                      'mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border',
                      active ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/40',
                    )}
                  >
                    {active && <Check className="size-3" />}
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-foreground">{p.name}</span>
                      {p.id === 'default' && <Badge variant="secondary" className="text-[9px]">recommended</Badge>}
                    </div>
                    <p className="mt-0.5 text-xs leading-4 text-muted-foreground">{p.description}</p>
                  </div>
                </button>
              );
            })}
          </div>
        </SettingsCard>

        {/* Keyboard shortcuts */}
        <SettingsCard
          icon={Keyboard}
          title="Keyboard shortcuts"
          description="Common key combinations. Open the command palette (⌘K) to jump anywhere."
          inert
        >
          <div className="space-y-1">
            {SHORTCUTS.map((s) => (
              <div key={s.label} className="flex items-center justify-between rounded-md px-2 py-1.5 text-sm">
                <span className="text-foreground">{s.label}</span>
                <span className="flex items-center gap-1">
                  {s.keys.map((k) => (
                    <kbd
                      key={k}
                      className="rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground"
                    >
                      {k}
                    </kbd>
                  ))}
                </span>
              </div>
            ))}
          </div>
        </SettingsCard>

        {/* Onboarding */}
        <SettingsCard
          icon={GraduationCap}
          title="Onboarding"
          description="A short guided tour of the main features."
        >
          <SettingsToggle
            checked={tour}
            onCheckedChange={setTour}
            label="Show onboarding tour"
            description="Display a guided walkthrough the next time you open August."
            tooltip="The tour highlights where to find chat, settings, and activity."
          />
        </SettingsCard>
      </div>
    </div>
  );
}

interface ThemeModeButtonProps {
  mode: ThemeMode;
  currentMode: ThemeMode;
  onSelect: (mode: ThemeMode) => void;
  Icon: typeof Sun;
}

function ThemeModeButton({ mode, currentMode, onSelect, Icon }: ThemeModeButtonProps) {
  const active = currentMode === mode;
  const label = mode === 'light' ? 'Light' : mode === 'dark' ? 'Dark' : 'System';
  return (
    <button
      onClick={() => onSelect(mode)}
      className={cn(
        'flex items-center gap-2 rounded-lg border px-3 py-2.5 text-sm transition',
        active
          ? 'border-primary bg-primary/5 text-foreground'
          : 'border-border text-muted-foreground hover:bg-muted/40',
      )}
    >
      <Icon className="size-4" />
      {label}
      {active && <Check className="ml-auto size-3.5 text-primary" />}
    </button>
  );
}
