/* ── BotCreateModal — Part 27 F2: New Bot with an avatar picker ───────── */
/* A named teammate with its own memory, skills, and chat. The face grid is
   the existing deterministic blob-avatar: each cell is a preset salt; "Auto"
   leaves the salt empty so the face follows the name. Randomize = new salt;
   Lock/unlock = fixed vs auto. No backend change — uiMeta.avatar already
   stores the salt. */

import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, Lock, LockOpen, Shuffle, X } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { botAvatarSvg } from '@/lib/bot-avatar';
import { createBot } from '@/api/api-client';
import { Backdrop } from '@/components/overlays/Backdrop';

/** Preset salts → a stable grid of distinct faces (index is the pick key). */
const FACE_PRESETS = ['', 'a1', 'b2', 'c3', 'd4', 'e5', 'f6', 'g7', 'h8', 'i9', 'j0', 'k5'];

function FacePreview({ name, salt, size = 56 }: { name: string; salt: string; size?: number }) {
  const html = botAvatarSvg(name || 'bot', salt).replace(/width="64" height="64"/, '');
  return (
    <span
      className="inline-block overflow-hidden rounded-xl ring-1 ring-white/10"
      style={{ width: size, height: size }}
      aria-hidden
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

export function BotCreateModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [salt, setSalt] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [model, setModel] = useState('');
  const [role, setRole] = useState('');

  const locked = salt !== '';
  const previewName = name.trim() || 'new-bot';

  const create = useMutation({
    mutationFn: () =>
      createBot({
        name: name.trim(),
        title: title.trim() || name.trim(),
        description: description.trim(),
        role: role.trim() || undefined,
        model: model.trim() || undefined,
      }),
    onSuccess: async (bot) => {
      // Persist the chosen face (salt) onto uiMeta right after birth.
      if (salt) {
        try {
          const { updateBotUiMeta } = await import('@/api/api-client');
          await updateBotUiMeta(bot.id, { avatar: salt });
        } catch {
          /* face stays auto — non-fatal */
        }
      }
      toast.success(`Bot "${title.trim() || name.trim()}" created`);
      void qc.invalidateQueries({ queryKey: ['bots'] });
      void qc.invalidateQueries({ queryKey: ['bots', 'chats'] });
      onClose();
    },
    onError: (e) => toast.error('Could not create Bot', { description: String(e) }),
  });

  const canCreate = useMemo(() => /^[a-z0-9][a-z0-9_-]{0,31}$/i.test(name.trim()), [name]);

  return (
    <Backdrop onClose={onClose} className="z-[60]">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="New Bot"
        className="relative w-[min(94vw,460px)] rounded-2xl border border-border/70 bg-card p-5 shadow-2xl"
        data-testid="bot-create-modal"
      >
        <div className="mb-1 flex items-start justify-between gap-3">
          <h2 className="text-[15px] font-semibold text-foreground">New Bot</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-muted-foreground hover:bg-white/5 hover:text-foreground"
            aria-label="Close"
          >
            <X className="size-4" />
          </button>
        </div>
        <p className="mb-4 text-[12px] leading-relaxed text-muted-foreground">
          A named teammate with its own memory, skills, and chat. It can message your other agents.
        </p>

        {/* Face preview + picker */}
        <div className="mb-2 flex flex-col items-center gap-2">
          <FacePreview name={previewName} salt={salt} size={60} />
          <div className="grid grid-cols-6 gap-1.5" role="radiogroup" aria-label="Avatar face">
            {FACE_PRESETS.map((preset, i) => (
              <button
                key={preset || 'auto'}
                type="button"
                role="radio"
                aria-checked={salt === preset}
                onClick={() => setSalt(preset)}
                title={i === 0 ? 'Auto — face follows the name' : `Face ${i}`}
                className={cn(
                  'rounded-lg p-0.5 transition',
                  salt === preset ? 'ring-2 ring-primary' : 'hover:bg-white/5',
                )}
              >
                {i === 0 ? (
                  <span className="flex size-8 items-center justify-center text-[9px] text-muted-foreground">
                    Auto
                  </span>
                ) : (
                  <FacePreview name={previewName} salt={preset} size={32} />
                )}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
            <button
              type="button"
              onClick={() => setSalt(Math.random().toString(36).slice(2, 8))}
              className="inline-flex items-center gap-1 hover:text-foreground"
            >
              <Shuffle className="size-3" /> Randomize
            </button>
            <span className="inline-flex items-center gap-1" title={locked ? 'Face is fixed' : 'Face follows the name'}>
              {locked ? <Lock className="size-3" /> : <LockOpen className="size-3" />}
              {locked ? 'Locked face' : 'Face follows the name'}
            </span>
          </div>
        </div>

        <div className="space-y-2.5">
          <label className="block">
            <span className="mb-1 block text-[11px] font-medium text-foreground/80">Name</span>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="inbox-triage"
              className="w-full rounded-lg border border-border/60 bg-background/60 px-2.5 py-1.5 text-sm outline-none focus:border-primary/50"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[11px] font-medium text-foreground/80">Title</span>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Inbox Triage"
              className="w-full rounded-lg border border-border/60 bg-background/60 px-2.5 py-1.5 text-sm outline-none focus:border-primary/50"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[11px] font-medium text-foreground/80">Description</span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What should this Bot help with?"
              rows={2}
              className="w-full resize-none rounded-lg border border-border/60 bg-background/60 px-2.5 py-1.5 text-sm outline-none focus:border-primary/50"
            />
          </label>

          <button
            type="button"
            onClick={() => setAdvanced((v) => !v)}
            className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
          >
            {advanced ? <Check className="size-3" /> : null} Advanced
          </button>
          {advanced && (
            <div className="grid grid-cols-2 gap-2">
              <input
                value={role}
                onChange={(e) => setRole(e.target.value)}
                placeholder="role (e.g. researcher)"
                className="rounded-lg border border-border/60 bg-background/60 px-2.5 py-1.5 text-xs outline-none focus:border-primary/50"
              />
              <input
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="model override (optional)"
                className="rounded-lg border border-border/60 bg-background/60 px-2.5 py-1.5 text-xs outline-none focus:border-primary/50"
              />
            </div>
          )}
        </div>

        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-3 py-1.5 text-[13px] text-muted-foreground hover:text-foreground"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!canCreate || create.isPending}
            onClick={() => create.mutate()}
            className="rounded-lg bg-primary px-3 py-1.5 text-[13px] font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-40"
            data-testid="bot-create-submit"
          >
            {create.isPending ? 'Creating…' : 'Create Bot'}
          </button>
        </div>
      </div>
    </Backdrop>
  );
}
