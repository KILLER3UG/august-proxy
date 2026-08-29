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
import { FileClock } from 'lucide-react';
import { whenReady } from '@/api/client';
import type { ChatMessage } from '@/types/chat';

const SURFER_URL = 'https://app.surfer-project.org/';
const WAVEFORM_EXT = /\.(vcd|fst|ghw)$/i;
// The whole gated /circuit family — circuit_*, firmware_*, hdl_*, vcd_parse,
// fpga_compile, kicad_checks/render — can leave waveform artifacts.
const CIRCUIT_TOOLS =
  /^(circuit_|firmware_|hdl_|vcd_parse|fpga_compile|kicad_)/i;

export interface WaveformArtifact {
  path: string;
  label: string;
  tool: string;
  ts: number;
}

/** Newest-first waveform artifacts (vcd/fst/ghw) from circuit tool results. */
export function collectWaveformArtifacts(
  messages?: ChatMessage[] | null,
): WaveformArtifact[] {
  if (!messages) return [];
  const seen = new Set<string>();
  const out: WaveformArtifact[] = [];
  for (const message of messages) {
    // Block-level context JSON carries the artifact path as soon as the
    // tool returns (vcdFile / waveFile / path keys) — no need to parse the
    // full result.
    for (const block of message.blocks ?? []) {
      if (block.type !== 'toolCall' || !block.tool) continue;
      const name = block.tool.name || '';
      if (!CIRCUIT_TOOLS.test(name)) continue;
      let path: string | null = null;
      try {
        const parsed = JSON.parse(block.tool.context || '{}') as Record<string, unknown>;
        for (const key of ['vcdFile', 'waveFile', 'path', 'filePath', 'savedTo']) {
          const v = parsed[key];
          if (typeof v === 'string' && v.length > 0 && WAVEFORM_EXT.test(v)) {
            path = v;
            break;
          }
        }
      } catch {
        /* context not JSON */
      }
      if (!path) continue;
      const key = path.replace(/\\/g, '/');
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        path,
        label: key.split('/').pop() || key,
        tool: name,
        ts: block.tool.startedAt ?? 0,
      });
    }
  }
  return out.sort((a, b) => b.ts - a.ts);
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
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const activePath = selected ?? waves[0]?.path ?? null;

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
        <FileClock className="size-3.5 shrink-0 text-muted-foreground/70" />
        <span className="shrink-0 text-xs font-semibold text-foreground">Waveforms</span>
        <span className="truncate text-[10px] text-muted-foreground">
          Digital captures open in the embedded waveform viewer.
        </span>
      </div>

      {waves.length === 0 ? (
        <p className="px-1 py-3 text-[11px] leading-relaxed text-muted-foreground/70">
          No waveform captures yet — circuit_export_vcd writes .vcd files that
          render here with full pan/zoom/cursors.
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
                  className={`truncate rounded-md border px-2 py-1 text-left font-mono text-[10px] transition ${
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
        </>
      )}
    </div>
  );
}
