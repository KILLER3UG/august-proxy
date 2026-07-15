import { X, ArrowLeft } from 'lucide-react';
import type { IntegrationCatalogEntry } from '../integrationDirectory';
import type { DirectoryMode } from './DirectoryToolbar';

interface ModalHeaderProps {
  selected: IntegrationCatalogEntry | null;
  mode: DirectoryMode;
  onBack: () => void;
  onClose: () => void;
}

/** Title bar for the Add Integrations dialog — back link when viewing a catalog entry. */
export function ModalHeader({
  selected,
  mode,
  onBack,
  onClose,
}: ModalHeaderProps) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-white/[0.06] px-5 py-4">
      <div>
        {selected ? (
          <button
            type="button"
            onClick={onBack}
            className="mb-1 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-3" /> Back to directory
          </button>
        ) : null}
        <h2 className="text-lg font-semibold text-foreground">
          {selected
            ? selected.name
            : mode === 'custom'
              ? 'Create custom'
              : 'Add integrations'}
        </h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {selected
            ? selected.tagline
            : mode === 'custom'
              ? 'Register your own MCP server by command or URL.'
              : 'Browse extensions for August. Add only what you need — Gmail and Calendar are separate.'}
        </p>
      </div>
      <button
        type="button"
        onClick={onClose}
        className="rounded-lg p-1.5 text-muted-foreground hover:bg-white/[0.06] hover:text-foreground"
        aria-label="Close"
      >
        <X className="size-4" />
      </button>
    </div>
  );
}
