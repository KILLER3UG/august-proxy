/* ── CircuitWaveformViewer ─ Surfer iframe for workspace VCDs ──────────── */
/* Phase 2.3 of the EDA deep-dive plan: embed the Surfer waveform viewer  *
 * (EUPL-1.2, hosted WASM build) as a separate-program iframe in the      *
 * Circuit panel. It loads any workspace .vcd/.fst/.ghw the circuit tools *
 * produced (circuit_export_vcd from XSPICE runs; hdl_simulate later)    *
 * via surfer's official postMessage integration API:                      *
 *   {command: "LoadUrl", url: <raw-file route>}                           *
 * The backend serves the bytes from /api/workbench/files/raw with CORS   *
 * enabled for the surfer origin. No bundling/linking — the viewer stays  *
 * a separate program, which is the license-compliant embedding mode.     */

import { useEffect, useMemo, useRef, useState } from 'react';
import { FileClock, WifiOff } from 'lucide-react';
import { whenReady } from '@/api/client';
import { revealInFolder } from '@/lib/tauri-shell';
import {
  WAVEFORM_EXT,
  artifactsForMessages,
  type CircuitToolEntry,
} from '@/lib/circuit-artifacts';
import type { ChatMessage } from '@/types/chat';

const SURFER_URL = 'https://app.surfer-project.org/';

export interface WaveformArtifact {
  path: string;
  label: string;
  tool: string;
  ts: number;
}

/** Newest-first waveform artifacts (vcd/fst/ghw) from circuit tool results.
 *  `waveFile` / `vcdFile` are RESULT keys — `hdl_simulate`'s arguments are
 *  `{source, top, name}`, so the old block-context read never saw one. */
export function collectWaveformArtifacts(
  messages?: Array<{ tools?: CircuitToolEntry[] | null }> | null,
): WaveformArtifact[] {
  return artifactsForMessages(messages)
    .filter((a) => WAVEFORM_EXT.test(a.path))
    .map((a) => ({ path: a.path, label: a.label, tool: a.tool, ts: a.startedAt }))
    .sort((x, y) => y.ts - x.ts);
}

/** Absolute /files/raw URL for the surfer iframe to fetch (backend base
 *  differs from the webview origin inside Tauri — whenReady resolves it). */
export async function rawFileUrl(path: string, sessionId?: string | null): Promise<string> {
  const base = (await whenReady()) ?? '';
  const qs = new URLSearchParams({ path });
  if (sessionId) qs.set('sessionId', sessionId);
  return `${base}/api/workbench/files/raw?${qs.toString()}`;
}

export function CircuitWaveformViewer({
  messages,
  sessionId,
}: {
  messages?: ChatMessage[] | null;
  sessionId?: string | null;
}) {
  const waves = useMemo(() => collectWaveformArtifacts(messages), [messages]);
  const [selected, setSelected] = useState<string | null>(null);
  const [srcDocReady, setSrcDocReady] = useState(false);
  /** The hosted WASM viewer is a network dependency inside a signed desktop
   *  app that is expected to work offline, and a cross-origin iframe reports
   *  "no network" exactly like it reports "still loading" — an offline machine
   *  showed an empty 240px box under "captures open in the embedded viewer",
   *  which reads as *no data*. `navigator.onLine` is the honest signal here: it
   *  answers "is this machine connected", which is the case that silently
   *  produced a blank panel; it does not claim the far host will answer. */
  const [online, setOnline] = useState(() => navigator.onLine !== false);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const activePath = selected ?? waves[0]?.path ?? null;

  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);

  // Boot the surfer iframe once and LoadUrl the active waveform whenever
  // it changes. The iframe is same-URL always; only the postMessage load
  // differs — no reload flashes between files. The hosted app needs a
  // moment to boot its WASM before it registers the message listener, so
  // re-send LoadUrl a few times — a dropped early message (listener not
  // yet up) is otherwise indistinguishable from a slow load, and repeated
  // commands are ignored by the listener.
  useEffect(() => {
    if (!activePath || !srcDocReady) return;
    let cancelled = false;
    void (async () => {
      const url = await rawFileUrl(activePath, sessionId);
      if (cancelled) return;
      const send = () =>
        iframeRef.current?.contentWindow?.postMessage(
          { command: 'LoadUrl', url },
          SURFER_URL,
        );
      send();
      // Re-send at 2s/5s/10s — cheap, idempotent, covers cold WASM boots.
      for (const delay of [2000, 5000, 10000]) {
        await new Promise((r) => setTimeout(r, delay));
        if (cancelled) return;
        send();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activePath, srcDocReady, sessionId]);

  // Grace period before the first LoadUrl: the WASM build needs a moment
  // to register its message listener.
  useEffect(() => {
    if (srcDocReady) return;
    const t = setTimeout(() => setSrcDocReady(true), 3000);
    return () => clearTimeout(t);
  }, [srcDocReady]);

  return (
    <div className="flex flex-col gap-2 border-b border-border/60 px-3 py-2.5" data-testid="circuit-waveforms">
      <div className="flex items-center gap-2">
        <FileClock className="size-3 shrink-0 text-muted-foreground/70" />
        <span className="shrink-0 text-xs font-semibold text-foreground">Waveforms</span>
      </div>

      {waves.length === 0 ? (
        <p className="px-1 py-3 text-2xs leading-relaxed text-muted-foreground/70">
          No waveform captures yet.
        </p>
      ) : (
        <>
          {waves.length > 1 && (
            <div className="flex flex-col gap-1">
              {waves.slice(0, 4).map((w) => (
                <button
                  key={w.path}
                  type="button"
                  onClick={() => setSelected(w.path)}
                  aria-pressed={(activePath ?? '') === w.path}
                  className={`truncate rounded-md border px-2 py-1 text-left font-mono text-2xs transition ${
                    activePath === w.path
                      ? 'border-primary/50 bg-primary/10 text-foreground'
                      : 'border-border/50 bg-card/50 text-muted-foreground hover:border-primary/30'
                  }`}
                  data-testid={`waveform-file-${w.label}`}
                >
                  {w.label}
                </button>
              ))}
            </div>
          )}
          {!online ? (
            <div
              className="flex h-[240px] flex-col items-center justify-center gap-2 rounded-lg border border-border/50 bg-background px-4 text-center"
              data-testid="waveform-viewer-offline"
            >
              <WifiOff className="size-4 shrink-0 text-muted-foreground/70" />
              <p className="text-2xs leading-relaxed text-muted-foreground">
                This machine is offline and the waveform viewer is a hosted app. The capture
                itself is on disk.
              </p>
              {activePath && (
                <p className="max-w-full truncate font-mono text-2xs text-muted-foreground/80">
                  {activePath}
                </p>
              )}
              {activePath && (
                <button
                  type="button"
                  onClick={() => void revealInFolder(activePath)}
                  className="rounded-md border border-border/50 bg-card/50 px-2 py-1 text-2xs text-foreground transition hover:border-primary/30"
                  data-testid="waveform-reveal"
                >
                  Reveal in folder
                </button>
              )}
            </div>
          ) : (
            <div className="h-[240px] overflow-hidden rounded-lg border border-border/50 bg-background">
              <iframe
                ref={iframeRef}
                src={SURFER_URL}
                title="Surfer waveform viewer"
                className="h-full w-full border-0"
                // Separate-program embed: surfer needs its own origin +
                // scripts. No allow-same-origin into August's assets.
                sandbox="allow-scripts allow-same-origin allow-downloads"
              />
            </div>
          )}
        </>
      )}
    </div>
  );
}
