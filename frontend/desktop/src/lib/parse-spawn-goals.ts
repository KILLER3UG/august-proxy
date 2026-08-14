/** Parse spawn-modal lines into named DAG work items.

Supported lines:
  goal only
  name: goal
  name after:dep1,dep2: goal
*/

export interface ParsedSpawnItem {
  goal: string;
  name?: string;
  dependsOn?: string[];
}

export function parseSpawnGoalLine(line: string): ParsedSpawnItem | null {
  const raw = line.trim();
  if (!raw) return null;
  const afterMatch = raw.match(
    /^([A-Za-z0-9][A-Za-z0-9._-]{0,79})\s+after:([A-Za-z0-9._,-]+)\s*:\s*(.+)$/,
  );
  if (afterMatch) {
    const dependsOn = afterMatch[2]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    return { name: afterMatch[1], dependsOn, goal: afterMatch[3].trim() };
  }
  const named = raw.match(/^([A-Za-z0-9][A-Za-z0-9._-]{0,79})\s*:\s*(.+)$/);
  if (named && !named[2].startsWith('//') && named[2].trim()) {
    return { name: named[1], goal: named[2].trim() };
  }
  return { goal: raw };
}

export function parseSpawnGoals(text: string): ParsedSpawnItem[] {
  return text
    .split('\n')
    .map(parseSpawnGoalLine)
    .filter((x): x is ParsedSpawnItem => x != null);
}

/** Client-side wave preview (same edges as backend plan_waves). */
export function previewWaves(items: ParsedSpawnItem[]): string[][] {
  const names = items.map((it, i) => it.name || `item_${i + 1}`);
  const batch = new Set(names);
  const remaining = new Set(names);
  const waves: string[][] = [];
  const depsOf = (i: number): string[] =>
    (items[i].dependsOn ?? []).filter((d) => batch.has(d));

  while (remaining.size) {
    const wave: string[] = [];
    names.forEach((n, i) => {
      if (!remaining.has(n)) return;
      if (depsOf(i).every((d) => !remaining.has(d))) wave.push(n);
    });
    if (wave.length === 0) {
      waves.push([...remaining]);
      break;
    }
    waves.push(wave);
    wave.forEach((n) => remaining.delete(n));
  }
  return waves;
}
