/* ── UI Designer — customize colors with live preview + Apply ──────── */
/* Draft edits update the preview only. Apply paints the real app.      */

import { useMemo } from 'react';
import {
  Palette,
  Check,
  RotateCcw,
  Undo2,
  MessageSquare,
  Settings2,
  PanelLeft,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { SettingsCard } from '@/components/settings/SettingsCard';
import {
  UI_TOKEN_DEFS,
  useUiCustomizationStore,
  setDraftToken,
  resetDraftToken,
  resetAllDraft,
  discardDraftToApplied,
  applyDraftCustomization,
  resetAppliedCustomization,
  draftToPreviewStyle,
  draftIsDirty,
  readComputedToken,
  toColorInputValue,
  type UiTokenId,
  type UiTokenDef,
} from '@/lib/ui-customization';

const GROUPS: { id: UiTokenDef['group']; label: string; hint: string }[] = [
  { id: 'app', label: 'App & settings', hint: 'Background, cards, text, borders' },
  { id: 'chat', label: 'Chat', hint: 'Composer / input chrome' },
  { id: 'sidebar', label: 'Session sidebar', hint: 'Left rail colors' },
  { id: 'brand', label: 'Brand & focus', hint: 'Primary buttons and rings' },
];

export function UiDesignerSection() {
  const draft = useUiCustomizationStore((s) => s.draft);
  const applied = useUiCustomizationStore((s) => s.applied);
  const dirty = draftIsDirty(draft, applied);
  const previewStyle = useMemo(() => draftToPreviewStyle(draft), [draft]);
  const hasApplied = Object.keys(applied).length > 0;

  const effective = (id: UiTokenId, cssVar: string): string => {
    const d = draft[id];
    if (d) return toColorInputValue(d);
    return readComputedToken(cssVar);
  };

  const onApply = () => {
    applyDraftCustomization();
    toast.success('UI theme applied', {
      description: 'Colors are live across the app and saved for next launch.',
    });
  };

  const onResetAll = () => {
    resetAppliedCustomization();
    toast.message('UI theme reset', {
      description: 'Restored default light/dark theme tokens.',
    });
  };

  return (
    <div className="flex h-full flex-col">
      <header className="px-6 pt-5 pb-4 shrink-0 border-b border-border/60">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold tracking-tight text-foreground">UI Designer</h2>
            <p className="mt-1 text-sm leading-5 text-muted-foreground max-w-2xl">
              Design colors for the app background, chat input, session sidebar, settings surfaces, and brand accents.
              Changes update the preview live — press <strong className="text-foreground/90">Apply</strong> to paint the real UI.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 shrink-0">
            {dirty && (
              <Badge variant="outline" className="font-mono text-[10px]">
                unsaved draft
              </Badge>
            )}
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => discardDraftToApplied()}
              disabled={!dirty}
              title="Discard draft and match what is currently applied"
            >
              <Undo2 className="size-3.5" />
              Discard
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                resetAllDraft();
                toast.message('Draft cleared');
              }}
            >
              <RotateCcw className="size-3.5" />
              Clear draft
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={onResetAll}
              disabled={!hasApplied && !dirty}
              title="Remove all custom colors from the real app"
            >
              Reset app
            </Button>
            <Button type="button" size="sm" onClick={onApply} disabled={!dirty}>
              <Check className="size-3.5" />
              Apply
            </Button>
          </div>
        </div>
      </header>

      <div className="flex-1 min-h-0 overflow-auto">
        <div className="grid gap-4 p-6 lg:grid-cols-[minmax(0,1fr)_minmax(320px,420px)] lg:items-start">
          {/* Controls */}
          <div className="space-y-4 min-w-0">
            {GROUPS.map((g) => {
              const tokens = UI_TOKEN_DEFS.filter((t) => t.group === g.id);
              return (
                <SettingsCard
                  key={g.id}
                  icon={g.id === 'sidebar' ? PanelLeft : g.id === 'chat' ? MessageSquare : g.id === 'brand' ? Palette : Settings2}
                  title={g.label}
                  description={g.hint}
                  inert
                >
                  <div className="space-y-2">
                    {tokens.map((t) => {
                      const value = effective(t.id, t.cssVar);
                      const overridden = Boolean(draft[t.id]);
                      return (
                        <div
                          key={t.id}
                          className="flex items-center gap-3 rounded-lg border border-border/70 bg-muted/20 px-3 py-2"
                        >
                          <label className="relative size-9 shrink-0 cursor-pointer overflow-hidden rounded-lg border border-border shadow-sm">
                            <span
                              className="absolute inset-0"
                              style={{ backgroundColor: value }}
                              aria-hidden
                            />
                            <input
                              type="color"
                              className="absolute inset-0 cursor-pointer opacity-0"
                              value={value}
                              onChange={(e) => setDraftToken(t.id, e.target.value)}
                              aria-label={t.label}
                            />
                          </label>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium text-foreground truncate">
                                {t.label}
                              </span>
                              {overridden && (
                                <span className="text-[10px] uppercase tracking-wider text-primary font-semibold">
                                  custom
                                </span>
                              )}
                            </div>
                            <p className="text-[11px] text-muted-foreground truncate">
                              {t.description}
                            </p>
                          </div>
                          <input
                            type="text"
                            value={draft[t.id] ?? ''}
                            placeholder={value}
                            onChange={(e) => {
                              const v = e.target.value.trim();
                              if (!v) resetDraftToken(t.id);
                              else setDraftToken(t.id, v);
                            }}
                            className="w-[6.5rem] shrink-0 rounded-md border border-border bg-background px-2 py-1 font-mono text-[11px] text-foreground outline-none focus:border-primary/50"
                            spellCheck={false}
                            aria-label={`${t.label} hex`}
                          />
                          <button
                            type="button"
                            className="text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-30"
                            disabled={!overridden}
                            onClick={() => resetDraftToken(t.id)}
                          >
                            Clear
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </SettingsCard>
              );
            })}
          </div>

          {/* Live preview — isolated sandbox using draft CSS variables */}
          <div className="lg:sticky lg:top-4 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold text-foreground">Live preview</h3>
                <p className="text-[11px] text-muted-foreground">
                  Reflects draft colors only — not the real app until Apply.
                </p>
              </div>
              {dirty ? (
                <Badge className="bg-primary/15 text-primary border-primary/20">previewing</Badge>
              ) : (
                <Badge variant="outline">in sync</Badge>
              )}
            </div>

            <div
              className="overflow-hidden rounded-2xl border shadow-lg"
              style={{
                ...previewStyle,
                borderColor: 'var(--dt-border)',
                background: 'var(--dt-background)',
                color: 'var(--dt-foreground)',
              }}
              data-testid="ui-designer-preview"
            >
              <div className="flex h-[420px] min-h-0">
                {/* Sidebar mock */}
                <aside
                  className="flex w-[38%] flex-col border-r"
                  style={{
                    background: 'var(--dt-sidebar)',
                    color: 'var(--dt-sidebar-foreground)',
                    borderColor: 'var(--dt-sidebar-border)',
                  }}
                >
                  <div className="px-3 py-2.5 text-[10px] font-semibold uppercase tracking-wider opacity-70">
                    Sessions
                  </div>
                  <div className="space-y-1 px-2">
                    <div
                      className="rounded-lg px-2.5 py-2 text-[12px] font-medium"
                      style={{
                        background: 'var(--dt-sidebar-accent)',
                        color: 'var(--dt-sidebar-accent-foreground, var(--dt-sidebar-foreground))',
                      }}
                    >
                      Current chat
                    </div>
                    <div className="rounded-lg px-2.5 py-2 text-[12px] opacity-75">
                      Older session
                    </div>
                    <div className="rounded-lg px-2.5 py-2 text-[12px] opacity-55">
                      Archive note
                    </div>
                  </div>
                </aside>

                {/* Main / chat mock */}
                <div className="flex min-w-0 flex-1 flex-col" style={{ background: 'var(--dt-background)' }}>
                  <div className="flex-1 space-y-2 overflow-hidden p-3">
                    <div
                      className="ml-auto max-w-[85%] rounded-xl border px-3 py-2 text-[11px]"
                      style={{
                        background: 'var(--dt-card)',
                        borderColor: 'var(--dt-border)',
                        color: 'var(--dt-foreground)',
                      }}
                    >
                      User message preview
                    </div>
                    <div
                      className="max-w-[90%] rounded-xl border px-3 py-2 text-[11px]"
                      style={{
                        background: 'var(--dt-muted)',
                        borderColor: 'var(--dt-border)',
                        color: 'var(--dt-foreground)',
                      }}
                    >
                      <span style={{ color: 'var(--dt-muted-foreground)' }}>Assistant · </span>
                      Recap and tools use these surfaces.
                    </div>
                    <div
                      className="inline-flex items-center rounded-md px-2 py-1 text-[10px] font-medium"
                      style={{
                        background: 'var(--dt-primary)',
                        color: 'var(--dt-primary-foreground)',
                      }}
                    >
                      Primary action
                    </div>
                  </div>

                  {/* Composer mock */}
                  <div className="border-t p-2.5" style={{ borderColor: 'var(--dt-border)' }}>
                    <div
                      className="rounded-xl border px-3 py-2.5 text-[11px]"
                      style={{
                        borderColor: 'var(--dt-input)',
                        background: 'var(--dt-card)',
                        color: 'var(--dt-muted-foreground)',
                        boxShadow: '0 0 0 1px var(--dt-ring)',
                      }}
                    >
                      Enter message… (chat input)
                    </div>
                  </div>
                </div>
              </div>

              {/* Settings strip mock */}
              <div
                className="border-t px-3 py-2.5"
                style={{
                  borderColor: 'var(--dt-border)',
                  background: 'var(--dt-muted)',
                }}
              >
                <div className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--dt-muted-foreground)' }}>
                  Settings card
                </div>
                <div
                  className="mt-1.5 rounded-lg border px-3 py-2 text-[11px]"
                  style={{
                    background: 'var(--dt-card)',
                    borderColor: 'var(--dt-border)',
                    color: 'var(--dt-foreground)',
                  }}
                >
                  Profile, models, and designer use card + muted tokens.
                </div>
              </div>
            </div>

            <p className="text-[11px] leading-relaxed text-muted-foreground">
              Tip: pick colors in the draft, confirm in the preview, then <span className="text-foreground/80">Apply</span>.
              Custom colors override light/dark theme tokens until you use <span className="text-foreground/80">Reset app</span>.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
