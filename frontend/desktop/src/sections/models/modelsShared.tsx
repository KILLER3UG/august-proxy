import { Card, CardContent } from '@/components/ui/card';
import { Inbox, Boxes, Search, ArrowRightLeft, Calculator, Gauge, Tag } from 'lucide-react';

export type ModelsTab =
  | 'catalog'
  | 'capabilities'
  | 'aliases'
  | 'user-aliases'
  | 'cost'
  | 'quotas';

export const MODELS_TABS: { key: ModelsTab; label: string; Icon: typeof Boxes }[] = [
  { key: 'catalog', label: 'Catalog', Icon: Boxes },
  { key: 'capabilities', label: 'Capabilities', Icon: Search },
  { key: 'aliases', label: 'Aliases', Icon: ArrowRightLeft },
  { key: 'user-aliases', label: 'User Aliases', Icon: Tag },
  { key: 'cost', label: 'Cost estimator', Icon: Calculator },
  { key: 'quotas', label: 'Per-model quota', Icon: Gauge },
];

export function EmptyState({ label }: { label: string }) {
  return (
    <Card className="border-dashed">
      <CardContent className="p-10 grid place-items-center text-center text-muted-foreground">
        <Inbox className="size-8 text-muted-foreground/40 mb-2" />
        <p className="text-sm">{label}</p>
      </CardContent>
    </Card>
  );
}

export function formatQuotaNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}
