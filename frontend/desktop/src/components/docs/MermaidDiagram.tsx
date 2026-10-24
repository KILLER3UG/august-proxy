/* MermaidDiagram — render one authored diagram and make its mapped nodes
 * navigate.
 *
 * Three things happen here that a plain `mermaid.render()` does not give you:
 *
 * 1. **mermaid is imported lazily.** It is megabytes of parser and renderer for
 *    a surface most sessions never open, and the app already keeps the circuit
 *    3D chunk off the cold path the same way. A docs page with no diagram in it
 *    never fetches it at all.
 * 2. **`securityLevel: 'strict'`.** The format contract says HTML in a document
 *    is not executed, and these files come off disk. Strict is what makes that
 *    true rather than merely intended.
 * 3. **Drill-down is applied to the rendered SVG**, because `diagramLinks` is
 *    metadata about node ids while mermaid decides what those ids become in the
 *    DOM.
 *
 * The node matching is deliberately not a guess about mermaid's id scheme.
 * Mermaid names a flowchart node `flowchart-<id>-<n>` and a state node
 * `state-<id>-start`, so prefix and suffix both vary by diagram type. Splitting
 * on separators and testing for the mapped token survives both; a substring
 * fallback covers a node id that itself contains a separator. */

import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

let mermaidSeq = 0;

interface Props {
  code: string;
  /** mermaid node id -> document id. Only these nodes navigate. */
  links?: Record<string, string>;
  /** mermaid node id -> a heading in the same document. */
  details?: Record<string, string>;
  onNavigate?: (documentId: string) => void;
  onOpenDetail?: (heading: string) => void;
  className?: string;
}

/** Which mapped key, if any, names this rendered node. */
function matchKey(elementId: string, keys: string[]): string | null {
  if (!elementId || keys.length === 0) return null;
  const tokens = new Set(elementId.split(/[-_]/).filter(Boolean));
  for (const key of keys) if (tokens.has(key)) return key;
  for (const key of keys) if (key.includes('-') && elementId.includes(key)) return key;
  return null;
}

export function MermaidDiagram({
  code,
  links = {},
  details = {},
  onNavigate,
  onOpenDetail,
  className,
}: Props) {
  const host = useRef<HTMLDivElement>(null);
  // Handlers arrive fresh every render; the effect below runs on `code` alone,
  // so it reaches them through a ref rather than closing over a stale pair.
  const handlers = useRef({ onNavigate, onOpenDetail });
  handlers.current = { onNavigate, onOpenDetail };
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setPending(true);
    setError(null);

    // Captured for the cleanup below. Reading `host.current` there is the thing
    // exhaustive-deps warns about: by the time cleanup runs the ref may point at
    // a different node, and the wipe would land on the wrong element.
    const node = host.current;
    void (async () => {
      try {
        const mermaid = (await import('mermaid')).default;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: 'dark',
        });
        const id = `aug-docs-diagram-${(mermaidSeq += 1)}`;
        const rendered = await mermaid.render(id, code);
        if (cancelled || !host.current) return;
        host.current.innerHTML = rendered.svg;
        // The host is never hidden. It starts empty, so there is nothing to
        // flash, and a `hidden` class would still be applied by React when the
        // first browser run measured these boxes — `getBBox()` inside a
        // `display: none` subtree returns a zero rect, which silently dropped
        // every + badge while the click handlers on the same nodes kept working.
        // Ordering a reveal before a measure cannot work either: the state
        // update lands on the next render, after this block has finished.

        const svg = host.current.querySelector('svg');
        if (!svg) return;
        svg.removeAttribute('width');
        svg.setAttribute('style', 'max-width:100%;height:auto;');

        const linkKeys = Object.keys(links);
        const detailKeys = Object.keys(details);
        const nodes = Array.from(svg.querySelectorAll('.node, g.node, .stateGroup, .stateGroup *'));
        const wired = new Set<Element>();

        for (const node of nodes) {
          const el = node as SVGElement;
          if (wired.has(el)) continue;
          const elId = el.id || el.getAttribute('id') || '';
          const target = matchKey(elId, linkKeys);
          const detail = matchKey(elId, detailKeys);
          if (!target && !detail) continue;
          wired.add(el);

          el.style.cursor = 'pointer';
          el.classList.add('aug-docs-actionable');
          el.setAttribute('tabindex', '0');
          el.setAttribute(
            'role',
            'button',
          );
          el.setAttribute(
            'aria-label',
            target
              ? `Open the ${target} document from this diagram node`
              : `Read the explanation for this node`,
          );

          // A + is the contract's own marker for "this node has depth". It goes
          // on as SVG text so it scales with the node it belongs to.
          const bbox =
            typeof (el as SVGGraphicsElement).getBBox === 'function'
              ? (el as SVGGraphicsElement).getBBox()
              : null;
          if (bbox && bbox.width > 0) {
            const badge = document.createElementNS('http://www.w3.org/2000/svg', 'text');
            badge.setAttribute('x', String(bbox.x + bbox.width - 6));
            badge.setAttribute('y', String(bbox.y + 12));
            badge.setAttribute('class', 'aug-docs-plus');
            badge.setAttribute('text-anchor', 'middle');
            badge.textContent = '+';
            el.appendChild(badge);
          }

          const act = () => {
            if (target) handlers.current.onNavigate?.(links[target]);
            else if (detail) handlers.current.onOpenDetail?.(details[detail]);
          };
          el.addEventListener('click', act);
          el.addEventListener('keydown', (event: KeyboardEvent) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              act();
            }
          });
        }
      } catch (exc) {
        if (cancelled) return;
        // A malformed diagram is the AUTHOR's error and belongs on screen with
        // the source under it — silently blanking the box is how a broken
        // statechart gets read as an empty one.
        setError(exc instanceof Error ? exc.message : String(exc));
      } finally {
        if (!cancelled) setPending(false);
      }
    })();

    return () => {
      cancelled = true;
      if (node) node.innerHTML = '';
    };
  }, [code, links, details]);

  if (error) {
    return (
      <div
        className={cn(
          'rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-xs',
          className,
        )}
        role="alert"
        data-testid="mermaid-error"
      >
        <p className="font-medium text-destructive">This diagram did not parse.</p>
        <p className="mt-1 break-words text-muted-foreground">{error}</p>
        <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap text-2xs text-muted-foreground">
          {code}
        </pre>
      </div>
    );
  }

  return (
    <div className={cn('relative', className)}>
      {pending ? (
        <div
          className="flex h-24 items-center justify-center"
          role="status"
          aria-label="Rendering diagram"
        >
          <div className="size-4 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
        </div>
      ) : null}
      <div
        ref={host}
        className="w-full overflow-x-auto"
        data-testid="mermaid-diagram"
      />
    </div>
  );
}
