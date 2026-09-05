/* ── BotCreateModal — Part 27 F2: New Bot with an avatar picker ───────── */
/* A named teammate with its own memory, skills, and chat. The face picker
   ships the three-tab layout called for in the plan: Shapes (the existing
   deterministic blob-avatar presets), Shuffle (random salt until you settle),
   Upload (a local file → backend-stored SVG — falls back to "no upload yet"
   when the backend route is absent so the modal still works in dev). The
   Lock toggle freezes the face independent of name edits. `uiMeta.avatar` is
   stored as `{salt, locked, source}` so we can distinguish a chosen shape
   from a name-derived one and avoid the silent re-hash on rename. */

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Check,
  Lock,
  LockOpen,
  Shuffle,
  Upload,
  Shapes,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { botAvatarSvg } from '@/lib/bot-avatar';
import { api } from '@/api/client';
import {
  createBot,
  updateBotUiMeta,
  type Bot,
  type BotAvatar,
} from '@/api/api-client/bots';
import { Backdrop } from '@/components/overlays/Backdrop';

/** Preset salts → a stable grid of distinct faces (index is the pick key). */
const FACE_PRESETS = ['', 'a1', 'b2', 'c3', 'd4', 'e5', 'f6', 'g7', 'h8', 'i9', 'j0', 'k5'];

type AvatarTab = 'shapes' | 'shuffle' | 'upload';
type AvatarSource = 'shape' | 'shuffle' | 'upload' | 'auto';

