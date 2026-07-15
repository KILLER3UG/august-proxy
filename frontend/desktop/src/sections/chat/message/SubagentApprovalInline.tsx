/**
 * Inline sub-agent approval card. Phase 3 will replace this with the full
 * SubagentApprovalCard once the orchestrator's `propose-breakdown` endpoint
 * is wired. For now this is a no-op stub that surfaces the breakdown items.
 */
export function SubagentApprovalInline({
  breakdown,
  onApprove,
  onCancel,
}: {
  breakdown: Array<{ goal: string; restrictedTools?: string[] }>;
  onApprove: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      data-slot="subagent-approval-inline"
      className="rounded-lg border border-border bg-card p-4 space-y-3 max-w-2xl"
    >
      <div className="text-sm font-semibold text-foreground">
        Subagent plan ({breakdown.length} item{breakdown.length === 1 ? '' : 's'})
      </div>
      {breakdown.length === 0 ? (
        <div className="text-xs text-muted-foreground">No items proposed.</div>
      ) : (
        <ul className="space-y-2">
          {breakdown.map((item, idx) => (
            <li key={idx} className="text-xs space-y-0.5">
              <div className="text-foreground/90">{item.goal}</div>
              {item.restrictedTools && item.restrictedTools.length > 0 && (
                <div className="text-[11px] text-muted-foreground">
                  Tools: {item.restrictedTools.join(', ')}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-2 pt-1">
        <button
          type="button"
          onClick={onApprove}
          className="px-3 py-1 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:opacity-90"
        >
          Approve
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="px-3 py-1 rounded-md border border-border text-xs font-medium hover:bg-muted"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
