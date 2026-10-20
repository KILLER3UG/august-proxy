/* ── General — profile, preferences, notifications, and app basics ─── */
/* Landing section of the Settings header (2026-08-28 restructure).
 * Replaces the old profile-preferences hub and absorbs its theme-adjacent
 * cards (text size, presets, shortcuts, onboarding). Profile + preference
 * state lives in the preferences store (localStorage blob); OS-notify
 * state stays on OsNotifyService.
 *
 * The reference's settings surface is "one rounded container with hairline
 * children, not N bordered cards" — so the six cards this panel used to
 * draw (Profile, Preferences, Notifications, Keyboard shortcuts, Onboarding,
 * About August) are now six SECTIONS OF ONE CONTAINER, separated by a
 * hairline. Section labels are BARE: the reference carries a count or
 * nothing, never a sentence, so every descriptive line that used to sit
 * under a label is gone.
 *
 * The rows are the three-column grammar — name, value, muted metadata —
 * and the control sits at the row's RIGHT edge. */

import { useEffect, useState, type ReactNode } from 'react';

import { usePreferencesStore, type ChatFont, type LiveHtmlPreview, type VoiceSpeed } from '@/lib/preferences';
import { setOnboardingSeen, shouldShowOnboarding } from '@/components/overlays/OnboardingTour';
import { useAccountStore } from '@/store/account';
import { SectionHeader } from '@/components/SectionHeader';
import { SettingsToggle } from '@/components/settings/SettingsToggle';
import { SettingsSelect } from '@/components/settings/SettingsSelect';
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

/** One section of the single container. The label is bare; `hint` is muted
 *  metadata in the header's right slot — the reference's count slot. */
function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <section className="px-5 py-4">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-semibold tracking-tight text-foreground">{title}</h3>
        {hint ? (
          <span className="shrink-0 text-2xs tabular-nums text-muted-foreground/60">{hint}</span>
        ) : null}
      </div>
      <div className="mt-3">{children}</div>
    </section>
  );
}

/** A settings row: name (+ a muted description) on the left, the control at
 *  the row's RIGHT edge. Same geometry as SettingsToggle's own row, so the
 *  two read as one grammar. */
