// Research-only helper: verify docs/research/<repo>/manifest.tsv against `git ls-files`.
// Read-only against the clones; writes nothing outside stdout.
//
// This is the LEDGER GATE, merged from the retired merge-rows.mjs when the
// per-shard `<shard>.rows.tsv` files were merged into manifest.tsv and deleted:
// besides reconciliation it refuses an unresolved status, a skip with no reason
// and a read with no note, and exits non-zero on any of them.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Derive the checkout root; the old absolute C:/Dev/august-proxy path made the
// gate runnable on exactly one machine.
const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
  'docs/research',
);
const CLONE_BASE =
  process.env.AUGUST_RESEARCH_CLONES || 'C:/Users/rober/AppData/Local/Temp/harness-research';
const CLONES = {
  pi: `${CLONE_BASE}/pi`,
  simulide: `${CLONE_BASE}/simulide`,
  'deepseek-harness': `${CLONE_BASE}/deepseek-harness`,
};
let failures = 0;

for (const [repo, dir] of Object.entries(CLONES)) {
  const tracked = execFileSync('git', ['-C', dir, 'ls-files'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\n').filter(Boolean);
  const trackedSet = new Set(tracked);

  const tsv = readFileSync(path.join(ROOT, repo, 'manifest.tsv'), 'utf8');
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
  const unresolved = rows.filter((r) => r.status !== 'read' && r.status !== 'skipped');
  const skippedNoReason = rows.filter((r) => r.status === 'skipped' && !r.note.trim());
  const readNoNote = rows.filter((r) => r.status === 'read' && !r.note.trim());
  failures += missing.length + extra.length + dupes.length + unresolved.length + skippedNoReason.length + readNoNote.length;

  console.log(`\n===== ${repo} =====`);
  console.log(`git ls-files: ${tracked.length}   manifest rows: ${rows.length}`);
  console.log(`missing from manifest: ${missing.length}` + (missing.length ? ` -> ${missing.slice(0, 8).join(', ')}` : ''));
  console.log(`in manifest but not tracked: ${extra.length}` + (extra.length ? ` -> ${extra.slice(0, 8).join(', ')}` : ''));
  console.log(`duplicate paths: ${dupes.length}` + (dupes.length ? ` -> ${dupes.slice(0, 8).join(', ')}` : ''));
  console.log(`status: ${JSON.stringify(statusCounts)}`);
  console.log(`UNRESOLVED (gate fail): ${unresolved.length}` + (unresolved.length ? ` -> ${unresolved.slice(0, 8).map((r) => r.path).join(', ')}` : ''));
  console.log(`skipped without a reason: ${skippedNoReason.length}` + (skippedNoReason.length ? ` -> ${skippedNoReason.slice(0, 8).map((r) => r.path).join(', ')}` : ''));
  console.log(`read without a note: ${readNoNote.length}` + (readNoNote.length ? ` -> ${readNoNote.slice(0, 8).map((r) => r.path).join(', ')}` : ''));
  console.log(`shards: ${shardList.length}`);
  for (const s of shardList) {
    const flag = s.files > 600 ? '  <== SPLIT' : '';
    console.log(`  ${s.name.padEnd(34)} ${String(s.files).padStart(5)} files  ${String(s.kb).padStart(7)} KB${flag}`);
  }
}

if (failures) {
  console.error(`\n[verify-manifest] FAIL — ${failures} problem(s) across the three manifests`);
  process.exitCode = 1;
}
