/* ── Bots rail — roster rows with identicon avatars + presence ──────── */
/* Bot Mode Phase A: one row per Bot (avatar + title + last activity),
 * opening the Bot's canonical chat. Vertical section in the session
 * sidebar (no horizontal pill tabs). Hidden Bots stay accessible via
 * the eye toggle in the row menu. */

import { useMemo, useState, useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { motion, AnimatePresence } from 'framer-motion';
import { EyeOff, Eye, EllipsisVertical, Plus, Trash2, Copy, Shuffle, Search, Bell, BellOff, Users, X, Bot as BotIcon } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { sessionRow } from '@/lib/motion';
import { botAvatarSvg } from '@/lib/bot-avatar';
import { BotCreateModal } from '@/components/sidebar/BotCreateModal';
import { RoomView } from '@/components/sidebar/RoomView';
import { Backdrop } from '@/components/overlays/Backdrop';
import {
  createBot,
  deleteBot,
  ensureBotChat,
  getBot,
  listBots,
  updateBotUiMeta,
  type Bot,
} from '@/api/api-client';
import { getWorkbenchSessions } from '@/api/workbench';
import { useActiveChatStreamsStore } from '@/store/chat-active-streams';

/** A Bot is "active now" when its chat wrote within 90 s (plan §Phase A). */
const ACTIVE_WINDOW_MS = 90_000;

function timeAgo(iso?: string | null): string {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return 'now';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

function isRecent(iso?: string | null): boolean {
  if (!iso) return false;
  return Date.now() - new Date(iso).getTime() < ACTIVE_WINDOW_MS;
}
function BotAvatar({ bot, size = 22 }: { bot: Bot; size?: number }) {
  // Identicon per name; uiMeta.avatar holds the randomize SALT (deterministic
  // per salt, so Lock = stop randomizing = keep the salt).
  const html = botAvatarSvg(bot.name, bot.uiMeta?.avatar || '').replace(/width="64" height="64"/, '');
  return (
    <span
      className="shrink-0 rounded-full overflow-hidden ring-1 ring-white/10"
      style={{ width: size, height: size }}
      aria-hidden
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

interface BotRowMenuProps {
  bot: Bot;
  onDeleted: () => void;
}

function BotRowMenu({ bot, onDeleted }: BotRowMenuProps) {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();

  const toggleHidden = useMutation({
    mutationFn: (hidden: boolean) => updateBotUiMeta(bot.id, { hidden }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['bots'] }),
    onError: () => toast.error('Could not update Bot'),
  });

  // Randomize = new salt (deterministic per salt → same face until randomized
  // again). The roster never reorders; only the face changes.
  const randomize = useMutation({
    mutationFn: () => updateBotUiMeta(bot.id, { avatar: Math.random().toString(36).slice(2, 8) }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['bots'] }),
    onError: () => toast.error('Could not randomize avatar'),
  });

  // Duplicate = full clone of the record + persona (plan: "full clone of
  // record + persona + skills refs"). cloneFrom copies role/model/provider/
  // toolsets server-side; canonical chat is created on birth (create_bot).
  const duplicate = useMutation({
    mutationFn: () =>
      createBot({
        name: `${bot.name}-copy`,
        title: `${bot.uiMeta?.title || bot.name} (copy)`,
        description: bot.description || '',
        cloneFrom: bot.id,
      }),
    onSuccess: () => {
      toast.success('Bot duplicated');
      void queryClient.invalidateQueries({ queryKey: ['bots'] });
      void queryClient.invalidateQueries({ queryKey: ['bots', 'chats'] });
    },
    onError: () => toast.error('Could not duplicate Bot'),
  });

  const remove = useMutation({
    mutationFn: () => deleteBot(bot.id),
    onSuccess: () => {
      toast.success(`Bot "${bot.uiMeta?.title || bot.name}" deleted`);
      onDeleted();
      void queryClient.invalidateQueries({ queryKey: ['bots'] });
    },
    onError: () => toast.error('Could not delete Bot'),
  });

  return (
    <div className="relative">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-sidebar-foreground/40 hover:text-sidebar-foreground/80 transition"
        aria-label="Bot actions"
      >
        <EllipsisVertical className="size-3" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            role="menu"
            className="absolute right-0 top-6 z-50 w-36 rounded-md border border-border/50 bg-popover py-1 text-xs shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                toggleHidden.mutate(!bot.uiMeta?.hidden);
                setOpen(false);
              }}
              className="flex w-full items-center gap-1.5 px-2.5 py-1 text-left text-foreground/90 hover:bg-white/5"
            >
              {bot.uiMeta?.hidden ? <Eye className="size-3" /> : <EyeOff className="size-3" />}
              {bot.uiMeta?.hidden ? 'Unhide Bot' : 'Hide Bot'}
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                void navigator.clipboard?.writeText(bot.name).then(() =>
                  toast.success('Bot name copied'),
                );
                setOpen(false);
              }}
              className="flex w-full items-center gap-1.5 px-2.5 py-1 text-left text-foreground/90 hover:bg-white/5"
            >
              <Copy className="size-3" />
              Copy @handle
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                randomize.mutate();
                setOpen(false);
              }}
              className="flex w-full items-center gap-1.5 px-2.5 py-1 text-left text-foreground/90 hover:bg-white/5"
              title="New deterministic face for this Bot"
            >
              <Shuffle className="size-3" />
              Randomize avatar
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                duplicate.mutate();
                setOpen(false);
              }}
              className="flex w-full items-center gap-1.5 px-2.5 py-1 text-left text-foreground/90 hover:bg-white/5"
            >
              <Copy className="size-3" />
              Duplicate Bot
            </button>
            <div className="my-1 h-px bg-border/40" />
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                remove.mutate();
                setOpen(false);
              }}
              className="flex w-full items-center gap-1.5 px-2.5 py-1 text-left text-destructive hover:bg-white/5"
            >
              <Trash2 className="size-3" />
              Delete Bot
            </button>
          </div>
        </>
      )}
    </div>
  );
}

