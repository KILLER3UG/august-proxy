/**
 * Animated "Context compacted" card shown in the chat stream when auto-compact
 * (or Free up memory) collapses middle messages to fit the model window.
 */

import { useState } from 'react';
import { Archive } from 'lucide-react';
import { motion } from 'framer-motion';
import { cn } from '@/lib/utils';
import { DisclosureRow } from '@/components/chat/DisclosureRow';
import { formatContextWindow } from '@/sections/chat/model-display';
import { t } from '@/lib/motion';

export interface CompactionNoticeInfo {
  headCount: number;
  tailCount: number;
  compressedCount: number;
  originalTokens: number;
  compressedTokens: number;
  contextWindow?: number;
  threshold?: number;
}

function formatTokens(n: number): string {
  if (!n || n <= 0) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

export function CompactionNoticeCard({ info }: { info: CompactionNoticeInfo }) {
  const [open, setOpen] = useState(false);
  const saved = Math.max(0, info.originalTokens - info.compressedTokens);
  const label =
    info.compressedCount > 0
      ? `Context compacted — summarized ${info.compressedCount} messages`
      : 'Context compacted';

  return (
    <motion.div
      className="text-sm text-muted-foreground w-full py-0.5"
      data-slot="compaction-notice"
      initial={{ opacity: 0, y: 10, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={t.spring}
    >
      <DisclosureRow onToggle={() => setOpen(!open)} open={open}>
        <span className="flex min-w-0 items-center gap-2">
          <motion.span
            className="inline-flex shrink-0"
            initial={{ rotate: -20, scale: 0.8 }}
            animate={{ rotate: 0, scale: 1 }}
            transition={{ ...t.spring, delay: 0.05 }}
          >
            <Archive className="size-3.5 text-primary/80" />
          </motion.span>
          <span className="text-[12.5px] font-medium leading-5 text-foreground/80">
            {label}
          </span>
          <span className="text-[11px] text-muted-foreground/70 tabular-nums shrink-0">
            {formatTokens(info.originalTokens)} → {formatTokens(info.compressedTokens)}
            {saved > 0 ? ` (−${formatTokens(saved)})` : ''}
          </span>
        </span>
      </DisclosureRow>
      {open && (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          transition={t.smooth}
          className={cn(
            'ml-5 mt-1 mb-1 rounded-lg border border-border/50 bg-muted/20 px-3 py-2',
            'text-[12.5px] leading-relaxed text-muted-foreground/85',
          )}
        >
          Kept the first {info.headCount} and last {info.tailCount} messages; summarized{' '}
          {info.compressedCount} in the middle
          {info.contextWindow
            ? ` to stay within ${formatContextWindow(info.contextWindow)} context`
            : ''}
          .
        </motion.div>
      )}
    </motion.div>
  );
}

/** Build a transcript card for a compaction event. */
export function buildCompactionNoticeMessage(info: CompactionNoticeInfo) {
  return {
    id: `compaction-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    role: 'assistant' as const,
    content: '',
    timestamp: new Date().toISOString(),
    kind: 'compaction-notice' as const,
    context: {
      headCount: info.headCount,
      tailCount: info.tailCount,
      compressedCount: info.compressedCount,
      originalTokens: info.originalTokens,
      compressedTokens: info.compressedTokens,
      contextWindow: info.contextWindow,
      threshold: info.threshold,
    },
  };
}
