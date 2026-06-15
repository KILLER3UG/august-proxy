import { useState, type RefObject } from 'react';
import { Paperclip, AtSign, Mic, Send, StopCircle, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

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
  fileInputRef,
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
              <span className="font-mono font-medium text-amber-500">{c.name}</span>
              <span className="text-[10px] text-muted-foreground">{c.desc}</span>
            </button>
          ))}
        </div>
      )}

      <div className={cn(
        'rounded-2xl border bg-card shadow-sm transition focus-within:ring-2 focus-within:ring-primary/40 focus-within:border-primary overflow-visible',
        'border-border',
      )}>
        {voiceActive ? (
          <div className="h-[96px] w-full flex flex-col items-center justify-center bg-background/90 backdrop-blur-sm space-y-2 text-foreground">
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
                    <span className="text-[9px] text-muted-foreground">({file.size})</span>
                    <button
                      onClick={() => onRemoveAttachment(i)}
                      className="p-0.5 hover:bg-background rounded text-muted-foreground hover:text-foreground transition"
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
              onChange={(e) => {
                onInputChange(e.target.value);
                e.target.style.height = 'auto';
                e.target.style.height = Math.min(e.target.scrollHeight, 240) + 'px';
              }}
              onKeyDown={onKey}
              placeholder={streaming ? 'August is working…' : (currentModel ? `Message ${currentModel.name}…` : 'Type a message…')}
              rows={1}
              disabled={streaming}
              className="w-full resize-none bg-transparent px-4 pt-3 pb-1 text-xs outline-none placeholder:text-muted-foreground disabled:opacity-60"
              style={{ minHeight: '40px', maxHeight: '240px' }}
            />
          </>
        )}

        <div className="flex items-center justify-between px-1.5 pb-1.5">
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
              <Button onClick={onStop} size="sm" variant="outline">
                <StopCircle className="size-3" /> Stop
              </Button>
            ) : (
              <Button onClick={onSend} disabled={!input.trim() && attachments.length === 0} size="sm">
                <Send className="size-3" />
                Send
                <kbd className="ml-1 rounded bg-muted/20 border border-border/20 px-1 text-[10px] font-mono">↵</kbd>
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

function ToolBtn({ Icon, label, onClick }: { Icon: any; label: string; onClick?: () => void }) {
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
  onToggleModelVisibility,
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
  const label = selected ? `${selected.name}${selected.provider ? ` · ${selected.provider}` : ''}` : 'Choose model';

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v: boolean) => !v)}
        className="px-2 py-1 rounded-md text-[11px] bg-muted hover:bg-muted/70 text-foreground border border-border/50 max-w-[180px] truncate"
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
                <span>{m.provider} · {m.contextWindow.toLocaleString()} ctx</span>
                <span className="flex gap-1">
                  {m.isFree && <span className="text-green-600">free</span>}
                  {m.supportsThinking && <span className="text-amber-600">thinking</span>}
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
        className="px-2 py-1 rounded-md text-[11px] bg-muted hover:bg-muted/70 text-foreground border border-border/50 capitalize"
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

/* ── Context usage ring — compact, details on hover ─────────────────── */
/* A ~22px donut showing how full the context window is. Idle state shows
 * just the ring + centered %; hovering reveals a tooltip card with the
 * exact token counts and the active model. Keeps the composer calm for
 * beginners while keeping every detail one hover away. */
export function ContextRing({
  pct,
  estTokens,
  maxContext,
  modelName,
  size = 22,
  stroke = 3,
}: {
  pct: number;
  estTokens: number;
  maxContext: number;
  modelName?: string;
  size?: number;
  stroke?: number;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(100, pct));
  const dash = (clamped / 100) * c;
  const tone = clamped > 80 ? 'var(--dt-destructive)' : clamped > 60 ? '#f59e0b' : 'var(--dt-primary)';
  const [hovered, setHovered] = useState(false);

  return (
    <div
      className="relative inline-flex items-center"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <svg width={size} height={size} className="-rotate-90 shrink-0" aria-label={`${clamped}% of context used`}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--dt-muted)" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={tone}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${dash} ${c - dash}`}
          style={{ transition: 'stroke-dasharray 0.3s ease, stroke 0.3s ease' }}
        />
      </svg>
      <span className="absolute inset-0 grid place-items-center text-[8px] font-mono tabular-nums text-muted-foreground pointer-events-none">
        {clamped}
      </span>

      {hovered && (
        <div className="absolute right-0 bottom-full mb-2 z-30 w-44 bg-card border border-border rounded-lg shadow-2xl p-2.5 text-left animate-in fade-in slide-in-from-bottom-1 duration-100">
          <div className="flex items-center justify-between text-[11px] mb-1.5">
            <span className="text-muted-foreground">Context</span>
            <span className="font-mono font-semibold tabular-nums" style={{ color: tone }}>{clamped}%</span>
          </div>
          <div className="h-1 rounded-full bg-muted overflow-hidden mb-2">
            <div className="h-full rounded-full transition-all duration-300" style={{ width: `${clamped}%`, backgroundColor: tone }} />
          </div>
          <div className="flex items-center justify-between text-[10px] text-muted-foreground font-mono tabular-nums">
            <span>{estTokens.toLocaleString()} used</span>
            <span>{maxContext.toLocaleString()} max</span>
          </div>
          {modelName && (
            <div className="mt-2 pt-2 border-t border-border/60 text-[10px] text-muted-foreground truncate">
              <span className="opacity-60">Model · </span>{modelName}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
