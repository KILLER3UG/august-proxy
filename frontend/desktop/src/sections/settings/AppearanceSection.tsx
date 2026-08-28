/* ── Appearance — theme + UI color designer ─────────────────────────── */
/* New section from the 2026-08-28 restructure: the theme picker moved
 * out of the old profile-preferences hub, and the UI Designer lives here
 * as a tree sub-item (RAIL_CHILDREN: appearance → ui-designer). Navigating
 * to /settings/ui-designer scrolls the designer into view. */

import { useEffect } from 'react';

import { Sun, Moon, Monitor, Check } from 'lucide-react';
import { useThemeStore, setThemeMode } from '@/lib/theme';
import type { ThemeMode } from '@/lib/theme';
import { SettingsCard } from '@/components/settings/SettingsCard';
import { SettingsTooltip } from '@/components/settings/SettingsTooltip';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { UiDesignerSection } from './UiDesignerSection';
import type { SettingsSection } from '@/settings/settings-registry';

export function AppearanceSection({ active }: { active?: SettingsSection }) {
  const themeMode = useThemeStore((s) => s.mode);

  // Deep link /settings/ui-designer → bring the designer block into view.
  useEffect(() => {
    if (active?.id !== 'ui-designer') return;
    requestAnimationFrame(() => {
      document.getElementById('settings-colors')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
  }, [active?.id]);

  const themeModeIcon =
    themeMode === 'light' ? Sun : themeMode === 'dark' ? Moon : Monitor;

  return (
    <div className="flex h-full flex-col">
      <header className="px-6 pt-5 pb-3 shrink-0">
        <h2 className="text-lg font-semibold tracking-tight text-foreground">Appearance</h2>
        <p className="mt-1 text-sm leading-5 text-muted-foreground">
          Theme and colors — light, dark, or system, plus the UI designer.
        </p>
      </header>

      <div className="flex-1 overflow-auto px-6 pb-6 space-y-4">
        {/* Theme */}
        <SettingsCard
          icon={themeModeIcon}
          title="Theme"
          description={
            <span>
              Choose light, dark, or follow your system.{' '}
              <SettingsTooltip content="System mode follows your operating system's light/dark setting in real time." />
            </span>
          }
          actions={<Badge variant="outline" className="font-mono">{themeMode}</Badge>}
          inert
        >
          <div className="grid grid-cols-3 gap-2">
            <ThemeModeButton mode="light" currentMode={themeMode} onSelect={setThemeMode} Icon={Sun} />
            <ThemeModeButton mode="dark" currentMode={themeMode} onSelect={setThemeMode} Icon={Moon} />
            <ThemeModeButton mode="system" currentMode={themeMode} onSelect={setThemeMode} Icon={Monitor} />
          </div>
        </SettingsCard>

        {/* UI Designer — tree sub-item under Appearance. */}
        <div id="settings-colors" className="scroll-mt-4">
          <UiDesignerSection />
        </div>
      </div>
    </div>
  );
}

interface ThemeModeButtonProps {
  mode: ThemeMode;
  currentMode: ThemeMode;
  onSelect: (mode: ThemeMode) => void;
  Icon: typeof Sun;
}

function ThemeModeButton({ mode, currentMode, onSelect, Icon }: ThemeModeButtonProps) {
  const active = currentMode === mode;
  const label = mode === 'light' ? 'Light' : mode === 'dark' ? 'Dark' : 'System';
  return (
    <button
      onClick={() => onSelect(mode)}
      className={cn(
        'flex items-center gap-2 rounded-lg border px-3 py-2.5 text-sm transition',
        active
          ? 'border-primary bg-primary/5 text-foreground'
          : 'border-border text-muted-foreground hover:bg-muted/40',
      )}
    >
      <Icon className="size-4" />
      {label}
      {active && <Check className="ml-auto size-3.5 text-primary" />}
    </button>
  );
}
