import * as React from 'react';
import { Plus, Send } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { playReceiveChime, playSendChime } from '@/lib/chat-chime';

/* ------------------------------------------------------------------ */
/*  types                                                             */
/* ------------------------------------------------------------------ */
export interface GradientChatMessage {
  id: number;
  text: string;
  sender: 'user' | 'bot';
}

export interface GradientChatInputProps {
  /** Placeholder shown inside the text field. */
  placeholder?: string;
  /** Auto-reply pushed back after a user message. Pass `null` to disable. */
  autoReply?: string | null;
  /** Delay (ms) before the auto-reply lands. */
  autoReplyDelay?: number;
  /** Max number of bubbles kept on screen. */
  maxVisible?: number;
  /** Play synthesized send / receive sounds. */
  sound?: boolean;
  /** The spectrum used for the reveal glow (top → bottom). Reserved for theming. */
  gradientColors?: string[];
  /** Fired whenever the user submits a message. */
  onSend?: (message: string) => void;
  className?: string;
}

/* ------------------------------------------------------------------ */
/*  defaults                                                          */
/* ------------------------------------------------------------------ */
const DEFAULT_GRADIENT = [
  '#FC2BA3',
  '#FC6D35',
  '#F9C83D',
  '#C2D6E1',
  '#144EC5',
];

/** Smooth rise used for bubble enter (aligned with chat thread motion). */
export const MESSAGE_POP_TRANSITION = {
  opacity: { duration: 0.32, ease: [0.16, 1, 0.3, 1] as const },
  y: { type: 'spring' as const, stiffness: 260, damping: 28, mass: 0.85 },
  scale: { type: 'spring' as const, stiffness: 280, damping: 30, mass: 0.85 },
};

export const MESSAGE_POP_INITIAL = { opacity: 0, y: 14, scale: 0.97 };
export const MESSAGE_POP_ANIMATE = { opacity: 1, y: 0, scale: 1 };
export const MESSAGE_POP_EXIT = { opacity: 0, y: -6, scale: 0.98 };

/* ------------------------------------------------------------------ */
/*  component                                                         */
/* ------------------------------------------------------------------ */
export default function GradientChatInput({
  placeholder = 'Send Message',
  autoReply = 'Got it — looking into that now ✨',
  autoReplyDelay = 650,
  maxVisible = 4,
  sound = true,
  gradientColors = DEFAULT_GRADIENT,
  onSend,
  className,
}: GradientChatInputProps) {
  void gradientColors; // reserved for future glow theming
  const [value, setValue] = React.useState('');
  const [messages, setMessages] = React.useState<GradientChatMessage[]>([]);
  const idRef = React.useRef(0);
  const timersRef = React.useRef<ReturnType<typeof setTimeout>[]>([]);

  React.useEffect(() => {
    const timers = timersRef.current;
    return () => {
      timers.forEach(clearTimeout);
    };
  }, []);

  const pushMessage = (text: string, sender: GradientChatMessage['sender']) =>
    setMessages((prev) => [...prev, { id: idRef.current++, text, sender }]);

  const handleSend = () => {
    const text = value.trim();
    if (!text) return;

    onSend?.(text);
    pushMessage(text, 'user');
    if (sound) playSendChime();
    setValue('');

    if (autoReply) {
      const t = setTimeout(() => {
        pushMessage(autoReply, 'bot');
        if (sound) playReceiveChime();
        timersRef.current = timersRef.current.filter((timer) => timer !== t);
      }, autoReplyDelay);
      timersRef.current.push(t);
    }
  };

  const hasText = value.trim().length > 0;
  const visible = messages.slice(-maxVisible);

  return (
    <div className={cn('relative mx-auto w-full max-w-lg', className)}>
      {/* the input card */}
      <div className="relative rounded-3xl border border-border bg-background p-1 shadow-[0_10px_20px_-6px_rgba(0,0,0,0.1)]">
        <div className="relative z-[2] flex items-center justify-between gap-2 rounded-3xl bg-background p-1.5">
          <div className="flex flex-1 items-center gap-3 pr-1">
            <Button
              type="button"
              variant="secondary"
              size="icon"
              aria-label="Add attachment"
              className="size-10 shrink-0 rounded-xl"
            >
              <Plus className="size-5" />
            </Button>
            <Input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleSend();
                }
              }}
              placeholder={placeholder}
              aria-label="Message"
              className="h-auto flex-1 border-0 bg-transparent px-0 py-0 text-base shadow-none focus-visible:ring-0 dark:bg-transparent md:text-sm"
            />
          </div>
          <Button
            type="button"
            onClick={handleSend}
            onMouseDown={(e) => e.preventDefault()}
            variant={hasText ? 'default' : 'secondary'}
            size="icon"
            aria-label="Send message"
            className="size-10 shrink-0 rounded-xl transition-colors active:scale-95"
          >
            <Send className="size-5" strokeWidth={2.25} />
          </Button>
        </div>

        {/* bubble stack — floats above the card */}
        <div className="pointer-events-none absolute bottom-[70px] right-0 z-[1] flex w-full flex-col items-end gap-2">
          <AnimatePresence initial={false}>
            {visible.map((m) => (
              <motion.div
                key={m.id}
                layout
                initial={MESSAGE_POP_INITIAL}
                animate={MESSAGE_POP_ANIMATE}
                exit={MESSAGE_POP_EXIT}
                transition={MESSAGE_POP_TRANSITION}
                className={cn(
                  'max-w-[260px] break-words px-3.5 py-2.5 text-sm shadow-[0_10px_20px_-6px_rgba(0,0,0,0.15)]',
                  m.sender === 'user'
                    ? 'self-end rounded-[14px_14px_6px_14px] border border-border bg-background text-foreground'
                    : 'self-start rounded-[14px_14px_14px_6px] bg-primary text-primary-foreground',
                )}
              >
                {m.text}
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
