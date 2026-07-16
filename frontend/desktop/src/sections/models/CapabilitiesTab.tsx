import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { getModelCapabilities } from '@/api/api-client';
import { PageLoader } from '@/components/PageLoader';
import { EmptyState } from './modelsShared';

/** Badge grid of registered model capability flags. */
export function CapabilitiesTab() {
  const { data, isLoading } = useQuery({
    queryKey: ['model-capabilities'],
    queryFn: () => getModelCapabilities(),
  });
  const caps = data?.capabilities ?? [];
  if (isLoading) return <PageLoader label="Loading capabilities…" variant="card" className="py-2" />;
  if (caps.length === 0) return <EmptyState label="No capabilities registered" />;
  return (
    <Card className="p-4">
      <CardHeader className="p-0 mb-3">
        <CardTitle className="text-sm">Available capabilities</CardTitle>
      </CardHeader>
      <CardContent className="p-0 flex flex-wrap gap-2">
        {caps.map((c) => (
          <Badge key={c} variant="outline">{c}</Badge>
        ))}
      </CardContent>
    </Card>
  );
}
