/* ── FontChooserToast — the font hint above the composer ────────────────
 *
 * The reference (Claude desktop) puts a dismissible one-line card over its
 * composer: "You can change the font of Claude's responses / Hover a font to
 * try it. Click to keep it." with two `Aa` swatches and an ×. August had the
 * setting — General → Preferences → Chat font — and no way to discover it, so
 * the option existed only for someone who already knew to look.
 *
 * "Hover to try" is a promise, so it is wired to the same mechanism the
 * setting uses rather than to a second preview path: `applyPreferenceAttributes`
 * writes `:root[data-chat-font]`, which `styles/base.css` reads. Hovering a
 * swatch therefore changes the real chat typeface for as long as the pointer
 * rests on it, and leaving puts the stored choice back. The swatches are drawn
 * in their own faces by the `.chat-font-*` classes, which share those exact
 * declarations instead of restating the stacks.
 *
 * It shows once. Dismissing — or picking a font, which is a decision and so an
 * answer — is persisted in the preferences store, so it does not come back on
 * the next launch to ask the same question. */

import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  applyPreferenceAttributes,
  usePreferencesStore,
  type ChatFont,
} from '@/lib/preferences';
import { cn } from '@/lib/utils';

const FACES: { id: ChatFont; label: string; swatchClass?: string }[] = [
  { id: 'default', label: 'Default' },
  { id: 'serif', label: 'Serif', swatchClass: 'chat-font-serif' },
  { id: 'mono', label: 'Monospace', swatchClass: 'chat-font-mono' },
];

/** Write the document-level font hook WITHOUT touching the store, so a hover
 *  cannot half-persist a choice the user only meant to look at. */
function previewFont(font: ChatFont): void {
  applyPreferenceAttributes({
    chatFont: font,
    reduceMotion: usePreferencesStore.getState().reduceMotion,
  });
}

function restoreFont(): void {
  const s = usePreferencesStore.getState();
  applyPreferenceAttributes({ chatFont: s.chatFont, reduceMotion: s.reduceMotion });
}

export function FontChooserToast() {
  const chatFont = usePreferencesStore((s) => s.chatFont);
  const dismissed = usePreferencesStore((s) => s.fontHintDismissed);
  const setChatFont = usePreferencesStore((s) => s.setChatFont);
  const dismissFontHint = usePreferencesStore((s) => s.dismissFontHint);

  // A stored choice that is not the default means the question is already
  // answered — from this card or from Settings.
  if (dismissed || chatFont !== 'default') return null;

  return (
    <div
      role="note"
      aria-label="You can change the font of August's responses"
      data-testid="font-chooser-toast"
      className="mb-1.5 flex items-center gap-3 rounded-xl border border-hairline-strong bg-popover/95 px-3 py-2 shadow-lg"
    >
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium text-foreground">
          You can change the font of August&rsquo;s responses
        </p>
        <p className="text-2xs text-muted-foreground">
          Hover a font to try it. Click to keep it.
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1.5" role="group" aria-label="Chat fonts">
        {FACES.map((face) => (
          <Button
            key={face.id}
            type="button"
            variant="outline"
            size="sm"
            aria-pressed={chatFont === face.id}
            aria-label={`Try the ${face.label.toLowerCase()} font`}
            className={cn(
              'h-8 min-w-10 px-2 text-sm',
              face.swatchClass,
              chatFont === face.id && 'border-primary text-primary',
            )}
            onMouseEnter={() => previewFont(face.id)}
            onMouseLeave={restoreFont}
            onFocus={() => previewFont(face.id)}
            onBlur={restoreFont}
            onClick={() => {
              setChatFont(face.id);
              dismissFontHint();
            }}
          >
            Aa
          </Button>
        ))}
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label="Dismiss the font hint"
        className="size-7 shrink-0 text-muted-foreground"
        onClick={() => {
          restoreFont();
          dismissFontHint();
        }}
      >
        <X className="size-3.5" />
      </Button>
    </div>
  );
}
