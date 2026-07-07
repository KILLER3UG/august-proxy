/* v3 — System Health tab: per-phase status board */
import { useEffect, useState } from 'react';
import { Clock, Heart } from 'lucide-react';

interface LayerInfo {
  layer: string;
  flag: string;
  flagValue: boolean;
  status: 'on & healthy' | 'on & failing' | 'off' | 'not shipped';
  detail: string;
  lastCheckAt: string;
}

interface HealthData {
  phases: LayerInfo[];
}

const STATUS_COLOR: Record<string, string> = {
  'on & healthy': 'text-success',
  'on & failing': 'text-danger',
  off: 'text-muted-foreground',
  'not shipped': 'text-muted-foreground',
};

const DOT_COLOR: Record<string, string> = {
  'on & healthy': 'bg-success',
  'on & failing': 'bg-danger',
  off: 'bg-muted-foreground',
  'not shipped': 'bg-muted',
};

const API_BASE = '/api/brain';

export function SystemHealthTab() {
  const [data, setData] = useState<HealthData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const fetchData = async () => {
      try {
        const resp = await fetch(`${API_BASE}/health`);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const json = await resp.json();
        if (!cancelled) setData(json);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    };
    fetchData();
    const id = setInterval(fetchData, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  if (error) {
    return <div className="p-4 text-danger">Error loading health: {error}</div>;
  }
  if (!data) {
    return (
      <div className="p-8 text-center text-muted-foreground flex items-center justify-center gap-2">
        <Clock className="size-4 animate-spin" /> Loading…
      </div>
    );
  }

  const allHealthy = data.phases.every((p) => p.status === 'on & healthy' || p.status === 'off');

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-12 gap-3 px-4 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">
        <span className="col-span-4">Phase / Layer</span>
        <span className="col-span-2">Flag</span>
        <span className="col-span-2">Status</span>
        <span className="col-span-4">Detail</span>
      </div>
      {data.phases.map((p) => (
        <div
          key={p.flag}
          className="grid grid-cols-12 gap-3 items-start px-4 py-2.5 bg-card rounded-lg border border-border text-sm"
        >
          <span className="col-span-4 font-medium">{p.layer}</span>
          <code className="col-span-2 text-xs text-muted-foreground">{p.flag}</code>
          <span
            className={`col-span-2 inline-flex items-center gap-1 text-xs font-medium ${
              STATUS_COLOR[p.status] ?? 'text-muted-foreground'
            }`}
          >
            <span className={`size-1.5 rounded-full ${DOT_COLOR[p.status] ?? 'bg-muted'}`} />
            {p.status}
          </span>
          <div className="col-span-4 text-xs text-muted-foreground">
            <p>{p.detail}</p>
            <p className="text-[10px] mt-0.5">
              checked {new Date(p.lastCheckAt).toLocaleTimeString()}
            </p>
          </div>
        </div>
      ))}
      {allHealthy && (
        <div className="p-3 bg-success/10 text-success text-xs rounded-lg flex items-center gap-2">
          <Heart className="size-3.5" /> All cognitive layers are healthy.
        </div>
      )}
    </div>
  );
}