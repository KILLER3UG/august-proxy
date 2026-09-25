/* ── General — profile, preferences, notifications, and app basics ─── */
/* Landing section of the Settings header (2026-08-28 restructure).
 * Replaces the old profile-preferences hub and absorbs its theme-adjacent
 * cards (text size, presets, shortcuts, onboarding). Profile + preference
 * state lives in the preferences store (localStorage blob); OS-notify
 * state stays on OsNotifyService. */

import { useEffect, useState } from 'react';

import {
  Sparkles,
  GraduationCap,
  Bell,
  Keyboard,
  SlidersHorizontal,
  UserRound,
} from 'lucide-react';
import { useThemeStore, setTextSize } from '@/lib/theme';
import type { TextSize } from '@/lib/theme';
import { usePreferencesStore, type ChatFont, type VoiceSpeed } from '@/lib/preferences';
import { setOnboardingSeen, shouldShowOnboarding } from '@/components/overlays/OnboardingTour';
import { useAccountStore } from '@/store/account';
import { SettingsCard } from '@/components/settings/SettingsCard';
import { SettingsToggle } from '@/components/settings/SettingsToggle';
import { SettingsTooltip } from '@/components/settings/SettingsTooltip';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { OsNotifyService } from '@/lib/os-notify';

const IS_MAC =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

const SHORTCUTS: { keys: string[]; label: string }[] = [
  { keys: [IS_MAC ? '⌘' : 'Ctrl', ','], label: 'Open Settings' },
  { keys: [IS_MAC ? '⌘' : 'Ctrl', 'K'], label: 'Command palette' },
  { keys: [IS_MAC ? '⌘' : 'Ctrl', 'F'], label: 'Search in thread' },
  { keys: ['Ctrl', 'Shift', 'Space'],   label: 'Focus composer' },
  { keys: ['Ctrl', 'Shift', 'P'],       label: 'Markdown preview' },
  { keys: ['esc'],                      label: 'Close overlay / dialog' },
];

const TEXT_SIZE_OPTIONS: { id: TextSize; label: string; scale: string }[] = [
  { id: 'compact',     label: 'Small',      scale: '0.92' },
  { id: 'default',     label: 'Default',    scale: '1.00' },
  { id: 'comfortable', label: 'Large',      scale: '1.08' },
  { id: 'spacious',    label: 'Extra Large', scale: '1.18' },
];

const CHAT_FONT_OPTIONS: { id: ChatFont; label: string }[] = [
  { id: 'default', label: 'Default' },
  { id: 'serif',   label: 'Serif' },
  { id: 'mono',    label: 'Monospace' },
];

const VOICE_SPEEDS: { id: VoiceSpeed; label: string }[] = [
  { id: 'slow',   label: 'Slow' },
  { id: 'normal', label: 'Normal' },
  { id: 'fast',   label: 'Fast' },
];

const inputClass =
  'w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground ' +
  'placeholder:text-muted-foreground/60 outline-none transition focus:border-primary/60';

