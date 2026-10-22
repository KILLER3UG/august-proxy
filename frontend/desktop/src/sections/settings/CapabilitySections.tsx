/* ── Browser Use settings section ────────────────────────────────────── */
/* Browser Use → the live browser/web tool roster (/api/browser/registered-tools).

   The Subagents and Plugins panels that used to live here are gone: the
   delegation limits stay live in the backend and are set from the config file,
   and the plugin roster merged into the single writable Plugins door (the
   integrations panel), which already listed the same MCP servers with the
   ability to add and remove them. */

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { api } from '@/api/client';
import { SectionHeader } from '@/components/SectionHeader';
import { cn } from '@/lib/utils';

/* ── shared bits ─────────────────────────────────────────────────────── */

/**
 * A settings row, in the reference's three-column grammar: NAME on the left
 * (fixed width when `fixedName`, so every value in the list starts at the
 * same x), the VALUE in the flexible middle at THE SAME TYPE SIZE as the
 * name, and the control at the row's RIGHT edge.
 *
 * The value is truncated with a real CSS ellipsis. The old shape cut the
 * string in JS (`slice(0, 110)`), which cut mid-word with no ellipsis at
 * all — "…you need page content — web_s".
 */
function Row({
  label,
  hint,
  fixedName,
  children,
}: {
  label: string;
  hint?: string;
  /** Give the name a fixed width so the value column is a straight line. */
  fixedName?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <div className="flex min-w-0 flex-1 items-baseline gap-3">
        <p
          className={cn(
            'min-w-0 truncate text-sm font-medium text-foreground',
            fixedName && 'w-40 shrink-0',
          )}
        >
          {label}
        </p>
        {hint ? (
          <p className="min-w-0 flex-1 truncate text-sm text-foreground/70">{hint}</p>
        ) : null}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}


function Card({ title, icon, children }: { title: string; icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border/60 bg-card/60 p-5">
      <p className="flex items-center gap-2 text-sm font-medium text-foreground">
        {icon}
        {title}
      </p>
      <div className="mt-2 divide-y divide-white/[0.04]">{children}</div>
    </div>
  );
}

/* ── Browser Use ─────────────────────────────────────────────────────── */

export function BrowserUseSection() {
  // Which browser/web tools the agent is actually offered right now.
  const tools = useQuery({
    queryKey: ['browser-use-tools'],
    queryFn: () =>
      api.get<{ tools: Array<{ name: string; description?: string }> }>(
        '/api/browser/registered-tools',
      ),
  });
  const browserTools = useMemo(
    () =>
      (tools.data?.tools ?? []).filter((t) =>
        /^(browser_|web_search$|web_fetch)/.test(t.name),
      ),
    [tools.data],
  );

  return (
    <div className="px-8 py-6">
      {/* The standard settings header: a bold title and ONE muted subtitle,
          no icon. The section's own icon lived here and the reference's page
          header has none. */}
      <SectionHeader
        title="Browser Use"
        subtitle="Browser automation, web search, and page reading tools the agent can use."
        className="mb-4"
      />

      <div>
        <Card title={`Offered tools (${browserTools.length})`}>
          {tools.isLoading ? (
            <Loader2 className="my-3 size-4 animate-spin text-muted-foreground" />
          ) : browserTools.length === 0 ? (
            <p className="py-3 text-xs text-muted-foreground">
              No browser/web tools registered — check the backend log for registration errors.
            </p>
          ) : (
            browserTools.map((t) => (
              <Row key={t.name} label={t.name} hint={t.description} fixedName>
                <span className="rounded-full border border-success/30 bg-success/10 px-1.5 py-px text-2xs text-success-fg">
                  on
                </span>
              </Row>
            ))
          )}
        </Card>
      </div>

      {/* One line, no box. A bordered panel holding a paragraph of prose was
          the loudest thing on a page whose job is a list of tools. */}
      <p className="mt-4 text-2xs leading-relaxed text-muted-foreground">
        browser_open, browser_get_content and browser_screenshot drive a headless browser; web_search and web_fetch cover search and clean Markdown extraction. Desktop open-in-visible-browser lives under Computer Use.
      </p>
    </div>
  );
}