interface BotRowProps {
  bot: Bot;
  sessionId?: string;
  active: boolean;
  onOpenChat: (bot: Bot) => void;
  onOpenProfile: (bot: Bot) => void;
  /** Summary of the Bot's canonical chat (preview + updatedAt for presence). */
  summary?: { lastPreview?: string; updatedAt?: string | null };
}

function BotRow({ bot, sessionId, active, onOpenChat, onOpenProfile, summary }: BotRowProps) {
  const streaming = useActiveChatStreamsStore((s) => (sessionId ? s.active[sessionId] : undefined));
  const title = bot.uiMeta?.title || bot.name;
  const recent = isRecent(summary?.updatedAt);
  return (
    <motion.div
      layout
      variants={sessionRow}
      initial="initial"
      animate="animate"
      exit="exit"
      className={cn(
        'august-bot-row group relative rounded-md',
        active ? 'bg-white/[0.05]' : 'hover:bg-white/[0.03]',
      )}
    >
      <button
        type="button"
        onClick={() => onOpenProfile(bot)}
        className="flex w-full items-center gap-2 px-2 py-1 text-left min-w-0"
        title={bot.description || title}
        data-testid={`bot-row-${bot.name}`}
      >
        <span className="relative">
          <BotAvatar bot={bot} />
          {(streaming || recent) && (
            <span className="absolute -right-0.5 -top-0.5 size-1.5 rounded-full bg-emerald-400 animate-pulse" />
          )}
        </span>
        <span className="flex-1 min-w-0 flex flex-col">
          <span className="flex items-baseline justify-between gap-1">
            <span
              className={cn(
                'truncate text-[12.5px]',
                bot.uiMeta?.hidden ? 'text-sidebar-foreground/35 italic' : 'text-sidebar-foreground/85',
              )}
            >
              {title}
            </span>
            {summary?.updatedAt && (
              <span className="shrink-0 text-[9.5px] text-sidebar-foreground/25 tabular-nums">
                {timeAgo(summary.updatedAt)}
              </span>
            )}
          </span>
          {summary?.lastPreview ? (
            <span className="truncate text-[10.5px] text-sidebar-foreground/35">
              {summary.lastPreview}
            </span>
          ) : null}
        </span>
      </button>
      <span className="absolute right-1 top-1/2 -translate-y-1/2">
        <BotRowMenu bot={bot} onDeleted={() => undefined} />
      </span>
    </motion.div>
  );
}