export function GeneralSection() {
  const textSize = useThemeStore((s) => s.textSize);
  const chatFont = usePreferencesStore((s) => s.chatFont);
  const reduceMotion = usePreferencesStore((s) => s.reduceMotion);
  const voice = usePreferencesStore((s) => s.voice);
  const notifyResponseComplete = usePreferencesStore((s) => s.notifyResponseComplete);
  const setChatFont = usePreferencesStore((s) => s.setChatFont);
  const setReduceMotion = usePreferencesStore((s) => s.setReduceMotion);
  const setVoice = usePreferencesStore((s) => s.setVoice);
  const setNotifyResponseComplete = usePreferencesStore((s) => s.setNotifyResponseComplete);

  const accounts = useAccountStore((s) => s.accounts);
  const activeAccountId = useAccountStore((s) => s.activeAccountId);
  const account = accounts.find((a) => a.id === activeAccountId) ?? null;

  // Backed by the key OnboardingTour actually gates on, so this switch now has
  // an effect. It used to be `useState(true)`: unwired, reset on every revisit
  // to Settings, and ignored by the tour.
  const [tour, setTour] = useState<boolean>(() => shouldShowOnboarding());
  const [osNotify, setOsNotify] = useState(false);

  useEffect(() => {
    setOsNotify(OsNotifyService.isEnabled());
  }, []);

  const toggleTour = (next: boolean) => {
    setTour(next);
    setOnboardingSeen(!next);
  };

  return (
    <div className="flex h-full flex-col">
      <header className="px-6 pt-5 pb-3 shrink-0">
        <h2 className="text-lg font-semibold tracking-tight text-foreground">General</h2>
        <p className="mt-1 text-sm leading-5 text-muted-foreground">
          Profile, preferences, notifications, and the basics of how August behaves.
        </p>
      </header>

      <div className="flex-1 overflow-auto px-6 pb-6 space-y-4">
        {/* Profile */}
        <SettingsCard
          icon={UserRound}
          title="Profile"
          description="Who you are and how August should work with you."
          inert
        >
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <span className="grid size-11 shrink-0 place-items-center rounded-full bg-primary/15 text-sm font-semibold text-primary">
                {account?.initials || account?.displayName.slice(0, 2).toUpperCase() || 'A'}
              </span>
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-foreground">
                  {account?.displayName ?? 'August User'}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {account?.email || (account ? `@${account.username}` : 'Local account')}
                </p>
              </div>
            </div>

            {/* The three fields that used to sit here — "What should August
                call you?", "What best describes your work?" and "Instructions
                for August", the last one labelled "Added to the start of every
                conversation" — wrote only to localStorage. Nothing in the
                frontend or the backend ever read them, so the promise was
                false. What actually shapes the model is the `kind='profile'`
                fact lane, edited under Settings → Memory. */}
          </div>
        </SettingsCard>

        {/* Preferences */}
        <SettingsCard
          icon={SlidersHorizontal}
          title="Preferences"
          description="How August looks, moves, and sounds."
          inert
        >
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">Chat font</p>
                <p className="text-xs text-muted-foreground">Typeface used for chat messages.</p>
              </div>
              <select
                value={chatFont}
                onChange={(e) => setChatFont(e.target.value as ChatFont)}
                className={cn(inputClass, 'w-40 shrink-0')}
                aria-label="Chat font"
              >
                {CHAT_FONT_OPTIONS.map((f) => (
                  <option key={f.id} value={f.id}>{f.label}</option>
                ))}
              </select>
            </div>

            <SettingsToggle
              checked={reduceMotion}
              onCheckedChange={setReduceMotion}
              label="Reduce motion"
              description="Reduce animation in streaming responses and other interface elements."
            />

            <div className="grid gap-3 sm:grid-cols-3">
              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-foreground">Voice language</span>
                <select
                  value={voice.language}
                  onChange={(e) => setVoice({ language: e.target.value })}
                  className={inputClass}
                >
                  <option value="en">English (en)</option>
                </select>
              </label>
              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-foreground">Voice speed</span>
                <select
                  value={voice.speed}
                  onChange={(e) => setVoice({ speed: e.target.value as VoiceSpeed })}
                  className={inputClass}
                >
                  {VOICE_SPEEDS.map((s) => (
                    <option key={s.id} value={s.id}>{s.label}</option>
                  ))}
                </select>
              </label>
            </div>
          </div>
        </SettingsCard>

        {/* Notifications */}
        <SettingsCard
          icon={Bell}
          title="Notifications"
          description={
            <span>
              Opt-in alerts for finished work.{' '}
              <SettingsTooltip content="Requires notification permission from the browser or desktop shell." />
            </span>
          }
          actions={
            <Badge variant="outline" className="font-mono">
              {OsNotifyService.permission()}
            </Badge>
          }
          inert
        >
          <div className="space-y-3">
            <SettingsToggle
              checked={notifyResponseComplete}
              onCheckedChange={setNotifyResponseComplete}
              label="Response completions"
              description="Get notified when August has finished a response. Useful for long-running tasks."
            />
            <SettingsToggle
              checked={osNotify}
              onCheckedChange={(on) => {
                setOsNotify(on);
                OsNotifyService.setEnabled(on);
                if (on) void OsNotifyService.ensurePermission();
              }}
              label="Notify when jobs complete"
              description="Also available from the background task tray in the status bar."
            />
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

        {/* The "Experience" preset picker that used to sit here wrote
            `localStorage['august_preset']` and read it back for nothing but its
            own selected-button highlight — no layout, density, analytics or
            tooltip behaviour keyed off it anywhere in the frontend or backend,
            so "Power User — denser layouts, raw bodies surfaced" and "Privacy
            Focused — hide usage analytics and history previews" changed no
            thing. Its inline comment claimed the privacy preset hid the
            notification surface and kept the tour off; that code never existed. */}

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
            onCheckedChange={toggleTour}
            label="Show onboarding tour"
            description="Play the guided walkthrough the next time you start August with no conversations yet."
            tooltip="The tour highlights where to find chat, settings, and activity. It only plays while you have zero conversations, so clearing this stops it permanently."
          />
        </SettingsCard>

        {/* App description */}
        <SettingsCard
          icon={Sparkles}
          title="About August"
          description="What this app does, in one paragraph."
          inert
        >
          <p className="text-sm leading-6 text-muted-foreground">
            August reads project files, runs commands, and surfaces a clean timeline of what it
            did. Use code, ask questions, or delegate to a sub-agent — every step stays legible.
          </p>
        </SettingsCard>
      </div>
    </div>
  );
}
