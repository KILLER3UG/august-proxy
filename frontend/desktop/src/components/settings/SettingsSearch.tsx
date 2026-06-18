/* ── SettingsSearch — global section search input ─────────────────── */
/* Sits above the sidebar. Filters sections by label/category/description/
 * keywords. Mirrors the search affordance already used in Memory.tsx but
 * wrapped in our Input primitive with a clear button. */

import { Search, X } from 'lucide-react';
import { Input } from '@/components/ui/input';

interface SettingsSearchProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}

export function SettingsSearch({
  value,
  onChange,
  placeholder = 'Search settings…',
}: SettingsSearchProps) {
  return (
    <div className="relative">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label="Search settings"
        className="h-8 pl-8 pr-7 text-xs"
      />
      {value && (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => onChange('')}
          className="absolute right-1.5 top-1/2 -translate-y-1/2 grid size-5 place-items-center rounded text-muted-foreground transition hover:bg-accent hover:text-foreground"
        >
          <X className="size-3" />
        </button>
      )}
    </div>
  );
}
