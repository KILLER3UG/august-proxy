/* ── RightDrawerBrowserSection ─ live headless browser view ──────── */
/* Renders the most recent screenshot captured during a headless browser  */
/* tool run, with a cursor overlay on the element the action targeted and  */
/* a rolling action log. Fed by the browserAction SSE event →            */
/* lib/browser-store atom.                                                */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '@nanostores/react';
import { MousePointerClick, Globe, Loader2, Inbox, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { $browserDrawer, clearBrowserDrawer, screenshotUrl } from '@/lib/browser-store';

/** Human label + icon hint for each browser tool name. */
function actionLabel(name: string): { verb: string; detail?: string } {
  switch (name) {
    case 'browser_open':
      return { verb: 'Opened' };
    case 'browser_click':
      return { verb: 'Clicked' };
    case 'browser_type':
      return { verb: 'Typed' };
    case 'browser_select':
      return { verb: 'Selected' };
    case 'browser_scroll':
      return { verb: 'Scrolled' };
    case 'browser_screenshot':
      return { verb: 'Captured' };
    case 'browser_evaluate':
      return { verb: 'Evaluated' };
    case 'browser_get_content':
      return { verb: 'Read content' };
    case 'browser_wait':
      return { verb: 'Waited' };
    default:
      return { verb: name };
  }
}

function clock(ts: number): string {
  try {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return '';
  }
}

export function RightDrawerBrowserSection() {
  const state = useStore($browserDrawer);
  const { latest, log, title, url } = state;

  const imgWrapRef = useRef<HTMLDivElement | null>(null);
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null);

  // Reset the known screenshot dimensions when the screenshot path changes
  // so the overlay scaling recomputes against the new image.
  const shotPath = latest?.screenshot?.path ?? null;
  useEffect(() => {
    setNaturalSize(null);
  }, [shotPath]);

  // The screenshot is captured at the viewport size (1280×720 by default).
  // The <img> is displayed responsively, so we scale the target bbox from
  // page coordinates → displayed coordinates using the natural/draw ratio.
  const scale = useMemo(() => {
    if (!naturalSize || !naturalSize.w) return null;
    const displayed = imgWrapRef.current?.querySelector('img')?.getBoundingClientRect();
    if (!displayed || !displayed.width) return null;
    return displayed.width / naturalSize.w;
  }, [naturalSize]);

  const target = latest?.target ?? null;
  const cursorPos =
    target && scale
      ? { left: target.x * scale, top: target.y * scale }
      : null;

  const src = screenshotUrl(shotPath);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header: page title + URL */}
      <div className="shrink-0 border-b border-border/50 px-3 py-2">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground/90">
          <Globe className="size-3 text-muted-foreground/70 shrink-0" />
          <span className="truncate">{title || 'No page loaded'}</span>
        </div>
        {url && (
          <div className="mt-0.5 truncate text-[10px] text-muted-foreground/70">{url}</div>
        )}
      </div>

      {/* Live screenshot + cursor overlay */}
      <div className="relative min-h-0 flex-1 overflow-hidden bg-black/40">
        <div ref={imgWrapRef} className="relative flex h-full min-h-0 items-center justify-center">
          {src ? (
            <>
              <img
                src={src}
                alt="Browser screenshot"
                draggable={false}
                onLoad={(e) => {
                  const img = e.currentTarget;
                  setNaturalSize({ w: img.naturalWidth, h: img.naturalHeight });
                }}
                className="max-h-full max-w-full object-contain select-none"
              />
              {/* Element highlight box */}
              {target && scale && (
                <div
                  className="pointer-events-none absolute border-2 border-primary/80 bg-primary/15 rounded-sm"
                  style={{
                    left: (target.x - target.width / 2) * scale,
                    top: (target.y - target.height / 2) * scale,
                    width: target.width * scale,
                    height: target.height * scale,
                  }}
                />
              )}
              {/* Cursor */}
              {cursorPos && (
                <div
                  className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-1/2"
                  style={{ left: cursorPos.left, top: cursorPos.top }}
                >
                  <MousePointerClick className="size-5 text-primary drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]" />
                </div>
              )}
            </>
          ) : (
            <div className="flex flex-col items-center text-center text-muted-foreground/60 px-4">
              {latest ? (
                <>
                  <Loader2 className="size-5 animate-spin" />
                  <div className="mt-2 text-[11px]">Capturing screenshot…</div>
                </>
              ) : (
                <>
                  <Inbox className="size-5" />
                  <div className="mt-2 text-[11px]">No browser activity yet</div>
                  <div className="mt-0.5 text-[10px] text-muted-foreground/50">
                    Actions appear here when the model uses browser tools
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        {/* Last-action badge */}
        {latest && (
          <div className="absolute left-1.5 bottom-1.5 right-1.5 z-10 flex items-center gap-1.5 rounded-md bg-black/55 px-2 py-1 backdrop-blur-sm">
            <ActionDot name={latest.name} />
            <span className="text-[10px] font-medium text-foreground/90">
              {actionLabel(latest.name).verb}
            </span>
            {latest.typed && (
              <span className="truncate text-[10px] text-muted-foreground/80">
                "{latest.typed.slice(0, 24)}{latest.typed.length > 24 ? '…' : ''}"
              </span>
            )}
            <span className="ml-auto text-[10px] text-muted-foreground/60">{clock(latest.ts)}</span>
          </div>
        )}
      </div>

      {/* Action log */}
      <div className="shrink-0 border-t border-border/50">
        <div className="flex items-center justify-between px-3 py-1.5">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
            Actions
          </span>
          {log.length > 0 && (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={clearBrowserDrawer}
              aria-label="Clear browser log"
              title="Clear"
            >
              <RotateCcw className="size-3" />
            </Button>
          )}
        </div>
        <div className="max-h-[30%] overflow-y-auto px-2 pb-2">
          {log.length === 0 ? (
            <div className="px-1 py-2 text-[10px] text-muted-foreground/50">
              No actions recorded
            </div>
          ) : (
            <ul className="space-y-0.5">
              {log.map((a) => (
                <li
                  key={a.id + a.ts}
                  className="flex items-center gap-1.5 rounded px-1.5 py-1 text-[10.5px] hover:bg-white/5"
                >
                  <ActionDot name={a.name} />
                  <span className="font-medium text-foreground/85">{actionLabel(a.name).verb}</span>
                  {a.typed && (
                    <span className="truncate text-muted-foreground/70">
                      "{a.typed.slice(0, 18)}{a.typed.length > 18 ? '…' : ''}"
                    </span>
                  )}
                  {a.selected && (
                    <span className="truncate text-muted-foreground/70">{a.selected}</span>
                  )}
                  {a.scrolled && (
                    <span className="text-muted-foreground/70">↓ {a.scrolled}</span>
                  )}
                  <span className="ml-auto shrink-0 text-muted-foreground/50">{clock(a.ts)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

/** Small colored dot indicating the action type. */
function ActionDot({ name }: { name: string }) {
  const color =
    name === 'browser_click'
      ? 'bg-primary'
      : name === 'browser_type'
        ? 'bg-blue-400'
        : name === 'browser_open'
          ? 'bg-emerald-400'
          : 'bg-muted-foreground/50';
  return <span className={cn('size-1.5 shrink-0 rounded-full', color)} />;
}