function Row({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-lg px-3 py-2.5">
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground">{label}</p>
        {description ? (
          <p className="mt-0.5 text-xs leading-4 text-muted-foreground">{description}</p>
        ) : null}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/** The OS notification permission as a word a person can read. The raw
 *  `Notification.permission` enum ('default' | 'granted' | 'denied') is not
 *  UI copy, and it was being rendered verbatim in a monospace badge. */
function permissionWord(): string {
  const p = OsNotifyService.permission();
  if (p === 'granted') return 'Allowed';
  if (p === 'denied') return 'Denied';
  if (p === 'unsupported') return 'Unavailable';
  return 'Default';
}

export function GeneralSection() {
  const chatFont = usePreferencesStore((s) => s.chatFont);
  const reduceMotion = usePreferencesStore((s) => s.reduceMotion);
  const voice = usePreferencesStore((s) => s.voice);
  const notifyResponseComplete = usePreferencesStore((s) => s.notifyResponseComplete);
  const liveHtmlPreview = usePreferencesStore((s) => s.liveHtmlPreview);
  const setChatFont = usePreferencesStore((s) => s.setChatFont);
  const setReduceMotion = usePreferencesStore((s) => s.setReduceMotion);
  const setVoice = usePreferencesStore((s) => s.setVoice);
  const setNotifyResponseComplete = usePreferencesStore((s) => s.setNotifyResponseComplete);
  const setLiveHtmlPreview = usePreferencesStore((s) => s.setLiveHtmlPreview);

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
      <div className="shrink-0 px-6 pt-5">
        <SectionHeader
          title="General"
          subtitle="Profile, preferences, notifications, and the basics of how August behaves."
          className="mb-3"
        />
      </div>

      <div className="flex-1 overflow-auto px-6 pb-6">
        <div className="divide-y divide-border/60 rounded-xl border border-border/70 bg-card/40">
          {/* Profile */}
          <Section title="Profile">
            <div className="flex items-center gap-3 px-3">
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
          </Section>

          {/* Preferences */}
          <Section title="Preferences">
            <div className="space-y-1">
              <Row label="Chat font" description="Typeface used for chat messages.">
                <SettingsSelect
                  value={chatFont}
                  onChange={(v) => setChatFont(v as ChatFont)}
                  options={CHAT_FONT_OPTIONS.map((f) => ({ value: f.id, label: f.label }))}
                  aria-label="Chat font"
                  className="w-40 shrink-0"
                />
              </Row>

              <SettingsToggle
                checked={reduceMotion}
                onCheckedChange={setReduceMotion}
                label="Reduce motion"
                description="Reduce animation in streaming responses and other interface elements."
              />

              <Row
                label="Live artifact previews"
                description="Figures and dashboards August writes run their own scripts when previewed. Files you open yourself stay static renders."
              >
                <SettingsSelect
                  value={liveHtmlPreview}
                  onChange={(v) => setLiveHtmlPreview(v as LiveHtmlPreview)}
                  options={[
                    { value: 'auto', label: "August's files only" },
                    { value: 'on', label: 'Every file with a path' },
                    { value: 'off', label: 'Never' },
                  ]}
                  aria-label="Live artifact previews"
                  className="w-40 shrink-0"
                />
              </Row>

              {/* These two were a 2-up block whose labels sat ABOVE full-width
                  controls at text-xs — two grammars inside one card, and the
                  controls nowhere near the row's right edge. They are rows
                  now, like the two above them. */}
              <Row label="Voice language" description="Language for spoken replies.">
                <SettingsSelect
                  value={voice.language}
                  onChange={(v) => setVoice({ language: v })}
                  options={[{ value: 'en', label: 'English (en)' }]}
                  aria-label="Voice language"
                  className="w-40 shrink-0"
                />
              </Row>
              <Row label="Voice speed" description="Speed of spoken replies.">
                <SettingsSelect
                  value={voice.speed}
                  onChange={(v) => setVoice({ speed: v as VoiceSpeed })}
                  options={VOICE_SPEEDS.map((s) => ({ value: s.id, label: s.label }))}
                  aria-label="Voice speed"
                  className="w-40 shrink-0"
                />
              </Row>
            </div>
          </Section>

          {/* Notifications */}
          <Section title="Notifications" hint={permissionWord()}>
            <div className="space-y-1">
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
                description="Also available from the Jobs panel in the right drawer."
                tooltip="Requires notification permission from the browser or desktop shell."
              />
            </div>
          </Section>

          {/* The global 4-step "Text size" picker used to live here and is
              gone. It had been marked `inert` — a visible control that could
              not be pressed — while Appearance grew the four PER-SURFACE rows
              that replaced it, so the most-visited settings page was showing a
              dead duplicate of a working control. Sizing lives in Appearance
              now (Interface / Chat messages / Chat input / Code), which is
              also the only reference shape: four quiet rows, one pill each.

              `data-text-size` itself is untouched — it still scales the root
              rem for surfaces with no per-surface override, so an existing
              user who had picked "spacious" keeps it. */}

          {/* The "Experience" preset picker that used to sit here wrote
              `localStorage['august_preset']` and read it back for nothing but
              its own selected-button highlight — no layout, density, analytics
              or tooltip behaviour keyed off it anywhere in the frontend or
              backend, so "Power User — denser layouts, raw bodies surfaced" and
              "Privacy Focused — hide usage analytics and history previews"
              changed no thing. Its inline comment claimed the privacy preset
              hid the notification surface and kept the tour off; that code
              never existed. */}

          {/* Keyboard shortcuts */}
          <Section title="Keyboard shortcuts">
            <div className="space-y-1">
              {SHORTCUTS.map((s) => (
                <div key={s.label} className="flex items-center justify-between rounded-md px-2 py-1.5 text-sm">
                  <span className="text-foreground">{s.label}</span>
                  <span className="flex items-center gap-1">
                    {s.keys.map((k) => (
                      <kbd
                        key={k}
                        className="rounded border border-border bg-muted px-1.5 py-0.5 text-2xs font-mono text-muted-foreground"
                      >
                        {k}
                      </kbd>
                    ))}
                  </span>
                </div>
              ))}
            </div>
          </Section>

          {/* Onboarding */}
          <Section title="Onboarding">
            <SettingsToggle
              checked={tour}
              onCheckedChange={toggleTour}
              label="Show onboarding tour"
              description="Play the guided walkthrough the next time you start August with no conversations yet."
              tooltip="The tour highlights where to find chat, settings, and activity. It only plays while you have zero conversations, so clearing this stops it permanently."
            />
          </Section>

          {/* App description */}
          <Section title="About August">
            <p className="text-sm text-muted-foreground">
              August reads your project files, runs commands, and keeps every step legible.
            </p>
          </Section>
        </div>
      </div>
    </div>
  );
}
