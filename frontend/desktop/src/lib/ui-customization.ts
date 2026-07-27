/**
 * User UI customization — override design tokens with live preview + apply.
 *
 * Draft colors update the settings preview only.
 * Applied colors write to document.documentElement (and localStorage) so the
 * real app chrome picks them up immediately.
 */

import { create } from 'zustand';
import type { CSSProperties } from 'react';

const STORAGE_KEY = 'august.uiCustomization.v1';

/** User-editable tokens (subset of --dt-* that map cleanly to common surfaces). */
export type UiTokenId =
  | 'background'
  | 'foreground'
  | 'card'
  | 'muted'
  | 'mutedForeground'
  | 'primary'
  | 'primaryForeground'
  | 'border'
  | 'input'
  | 'chatBackground'
  | 'chatInputBackground'
  | 'userBubble'
  | 'sidebar'
  | 'sidebarForeground'
  | 'sidebarAccent'
  | 'sidebarBorder'
  | 'accent'
  | 'ring';

export interface UiTokenDef {
  id: UiTokenId;
  /** CSS custom property name */
  cssVar: string;
  /** Short UI label */
  label: string;
  /** Group in the designer */
  group: 'app' | 'chat' | 'sidebar' | 'brand';
  description: string;
}

export const UI_TOKEN_DEFS: readonly UiTokenDef[] = [
  {
    id: 'background',
    cssVar: '--dt-background',
    label: 'App background',
    group: 'app',
    description: 'Main window / chat area background',
  },
  {
    id: 'foreground',
    cssVar: '--dt-foreground',
    label: 'Primary text',
    group: 'app',
    description: 'Default body text color',
  },
  {
    id: 'card',
    cssVar: '--dt-card',
    label: 'Cards & panels',
    group: 'app',
    description: 'Settings cards, bubbles, elevated surfaces',
  },
  {
    id: 'muted',
    cssVar: '--dt-muted',
    label: 'Muted surface',
    group: 'app',
    description: 'Secondary panels and hover fills',
  },
  {
    id: 'mutedForeground',
    cssVar: '--dt-muted-foreground',
    label: 'Muted text',
    group: 'app',
    description: 'Secondary labels and hints',
  },
  {
    id: 'border',
    cssVar: '--dt-border',
    label: 'Borders',
    group: 'app',
    description: 'Default dividers and outlines',
  },
  {
    id: 'input',
    cssVar: '--dt-input',
    label: 'Chat input / fields',
    group: 'chat',
    description: 'Composer and form field borders / fills',
  },
  {
    id: 'chatBackground',
    cssVar: '--dt-chat-background',
    label: 'Chat area background',
    group: 'chat',
    description: 'Background behind the conversation thread',
  },
  {
    id: 'chatInputBackground',
    cssVar: '--dt-chat-input-bg',
    label: 'Chat input background',
    group: 'chat',
    description: 'Composer card surface (where you type)',
  },
  {
    id: 'userBubble',
    cssVar: '--dt-user-bubble',
    label: 'Your message bubble',
    group: 'chat',
    description: 'Background of the messages you send',
  },
  {
    id: 'sidebar',
    cssVar: '--dt-sidebar',
    label: 'Session sidebar',
    group: 'sidebar',
    description: 'Left session list background',
  },
  {
    id: 'sidebarForeground',
    cssVar: '--dt-sidebar-foreground',
    label: 'Sidebar text',
    group: 'sidebar',
    description: 'Session titles and labels',
  },
  {
    id: 'sidebarAccent',
    cssVar: '--dt-sidebar-accent',
    label: 'Sidebar highlight',
    group: 'sidebar',
    description: 'Active session / hover row',
  },
  {
    id: 'sidebarBorder',
    cssVar: '--dt-sidebar-border',
    label: 'Sidebar border',
    group: 'sidebar',
    description: 'Sidebar edge and row dividers',
  },
  {
    id: 'primary',
    cssVar: '--dt-primary',
    label: 'Primary / brand',
    group: 'brand',
    description: 'Buttons, focus rings, active accents',
  },
  {
    id: 'primaryForeground',
    cssVar: '--dt-primary-foreground',
    label: 'Primary text',
    group: 'brand',
    description: 'Text on primary buttons',
  },
  {
    id: 'accent',
    cssVar: '--dt-accent',
    label: 'Accent surface',
    group: 'brand',
    description: 'Soft brand fills',
  },
  {
    id: 'ring',
    cssVar: '--dt-ring',
    label: 'Focus ring',
    group: 'brand',
    description: 'Keyboard focus outline',
  },
] as const;

