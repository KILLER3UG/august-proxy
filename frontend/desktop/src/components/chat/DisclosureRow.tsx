import { ChevronRight } from 'lucide-react';
import {
  useCallback,
  useId,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { cn } from '@/lib/utils';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';

/**
 * The channel a body that manages its own presence is handed.
 *
 * `forceMount` + `hidden` is what makes the association honest: the region
 * stays in the DOM while the row is closed and carries a real hidden state
 * — the state a screen reader actually navigates. But `hidden` is
 * `display:none`, and a body that collapses ITSELF (framer-motion) cannot
 * be seen collapsing inside one: the `hidden` lands on the same frame the
 * exit starts, and the collapse is replaced by a cut.
 *
 * So a body that leaves on its own takes the function form of `content` and
 * reports that it is gone. Until then the region stays rendered and the
 * collapse is seen. A body with no exit animation passes a plain node, and
 * the region hides the moment the row closes — exactly as before.
 */
export interface DisclosureBodyApi {
  /** Call when the body has finished animating out. The region is hidden
   *  from that moment on. */
  onBodyExitComplete: () => void;
}

/**
 * DisclosureRow — collapsible row with hover-only caret
 *
 * Collapsible header with a hover-only caret on the right side.
 * The click target is a content-shaped pill (sized to title text, not full row).
 *
 * Built on the same Radix base as `components/ui/task.tsx` (B4's "one component"):
 * the row IS a disclosure now, not a button that a parent happens to pair with a
 * conditionally-rendered body. `content` is optional so the existing callers
 * that pass no body keep their current markup untouched — each one that passes
 * it gets `aria-controls`, a real `aria-expanded`, and a body Radix hides rather
 * than a subtree silently absent from the DOM.
 */
export function DisclosureRow({
  children,
  onToggle,
  open,
  trailing,
  content,
}: {
  children: ReactNode;
  onToggle?: () => void;
  open: boolean;
  trailing?: ReactNode;
  /** The body. A plain node is a body with no exit animation; a function is a
   *  body that manages its own presence (see `DisclosureBodyApi`). */
  content?: ReactNode | ((api: DisclosureBodyApi) => ReactNode);
}) {
  // The association is set here rather than left to Radix: measured on the
  // handoff notice, a CollapsibleTrigger asChild chained through the Button
  // primitive advertised neither aria-controls nor aria-expanded while the body
  // was closed — which is the state a screen reader actually navigates. Owning
  // the ids makes it deterministic and testable.
  const uid = useId();
  const triggerId = `${uid}-trigger`;
  const regionId = `${uid}-content`;

  // A body that leaves on its own owns the moment the region may hide.
  //
  // The region's `hidden` flag is NOT the row's open state when the body
  // animates its own exit: `hidden` is `display:none`, so a region that
  // hides on the frame the row closes cuts the body's collapse short — and
  // worse, framer-motion would measure the collapsing element inside a
  // `display:none` box. For a body that leaves on its own the region stays
  // rendered from the moment the row opens until the body reports that it
  // is gone, and the flag flips in a LAYOUT effect (which React flushes
  // before the browser paints) so it never lags a frame the user can see.
  const selfLeaving = typeof content === 'function';
  const [bodyGone, setBodyGone] = useState(true);
  useLayoutEffect(() => {
    // The body is present (or mounting) again.
    if (open) setBodyGone(false);
  }, [open]);

  const onBodyExitComplete = useCallback(() => {
    setBodyGone(true);
  }, []);
  const bodyApi = useMemo<DisclosureBodyApi>(
    () => ({ onBodyExitComplete }),
    [onBodyExitComplete],
  );

  // Open → the region is visible in the SAME commit the body mounts in, so
  // a mount animation is seen rather than played inside a hidden box.
  // Closed → hidden, unless the body is still animating out.
  const regionHidden = selfLeaving ? !open && bodyGone : !open;

  return (
    <Collapsible
      open={open}
      onOpenChange={() => onToggle?.()}
      className="group/disclosure-row relative flex w-full max-w-full min-w-0 flex-col text-muted-foreground"
    >
      <div className="flex w-full min-w-0 items-start">
        <CollapsibleTrigger asChild disabled={!onToggle}>
          <button
            id={triggerId}
            aria-expanded={onToggle ? open : undefined}
            aria-controls={content !== undefined ? regionId : undefined}
            className={cn(
              'flex min-w-0 max-w-fit items-start gap-1.5 text-left transition-colors',
              onToggle
                ? 'hover:text-foreground focus-visible:text-foreground focus-visible:outline-none'
                : 'cursor-default'
            )}
            disabled={!onToggle}
            type="button"
          >
            <span className="flex min-w-0 flex-col gap-0.5">{children}</span>
            {onToggle && (
              <span
                className={cn(
                  'flex h-5 shrink-0 items-center justify-center transition-opacity duration-150',
                  open
                    ? 'opacity-80'
                    : 'opacity-0 group-hover/disclosure-row:opacity-80 group-focus-within/disclosure-row:opacity-80'
                )}
              >
                <DisclosureCaret open={open} />
              </span>
            )}
          </button>
        </CollapsibleTrigger>
        {trailing && (
          <span className="ml-auto flex h-5 shrink-0 items-center pr-1">{trailing}</span>
        )}
      </div>
      {/* forceMount keeps the region in the DOM with a real `hidden` flag while
          closed. Without it Radix unmounts the content, and a probe measured the
          consequence on the handoff notice: the trigger advertised neither
          aria-controls nor aria-expanded, so the closed disclosure — the exact
          case a screen reader navigates — exposed less than the native
          <details> it replaced.

          The one thing `forceMount` costs is the body's OWN mount animation:
          a motion element that is mounted eagerly (while the region is still
          hidden) finishes animating where nobody can see it, and the row then
          opens on an element that is already at its final state. The body
          therefore mounts LAZILY — it is created in the same commit that
          un-hides this region — and the mount animation is genuinely seen.
          The `hidden` flag is the region's own; the body's exit is the body's,
          and `DisclosureBodyApi` is how the two are kept apart. */}
      {content !== undefined && (
        <CollapsibleContent
          forceMount
          hidden={regionHidden}
          id={regionId}
          role="region"
          aria-labelledby={triggerId}
        >
          {typeof content === 'function' ? content(bodyApi) : content}
        </CollapsibleContent>
      )}
    </Collapsible>
  );
}

function DisclosureCaret({ open }: { open: boolean }) {
  return (
    <ChevronRight
      className={cn(
        'size-3 shrink-0 transition-transform duration-200 text-muted-foreground',
        open && 'rotate-90'
      )}
      strokeWidth={2}
    />
  );
}
