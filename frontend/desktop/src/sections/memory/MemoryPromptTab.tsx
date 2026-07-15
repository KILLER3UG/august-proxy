import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import type { BrainDiagnostics } from './memoryTypes';

/** Preview of the assembled brain system prompt. */
export function MemoryPromptTab({
  prompt,
  promptLength,
  brain,
}: {
  prompt?: string;
  promptLength?: number;
  brain?: BrainDiagnostics;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        {!prompt ? (
          <p className="text-sm text-muted-foreground text-center py-4">Loading system prompt...</p>
        ) : (
          <>
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs text-muted-foreground font-mono">{promptLength ?? prompt.length} chars</span>
              <Badge variant={brain?.compacted ? 'destructive' : 'secondary'}>
                {brain?.compacted ? 'compacted' : 'full'}
              </Badge>
            </div>
            <pre className="text-xs font-mono whitespace-pre-wrap text-foreground/80 leading-relaxed max-h-[60vh] overflow-y-auto bg-muted/20 rounded p-3">
              {prompt}
            </pre>
          </>
        )}
      </CardContent>
    </Card>
  );
}