export interface BotsRailProps {
  /** Open a workbench session by id (the canonical Bot Chat). */
  onOpenSession: (sessionId: string) => void;
  activeSessionId?: string;
  /** Optional: open the group-room creator (New Group Chat menu item). */
  onNewGroupChat?: () => void;
}

/** Vertical roster section: every Bot, hidden ones dimmed, presence dots live. */
export function BotsRail({ onOpenSession, activeSessionId, onNewGroupChat }: BotsRailProps) {
  // Part 27 F1: rail chrome — search, notification mute, "+" menu; F2: the
  // New Bot flow is a modal with an avatar picker (replaces the inline form).
  const [search, setSearch] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [showRooms, setShowRooms] = useState(false);
  const [profileBot, setProfileBot] = useState<Bot | null>(null);
  const [muted, setMuted] = useState(() => {
    try {
      return localStorage.getItem('august.bots.muted') === '1';
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem('august.bots.muted', muted ? '1' : '0');
    } catch {
      /* private mode */
    }
  }, [muted]);

  const botsQuery = useQuery({
    queryKey: ['bots'],
    queryFn: listBots,
  });
  const bots = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (botsQuery.data?.bots ?? [])
      .slice()
      .sort((a, b) => {
        const ah = a.uiMeta?.hidden ? 1 : 0;
        const bh = b.uiMeta?.hidden ? 1 : 0;
        return ah - bh;
      })
      .filter(
        (b) =>
          !q ||
          b.name.toLowerCase().includes(q) ||
          (b.uiMeta?.title || '').toLowerCase().includes(q) ||
          (b.description || '').toLowerCase().includes(q),
      );
  }, [botsQuery.data, search]);

  // Resolve each Bot's canonical chat id once (for presence + open).
  const chatsQuery = useQuery({
    queryKey: ['bots', 'chats'],
    queryFn: async () => {
      const out: Record<string, string> = {};
      await Promise.all(
        (botsQuery.data?.bots ?? []).map(async (bot) => {
          try {
            const chat = await ensureBotChat(bot.id);
            out[bot.id] = chat.sessionId;
          } catch {
            /* Bot without a chat yet — row still renders */
          }
        }),
      );
      return out;
    },
    enabled: !!botsQuery.data?.bots.length,
    staleTime: 30_000,
  });
  const botSessionIds = chatsQuery.data ?? {};

  const openChat = async (bot: Bot) => {
    try {
      const chat = await ensureBotChat(bot.id);
      onOpenSession(chat.sessionId);
    } catch {
      toast.error('Could not open Bot Chat');
    }
  };

  const anyBots = (botsQuery.data?.bots?.length ?? 0) > 0;

  // Session summaries power the roster rows (last-message preview +
  // timestamp) and the "Active now" strip (updatedAt within 90 s).
  const summariesQ = useQuery({
    queryKey: ['bots', 'summaries'],
    queryFn: async () => {
      const sessions = await getWorkbenchSessions();
      const out: Record<string, { lastPreview?: string; updatedAt?: string | null }> = {};
      for (const s of sessions) {
        if (s.canonicalBotChat && s.agentId) {
          out[s.agentId] = { lastPreview: s.lastPreview, updatedAt: s.updatedAt };
        }
      }
      return out;
    },
    enabled: anyBots,
    refetchInterval: 30_000,
    staleTime: 15_000,
  });
  const summaries = summariesQ.data ?? {};

  // "Active now": Bots that wrote within the window, in roster order —
  // the strip never reorders the roster itself (plan §Phase A).
  const activeNow = bots.filter(
    (b) => !b.uiMeta?.hidden && isRecent(summaries[b.id]?.updatedAt),
  );

  return (
    <div className="august-bots-rail">
      <div className="flex items-center justify-between px-2 mb-1">
        <div className="flex items-center gap-1">
          <h3 className="text-[11px] text-sidebar-foreground/40 font-normal">Bots</h3>
          {anyBots && (
            <span className="text-[10px] text-sidebar-foreground/25 tabular-nums">
              {botsQuery.data?.bots.length ?? 0}
            </span>
          )}
        </div>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={() => setShowRooms(true)}
            className="p-0.5 rounded text-sidebar-foreground/30 hover:text-sidebar-foreground/60 transition-colors hover:bg-white/[0.03]"
            title="Group rooms"
            aria-label="Group rooms"
            data-testid="bots-open-rooms"
          >
            <Users className="size-3" />
          </button>
          <button
            type="button"
            onClick={() => setMuted((v) => !v)}
            className="p-0.5 rounded text-sidebar-foreground/30 hover:text-sidebar-foreground/60 transition-colors hover:bg-white/[0.03]"
            title={muted ? 'Unmute Bot activity' : 'Mute Bot activity'}
            aria-label={muted ? 'Unmute Bot activity' : 'Mute Bot activity'}
            aria-pressed={muted}
          >
            {muted ? <BellOff className="size-3" /> : <Bell className="size-3" />}
          </button>
          <div className="relative">
            <button
              type="button"
              onClick={() => setMenuOpen((v) => !v)}
              className="p-0.5 rounded text-sidebar-foreground/30 hover:text-sidebar-foreground/60 transition-colors hover:bg-white/[0.03]"
              title="New"
              aria-label="New"
              aria-expanded={menuOpen}
            >
              <Plus className="size-3" />
            </button>
            {menuOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
                <div
                  role="menu"
                  className="absolute right-0 top-5 z-50 w-40 rounded-md border border-border/50 bg-popover py-1 text-xs shadow-2xl"
                >
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      setShowModal(true);
                    }}
                    className="flex w-full items-center gap-1.5 px-2.5 py-1 text-left text-foreground/90 hover:bg-white/5"
                    data-testid="bots-menu-new-bot"
                  >
                    <BotIcon className="size-3" /> New Bot
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      if (onNewGroupChat) onNewGroupChat();
                      else setShowRooms(true);
                    }}
                    className="flex w-full items-center gap-1.5 px-2.5 py-1 text-left text-foreground/90 hover:bg-white/5"
                    data-testid="bots-menu-new-group"
                  >
                    <Users className="size-3" /> New Group Chat
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {anyBots && (
        <div className="px-1.5 pb-1">
          <div className="flex items-center gap-1.5 rounded-md border border-sidebar-border/50 bg-white/[0.03] px-2 py-1">
            <Search className="size-3 shrink-0 text-sidebar-foreground/30" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search bots…"
              aria-label="Search bots"
              className="min-w-0 flex-1 bg-transparent text-[11.5px] text-sidebar-foreground/80 outline-none placeholder:text-sidebar-foreground/30"
            />
          </div>
        </div>
      )}

      {!muted && activeNow.length > 0 && (
        <div
          className="mb-1 flex flex-wrap items-center gap-1 px-1.5"
          data-testid="bots-active-now"
        >
          <span className="text-[9.5px] uppercase tracking-wide text-emerald-400/70">
            Active now
          </span>
          {activeNow.map((b) => (
            <button
              key={b.id}
              type="button"
              onClick={() => void openChat(b)}
              className="rounded-full border border-emerald-400/25 bg-emerald-400/10 px-1.5 py-0.5 text-[10px] text-emerald-300 hover:bg-emerald-400/20 transition"
              title={`Open ${b.uiMeta?.title || b.name}`}
            >
              {b.uiMeta?.title || b.name}
            </button>
          ))}
        </div>
      )}

      <div className="space-y-0.5">
        <AnimatePresence initial={false} mode="popLayout">
          {bots.map((bot) => (
            <BotRow
              key={bot.id}
              bot={bot}
              sessionId={botSessionIds[bot.id]}
              active={!!botSessionIds[bot.id] && botSessionIds[bot.id] === activeSessionId}
              onOpenChat={openChat}
              onOpenProfile={setProfileBot}
              summary={summaries[bot.id]}
            />
          ))}
        </AnimatePresence>
        {!anyBots && (
          <p className="px-2 py-1 text-[11px] text-sidebar-foreground/30 italic">
            No Bots yet — create one to give it a forever-chat.
          </p>
        )}
        {anyBots && bots.length === 0 && (
          <p className="px-2 py-1 text-[11px] text-sidebar-foreground/30 italic">
            No Bots match “{search}”.
          </p>
        )}
      </div>

      {showModal && <BotCreateModal onClose={() => setShowModal(false)} />}

      {profileBot && (
        <Backdrop onClose={() => setProfileBot(null)} className="z-[60]">
          <div
            className="relative w-[min(94vw,420px)] rounded-2xl border border-border/70 bg-card p-6 text-center shadow-2xl"
            role="dialog"
            aria-modal="true"
            aria-label={profileBot.uiMeta?.title || profileBot.name}
            data-testid="bot-profile"
          >
            <button
              type="button"
              onClick={() => setProfileBot(null)}
              className="absolute right-3 top-3 rounded-md p-1 text-muted-foreground hover:bg-white/5 hover:text-foreground"
              aria-label="Close"
            >
              <X className="size-4" />
            </button>
            <div className="mx-auto mb-3 flex justify-center">
              <BotAvatar bot={profileBot} size={72} />
            </div>
            <h2 className="text-lg font-semibold text-foreground">
              {profileBot.uiMeta?.title || profileBot.name}
            </h2>
            <p className="mt-0.5 text-[12px] text-muted-foreground">
              Bot · @{profileBot.name}
            </p>
            {profileBot.description && (
              <p className="mx-auto mt-3 max-w-xs text-[12.5px] leading-relaxed text-muted-foreground/90">
                {profileBot.description}
              </p>
            )}
            <p className="mx-auto mt-4 max-w-xs text-[12px] text-muted-foreground/70">
              Open this bot&apos;s continuous chat. Its background work keeps running when you
              switch away.
            </p>
            <button
              type="button"
              onClick={() => {
                const b = profileBot;
                setProfileBot(null);
                void openChat(b);
              }}
              className="mt-4 rounded-lg bg-primary px-4 py-1.5 text-[13px] font-medium text-primary-foreground transition hover:opacity-90"
              data-testid="bot-profile-open-chat"
            >
              Open chat
            </button>
          </div>
        </Backdrop>
      )}

      {showRooms && (
        <Backdrop onClose={() => setShowRooms(false)} className="z-[60]">
          <div
            className="relative flex h-[min(88vh,820px)] w-[min(96vw,1040px)] overflow-hidden rounded-2xl border border-border/70 bg-background shadow-2xl"
            role="dialog"
            aria-modal="true"
            aria-label="Group rooms"
          >
            <button
              type="button"
              onClick={() => setShowRooms(false)}
              className="absolute right-3 top-2 z-10 rounded-md p-1 text-muted-foreground hover:bg-white/5 hover:text-foreground"
              aria-label="Close rooms"
            >
              <X className="size-4" />
            </button>
            <div className="min-h-0 flex-1 pt-8">
              <RoomView />
            </div>
          </div>
        </Backdrop>
      )}
    </div>
  );
}
