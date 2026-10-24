/* ── DocsPage — browse a project's Nessa Docs system map ────────────────
 *
 * The reading half of `skills/nessa-docs`. Upstream ships a standalone Vite app
 * for this; August already has the catalog rules in
 * `app/services/docs_state.py`, so what was missing was a surface.
 *
 * Three decisions worth stating:
 *
 * **The tree comes from `parent`, never from the folder layout.** That is the
 * contract's own rule ("metadata owns navigation; do not add a second navigation
 * manifest"), and it is why the validator reports a folder/parent disagreement
 * as a warning rather than an error — the page still has exactly one place in
 * the tree, and that place is decided by its metadata.
 *
 * **Mermaid fences are lifted out before markdown rendering.** Handing a
 * diagram to `Markdown` produces a `<pre><code>` block, and post-processing that
 * into a diagram means fighting the renderer's own block cache. Splitting the
 * source into text and diagram segments keeps each renderer doing one job, and
 * it is what lets a diagram carry its own drill-down handlers.
 *
 * **Health is always reachable, never a takeover.** A catalog with three broken
 * pages still has forty good ones. The header shows the counts; the panel opens
 * on click. Replacing the map with an error list would hide the thing the reader
 * came for. */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { BookOpen, CircleAlert, TriangleAlert, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Markdown } from '@/sections/chat/ChatMarkdown';
import { MermaidDiagram } from '@/components/docs/MermaidDiagram';
import {
  fetchDocsCatalog,
  fetchDocsPage,
  type DocsCatalog,
  type DocsPageNode,
} from '@/api/api-client/docs-state';
import { PageLoader } from '@/components/PageLoader';
import { splitMermaidSegments, stripDuplicateTitle } from '@/lib/docs-markdown';
import { cn } from '@/lib/utils';

const PROJECT_KEY = 'august.docsProject';

/** Children of `parentId` in catalog order, so the tree follows the same
 *  sequence the validator walked rather than a second sort. */
function childrenOf(catalog: DocsCatalog, parentId: string | null): DocsPageNode[] {
  return catalog.pages.filter((p) => (p.parent ?? null) === parentId);
}

const STATUS_TONE: Record<string, string> = {
  implemented: 'text-foreground/70 border-hairline',
  mixed: 'text-warning-fg border-warning/40',
  fixture: 'text-muted-foreground border-hairline',
  proposed: 'text-primary/80 border-primary/30',
  reference: 'text-muted-foreground border-hairline',
};

