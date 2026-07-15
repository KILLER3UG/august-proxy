import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Calculator } from 'lucide-react';
import { estimateModelCost, type ModelCostEstimate } from '@/api/api-client';

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className={`font-mono tabular-nums ${strong ? 'font-semibold' : ''}`}>{value}</span>
    </div>
  );
}

/** Token cost estimator for a given model id. */
export function CostTab() {
  const [modelId, setModelId] = useState('');
  const [inputTokens, setInputTokens] = useState('1000');
  const [outputTokens, setOutputTokens] = useState('500');

  const estimate = useMutation<ModelCostEstimate>({
    mutationFn: () =>
      estimateModelCost(modelId, Number(inputTokens) || 0, Number(outputTokens) || 0),
  });

  return (
    <div className="space-y-4 max-w-xl">
      <Card>
        <CardContent className="p-4 space-y-3">
          <div>
            <label className="text-[10px] uppercase tracking-wider text-muted-foreground">Model ID</label>
            <Input
              value={modelId}
              onChange={(e) => setModelId(e.target.value)}
              placeholder="e.g. claude-sonnet-4-5"
              className="mt-1 font-mono text-sm"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[10px] uppercase tracking-wider text-muted-foreground">Input tokens</label>
              <Input
                value={inputTokens}
                onChange={(e) => setInputTokens(e.target.value)}
                type="number"
                className="mt-1 font-mono text-sm"
              />
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-wider text-muted-foreground">Output tokens</label>
              <Input
                value={outputTokens}
                onChange={(e) => setOutputTokens(e.target.value)}
                type="number"
                className="mt-1 font-mono text-sm"
              />
            </div>
          </div>
          <Button
            size="sm"
            disabled={!modelId.trim() || estimate.isPending}
            onClick={() => estimate.mutate()}
          >
            <Calculator className="size-3" /> Estimate cost
          </Button>
        </CardContent>
      </Card>

      {estimate.data && (
        <Card>
          <CardContent className="p-4 space-y-2">
            {estimate.data.error ? (
              <p className="text-sm text-destructive">{estimate.data.error}</p>
            ) : (
              <>
                <Row label="Model" value={estimate.data.model} />
                <div className="border-t border-border pt-2">
                  <Row label="Total" value={`$${(estimate.data.cost || 0).toFixed(6)}`} strong />
                </div>
              </>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