export type UiCustomizationMap = Partial<Record<UiTokenId, string>>;

/** One-click theme presets for the UI Designer. Each is a plain token map —
 *  empty map means "theme defaults". Colors are hand-tuned dark palettes. */
export interface ThemePreset {
  id: string;
  name: string;
  map: UiCustomizationMap;
}

export const THEME_PRESETS: readonly ThemePreset[] = [
  { id: 'default', name: 'Default', map: {} },
  {
    id: 'midnight',
    name: 'Midnight',
    map: {
      background: '#0b1020',
      foreground: '#e6e9f5',
      card: '#131a30',
      muted: '#1c2440',
      mutedForeground: '#8b93b8',
      border: '#232c4d',
      primary: '#7aa2ff',
      chatBackground: '#0b1020',
      chatInputBackground: '#131a30',
      userBubble: '#273257',
    },
  },
  {
    id: 'carbon',
    name: 'Carbon',
    map: {
      background: '#101012',
      foreground: '#ececec',
      card: '#17171a',
      muted: '#202024',
      mutedForeground: '#9a9aa2',
      border: '#2a2a2f',
      primary: '#f5a524',
      chatBackground: '#101012',
      chatInputBackground: '#17171a',
      userBubble: '#2a2620',
    },
  },
  {
    id: 'rose',
    name: 'Rosé',
    map: {
      background: '#171017',
      foreground: '#f3e8ef',
      card: '#20161f',
      muted: '#2a1d29',
      mutedForeground: '#b398ab',
      border: '#3a2838',
      primary: '#f472b6',
      chatBackground: '#171017',
      chatInputBackground: '#20161f',
      userBubble: '#3a2436',
    },
  },
  {
    id: 'solarized',
    name: 'Solarized',
    map: {
      background: '#002b36',
      foreground: '#93a1a1',
      card: '#073642',
      muted: '#0a4050',
      mutedForeground: '#657b83',
      border: '#0f4a5c',
      primary: '#268bd2',
      chatBackground: '#002b36',
      chatInputBackground: '#073642',
      userBubble: '#0f4a5c',
    },
  },
  {
    id: 'forest',
    name: 'Forest',
    map: {
      background: '#0c1310',
      foreground: '#dcefe4',
      card: '#121d17',
      muted: '#1a2a21',
      mutedForeground: '#87a695',
      border: '#22382c',
      primary: '#34d399',
      chatBackground: '#0c1310',
      chatInputBackground: '#121d17',
      userBubble: '#1e3529',
    },
  },
];

interface UiCustomizationState {
  /** Live editor draft (preview only until Apply) */
  draft: UiCustomizationMap;
  /** Applied to the real UI */
  applied: UiCustomizationMap;
}

export const useUiCustomizationStore = create<UiCustomizationState>(() => ({
  draft: {},
  applied: {},
}));

export function isHexColor(value: string): boolean {
  return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(value.trim());
}

/** Normalize #RGB → #RRGGBB for <input type="color"> */
export function toColorInputValue(hex: string): string {
  const h = hex.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(h)) return h;
  if (/^#[0-9a-fA-F]{3}$/.test(h)) {
    const r = h[1];
    const g = h[2];
    const b = h[3];
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  return '#000000';
}

export function setDraftToken(id: UiTokenId, value: string): void {
  const next = value.trim();
  useUiCustomizationStore.setState((s) => {
    const draft = { ...s.draft };
    if (!next) {
      delete draft[id];
    } else {
      draft[id] = next;
    }
    return { draft };
  });
}

export function resetDraftToken(id: UiTokenId): void {
  useUiCustomizationStore.setState((s) => {
    const draft = { ...s.draft };
    delete draft[id];
    return { draft };
  });
}

export function resetAllDraft(): void {
  useUiCustomizationStore.setState({ draft: {} });
}

export function discardDraftToApplied(): void {
  const applied = useUiCustomizationStore.getState().applied;
  useUiCustomizationStore.setState({ draft: { ...applied } });
}

/** Copy draft → applied, persist, paint document root. */
export function applyDraftCustomization(): void {
  const draft = { ...useUiCustomizationStore.getState().draft };
  // Drop invalid values
  for (const [k, v] of Object.entries(draft) as [UiTokenId, string][]) {
    if (!v || !isHexColor(v)) delete draft[k];
  }
  useUiCustomizationStore.setState({ applied: draft, draft: { ...draft } });
  paintAppliedToDocument(draft);
  persistApplied(draft);
}

