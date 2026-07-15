/* ── Message bubble + tool cards ─────────────────────────────────────── */
/* Renders a single chat message: text, thinking, tool calls, and badges. */

import { useState, useMemo } from 'react';
import { toast } from 'sonner';
import { ClarifyTool } from '@/components/chat/ClarifyTool';
import type { ChatMessage } from '@/types/chat';
import { getDisplayBlocks } from './message-blocks';
import {
  voiceCommandRegistry,
  type VoiceCommandCardProps,
} from '@/api/voice/registry';
import { CommandHelpCard } from './CommandHelpCard';
import { ToolCallCard } from './message/ToolCallCard';
import { SubagentApprovalInline } from './message/SubagentApprovalInline';
import { UserMessageBubble } from './message/UserMessageBubble';
import { AssistantMessageContent } from './message/AssistantMessageContent';

export { ReasoningBlock } from './message/ReasoningBlock';
export { ToolCallCard, ToolBlock } from './message/ToolCallCard';

export function MessageBubble({
  message,
  isLast,
  streaming,
  sessionId,
  modelId,
  onRevert,
  onEdit,
  onRegenerate,
  onClarifyAnswer,
  toolProgress,
  subagentPrompts,
  subagentBlocks,
}: {
  message: ChatMessage;
  isLast?: boolean;
  streaming?: boolean;
  sessionId?: string;
  /** Selected model id — used for optional Recap "Rewrite with AI". */
  modelId?: string | null;
  onRevert?: () => void;
  onEdit?: (text: string) => void;
  onRegenerate?: () => void;
  onClarifyAnswer?: (answer: string) => void;
  toolProgress?: Map<string, ReadonlyArray<{ path: string; status: 'reading' | 'read' }>>;
  /** Sub-agent prompt disclosures keyed by the parent toolUse id. Only
   *  present for blocks whose tool name is august__spawn_subagent or
   *  august__run_team (and the team-run agents they spawn). The bubble
   *  renders each disclosure directly under its matching tool call. */
  subagentPrompts?: Map<string, {
    content: string;
    systemPrompt: string;
    userMessage: string;
    tokens: number;
    subagentId?: string;
    jobId?: string;
  }>;
  /** Live sub-agent containers keyed by jobId. Each container has the
   *  sub-agent's own blocks (thinking/text/toolCall/toolResult) and is
   *  rendered as a nested block under the matching parent toolCall.
   *  Independent of `subagentPrompts` so it survives tab switches and
   *  backend reconnects. */
  subagentBlocks?: Map<string, import('./chat-stream-manager').SubagentBlockState>;
}) {
  const [showActions, setShowActions] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState('');
  const [copied, setCopied] = useState(false);
  const [isRegenerating, setIsRegenerating] = useState(false);
  const [speaking, setSpeaking] = useState(false);

  const [showRaw, setShowRaw] = useState(false);
  const [userMsgExpanded, setUserMsgExpanded] = useState(false);

  // Hooks must run on every render path, so compute these BEFORE the early
  // returns below (rules-of-hooks).
  const isUser = message.role === 'user';
  const displayBlocks = useMemo(() => {
    if (isUser) return [];
    return getDisplayBlocks(message.blocks, message.thinking, message.tools, message.content);
  }, [message.blocks, message.thinking, message.tools, message.content, isUser]);
  const showPendingThinking = !isUser && isLast && streaming && !showRaw && displayBlocks.length === 0;

  const startEdit = () => {
    setEditText(message.content);
    setEditing(true);
  };

  const saveEdit = () => {
    if (editText.trim() && onEdit) onEdit(editText);
    setEditing(false);
  };

  const cancelEdit = () => {
    setEditing(false);
    setEditText('');
  };

  if (message.role === 'tool') {
    const toolKey = message.tool?.name ?? 'legacy';
    return (
      <ToolCallCard
        tool={message.tool!}
        timestamp={message.timestamp}
        progress={toolProgress?.get(toolKey)}
      />
    );
  }

  if (message.kind === 'help') {
    return (
      <div className="flex justify-start">
        <CommandHelpCard />
      </div>
    );
  }

  if (message.kind === 'voice-command-card' && message.commandId) {
    const cmd = voiceCommandRegistry.getById(message.commandId);
    const Card = cmd?.uiCard;
    if (Card) {
      const dismiss = () => {
        // Bubble unmount: parent will re-render without this message.
        // We can't reach setMessages from here without a callback; the
        // message is removed when the user dismisses it via the card's
        // own UI. If the card doesn't call onDismiss, the message stays.
      };
      const props: VoiceCommandCardProps = {
        sessionId: sessionId ?? '',
        onDismiss: dismiss,
        context: message.context,
      };
      return (
        <div className="flex justify-start" data-command-id={message.commandId}>
          <Card {...props} />
        </div>
      );
    }
    // Card component not found — fall through to a small toast-style hint.
    return (
      <div className="flex justify-start text-xs text-muted-foreground">
        Unknown card: {message.commandId}
      </div>
    );
  }

  if (message.kind === 'subagent-approval') {
    return (
      <div className="flex justify-start">
        <SubagentApprovalInline
          breakdown={message.breakdown ?? []}
          onApprove={() => toast.success('Subagent plan approved')}
          onCancel={() => toast.info('Subagent plan cancelled')}
        />
      </div>
    );
  }

  const handleCopy = async () => {
    const textToCopy = message.content;

    // Try clipboard API first, then fallback to execCommand
    const copyText = async (text: string) => {
      try {
        if (navigator.clipboard && window.isSecureContext) {
          await navigator.clipboard.writeText(text);
          return true;
        }
      } catch {
        // Clipboard API failed, try fallback
      }

      // Fallback: use execCommand (deprecated but works in insecure contexts)
      try {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.left = '-9999px';
        textarea.style.top = '-9999px';
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        const success = document.execCommand('copy');
        document.body.removeChild(textarea);
        return success;
      } catch {
        return false;
      }
    };

    const success = await copyText(textToCopy);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);

    if (!success) {
      console.warn('[ChatThread] Copy failed - clipboard unavailable');
    }
  };

  const handleRegenClick = () => {
    if (onRegenerate) {
      setIsRegenerating(true);
      try {
        onRegenerate();
      } finally {
        setIsRegenerating(false);
      }
    }
  };

  const handleSpeak = () => {
    if (speaking) {
      window.speechSynthesis.cancel();
      setSpeaking(false);
      return;
    }
    const text = message.content;
    if (!text) return;
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1;
    utterance.pitch = 1;
    utterance.onend = () => setSpeaking(false);
    utterance.onerror = () => setSpeaking(false);
    window.speechSynthesis.speak(utterance);
    setSpeaking(true);
  };

  return (
    <div
      id={`msg-${message.id}`}
      className="w-full flex flex-col"
      onMouseEnter={() => setShowActions(true)}
      onMouseLeave={() => setShowActions(false)}
    >
      {!isUser && message.clarify && !message.clarify.answer && onClarifyAnswer && (
        <ClarifyTool
          payload={message.clarify}
          onSubmit={onClarifyAnswer}
        />
      )}
      {/* todos are rendered in the layout-level Workbench sidebar */}
      {isUser ? (
        <UserMessageBubble
          message={message}
          editing={editing}
          editText={editText}
          setEditText={setEditText}
          userMsgExpanded={userMsgExpanded}
          setUserMsgExpanded={setUserMsgExpanded}
          showActions={showActions}
          copied={copied}
          streaming={streaming}
          isLast={isLast}
          isRegenerating={isRegenerating}
          onStartEdit={startEdit}
          onSaveEdit={saveEdit}
          onCancelEdit={cancelEdit}
          onCopy={() => { void handleCopy(); }}
          onRegen={() => { void handleRegenClick(); }}
          onRevert={onRevert}
        />
      ) : (
        <AssistantMessageContent
          message={message}
          isLast={isLast}
          streaming={streaming}
          modelId={modelId}
          displayBlocks={displayBlocks}
          showPendingThinking={!!showPendingThinking}
          showRaw={showRaw}
          setShowRaw={setShowRaw}
          showActions={showActions}
          copied={copied}
          speaking={speaking}
          isRegenerating={isRegenerating}
          toolProgress={toolProgress}
          subagentPrompts={subagentPrompts}
          subagentBlocks={subagentBlocks}
          onSpeak={handleSpeak}
          onCopy={() => { void handleCopy(); }}
          onRegen={() => { void handleRegenClick(); }}
        />
      )}
    </div>
  );
}
