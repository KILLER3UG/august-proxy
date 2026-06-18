/* ── Profile & Preferences — new beginner-friendly preferences hub ─── */
/* Theme + appearance (backed by the existing $theme store), experience
 * presets (UI-only preview until a backing store exists), keyboard shortcut
 * reference, and an onboarding toggle placeholder. Everything uses the
 * shared primitives so it reads like the rest of the redesigned settings. */

import { useState } from 'react';
import { useStore } from '@nanostores/react';
import {
  Sun,
  Moon,
  Keyboard,
  Sparkles,
  GraduationCap,
  Check,
} from 'lucide-react';
import { $theme, toggleTheme } from '@/store/theme';
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

export function ProfilePreferencesSection() {
  const theme = useStore($theme);
  const [activePreset, setActivePreset] = useState<string>('default');
  const [tour, setTour] = useState(true);

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
          icon={theme === 'dark' ? Moon : Sun}
          title="Appearance"
          description={
            <span>
              Choose light or dark mode.{' '}
              <SettingsTooltip content="Dark mode uses a dark background with light text, which many people find easier on the eyes at night." />
            </span>
          }
          actions={<Badge variant="outline" className="font-mono">{theme}</Badge>}
          inert
        >
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => theme !== 'light' && toggleTheme()}
              className={cn(
                'flex items-center gap-2 rounded-lg border px-3 py-2.5 text-sm transition',
                theme === 'light'
                  ? 'border-primary bg-primary/5 text-foreground'
                  : 'border-border text-muted-foreground hover:bg-muted/40',
              )}
            >
              <Sun className="size-4" />
              Light
              {theme === 'light' && <Check className="ml-auto size-3.5 text-primary" />}
            </button>
            <button
              onClick={() => theme !== 'dark' && toggleTheme()}
              className={cn(
                'flex items-center gap-2 rounded-lg border px-3 py-2.5 text-sm transition',
                theme === 'dark'
                  ? 'border-primary bg-primary/5 text-foreground'
                  : 'border-border text-muted-foreground hover:bg-muted/40',
              )}
            >
              <Moon className="size-4" />
              Dark
              {theme === 'dark' && <Check className="ml-auto size-3.5 text-primary" />}
            </button>
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
