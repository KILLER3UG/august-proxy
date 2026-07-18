import { RecapCard } from '@/components/chat/RecapCard';
import { ChangedFilesCard } from '@/components/chat/ChangedFilesCard';
import type { ChatMessage, MessageBlock } from '@/types/chat';
import type { GitDiffResult } from '@/api/git';
import type { SubagentBlockState } from '../chat-stream-manager';
import {
  AssistantBlockTimeline,
  type SubagentPromptEntry,
  type ToolProgressMap,
} from './AssistantBlockTimeline';
import { AssistantMessageActions } from './AssistantMessageActions';

type DisplayBlock = MessageBlock;

/** Assistant message body: blocks timeline, recap, and action footer. */
export function AssistantMessageContent({
  message,
  isLast,
  streaming,
  modelId,
  displayBlocks,
  showPendingThinking,
  showRaw,
  setShowRaw,
  showActions,
  copied,
  speaking,
  isRegenerating,
  toolProgress,
  subagentPrompts,
  subagentBlocks,
  onSpeak,
  onCopy,
  onRegen,
}: {
  message: ChatMessage;
  isLast?: boolean;
  streaming?: boolean;
  modelId?: string | null;
  displayBlocks: DisplayBlock[];
  showPendingThinking: boolean;
  showRaw: boolean;
  setShowRaw: (v: boolean) => void;
  showActions: boolean;
  copied: boolean;
  speaking: boolean;
  isRegenerating: boolean;
  toolProgress?: ToolProgressMap;
  subagentPrompts?: Map<string, SubagentPromptEntry>;
  subagentBlocks?: Map<string, SubagentBlockState>;
  onSpeak: () => void;
  onCopy: () => void;
  onRegen: () => void;
}) {
  return (
    <>
      <div className="flex flex-col w-full gap-2">
        {showRaw ? (
          <div className="p-3 bg-muted/40 rounded-xl border border-border/50 text-xs font-mono text-muted-foreground whitespace-pre-wrap overflow-x-auto leading-relaxed">
            {JSON.stringify(message, null, 2)}
          </div>
        ) : (
          <AssistantBlockTimeline
            displayBlocks={displayBlocks}
            message={message}
            isLast={isLast}
            streaming={streaming}
            showPendingThinking={showPendingThinking}
            toolProgress={toolProgress}
            subagentPrompts={subagentPrompts}
            subagentBlocks={subagentBlocks}
            modelId={modelId}
          />
        )}
        {(() => {
          const cf = message.changedFiles as { files?: unknown[] } | undefined;
          return cf && Array.isArray(cf.files) && cf.files.length > 0
            ? <ChangedFilesCard changes={message.changedFiles as GitDiffResult} />
            : null;
        })()}
        {/* End-of-turn recap: instant template from tools/files; AI rewrite optional.
            Hide while this message is still streaming so it appears with the settled answer. */}
        {!(isLast && streaming) && (
          <RecapCard
            modelId={modelId}
            input={{
              blocks: message.blocks,
              tools: message.tools,
              changedFiles: message.changedFiles as {
                files?: Array<{ path: string; added?: number; removed?: number; status?: string }>;
              } | undefined,
              finalText:
                message.blocks
                  ?.filter((b) => b.type === 'finalOutput' && b.content)
                  .map((b) => b.content || '')
                  .join('\n') ||
                message.content ||
                '',
            }}
          />
        )}
      </div>
      <AssistantMessageActions
        showActions={showActions}
        copied={copied}
        speaking={speaking}
        isLast={isLast}
        streaming={streaming}
        isRegenerating={isRegenerating}
        showRaw={showRaw}
        setShowRaw={setShowRaw}
        onSpeak={onSpeak}
        onCopy={onCopy}
        onRegen={onRegen}
      />
    </>
  );
}
