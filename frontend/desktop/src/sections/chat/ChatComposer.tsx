import { useEffect, useState, useLayoutEffect, useCallback, type RefObject } from 'react';
import { Paperclip, AtSign, Mic, Send, StopCircle, X, type LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  FOCUS_COMPOSER_EVENT,
  INSERT_COMPOSER_TEXT_EVENT,
} from '@/api/ui-events';
import { ContextRing } from './ContextRing';

export type { ContextBreakdown } from './context-breakdown';
export { estimateContextBreakdown } from './context-breakdown';
export { ContextRing };

interface ModelItem {
  id: string;
  name: string;
  provider: string;
  contextWindow: number;
  isFree?: boolean;
  supportsReasoning?: boolean;
  supportsThinking?: boolean;
}

interface ToolOption {
  name: string;
  desc: string;
}

interface CommandOption {
  name: string;
  desc: string;
}

interface ChatComposerProps {
  input: string;
  attachments: Array<{ name: string; size: string }>;
  voiceActive: boolean;
  showToolsDropdown: boolean;
  showCommandsDropdown: boolean;
  streaming: boolean;
  currentModel: ModelItem | null;
  selectedModel: ModelItem | null;
  models: ModelItem[];
  visibleModels: ModelItem[];
  modelsLoading: boolean;
  effort: 'low' | 'medium' | 'high' | 'max';
  pct: number;
  estTokens: number;
  maxContext: number;
  taRef: RefObject<HTMLTextAreaElement | null>;
  fileInputRef: RefObject<HTMLInputElement | null>;
  sessionId: string | null;
  tools: ToolOption[];
  commands: CommandOption[];
  onInputChange: (value: string) => void;
  onKey: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onInsertText: (text: string) => void;
  onToggleToolsDropdown: (open: boolean) => void;
  onToggleCommandsDropdown: (open: boolean) => void;
  onRemoveAttachment: (index: number) => void;
  onOpenFilePicker: () => void;
  onStartVoiceInput: () => void;
  onRefreshModels: (refresh?: boolean) => void;
  onEditModels: () => void;
  onSelectModel: (model: ModelItem | null) => void;
  onEffortChange: (value: 'low' | 'medium' | 'high' | 'max') => void;
  onSend: () => void;
  onStop: () => void;
  onToggleModelVisibility: (modelId: string) => void;
  onSetModelVisibilityOpen: (open: boolean) => void;
  onSetSessionModel: (sessionId: string | null | undefined, modelId: string, provider: string) => void;
}

