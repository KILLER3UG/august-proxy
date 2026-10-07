/* ── useSettingsFieldLink — /settings?tab=X&field=Y control targeting ── */
/* A field deep link names one control inside a settings section. Controls
 * carry no ids of their own — sections render through SettingsCard /
 * SettingsToggle / WorkspaceField — so the target is found by its VISIBLE
 * label or description, matched with the same tokenized AND rule the settings
 * search uses (WorkspaceShell `hintMatch`).
 *
 * A miss is a normal outcome, not an error: registry `settingHints` are
 * written for search ("Theme light dark system") and `settingAliases` never
 * render at all, so nothing here may block a tab from opening or report a
 * failure. Nothing here adds a keyboard layer either — no keys are handled, so
 * Escape still closes exactly one surface (BackdropEscape); the one focus move
 * is to the control the link already named. */

import { useEffect, type RefObject } from 'react';

/** The flash itself (see `.settings-field-flash` in styles/settings.css). */
const FLASH_CLASS = 'settings-field-flash';
/** Slightly longer than the flash reads as intentional; cleared by the timer. */
const FLASH_MS = 1600;
/** Sections are lazy + Suspense-wrapped (SettingsPage.tsx), so the control is
 *  usually not in the DOM the moment this effect runs. Re-scan on an interval
 *  rather than an observer — the work is one subtree walk per tick. Starting
 *  on the first tick (not inline) is also what lets the `?tab=` → path rewrite
 *  settle, so a deep link cannot flash the section it is leaving. */
const POLL_MS = 150;
const GIVE_UP_MS = 5000;

/** Rows are judged as label-or-description text; anything carrying a long
 *  transcript (a log line, a provider model list) is content, not a control,
 *  and flashing half a panel names nothing. */
const MAX_LABEL_CHARS = 320;
/** How much extra text a row may carry beyond the matched caption before the
 *  climb stops — keeps the highlight on one row instead of its whole card. */
const MAX_ROW_EXTRA_CHARS = 160;

/** Caption shapes a settings control actually uses (SettingsCard title div,
 *  SettingsToggle label span + description p, WorkspaceField label). */
const LABEL_SELECTOR = 'div,p,span,label,h1,h2,h3';
const CONTROL_SELECTOR =
  'button,input,select,textarea,[role="switch"],[role="slider"],[role="combobox"],[role="checkbox"],[role="radio"]';

/** Same tokenization as the settings search (`WorkspaceShell` builds it the
 *  same way from the query string). */
function fieldTokens(field: string): string[] {
  return field.toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * Score one candidate caption: all tokens present wins outright (and beats any
 * partial, since a partial scores below `total`). When the registry hint is
 * written for search and differs from what the page actually says —
 * "Auto-recall memories each session" renders as "Auto-inject relevant
 * memories each turn" — a majority of tokens still identifies the control a
 * human scanning the section would land on. A single token gets no partial
 * credit: one word either appears or it does not.
 */
function scoreCaption(caption: string, tokens: string[]): number {
  const total = tokens.length;
  if (tokens.every((t) => caption.includes(t))) return total * 2;
  if (total < 2) return 0;
  const matched = tokens.reduce((n, t) => n + (caption.includes(t) ? 1 : 0), 0);
  return matched >= Math.ceil(total / 2) ? matched : 0;
}

/** Widen a caption hit to the row that also holds the control, so the flash
 *  frames the switch or input and not only its label. */
function widenToRow(hit: HTMLElement, scope: HTMLElement): HTMLElement {
  const hitLength = (hit.textContent ?? '').trim().length;
  let node: HTMLElement = hit;
  for (let depth = 0; depth < 3; depth += 1) {
    const parent = node.parentElement;
    if (!parent || parent === scope) break;
    if ((parent.textContent ?? '').trim().length > hitLength + MAX_ROW_EXTRA_CHARS) break;
    node = parent;
    if (node.querySelector(CONTROL_SELECTOR)) return node;
  }
  return hit;
}

/** The control `field` names inside `scope`, or null when nothing claims it. */
export function findFieldTarget(scope: HTMLElement, field: string): HTMLElement | null {
  const tokens = fieldTokens(field);
  if (tokens.length === 0) return null;

  let best: HTMLElement | null = null;
  let bestScore = 0;
  let bestLength = Number.POSITIVE_INFINITY;

  for (const el of Array.from(scope.querySelectorAll<HTMLElement>(LABEL_SELECTOR))) {
    const caption = (el.textContent ?? '').trim().toLowerCase();
    if (!caption || caption.length > MAX_LABEL_CHARS) continue;
    const score = scoreCaption(caption, tokens);
    if (score === 0) continue;
    // Highest score wins; the shortest caption breaks ties, so a label beats
    // the card or section that merely contains it.
    if (score > bestScore || (score === bestScore && caption.length < bestLength)) {
      best = el;
      bestScore = score;
      bestLength = caption.length;
    }
  }

  return best ? widenToRow(best, scope) : null;
}

/**
 * Scroll to + flash the control named by `field` once the section renders.
 * `sectionId` re-arms the link: the same `?field=` on a different tab is a
 * different target, and `/settings?tab=X&field=Y` lands on the path form with
 * the field already set and only the section still moving.
 */
export function useSettingsFieldLink(
  scopeRef: RefObject<HTMLElement | null>,
  field: string,
  sectionId: string,
): void {
  useEffect(() => {
    const target = field.trim();
    if (!target) return;

    let waitedMs = 0;
    let undo: (() => void) | null = null;
    let flashTimer = 0;
    let pollTimer = 0;

    const attempt = () => {
      const scope = scopeRef.current;
      const hit = scope ? findFieldTarget(scope, target) : null;
      if (!hit) {
        waitedMs += POLL_MS;
        if (waitedMs >= GIVE_UP_MS) window.clearInterval(pollTimer);
        return;
      }
      window.clearInterval(pollTimer);
      hit.scrollIntoView({ block: 'center', behavior: 'smooth' });
      // Then move focus INTO the control. A wash alone is visual-only: a
      // keyboard or screen-reader user following /settings?tab=X&field=Y would
      // land on a section and be told nothing about which control was meant.
      hit.querySelector<HTMLElement>(CONTROL_SELECTOR)?.focus({ preventScroll: true });
      hit.classList.add(FLASH_CLASS);
      // Which link fired — the handle a test or e2e spec asserts on.
      hit.dataset.fieldLink = `${sectionId}:${target}`;
      const clear = () => {
        hit.classList.remove(FLASH_CLASS);
        delete hit.dataset.fieldLink;
      };
      // The wash clears itself: a deep link that left a permanent highlight
      // would read as a selection state the control does not have.
      undo = clear;
      flashTimer = window.setTimeout(clear, FLASH_MS);
    };

    pollTimer = window.setInterval(attempt, POLL_MS);

    return () => {
      window.clearInterval(pollTimer);
      window.clearTimeout(flashTimer);
      undo?.();
    };
  }, [scopeRef, field, sectionId]);
}
