import { FolderOpen, Brain, Globe, Package } from 'lucide-react';
import { SiGithub, SiGoogle, SiSlack } from 'react-icons/si';

export type BrandIcon = React.ComponentType<{
  className?: string;
  style?: React.CSSProperties;
}>;

/** Maps catalog brand keys to logo components shown on directory cards and detail. */
export const BRAND_ICON: Record<string, BrandIcon> = {
  google: SiGoogle,
  github: SiGithub,
  slack: SiSlack,
  filesystem: FolderOpen,
  memory: Brain,
  browser: Globe,
};

/** Brand accent colors for well-known logos; others inherit current text color. */
export function brandIconStyle(brand: string): React.CSSProperties | undefined {
  if (brand === 'google') return { color: '#4285F4' };
  if (brand === 'github') return { color: '#E6EDF3' };
  if (brand === 'slack') return { color: '#E01E5A' };
  return undefined;
}

export function resolveBrandIcon(brand: string): BrandIcon {
  return BRAND_ICON[brand] ?? Package;
}