export function ChatComposer({
  input,
  attachments,
  voiceActive,
  showToolsDropdown,
  showCommandsDropdown,
  streaming,
  currentModel,
  selectedModel,
  models,
  visibleModels,
  modelsLoading,
  effort,
  pct,
  estTokens,
  maxContext,
  sessionId,
  taRef,
  tools,
  commands,
  onInputChange,
  onKey,
  onInsertText,
  onToggleToolsDropdown,
  onToggleCommandsDropdown,
  onRemoveAttachment,
  onOpenFilePicker,
  onStartVoiceInput,
  onRefreshModels,
  onEditModels,
  onSelectModel,
  onEffortChange,
  onSend,
  onStop,
  onToggleModelVisibility,
  onSetModelVisibilityOpen,
  onSetSessionModel,
}: ChatComposerProps) {
  // Task 5: respond to LLM-driven UI events that target the composer.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const focusHandler = () => {
      // Defer focus to next frame so we don't fight the React render cycle.
      requestAnimationFrame(() => {
        taRef.current?.focus();
      });
    };
    const insertHandler = (event: Event) => {
      const ce = event as CustomEvent<{ text: string }>;
      const text = ce.detail?.text;
      if (typeof text === 'string' && text.length > 0) {
        onInsertText(text);
        taRef.current?.focus();
      }
    };
    window.addEventListener(FOCUS_COMPOSER_EVENT, focusHandler);
    window.addEventListener(INSERT_COMPOSER_TEXT_EVENT, insertHandler);
    return () => {
      window.removeEventListener(FOCUS_COMPOSER_EVENT, focusHandler);
      window.removeEventListener(INSERT_COMPOSER_TEXT_EVENT, insertHandler);
    };
  }, [taRef, onInsertText]);

  // v4 §16.2: Auto-grow textarea — value-driven, not event-driven
  const MAX_H = 360;
  const resizeTextarea = useCallback(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const next = Math.min(el.scrollHeight, MAX_H);
    el.style.height = next + 'px';
    el.style.overflowY = el.scrollHeight > MAX_H ? 'auto' : 'hidden';
  }, [taRef]);

  useLayoutEffect(() => { resizeTextarea(); }, [input, resizeTextarea]);

  return (
    <>
      {showToolsDropdown && (
        <div className="absolute bottom-full mb-2 left-2 z-10 w-64 bg-card border border-border shadow-2xl rounded-xl p-1.5 space-y-0.5 animate-in fade-in slide-in-from-bottom-2 duration-150">
          <div className="px-2 py-1 text-[10px] text-muted-foreground uppercase font-semibold">Mention Tool</div>
          {tools.map((t) => (
            <button
              key={t.name}
              onClick={() => {
                onInsertText(t.name);
                onToggleToolsDropdown(false);
                onToggleCommandsDropdown(false);
              }}
              className="w-full text-left rounded-md px-2.5 py-1.5 text-xs text-foreground/80 hover:bg-muted hover:text-foreground transition flex items-center justify-between"
            >
              <span className="font-mono font-medium text-primary">{t.name}</span>
              <span className="text-[10px] text-muted-foreground">{t.desc}</span>
            </button>
          ))}
        </div>
      )}

      {showCommandsDropdown && (
        <div className="absolute bottom-full mb-2 left-2 z-10 w-64 bg-card border border-border shadow-2xl rounded-xl p-1.5 space-y-0.5 animate-in fade-in slide-in-from-bottom-2 duration-150">
          <div className="px-2 py-1 text-[10px] text-muted-foreground uppercase font-semibold">Commands & Tools</div>
          {commands.filter(c => !input || c.name.startsWith(input)).map((c) => (
            <button
              key={c.name}
              onClick={() => {
                onInsertText(c.name);
                onToggleCommandsDropdown(false);
                onToggleToolsDropdown(false);
              }}
              className="w-full text-left rounded-md px-2.5 py-1.5 text-xs text-foreground/80 hover:bg-muted hover:text-foreground transition flex items-center justify-between"
            >
              <span className="font-mono font-medium text-warning">{c.name}</span>
              <span className="text-[10px] text-muted-foreground">{c.desc}</span>
            </button>
          ))}
        </div>
      )}

      <div className={cn(
        'w-full min-w-0 rounded-2xl border bg-card shadow-sm transition focus-within:ring-2 focus-within:ring-primary/40 focus-within:border-primary overflow-visible',
        'border-border',
      )}>
        {voiceActive ? (
          <div className="h-[128px] w-full flex flex-col items-center justify-center bg-background/90 backdrop-blur-sm space-y-2 text-foreground">
            <div className="flex items-center gap-1">
              <span className="w-1 h-4 bg-primary rounded animate-pulse" />
              <span className="w-1 h-6 bg-primary rounded animate-pulse" style={{ animationDelay: '150ms' }} />
              <span className="w-1 h-8 bg-primary rounded animate-pulse" style={{ animationDelay: '300ms' }} />
              <span className="w-1 h-5 bg-primary rounded animate-pulse" style={{ animationDelay: '450ms' }} />
              <span className="w-1 h-3 bg-primary rounded animate-pulse" style={{ animationDelay: '600ms' }} />
            </div>
            <span className="text-xs font-semibold tracking-wide text-primary animate-pulse">August is listening…</span>
          </div>
        ) : (
          <>
            {attachments.length > 0 && (
              <div className="flex flex-wrap gap-1.5 p-2 bg-muted/20 border-b border-border">
                {attachments.map((file, i) => (
                  <div key={i} className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-muted border border-border text-[10.5px] font-mono">
                    <span className="truncate max-w-[150px]">{file.name}</span>
                    <button
                      onClick={() => onRemoveAttachment(i)}
                      className="p-0.5 hover:bg-background rounded text-muted-foreground hover:text-foreground transition"
                      aria-label={`Remove ${file.name}`}
                    >
                      <X className="size-2.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <textarea
              ref={taRef}
              value={input}
              onChange={(e) => onInputChange(e.target.value)}
              onKeyDown={onKey}
              placeholder={
                streaming
                  ? 'Add a direction while August works…'
                  : currentModel
                    ? `Message ${currentModel.name}…`
                    : 'Message August…'
              }
              rows={1}
              className="w-full resize-none bg-transparent px-4 pt-3 pb-1.5 bubble-body outline-none placeholder:text-muted-foreground"
              style={{ minHeight: '64px', maxHeight: '360px' }}
            />
          </>
        )}

        <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 px-1.5 pb-1.5">
          <div className="flex items-center text-muted-foreground">
            <ToolBtn Icon={Paperclip} label="Attach file" onClick={onOpenFilePicker} />
            <ToolBtn Icon={AtSign} label="Mention tool" onClick={() => { onToggleToolsDropdown(!showToolsDropdown); onToggleCommandsDropdown(false); }} />
            <ToolBtn Icon={Mic} label="Voice input" onClick={onStartVoiceInput} />
          </div>
          <div className="flex items-center gap-2">
            <ModelDropdown
              models={models}
              visibleModels={visibleModels}
              loading={modelsLoading}
              selected={selectedModel}
              onRefresh={() => onRefreshModels(true)}
              onEditModels={onEditModels}
              onSelect={onSelectModel}
              onToggleModelVisibility={onToggleModelVisibility}
              onSetModelVisibilityOpen={onSetModelVisibilityOpen}
              onSetSessionModel={onSetSessionModel}
              sessionId={sessionId}
            />
            {selectedModel?.supportsReasoning && (
              <EffortDropdown value={effort} onChange={onEffortChange} />
            )}

            {streaming ? (
              <>
                <Button
                  onClick={onSend}
                  disabled={!input.trim() && attachments.length === 0}
                  size="sm"
                  variant="secondary"
                  title="Steer August mid-run — applies after the current tool step"
                >
                  <Send className="size-3" />
                  Add direction
                </Button>
                <Button onClick={onStop} size="sm" variant="outline">
                  <StopCircle className="size-3" /> Stop
                </Button>
              </>
            ) : (
              <Button onClick={onSend} disabled={!input.trim() && attachments.length === 0} size="sm">
                <Send className="size-3" />
                Send
                <kbd className="ml-1 rounded bg-muted/30 border border-border/30 px-1 text-[11px] font-mono">↵</kbd>
              </Button>
            )}
          </div>
        </div>
      </div>

      <div className="flex items-center justify-end mt-1 px-1">
        <ContextRing pct={pct} estTokens={estTokens} maxContext={maxContext} modelName={currentModel?.name} />
      </div>
    </>
  );
}

function ToolBtn({ Icon, label, onClick }: { Icon: LucideIcon; label: string; onClick?: () => void }) {
  return (
    <button
      onClick={onClick}
      className="p-1.5 rounded-lg hover:bg-muted hover:text-foreground transition text-muted-foreground"
      title={label}
    >
      <Icon className="size-4" />
    </button>
  );
}

function ModelDropdown({
  models,
  visibleModels,
  loading,
  selected,
  onSelect,
  onRefresh,
  onEditModels,
  onToggleModelVisibility: _onToggleModelVisibility,
  onSetModelVisibilityOpen,
  onSetSessionModel,
  sessionId,
}: {
  models: ModelItem[];
  visibleModels: ModelItem[];
  loading: boolean;
  selected: ModelItem | null;
  onSelect: (model: ModelItem | null) => void;
  onRefresh: () => void;
  onEditModels: () => void;
  onToggleModelVisibility: (modelId: string) => void;
  onSetModelVisibilityOpen: (open: boolean) => void;
  onSetSessionModel: (sessionId: string | null | undefined, modelId: string, provider: string) => void;
  sessionId: string | null | undefined;
}) {
  const [open, setOpen] = useState(false);
  const label = selected
    ? `${selected.name}${selected.provider ? ` · ${selected.provider}` : ''}`
    : models.length === 0
      ? 'No model loaded'
      : 'Choose model';

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v: boolean) => !v)}
        className="px-2.5 py-1 rounded-md text-xs bg-muted hover:bg-muted/70 text-foreground border border-border/60 max-w-[140px] truncate"
        title={label}
      >
        {loading ? 'Loading…' : label}
      </button>
      {open && (
        <div className="absolute right-0 bottom-full mb-2 w-72 max-h-96 overflow-y-auto bg-card border border-border rounded-xl shadow-2xl p-1.5 z-20">
          <div className="flex items-center justify-between px-2 py-1.5 border-b border-border/70 mb-1">
            <div>
              <div className="text-[11px] font-semibold">Model</div>
              <div className="text-[10px] text-muted-foreground">Available to this session</div>
            </div>
            <button
              onClick={() => {
                setOpen(false);
                onEditModels();
              }}
              className="text-[10px] text-primary hover:text-primary/80"
            >
              Edit
            </button>
          </div>
          <button
            onClick={onRefresh}
            className="w-full text-left px-2 py-1.5 text-[11px] text-muted-foreground hover:bg-muted rounded-md"
          >
            Refresh models
          </button>
          {visibleModels.map((m) => (
            <button
              key={m.id}
              onClick={() => {
                onSelect(m);
                onSetSessionModel(sessionId, m.id, m.provider);
                setOpen(false);
              }}
              className={cn(
                'w-full text-left px-2 py-1.5 rounded-md text-xs hover:bg-muted transition',
                selected?.id === m.id && 'bg-primary/10 text-primary'
              )}
            >
              <div className="font-medium">{m.name}</div>
              <div className="text-[10px] text-muted-foreground flex items-center justify-between">
                <span>
                  {m.provider} · {m.contextWindow.toLocaleString()} ctx
                </span>
                <span className="flex gap-1">
                  {m.isFree && <span className="text-success">free</span>}
                  {m.supportsThinking && <span className="text-warning">thinking</span>}
                </span>
              </div>
            </button>
          ))}
          {models.length > visibleModels.length && (
            <button
              onClick={() => {
                onSetModelVisibilityOpen(true);
                setOpen(false);
              }}
              className="w-full text-left px-2 py-1.5 text-[11px] text-primary hover:bg-primary/10 rounded-md mt-1"
            >
              Show {models.length - visibleModels.length} hidden model{models.length - visibleModels.length === 1 ? '' : 's'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function EffortDropdown({ value, onChange }: { value: 'low' | 'medium' | 'high' | 'max'; onChange: (value: 'low' | 'medium' | 'high' | 'max') => void }) {
  const [open, setOpen] = useState(false);
  const options = ['low', 'medium', 'high', 'max'] as const;

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v: boolean) => !v)}
        className="px-2.5 py-1 rounded-md text-xs bg-muted hover:bg-muted/70 text-foreground border border-border/60 capitalize"
      >
        {value}
      </button>
      {open && (
        <div className="absolute right-0 bottom-full mb-2 w-32 bg-card border border-border rounded-xl shadow-2xl p-1.5 z-20">
          {options.map((option) => (
            <button
              key={option}
              onClick={() => {
                onChange(option);
                setOpen(false);
              }}
              className={cn(
                'w-full text-left px-2 py-1.5 rounded-md text-xs hover:bg-muted transition capitalize',
                value === option && 'bg-primary/10 text-primary'
              )}
            >
              {option}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
