// Phase 3 helper: merge per-shard `<shard>.rows.tsv` files back into the
// manifest's status/note columns, then reconcile against `git ls-files`.
//
// READ-ONLY against the clones (git ls-files + stat only).
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const ROOT = 'C:/Dev/august-proxy/docs/research';
const CLONES = {
  pi: 'C:/Users/rober/AppData/Local/Temp/harness-research/pi',
  simulide: 'C:/Users/rober/AppData/Local/Temp/harness-research/simulide',
  'deepseek-harness': 'C:/Users/rober/AppData/Local/Temp/harness-research/deepseek-harness',
};

const APPLY = process.argv.includes('--apply');
const repoArg = process.argv.find((a) => a.startsWith('--repo='))?.split('=')[1];
const repos = repoArg ? [repoArg] : Object.keys(CLONES);

let grandTotal = 0;
for (const repo of repos) {
  const dir = path.join(ROOT, repo);
  const tsvPath = path.join(dir, 'manifest.tsv');
  if (!existsSync(tsvPath)) { console.log(`!! ${repo}: no manifest`); continue; }

  const lines = readFileSync(tsvPath, 'utf8').split('\n').filter(Boolean);
  const header = lines[0].split('\t');
  const rows = lines.slice(1).map((l) => {
    const f = l.split('\t');
    return { path: f[0], size: Number(f[1] || 0), type: f[2], shard: f[3], status: f[4] || 'pending', note: f[5] || '' };
  });
  const byPath = new Map(rows.map((r) => [r.path, r]));

  // --- gather the per-shard row files -----------------------------------------
  const shardDir = path.join(dir, 'shards');
  const rowFiles = existsSync(shardDir)
    ? readdirSync(shardDir).filter((f) => f.endsWith('.rows.tsv'))
    : [];
  let applied = 0;
  const seenPaths = new Set();
  for (const rf of rowFiles) {
    const body = readFileSync(path.join(shardDir, rf), 'utf8');
    for (const line of body.split('\n')) {
      if (!line.trim()) continue;
      const f = line.split('\t');
      const p = (f[0] || '').trim();
      if (!p) continue;
      const status = (f[1] || '').trim();
      const note = (f[2] || '').trim();
      const row = byPath.get(p);
      if (!row) continue;
      seenPaths.add(p);
      row.status = status === 'read' ? 'read' : (status === 'skipped' ? 'skipped' : status);
      row.note = note;
      applied++;
    }
  }

  // --- reconcile against git ls-files -----------------------------------------
  const tracked = execFileSync('git', ['-C', CLONES[repo], 'ls-files'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\n').filter(Boolean);
  const trackedSet = new Set(tracked);
  const missing = tracked.filter((p) => !byPath.has(p));
  const extra = rows.filter((r) => !trackedSet.has(r.path)).map((r) => r.path);
  const unresolved = rows.filter((r) => r.status !== 'read' && r.status !== 'skipped');
  const skippedNoNote = rows.filter((r) => r.status === 'skipped' && !r.note.trim());
  const readNoNote = rows.filter((r) => r.status === 'read' && !r.note.trim());
  const shardFiles = new Map();
  for (const r of rows) shardFiles.set(r.shard, (shardFiles.get(r.shard) || 0) + 1);
  const shardsWithRows = new Set(rowFiles.map((f) => f.replace(/\.rows\.tsv$/, '')));

  const counts = {};
  for (const r of rows) counts[r.status] = (counts[r.status] || 0) + 1;

  console.log(`\n===== ${repo} =====`);
  console.log(`tracked=${tracked.length} rows=${rows.length} rowFiles=${rowFiles.length} applied=${applied}`);
  console.log(`status: ${JSON.stringify(counts)}`);
  console.log(`missing from manifest: ${missing.length}${missing.length ? ' -> ' + missing.slice(0, 5).join(', ') : ''}`);
  console.log(`in manifest, not tracked: ${extra.length}${extra.length ? ' -> ' + extra.slice(0, 5).join(', ') : ''}`);
  console.log(`UNRESOLVED (gate fail): ${unresolved.length}${unresolved.length ? ' -> ' + unresolved.slice(0, 5).map((r) => r.path).join(', ') : ''}`);
  console.log(`skipped without a reason: ${skippedNoNote.length}`);
  console.log(`read without a note: ${readNoNote.length}`);
  const missingShardRows = [...shardFiles.keys()].filter((s) => !shardsWithRows.has(s));
  console.log(`shards with no rows file: ${missingShardRows.length}${missingShardRows.length ? ' -> ' + missingShardRows.slice(0, 5).join(', ') : ''}`);

  if (APPLY) {
    const esc = (v) => String(v).replace(/\t/g, ' ').replace(/\r?\n/g, ' ');
    const out = [header.join('\t')];
    for (const r of rows) out.push([r.path, r.size, r.type, r.shard, r.status, r.note].map(esc).join('\t'));
    writeFileSync(tsvPath, out.join('\n') + '\n', 'utf8');
    console.log('  -> manifest updated');
  }
  grandTotal += rows.length;
}
console.log(`\nrows examined: ${grandTotal}`);
