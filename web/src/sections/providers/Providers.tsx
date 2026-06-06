import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { SectionHeader } from '@/components/SectionHeader';
import { PageLoader } from '@/components/PageLoader';

interface Provider {
  id: string;
  name: string;
  apiMode: string;
  isAvailable: boolean;
}
interface ActiveProviderData {
  activeProvider: string;
  providers: Provider[];
}

export function Providers() {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['providers'],
    queryFn: () => api.get<ActiveProviderData>('/api/config/activeProvider'),
  });

  if (isLoading) return <PageLoader label="Loading providers…" />;
  if (error) {
    return (
      <div className="p-6">
        <SectionHeader title="Providers" />
        <p className="text-sm text-destructive">Failed: {String(error)}</p>
      </div>
    );
  }
  if (!data) return null;

  const sorted = [...data.providers].sort((a, b) => {
    if (a.id === data.activeProvider) return -1;
    if (b.id === data.activeProvider) return 1;
    if (a.isAvailable && !b.isAvailable) return -1;
    if (!a.isAvailable && b.isAvailable) return 1;
    return a.name.localeCompare(b.name);
  });

  return (
    <div className="p-6 space-y-6">
      <SectionHeader
        title="Providers"
        subtitle={<>Active: <span className="font-mono text-foreground">{data.activeProvider}</span></>}
        actions={
          <button
            onClick={() => refetch()}
            className="text-xs text-muted-foreground hover:text-foreground transition"
          >
            ↻ Refresh
          </button>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle>Available providers</CardTitle>
        </CardHeader>
        <CardContent className="divide-y divide-border">
          {sorted.map((p) => (
            <div key={p.id} className="flex items-center justify-between py-2.5">
              <div className="flex items-center gap-3">
                <span className={`inline-block size-1.5 rounded-full ${p.isAvailable ? 'bg-primary' : 'bg-muted-foreground/40'}`} />
                <span className="text-sm">{p.name}</span>
                <span className="text-[10px] text-muted-foreground font-mono">{p.apiMode}</span>
              </div>
              <div className="flex items-center gap-2">
                {p.id === data.activeProvider && <Badge variant="success">active</Badge>}
                {p.isAvailable
                  ? <Badge variant="outline">ready</Badge>
                  : <Badge variant="secondary">no key</Badge>}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
