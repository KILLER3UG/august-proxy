import { useQuery } from '@tanstack/react-query';
import { Card } from '@/components/ui/card';
import { ArrowRightLeft } from 'lucide-react';
import { getModelAliases, type ModelAlias } from '@/api/api-client';
import { PageLoader } from '@/components/PageLoader';
import { EmptyState } from './modelsShared';

/** Read-only built-in model alias resolution table. */
export function AliasesTab() {
  const { data, isLoading } = useQuery({
    queryKey: ['model-aliases'],
    queryFn: () => getModelAliases(),
  });
  const aliases = data?.aliases ?? [];
  if (isLoading) return <PageLoader label="Loading aliases…" className="py-2" />;
  if (aliases.length === 0) return <EmptyState label="No model aliases defined" />;
  return (
    <Card className="overflow-auto">
      <div className="grid grid-cols-[1fr_24px_1fr_120px] gap-2 px-3 py-2 text-[10px] uppercase tracking-wider text-muted-foreground border-b border-border font-mono">
        <span>Alias</span><span /><span>Resolves to</span><span>Provider</span>
      </div>
      <div className="divide-y divide-border/40">
        {aliases.map((a: ModelAlias) => (
          <div key={a.alias} className="grid grid-cols-[1fr_24px_1fr_120px] gap-2 px-3 py-2 text-xs items-center font-mono">
            <span className="truncate">{a.alias}</span>
            <ArrowRightLeft className="size-3 text-muted-foreground/50" />
            <span className="truncate text-foreground">{a.resolvesTo}</span>
            <span className="text-muted-foreground truncate">{a.provider}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}
