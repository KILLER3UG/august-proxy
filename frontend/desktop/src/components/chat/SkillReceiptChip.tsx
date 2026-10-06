import { useMemo } from 'react';
import { Sparkles } from 'lucide-react';
import { SettingsTooltip } from '@/components/settings/SettingsTooltip';
import type { ChatMessage } from '@/types/chat';

/**
 * SkillReceiptChip — "this turn wrote a SKILL.md."
 *
 * A turn receipt, like SavePointChip beside it: it reports what the transcript
 * itself did. It is NOT the autonomy notice. That one is `SkillEvolvedChip`
 * above the composer, driven by the backend's `skill-evolved` event and the
 * auto-apply ledger, and it announces a change the machine made on its own,
 * with no turn to point at.
 *
 * This component cannot read that event, because the write it reports never
 * emits one: a model editing a skill through `write_file` goes through the tool
 * path, and the skills router emits nothing at all. The honest signal is the
 * turn's own tool record — a write/edit-class call whose resolved path is a
 * skill file (`skills/<name>/SKILL.md`, project `.aug/skills/…`, or the bundled
 * dir). Silence by default: a turn that touched no skill file renders nothing.
 */
export function SkillReceiptChip({ tools }: { tools?: ChatMessage['tools'] }) {
  const evolved = useMemo(() => {
    const names = new Set<string>();
    for (const tool of tools ?? []) {
      const writeClass =
        /write|edit|patch|str_replace|create|delete|remove/i.test(tool.name);
      if (!writeClass) continue;
      // The path lives in the tool's JSON args context (extractFilename's
      // source); match it directly here to keep this component standalone.
      let path: string | null = null;
      try {
        const parsed = JSON.parse(tool.context ?? '') as Record<string, unknown>;
        for (const key of ['filePath', 'file_path', 'path', 'filename', 'file', 'filepath']) {
          const v = parsed?.[key];
          if (typeof v === 'string' && v.length > 0) {
            path = v;
            break;
          }
        }
      } catch {
        /* not JSON */
      }
      if (!path) continue;
      const normalized = path.replace(/\\/g, '/');
      if (/skills\//i.test(normalized) && /SKILL\.md$/i.test(normalized)) {
        const m = normalized.match(/skills\/(?:[^/]+\/)?([^/]+)\/SKILL\.md$/i);
        names.add(m?.[1] ?? normalized);
      }
    }
    return [...names];
  }, [tools]);

  if (evolved.length === 0) return null;

  const label =
    evolved.length === 1 ? `Skill updated: ${evolved[0]}` : `${evolved.length} skills updated`;

  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-2xs text-foreground/90"
      data-testid="skill-receipt-chip"
    >
      <Sparkles className="size-2.5 shrink-0 text-primary" aria-hidden />
      <SettingsTooltip
        side="top"
        content={
          <div className="text-left">
            {evolved.length === 1
              ? `${evolved[0]}'s SKILL.md was written by this turn — the next turn reads the new version.`
              : evolved.map((n) => <div key={n}>{n}</div>)}
          </div>
        }
        trigger={(tp) => (
          <span {...tp} className="cursor-help">
            {label}
          </span>
        )}
      />
    </span>
  );
}