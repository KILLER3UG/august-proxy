/* ── WorkspaceGeneralSection — theme + presets + shortcuts + tour ────── */
/* Migrated from ProfilePreferencesSection. Uses the dark workspace panel
 * aesthetic — slightly different card colors than the modal version.
 *
 * Phase 2.X update: uses the new 3-mode theme picker (light/dark/system)
 * and text-size picker driven by @/lib/theme. */

import * as React from 'react';
import { Sun, Moon, Monitor, Keyboard, Sparkles, GraduationCap, Check } from 'lucide-react';
import { useThemeStore, setThemeMode, setTextSize } from '@/lib/theme';
import type { ThemeMode, TextSize } from '@/lib/theme';
import { cn } from '@/lib/utils';

const SHORTCUTS: { keys: string[]; label: string }[] = [
  { keys: ['⌘', ','], label: 'Open workspace settings' },
  { keys: ['⌘', 'K'], label: 'Command palette' },
  { keys: ['esc'], label: 'Close overlay / dialog' },
];

interface Preset {
  id: string;
  name: string;
  description: string;
}

const PRESETS: Preset[] = [
  { id: 'default', name: 'Default', description: 'Balanced view with helpful explanations shown.' },
  { id: 'power', name: 'Power User', description: 'Denser layouts, raw bodies surfaced, fewer tooltips.' },
  { id: 'privacy', name: 'Privacy Focused', description: 'Hide usage analytics and history previews.' },
];

const TEXT_SIZE_OPTIONS: { id: TextSize; label: string; scale: string }[] = [
  { id: 'compact',     label: 'Small',      scale: '0.92' },
  { id: 'default',     label: 'Default',    scale: '1.00' },
  { id: 'comfortable', label: 'Large',      scale: '1.08' },
  { id: 'spacious',    label: 'Extra Large', scale: '1.18' },
];

export function WorkspaceGeneralSection() {
  const themeMode = useThemeStore((s) => s.mode);
  const textSize = useThemeStore((s) => s.textSize);
  const activePreset = 'default'; // local-only until a settings store exists

  const themeModeIcon =
    themeMode === 'light' ? Sun : themeMode === 'dark' ? Moon : Monitor;

  return (
    <div className="px-8 py-6 max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">General</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Personalize how August looks and behaves. These are app-level preferences.
        </p>
      </div>

      {/* Appearance (theme) */}
      <div className="rounded-xl border border-white/[0.06] bg-card/60 p-5 space-y-3">
        <div className="flex items-center gap-2">
          {React.createElement(themeModeIcon, { className: 'size-4' })}
          <span className="text-sm font-semibold">Appearance</span>
        </div>
        <p className="text-xs text-muted-foreground">
          Choose light, dark, or follow your system. Pick a separate text size below.
        </p>
        <div className="grid grid-cols-3 gap-2 max-w-md">
          {(['light', 'dark', 'system'] as ThemeMode[]).map((mode) => {
            const Icon = mode === 'light' ? Sun : mode === 'dark' ? Moon : Monitor;
            const active = themeMode === mode;
            const label = mode === 'light' ? 'Light' : mode === 'dark' ? 'Dark' : 'System';
            return (
              <button
                key={mode}
                onClick={() => setThemeMode(mode)}
                className={cn(
                  'flex items-center gap-2 rounded-lg border px-3 py-2.5 text-sm transition',
                  active
                    ? 'border-primary bg-primary/5 text-foreground'
                    : 'border-white/[0.08] text-muted-foreground hover:bg-white/[0.04]',
                )}
              >
                <Icon className="size-4" />
                {label}
                {active && <Check className="ml-auto size-3.5 text-primary" />}
              </button>
            );
          })}
        </div>
      </div>

      {/* Text size */}
      <div className="rounded-xl border border-white/[0.06] bg-card/60 p-5 space-y-3">
        <div className="flex items-center gap-2">
          <Sparkles className="size-4" />
          <span className="text-sm font-semibold">Text size</span>
        </div>
        <p className="text-xs text-muted-foreground">
          Scales all chat, sidebar, and drawer text proportionally.
        </p>
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
                    : 'border-white/[0.08] text-muted-foreground hover:bg-white/[0.04]',
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
      </div>

      {/* Experience presets */}
      <div className="rounded-xl border border-white/[0.06] bg-card/60 p-5 space-y-3">
        <div className="flex items-center gap-2">
          <Sparkles className="size-4" />
          <span className="text-sm font-semibold">Experience</span>
        </div>
        <p className="text-xs text-muted-foreground">
          Start from a preset that matches how you use August.
        </p>
        <div className="space-y-2">
          {PRESETS.map((p) => {
            const active = activePreset === p.id;
            return (
              <div
                key={p.id}
                className={cn(
                  'flex items-start gap-3 rounded-lg border px-3 py-2.5 transition',
                  active
                    ? 'border-primary bg-primary/5'
                    : 'border-white/[0.08] hover:bg-white/[0.03]',
                )}
              >
                <div
                  className={cn(
                    'mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border',
                    active ? 'border-primary bg-primary text-primary-foreground' : 'border-white/[0.2]',
                  )}
                >
                  {active && <Check className="size-3" />}
                </div>
                <div className="min-w-0">
                  <div className="text-sm font-medium">{p.name}</div>
                  <p className="text-xs text-muted-foreground">{p.description}</p>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Keyboard shortcuts */}
      <div className="rounded-xl border border-white/[0.06] bg-card/60 p-5 space-y-3">
        <div className="flex items-center gap-2">
          <Keyboard className="size-4" />
          <span className="text-sm font-semibold">Keyboard shortcuts</span>
        </div>
        <div className="space-y-1.5">
          {SHORTCUTS.map((s) => (
            <div key={s.label} className="flex items-center justify-between rounded-md px-2 py-1.5 text-sm">
              <span>{s.label}</span>
              <span className="flex items-center gap-1">
                {s.keys.map((k) => (
                  <kbd
                    key={k}
                    className="rounded border border-white/[0.08] bg-white/[0.04] px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground"
                  >
                    {k}
                  </kbd>
                ))}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Onboarding */}
      <div className="rounded-xl border border-white/[0.06] bg-card/60 p-5 space-y-3">
        <div className="flex items-center gap-2">
          <GraduationCap className="size-4" />
          <span className="text-sm font-semibold">Onboarding</span>
        </div>
        <label className="flex items-center justify-between rounded-md px-2 py-1.5 text-sm cursor-pointer">
          <span>Show onboarding tour</span>
          <button
            type="button"
            role="switch"
            aria-checked
            className="relative inline-flex h-5 w-9 shrink-0 items-center rounded-full bg-primary"
          >
            <span className="inline-block size-4 transform rounded-full bg-white shadow translate-x-4" />
          </button>
        </label>
        <p className="text-xs text-muted-foreground">
          Display a guided walkthrough the next time you open August.
        </p>
      </div>
    </div>
  );
}
