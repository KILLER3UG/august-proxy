/* ── RightDrawerLauncher ─ Workbench panel trigger ────────────────── */
/* Clicking the panel icon opens the drawer straight into the ZCode-style */
/* "Open tab" card-grid chooser (no dropdown list).                        */

import { PanelRight, PanelRightClose } from 'lucide-react';
import {
  closeRightDrawer,
  openRightDrawerChooser,
  useRightDrawer,
  type RightDrawerSectionId,
} from './RightDrawerState';

export function RightDrawerDropdown({
  drawerOpen,
  // Kept for call-site compatibility; the chooser replaced the dropdown.
  onSelect,
  workersBadge = 0,
}: {
  drawerOpen: boolean;
  onSelect?: (section: RightDrawerSectionId) => void;
  workersBadge?: number;
}) {
  void onSelect;
  const state = useRightDrawer();

  return (
    <button
      type="button"
      onClick={() => {
        if (state.open && state.chooserActive) {
          // Second click on the icon while the chooser shows closes the panel.
          closeRightDrawer();
          return;
        }
        openRightDrawerChooser();
      }}
      className="relative size-11 flex items-center justify-center shrink-0 hover:bg-accent text-muted-foreground/60 hover:text-foreground transition"
      title={drawerOpen ? 'Workbench sections' : 'Open Workbench'}
      aria-label={drawerOpen ? 'Workbench sections' : 'Open Workbench'}
      data-testid="workbench-launcher"
    >
      {drawerOpen ? (
        <PanelRightClose className="size-3.5" />
      ) : (
        <PanelRight className="size-3.5" />
      )}
      {workersBadge > 0 ? (
        <span className="absolute right-1.5 top-1.5 min-w-3.5 rounded-full bg-warning px-1 text-[9px] font-semibold leading-4 text-warning-foreground">
          {workersBadge > 9 ? '9+' : workersBadge}
        </span>
      ) : null}
    </button>
  );
}
