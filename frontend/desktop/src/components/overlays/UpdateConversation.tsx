/* ── UpdateConversation — first-launch-after-update celebration ─────── */
/* Detects a version bump (current app version vs. the last one seen in */
/* localStorage), and on the first launch of a NEW build plays the same */
/* animated conversation, its bullets fed from the real changelog via   */
/* /api/whats-new. Shows once per version; skippable; never blocks the */
/* already-loaded app (it mounts inside the gate's children).          */

import { useEffect, useMemo, useState } from 'react';
import { api } from '@/api/client';
import { isTauri } from '@/lib/tauri-detect';
import { ConversationStage } from '@/components/overlays/ConversationStage';
import { buildUpdateScript } from '@/lib/conversations';
import type { WhatsNewResponse } from '@/components/overlays/WhatsNewModal';

const SEEN_KEY = 'august.lastSeenVersion';

/** Turn changelog data into ≤5 short, human bullets. */
function bulletsFromWhatsNew(data: WhatsNewResponse | null): string[] {
  const out: string[] = [];
  const rel = data?.releases?.[0] ?? data?.changelog?.[0];
  if (rel?.body) {
    for (const raw of rel.body.split('\n')) {
      const line = raw.replace(/^[-*•]\s*/, '').replace(/^#+\s*/, '').trim();
      if (line && !/^https?:/i.test(line)) out.push(line.replace(/\*\*/g, ''));
      if (out.length >= 5) break;
    }
  }
  if (out.length < 3 && data?.commits?.length) {
    for (const c of data.commits) {
      const msg = (c.message || '').replace(/^\w+\([^)]*\):\s*/, '').replace(/\.$/, '').trim();
      if (msg && !out.some((o) => o.toLowerCase() === msg.toLowerCase())) out.push(msg);
      if (out.length >= 5) break;
    }
  }
  return out.slice(0, 5);
}

export function UpdateConversation() {
  const [version, setVersion] = useState<string | null>(null);
  const [bullets, setBullets] = useState<string[]>([]);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!isTauri) return;
    let cancelled = false;
    void (async () => {
      let cur = '';
      try {
        const { getVersion } = await import('@tauri-apps/api/app');
        cur = await getVersion();
      } catch {
        return;
      }
      if (cancelled || !cur) return;
      let stored: string | null = null;
      try {
        stored = localStorage.getItem(SEEN_KEY);
        localStorage.setItem(SEEN_KEY, cur);
      } catch {
        /* storage blocked — skip the celebration */
        return;
      }
      // First-ever run (no prior version) → don't celebrate, just record.
      if (!stored || stored === cur) return;
      // A real update launch → fetch the changelog and show once.
      try {
        const data = await api.get<WhatsNewResponse>('/api/whats-new?hours=168');
        if (!cancelled) {
          setBullets(bulletsFromWhatsNew(data));
          setVersion(cur);
        }
      } catch {
        if (!cancelled) {
          setBullets([]);
          setVersion(cur);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const script = useMemo(
    () => (version ? buildUpdateScript(version, bullets) : null),
    [version, bullets],
  );

  if (!version || !script || dismissed) return null;

  return (
    <div className="pointer-events-none fixed inset-0 z-[150] flex items-center justify-center p-6">
      <div className="pointer-events-auto">
        <ConversationStage
          script={script}
          ready
          onDone={() => setDismissed(true)}
          pillText={`updated · v${version}`}
          pillState="ok"
          composerHint="Continue to the app…"
        />
      </div>
    </div>
  );
}
