// Research-only helper: verify docs/research/<repo>/manifest.tsv against `git ls-files`.
// Read-only against the clones; writes nothing outside stdout.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const CLONES = {
  pi: 'C:/Users/rober/AppData/Local/Temp/harness-research/pi',
  simulide: 'C:/Users/rober/AppData/Local/Temp/harness-research/simulide',
  'deepseek-harness': 'C:/Users/rober/AppData/Local/Temp/harness-research/deepseek-harness',
};

for (const [repo, dir] of Object.entries(CLONES)) {
  const tracked = execFileSync('git', ['-C', dir, 'ls-files'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\n').filter(Boolean);
  const trackedSet = new Set(tracked);

  const tsv = readFileSync(`C:/Dev/august-proxy/docs/research/${repo}/manifest.tsv`, 'utf8');
  const lines = tsv.split('\n').filter(Boolean);
  const header = lines[0].split('\t');
  const rows = lines.slice(1).map((l) => {
    const f = l.split('\t');
    return { path: f[0], size: Number(f[1] || 0), type: f[2], shard: f[3], status: f[4], note: f[5] || '' };
  });

  const seen = new Map();
  const dupes = [];
  for (const r of rows) {
    if (seen.has(r.path)) dupes.push(r.path);
    seen.set(r.path, r);
  }

  const missing = tracked.filter((p) => !seen.has(p));
  const extra = rows.filter((r) => !trackedSet.has(r.path)).map((r) => r.path);

  // shard balance
  const byShard = new Map();
  for (const r of rows) {
    const s = byShard.get(r.shard) || { files: 0, bytes: 0 };
    s.files++; s.bytes += r.size;
    byShard.set(r.shard, s);
  }
  const shardList = [...byShard.entries()]
    .map(([name, v]) => ({ name, files: v.files, kb: Math.round(v.bytes / 1024) }))
    .sort((a, b) => b.files - a.files);

  const statusCounts = {};
  for (const r of rows) statusCounts[r.status] = (statusCounts[r.status] || 0) + 1;

  console.log(`\n===== ${repo} =====`);
  console.log(`git ls-files: ${tracked.length}   manifest rows: ${rows.length}`);
  console.log(`missing from manifest: ${missing.length}` + (missing.length ? ` -> ${missing.slice(0, 8).join(', ')}` : ''));
  console.log(`in manifest but not tracked: ${extra.length}` + (extra.length ? ` -> ${extra.slice(0, 8).join(', ')}` : ''));
  console.log(`duplicate paths: ${dupes.length}` + (dupes.length ? ` -> ${dupes.slice(0, 8).join(', ')}` : ''));
  console.log(`status: ${JSON.stringify(statusCounts)}`);
  console.log(`shards: ${shardList.length}`);
  for (const s of shardList) {
    const flag = s.files > 600 ? '  <== SPLIT' : '';
    console.log(`  ${s.name.padEnd(34)} ${String(s.files).padStart(5)} files  ${String(s.kb).padStart(7)} KB${flag}`);
  }
}
