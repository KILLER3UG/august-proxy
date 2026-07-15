import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Search } from 'lucide-react';
import type { SearchResult } from './memoryTypes';

/** Memory search input and result cards. */
export function MemorySearchTab({
  searchQuery,
  setSearchQuery,
  results,
}: {
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  results?: SearchResult[];
}) {
  return (
    <div className="space-y-4">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
        <input
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          placeholder="Search memory..."
          className="w-full pl-10 pr-4 py-2.5 text-sm bg-background border border-border rounded-lg outline-none focus:ring-2 focus:ring-primary/40 transition"
          autoFocus
        />
      </div>

      {searchQuery.trim() && results && (
        <div className="space-y-2">
          {results.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-8">No results found</p>
          )}
          {results.map((r, i) => (
            <Card key={i}>
              <CardContent className="p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="text-[9px] shrink-0">{r.provider}</Badge>
                      <span className="text-xs font-medium text-foreground truncate">{r.title}</span>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{r.text}</p>
                  </div>
                  <Badge variant="outline" className="shrink-0 text-[9px]">{r.score}</Badge>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {!searchQuery.trim() && (
        <p className="text-sm text-muted-foreground text-center py-8">Type to search your memory</p>
      )}
    </div>
  );
}