function FacePreview({
  name,
  salt,
  size = 56,
  className,
}: {
  name: string;
  salt: string;
  size?: number;
  className?: string;
}) {
  const html = botAvatarSvg(name || 'bot', salt).replace(/width="64" height="64"/, '');
  return (
    <span
      className={cn(
        'inline-block overflow-hidden rounded-xl ring-1 ring-white/10',
        className,
      )}
      style={{ width: size, height: size }}
      aria-hidden
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

interface SkillSummary {
  name: string;
  description: string;
}

interface WorkspaceInfo {
  path: string;
  name: string;
  hasMemory?: boolean;
  hasSkills?: boolean;
}

export function BotCreateModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  /** Part 27 F2: the modal accepts an `onCreate` callback so the parent can
   *  react to a successful create (auto-open profile, etc.). */
  onCreated?: (bot: Bot) => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [salt, setSalt] = useState('');
  const [locked, setLocked] = useState(false);
  const [avatarTab, setAvatarTab] = useState<AvatarTab>('shapes');
  const [advanced, setAdvanced] = useState(false);
  const [model, setModel] = useState('');
  const [role, setRole] = useState('');
  const [skills, setSkills] = useState<string[]>([]);
  const [memoryScope, setMemoryScope] = useState<'global' | 'project' | 'none'>('global');
  const [workspacePath, setWorkspacePath] = useState('');
  const [uploadStatus, setUploadStatus] = useState<'idle' | 'uploading' | 'ok' | 'unsupported'>('idle');
  const [uploadFileName, setUploadFileName] = useState('');

  const previewName = name.trim() || 'new-bot';
  // Auto = salt empty AND not locked → face follows the name.
  const isAutoFace = salt === '' && !locked;
  // Source describes the origin for persistence + the "Face follows the name"
  // hint (unlocked avatars re-derive from name edits).
  const avatarSource: AvatarSource = isAutoFace
    ? 'auto'
    : avatarTab === 'shapes'
      ? 'shape'
      : avatarTab === 'shuffle'
        ? 'shuffle'
        : avatarTab === 'upload'
          ? 'upload'
          : 'auto';

  const skillsQuery = useQuery({
    queryKey: ['skills-list', '', ''],
    queryFn: () => {
      const params = new URLSearchParams();
      const qs = params.toString();
      return api.get<{ skills: SkillSummary[]; total: number }>(
        `/api/skills${qs ? `?${qs}` : ''}`,
      );
    },
    staleTime: 30_000,
  });
  const workspacesQuery = useQuery({
    queryKey: ['memory-workspaces'],
    queryFn: () => api.get<{ workspaces: WorkspaceInfo[] }>('/api/august/memory/workspaces'),
    staleTime: 30_000,
  });

  const create = useMutation({
    mutationFn: () =>
      createBot({
        name: name.trim(),
        title: title.trim() || name.trim(),
        description: description.trim(),
        role: role.trim() || undefined,
        model: model.trim() || undefined,
        skills: skills.length ? skills : undefined,
        memoryScope,
        workspacePath: memoryScope === 'project' ? workspacePath : undefined,
      }),
    onSuccess: async (bot) => {
      // Persist the chosen face (salt + lock + source) onto uiMeta right
      // after birth. The `avatar` field accepts a structured descriptor
      // ({salt, locked, source}) so reloads can tell a chosen face from a
      // name-derived one and avoid the silent re-hash.
      if (salt || locked) {
        const avatar: BotAvatar = { salt, locked, source: avatarSource };
        try {
          await updateBotUiMeta(bot.id, { avatar });
        } catch {
          /* face stays auto — non-fatal */
        }
      }
      toast.success(`Bot "${title.trim() || name.trim()}" created`);
      void qc.invalidateQueries({ queryKey: ['bots'] });
      void qc.invalidateQueries({ queryKey: ['bots', 'chats'] });
      onCreated?.(bot);
      onClose();
    },
    onError: (e) => toast.error('Could not create Bot', { description: String(e) }),
  });

  const canCreate = useMemo(() => /^[a-z0-9][a-z0-9_-]{0,31}$/i.test(name.trim()), [name]);

  const toggleSkill = (skillName: string) => {
    setSkills((cur) =>
      cur.includes(skillName) ? cur.filter((s) => s !== skillName) : [...cur, skillName],
    );
  };

  /** Best-effort upload — the backend may not have a face-upload route yet,
   *  in which case we mark the slot as "unsupported" so the user sees the
   *  truthful state. The shape blob remains the source of truth. */
  const handleUpload = async (file: File) => {
    setUploadStatus('uploading');
    setUploadFileName(file.name);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch('/api/agents/bots/avatar-upload', { method: 'POST', body: form });
      if (res.status === 404) {
        setUploadStatus('unsupported');
        return;
      }
      if (!res.ok) {
        setUploadStatus('unsupported');
        return;
      }
      const data = (await res.json()) as { salt?: string };
      if (data.salt) {
        setSalt(data.salt);
        setLocked(true);
        setUploadStatus('ok');
      } else {
        setUploadStatus('unsupported');
      }
    } catch {
      setUploadStatus('unsupported');
    }
  };

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

        {/* Face preview + picker — three tabs: Shapes · Shuffle · Upload */}
        <div className="mb-2 flex flex-col items-center gap-2">
          <FacePreview name={previewName} salt={salt} size={60} />

          <div
            className="flex w-full max-w-[320px] gap-1 rounded-lg border border-border/40 bg-muted/30 p-0.5"
            role="tablist"
            aria-label="Avatar source"
          >
            {(
              [
                { key: 'shapes', label: 'Shapes', Icon: Shapes },
                { key: 'shuffle', label: 'Shuffle', Icon: Shuffle },
                { key: 'upload', label: 'Upload', Icon: Upload },
              ] as const
            ).map(({ key, label, Icon }) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={avatarTab === key}
                onClick={() => setAvatarTab(key)}
                className={cn(
                  'flex flex-1 items-center justify-center gap-1 rounded-md px-2 py-1 text-[11px] transition',
                  avatarTab === key
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground',
                )}
                data-testid={`bot-create-avatar-tab-${key}`}
              >
                <Icon className="size-3" />
                {label}
              </button>
            ))}
          </div>

          {avatarTab === 'shapes' && (
            <div className="grid grid-cols-6 gap-1.5" role="radiogroup" aria-label="Avatar face">
              {FACE_PRESETS.map((preset, i) => (
                <button
                  key={preset || 'auto'}
                  type="button"
                  role="radio"
                  aria-checked={salt === preset && avatarTab === 'shapes'}
                  onClick={() => {
                    setSalt(preset);
                    setAvatarTab('shapes');
                  }}
                  title={i === 0 ? 'Auto — face follows the name' : `Face ${i}`}
                  className={cn(
                    'rounded-lg p-0.5 transition',
                    salt === preset && avatarTab === 'shapes'
                      ? 'ring-2 ring-primary'
                      : 'hover:bg-white/5',
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
          )}

          {avatarTab === 'shuffle' && (
            <div className="flex w-full max-w-[320px] flex-col items-center gap-2 rounded-lg border border-border/40 bg-muted/20 p-3">
              <FacePreview
                name={previewName}
                salt={salt || Math.random().toString(36).slice(2, 8)}
                size={48}
              />
              <button
                type="button"
                onClick={() => setSalt(Math.random().toString(36).slice(2, 8))}
                className="inline-flex items-center gap-1 rounded-md border border-border/60 px-2 py-1 text-[11px] hover:bg-white/5"
                data-testid="bot-create-shuffle"
              >
                <Shuffle className="size-3" />
                {salt ? 'Reshuffle' : 'Shuffle face'}
              </button>
              <p className="text-[10px] text-muted-foreground/70">
                Roll until you find one. Lock freezes the pick from re-hashing on rename.
              </p>
            </div>
          )}

          {avatarTab === 'upload' && (
            <div className="flex w-full max-w-[320px] flex-col items-center gap-2 rounded-lg border border-dashed border-border/60 bg-muted/10 p-3">
              {uploadStatus === 'ok' && salt ? (
                <FacePreview name={previewName} salt={salt} size={48} />
              ) : (
                <div className="grid size-12 place-items-center rounded-xl bg-muted/40 text-muted-foreground/60">
                  <Upload className="size-4" />
                </div>
              )}
              <label className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-border/60 px-2 py-1 text-[11px] hover:bg-white/5">
                <Upload className="size-3" />
                {uploadStatus === 'ok' ? 'Replace image' : 'Choose image'}
                <input
                  type="file"
                  accept="image/svg+xml,image/png"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void handleUpload(f);
                    e.target.value = '';
                  }}
                  data-testid="bot-create-upload-input"
                />
              </label>
              {uploadStatus === 'unsupported' && (
                <p className="text-center text-[10px] text-muted-foreground/70">
                  Upload not yet wired on this build — pick a Shape or Shuffle instead.
                </p>
              )}
              {uploadStatus === 'uploading' && (
                <p className="text-[10px] text-muted-foreground/70">Uploading {uploadFileName}…</p>
              )}
              {uploadStatus === 'ok' && (
                <p className="text-[10px] text-muted-foreground/70">Saved {uploadFileName}.</p>
              )}
            </div>
          )}

          <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
            <button
              type="button"
              onClick={() => {
                if (avatarTab === 'shuffle') {
                  setSalt(Math.random().toString(36).slice(2, 8));
                } else {
                  setSalt(Math.random().toString(36).slice(2, 8));
                  setAvatarTab('shuffle');
                }
              }}
              className="inline-flex items-center gap-1 hover:text-foreground"
            >
              <Shuffle className="size-3" /> Randomize
            </button>
            {/* Plan: explicit Lock toggle. Flips the persistence shape and
                makes the face re-derive on rename only when the toggle is off. */}
            <button
              type="button"
              role="switch"
              aria-checked={locked}
              onClick={() => setLocked((v) => !v)}
              className={cn(
                'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 transition',
                locked
                  ? 'border-primary/50 bg-primary/10 text-foreground'
                  : 'border-border/60 text-muted-foreground hover:text-foreground',
              )}
              data-testid="bot-create-lock"
            >
              {locked ? <Lock className="size-3" /> : <LockOpen className="size-3" />}
              {locked ? 'Locked face' : 'Face follows the name'}
            </button>
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
            <div className="space-y-2 rounded-lg border border-border/40 bg-muted/20 p-2.5">
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
              <div>
                <span className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
                  Skills
                </span>
                {skillsQuery.isLoading ? (
                  <p className="text-[11px] text-muted-foreground/60">Loading…</p>
                ) : (skillsQuery.data?.skills ?? []).length === 0 ? (
                  <p className="text-[11px] text-muted-foreground/60">No skills installed.</p>
                ) : (
                  <div className="flex max-h-28 flex-wrap gap-1 overflow-y-auto">
                    {(skillsQuery.data?.skills ?? []).map((s) => {
                      const active = skills.includes(s.name);
                      return (
                        <button
                          key={s.name}
                          type="button"
                          onClick={() => toggleSkill(s.name)}
                          className={cn(
                            'rounded-md border px-1.5 py-0.5 text-[10.5px] transition',
                            active
                              ? 'border-primary/60 bg-primary/15 text-foreground'
                              : 'border-border/60 text-muted-foreground hover:text-foreground',
                          )}
                          title={s.description}
                        >
                          {s.name}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
              <div>
                <span className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
                  Memory scope
                </span>
                <div className="flex gap-1">
                  {(['global', 'project', 'none'] as const).map((scope) => (
                    <button
                      key={scope}
                      type="button"
                      onClick={() => setMemoryScope(scope)}
                      className={cn(
                        'flex-1 rounded-md border px-1.5 py-1 text-[11px] transition',
                        memoryScope === scope
                          ? 'border-primary/60 bg-primary/10 text-foreground'
                          : 'border-border/60 text-muted-foreground hover:text-foreground',
                      )}
                    >
                      {scope}
                    </button>
                  ))}
                </div>
                {memoryScope === 'project' && (
                  <select
                    value={workspacePath}
                    onChange={(e) => setWorkspacePath(e.target.value)}
                    className="mt-1.5 w-full rounded-md border border-border/60 bg-background/60 px-2 py-1 text-[11px] outline-none focus:border-primary/50"
                  >
                    <option value="">Choose a project…</option>
                    {(workspacesQuery.data?.workspaces ?? []).map((w) => (
                      <option key={w.path} value={w.path}>
                        {w.name} · {w.path}
                      </option>
                    ))}
                  </select>
                )}
              </div>
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
