/* ── WorkspaceSelect — themed dropdown used in Model settings ───────── */
/* Native <select> styled to match the dark workspace panel. Avoids the
 * complexity of a fully custom dropdown while keeping a consistent look. */

import { forwardRef, type SelectHTMLAttributes } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

interface Option {
  value: string;
  label: string;
}

interface Props extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'children'> {
  options: Option[];
  /** Optional placeholder option rendered disabled + selected when value is empty. */
  placeholder?: string;
}

export const WorkspaceSelect = forwardRef<HTMLSelectElement, Props>(function WorkspaceSelect(
  { options, placeholder, className, ...rest },
  ref,
) {
  return (
    <div className="relative">
      <select
        ref={ref}
        {...rest}
        className={cn(
          'h-9 w-full appearance-none rounded-md border border-white/[0.08] bg-card px-3 pr-9 text-sm text-foreground outline-none transition',
          'focus:border-primary/60 focus:ring-2 focus:ring-primary/20',
          'disabled:cursor-not-allowed disabled:opacity-50',
          '[color-scheme:dark]',
          className,
        )}
      >
        {placeholder !== undefined && (
          <option value="" disabled className="bg-card text-foreground">
            {placeholder}
          </option>
        )}
        {options.map((o) => (
          <option key={o.value} value={o.value} className="bg-card text-foreground">
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
    </div>
  );
});