export function DocsPage() {
  const [project, setProject] = useState<string>(
    () => localStorage.getItem(PROJECT_KEY) || '',
  );
  const [catalog, setCatalog] = useState<DocsCatalog | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [body, setBody] = useState('');
  const [bodyLoading, setBodyLoading] = useState(false);
  const [showHealth, setShowHealth] = useState(false);
  const [detail, setDetail] = useState<string | null>(null);

  const open = useCallback(async (path: string) => {
    setLoading(true);
    setLoadError(null);
    try {
      const next = await fetchDocsCatalog(path);
      setCatalog(next);
      setSelected(next.roots[0] ?? next.pages[0]?.id ?? null);
      if (!next.found) {
        setLoadError(next.health.issues[0]?.message ?? 'No catalog at that path.');
      }
    } catch (exc) {
      setCatalog(null);
      setLoadError(exc instanceof Error ? exc.message : String(exc));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (project.trim()) void open(project.trim());
  }, [project, open]);

  const page = useMemo(
    () => catalog?.pages.find((p) => p.id === selected) ?? null,
    [catalog, selected],
  );

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    if (!page || !catalog) {
      setBody('');
      return;
    }
    setBodyLoading(true);
    void fetchDocsPage(catalog.projectRoot, page.id)
      .then((res) => {
        if (cancelled) return;
        setBody(res.found ? res.body : '');
      })
      .catch(() => {
        if (!cancelled) setBody('');
      })
      .finally(() => {
        if (!cancelled) setBodyLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [page, catalog]);

  const segments = useMemo(
    () => splitMermaidSegments(page ? stripDuplicateTitle(body, page.title) : body),
    [body, page],
  );
  const ancestors = useMemo(() => {
    const chain: DocsPageNode[] = [];
    let cursor = page?.parent ?? null;
    const seen = new Set<string>();
    while (cursor && catalog && !seen.has(cursor)) {
      seen.add(cursor);
      const next = catalog.pages.find((p) => p.id === cursor);
      if (!next) break;
      chain.unshift(next);
      cursor = next.parent;
    }
    return chain;
  }, [page, catalog]);

  const health = catalog?.health;

  return (
    <div className="flex h-full min-h-0 w-full" data-testid="docs-page">
      {/* Tree rail */}
      <aside className="flex min-h-0 w-64 shrink-0 flex-col overflow-hidden border-r border-sidebar-border bg-sidebar/60">
        <div className="space-y-2 border-b border-sidebar-border p-3">
          <form
            className="flex gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              localStorage.setItem(PROJECT_KEY, project.trim());
              void open(project.trim());
            }}
          >
            <Input
              value={project}
              onChange={(e) => setProject(e.target.value)}
              placeholder="Project path"
              aria-label="Project folder to document"
              className="min-w-0 flex-1 text-xs"
            />
            <Button type="submit" size="sm" variant="outline" aria-label="Open project">
              <RefreshCw className="size-3.5" />
            </Button>
          </form>
          {health ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setShowHealth((v) => !v)}
              className="flex h-auto w-full justify-start gap-2 rounded-lg px-1 py-1 text-left text-2xs font-normal text-muted-foreground transition hover:bg-transparent hover:text-foreground"
              data-testid="docs-health-toggle"
            >
              {health.errors > 0 ? (
                <CircleAlert className="size-3 shrink-0 text-destructive" />
              ) : health.warnings > 0 ? (
                <TriangleAlert className="size-3 shrink-0 text-warning-fg" />
              ) : (
                <BookOpen className="size-3 shrink-0" />
              )}
              <span>
                {health.errors} errors · {health.warnings} warnings ·{' '}
                {catalog?.pages.length ?? 0} pages
              </span>
            </Button>
          ) : null}
        </div>

        <nav className="min-h-0 flex-1 overflow-y-auto p-2" aria-label="Documentation">
          {loading ? (
            <PageLoader label="Loading catalog…" className="px-1 py-2" />
          ) : !catalog || !catalog.found ? (
            <p className="px-2 py-3 text-xs text-muted-foreground">
              {loadError ?? 'Enter a project path above.'}
            </p>
          ) : (
            <ul className="space-y-0.5">
              {childrenOf(catalog, null).map((root) => (
                <TreeItem
                  key={root.id}
                  node={root}
                  catalog={catalog}
                  depth={0}
                  selected={selected}
                  onSelect={setSelected}
                />
              ))}
            </ul>
          )}
        </nav>
      </aside>

      {/* Content */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {showHealth && health ? (
          <div
            className="border-b border-hairline bg-muted/30 px-8 py-4"
            data-testid="docs-health-panel"
          >
            <h2 className="text-sm font-medium">Catalog health</h2>
            {health.issues.length === 0 ? (
              <p className="mt-1 text-xs text-muted-foreground">
                Every page parses, every parent resolves and every drill-down
                target exists.
              </p>
            ) : (
              <ul className="mt-2 space-y-1.5">
                {health.issues.map((issue, i) => (
                  <li key={i} className="flex gap-2 text-xs">
                    <span
                      className={cn(
                        'shrink-0 font-medium',
                        issue.severity === 'error'
                          ? 'text-destructive'
                          : 'text-warning-fg',
                      )}
                    >
                      {issue.severity}
                    </span>
                    <span className="min-w-0 flex-1 text-muted-foreground">
                      {issue.message}
                      <span className="ml-1 break-all opacity-60">({issue.path})</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}

        {!page ? (
          <div className="flex flex-1 items-center justify-center px-8 text-sm text-muted-foreground">
            {loading ? 'Loading…' : 'No page selected.'}
          </div>
        ) : (
          <article className="mx-auto w-full max-w-3xl px-8 py-8">
            <nav className="mb-2 flex flex-wrap items-center gap-1 text-2xs text-muted-foreground">
              {ancestors.map((a) => (
                <span key={a.id}>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-auto px-0 text-2xs font-normal underline-offset-2 hover:bg-transparent hover:underline"
                    onClick={() => setSelected(a.id)}
                  >
                    {a.title}
                  </Button>
                  <span className="px-1">/</span>
                </span>
              ))}
            </nav>
            <h1 className="text-xl font-semibold">{page.title}</h1>
            <div className="mt-2 flex flex-wrap items-center gap-1.5 text-2xs">
              <span className="rounded-full border border-hairline px-2 py-0.5 text-muted-foreground">
                {page.kind}
              </span>
              <span
                className={cn(
                  'rounded-full border px-2 py-0.5',
                  STATUS_TONE[page.status] ?? 'border-hairline text-muted-foreground',
                )}
              >
                {page.status}
              </span>
              <span className="text-muted-foreground/70">
                {page.sourceRevision
                  ? `Source reviewed at ${page.sourceRevision.slice(0, 10)}`
                  : 'Source revision not recorded.'}
              </span>
            </div>
            <p className="mt-3 text-sm text-muted-foreground">{page.summary}</p>

            {page.sources.length > 0 ? (
              <details className="mt-3 text-xs">
                <summary className="cursor-pointer text-muted-foreground">
                  Sources ({page.sources.length})
                </summary>
                <ul className="mt-1 space-y-0.5 pl-4">
                  {page.sources.map((s) => (
                    <li key={s} className="list-disc break-all text-muted-foreground/80">
                      {s}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}

            <hr className="my-5 border-hairline" />

            {bodyLoading ? (
              <PageLoader label="Loading page…" />
            ) : (
              segments.map((seg, i) =>
                seg.kind === 'text' ? (
                  /* No `demoteHeadings` here. That prop exists for the settings
                   * dialog, where every section heading is already an h2; with
                   * it on this page the body's `##` rendered as h3 under the
                   * h1 title, skipping a level. The duplicate-title strip
                   * above is what keeps the page from carrying two h1s. */
                  <Markdown
                    key={i}
                    content={seg.value}
                    variant="assistant"
                  />
                ) : (
                  <MermaidDiagram
                    key={i}
                    code={seg.value}
                    links={page.diagramLinks}
                    details={page.diagramDetails}
                    onNavigate={(id) => setSelected(id)}
                    onOpenDetail={(heading) => setDetail(heading)}
                    className="my-4 rounded-xl border border-hairline bg-muted/20 p-3"
                  />
                ),
              )
            )}

            {detail ? (
              <div
                className="mt-5 rounded-xl border border-hairline bg-muted/30 p-4"
                data-testid="docs-detail-panel"
              >
                <div className="flex items-start justify-between gap-3">
                  <h2 className="text-sm font-medium">{detail}</h2>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label="Close explanation"
                    onClick={() => setDetail(null)}
                  >
                    Close
                  </Button>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  This explanation is authored in the document itself. Scroll to
                  the heading above to read it.
                </p>
              </div>
            ) : null}
          </article>
        )}
      </div>
    </div>
  );
}

function TreeItem({
  node,
  catalog,
  depth,
  selected,
  onSelect,
}: {
  node: DocsPageNode;
  catalog: DocsCatalog;
  depth: number;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const kids = childrenOf(catalog, node.id);
  const [open, setOpen] = useState(depth < 1);
  return (
    <li>
      <div className="flex items-center gap-0.5">
        {kids.length > 0 ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-expanded={open}
            aria-label={open ? `Collapse ${node.title}` : `Expand ${node.title}`}
            onClick={() => setOpen((v) => !v)}
            className="h-auto shrink-0 rounded p-1 text-muted-foreground hover:bg-transparent hover:text-foreground"
          >
            {open ? '▾' : '▸'}
          </Button>
        ) : (
          <span className="w-5 shrink-0" aria-hidden />
        )}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => onSelect(node.id)}
          aria-current={selected === node.id ? 'page' : undefined}
          className={cn(
            'h-auto min-w-0 flex-1 justify-start truncate rounded px-1.5 py-1 text-left text-xs font-normal transition',
            selected === node.id
              ? 'bg-white/[0.08] text-foreground hover:bg-white/[0.08]'
              : 'text-muted-foreground hover:bg-white/[0.04] hover:text-foreground',
          )}
          title={node.summary}
        >
          {node.title}
        </Button>
      </div>
      {open && kids.length > 0 ? (
        <ul className="ml-3 border-l border-hairline/60 pl-1">
          {kids.map((k) => (
            <TreeItem
              key={k.id}
              node={k}
              catalog={catalog}
              depth={depth + 1}
              selected={selected}
              onSelect={onSelect}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}
