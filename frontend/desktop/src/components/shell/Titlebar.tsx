import { useStore } from '@nanostores/react';
import { Command, Sun, Moon, User } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { $theme, toggleTheme } from '@/store/theme';
import { toggleCommandPalette } from '@/store/command-palette';
import { resolveRouteLabel } from '@/routes';

export function Titlebar() {
  const theme = useStore($theme);
  const currentLabel = resolveRouteLabel(location.pathname);

  return (
    <header className="h-12 flex items-center justify-between border-b border-border bg-background/80 backdrop-blur px-3 shrink-0">
      <div className="flex items-center gap-2 min-w-0">
        <h2 className="text-sm font-semibold truncate">{currentLabel}</h2>
      </div>

      <div className="flex items-center gap-1">
        <Button variant="ghost" size="sm" onClick={toggleCommandPalette} className="text-muted-foreground">
          <Command />
          <span className="hidden sm:inline">Search</span>
          <kbd className="ml-1 rounded border border-border bg-muted px-1 text-[10px] font-mono">⌘K</kbd>
        </Button>
        <Button variant="ghost" size="icon-sm" onClick={toggleTheme} aria-label="Toggle theme">
          {theme === 'dark' ? <Sun /> : <Moon />}
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label="Profile menu">
          <User />
        </Button>
      </div>
    </header>
  );
}
