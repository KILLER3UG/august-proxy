/* ── App preferences store — General settings tab ──────────────────── */
/* Profile identity, chat font, motion, voice, and notification prefs.
 * Persists as one JSON blob in localStorage and applies document-level
 * data attributes so styles.css can react without React re-renders. */

import { create } from 'zustand';

export type ChatFont = 'default' | 'serif' | 'mono';
export type VoiceSpeed = 'slow' | 'normal' | 'fast';

export interface ProfilePrefs {
  /** What August should call you (distinct from the account display name). */
  callYou: string;
  /** Free-form answer to "What best describes your work?". */
  workDescription: string;
  /** Standing instructions prepended to every conversation. */
  instructions: string;
}

export interface VoicePrefs {
  /** BCP-47-ish code, e.g. "en". */
  language: string;
  /** Cosmetic style label (Neutral / Warm / Buttery / Bright). */
  style: string;
  speed: VoiceSpeed;
}

interface PreferencesState {
  profile: ProfilePrefs;
  chatFont: ChatFont;
  reduceMotion: boolean;
  voice: VoicePrefs;
  notifyResponseComplete: boolean;
  setProfile: (patch: Partial<ProfilePrefs>) => void;
  setChatFont: (font: ChatFont) => void;
  setReduceMotion: (on: boolean) => void;
  setVoice: (patch: Partial<VoicePrefs>) => void;
  setNotifyResponseComplete: (on: boolean) => void;
}

const STORAGE_KEY = 'august.preferences';

const DEFAULTS: Omit<
  PreferencesState,
  'setProfile' | 'setChatFont' | 'setReduceMotion' | 'setVoice' | 'setNotifyResponseComplete'
> = {
  profile: { callYou: '', workDescription: '', instructions: '' },
  chatFont: 'default',
  reduceMotion: false,
  voice: { language: 'en', style: 'Neutral', speed: 'normal' },
  notifyResponseComplete: false,
};

function load(): typeof DEFAULTS {
  if (typeof window === 'undefined') return DEFAULTS;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<typeof DEFAULTS>;
    return {
      profile: { ...DEFAULTS.profile, ...(parsed.profile ?? {}) },
      chatFont: parsed.chatFont ?? DEFAULTS.chatFont,
      reduceMotion: parsed.reduceMotion ?? DEFAULTS.reduceMotion,
      voice: { ...DEFAULTS.voice, ...(parsed.voice ?? {}) },
      notifyResponseComplete:
        parsed.notifyResponseComplete ?? DEFAULTS.notifyResponseComplete,
    };
  } catch {
    return DEFAULTS;
  }
}

function persist(state: PreferencesState): void {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        profile: state.profile,
        chatFont: state.chatFont,
        reduceMotion: state.reduceMotion,
        voice: state.voice,
        notifyResponseComplete: state.notifyResponseComplete,
      }),
    );
  } catch {
    /* storage unavailable */
  }
}

/** Apply the document-level hooks styles.css reacts to. Safe to call
 *  before React mounts (main.tsx) and on every change. */
export function applyPreferenceAttributes(prefs: {
  chatFont: ChatFont;
  reduceMotion: boolean;
}): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (prefs.chatFont === 'default') delete root.dataset.chatFont;
  else root.dataset.chatFont = prefs.chatFont;
  if (prefs.reduceMotion) root.dataset.reduceMotion = '1';
  else delete root.dataset.reduceMotion;
}

export const usePreferencesStore = create<PreferencesState>((set, get) => ({
  ...load(),
  setProfile: (patch) => {
    set((s) => ({ profile: { ...s.profile, ...patch } }));
    persist(get());
  },
  setChatFont: (font) => {
    set({ chatFont: font });
    applyPreferenceAttributes(get());
    persist(get());
  },
  setReduceMotion: (on) => {
    set({ reduceMotion: on });
    applyPreferenceAttributes(get());
    persist(get());
  },
  setVoice: (patch) => {
    set((s) => ({ voice: { ...s.voice, ...patch } }));
    persist(get());
  },
  setNotifyResponseComplete: (on) => {
    set({ notifyResponseComplete: on });
    persist(get());
  },
}));

/** Boot-time application of the persisted attributes (call in main.tsx
 *  alongside applyTheme/applyTextSize to avoid FOUC). */
export function applyStoredPreferences(): void {
  const s = usePreferencesStore.getState();
  applyPreferenceAttributes({ chatFont: s.chatFont, reduceMotion: s.reduceMotion });
}

/** SpeechSynthesis rate multiplier for the persisted voice speed. */
export function voiceRate(speed: VoiceSpeed): number {
  return speed === 'slow' ? 0.85 : speed === 'fast' ? 1.25 : 1;
}