/** Clear all custom overrides and restore theme defaults. */
export function resetAppliedCustomization(): void {
  useUiCustomizationStore.setState({ applied: {}, draft: {} });
  clearDocumentOverrides();
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

export function paintAppliedToDocument(map: UiCustomizationMap = useUiCustomizationStore.getState().applied): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  for (const def of UI_TOKEN_DEFS) {
    const val = map[def.id];
    if (val && isHexColor(val)) {
      root.style.setProperty(def.cssVar, val);
    } else {
      root.style.removeProperty(def.cssVar);
    }
  }
  // Keep secondary surfaces in sync when primary brand changes for a coherent look
  if (map.primary) {
    root.style.setProperty('--dt-sidebar-primary', map.primary);
    root.style.setProperty('--dt-sidebar-ring', map.ring || map.primary);
  } else {
    root.style.removeProperty('--dt-sidebar-primary');
    root.style.removeProperty('--dt-sidebar-ring');
  }
}

function clearDocumentOverrides(): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  for (const def of UI_TOKEN_DEFS) {
    root.style.removeProperty(def.cssVar);
  }
  root.style.removeProperty('--dt-sidebar-primary');
  root.style.removeProperty('--dt-sidebar-ring');
}

function persistApplied(map: UiCustomizationMap): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* ignore */
  }
}

export function loadAppliedFromStorage(): UiCustomizationMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as UiCustomizationMap;
    if (!parsed || typeof parsed !== 'object') return {};
    const cleaned: UiCustomizationMap = {};
    for (const def of UI_TOKEN_DEFS) {
      const v = parsed[def.id];
      if (typeof v === 'string' && isHexColor(v)) cleaned[def.id] = v.trim();
    }
    return cleaned;
  } catch {
    return {};
  }
}

/** Call from main.tsx after hydrateTheme to restore custom colors. */
export function hydrateUiCustomization(): void {
  const applied = loadAppliedFromStorage();
  useUiCustomizationStore.setState({ applied, draft: { ...applied } });
  paintAppliedToDocument(applied);
}

/** Apply a customization map from outside the designer — the backend
 *  `customize_ui` tool (via the realtime bridge) or the startup server sync.
 *  Replaces the current overrides wholesale, same semantics as Apply. */
export function applyExternalCustomization(raw: unknown): void {
  const cleaned: UiCustomizationMap = {};
  if (raw && typeof raw === 'object') {
    for (const def of UI_TOKEN_DEFS) {
      const v = (raw as Record<string, unknown>)[def.id];
      if (typeof v === 'string' && isHexColor(v)) cleaned[def.id] = v.trim();
    }
  }
  useUiCustomizationStore.setState({ applied: cleaned, draft: { ...cleaned } });
  paintAppliedToDocument(cleaned);
  persistApplied(cleaned);
}

/** Read current computed default for a token (theme baseline when not overridden). */
export function readComputedToken(cssVar: string, el?: HTMLElement | null): string {
  if (typeof window === 'undefined') return '#000000';
  const target = el ?? document.documentElement;
  const raw = getComputedStyle(target).getPropertyValue(cssVar).trim();
  if (raw.startsWith('#')) return toColorInputValue(raw);
  // rgb(a) → hex
  const m = raw.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (m) {
    const r = Number(m[1]).toString(16).padStart(2, '0');
    const g = Number(m[2]).toString(16).padStart(2, '0');
    const b = Number(m[3]).toString(16).padStart(2, '0');
    return `#${r}${g}${b}`;
  }
  return '#888888';
}

/** Style object for the live preview sandbox (draft overrides only). */
export function draftToPreviewStyle(draft: UiCustomizationMap): CSSProperties {
  const style: Record<string, string> = {};
  for (const def of UI_TOKEN_DEFS) {
    const v = draft[def.id];
    if (v && isHexColor(v)) style[def.cssVar] = v;
  }
  if (draft.primary) {
    style['--dt-sidebar-primary'] = draft.primary;
    style['--dt-sidebar-ring'] = draft.ring || draft.primary;
  }
  return style;
}

export function draftIsDirty(
  draft: UiCustomizationMap = useUiCustomizationStore.getState().draft,
  applied: UiCustomizationMap = useUiCustomizationStore.getState().applied,
): boolean {
  const keys = new Set([...Object.keys(draft), ...Object.keys(applied)]);
  for (const k of keys) {
    if ((draft[k as UiTokenId] || '') !== (applied[k as UiTokenId] || '')) return true;
  }
  return false;
}
