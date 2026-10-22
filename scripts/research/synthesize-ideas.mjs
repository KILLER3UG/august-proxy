// Phase 3/4 helper: consolidate the "Ideas worth stealing" sections from every
// shard report into one file, so the synthesis and the proposal doc work from
// a single list rather than from memory.
//
// READ-ONLY against the clones; writes only the one output file.
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = 'C:/Dev/august-proxy/docs/research';
const OUTFILE = path.join(ROOT, 'IDEAS.md');

const repos = ['pi', 'simulide', 'deepseek-harness'];
const out = [];
let shardCount = 0;

for (const repo of repos) {
  const dir = path.join(ROOT, repo, 'shards');
  if (!existsSync(dir)) continue;
  const reports = readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
  const repoIdeas = [];
  for (const rf of reports) {
    const body = readFileSync(path.join(dir, rf), 'utf8');
    const shard = rf.replace(/\.md$/, '');
    // The ideas section runs until the next H2 that is not "Ideas worth stealing".
    const m = body.match(/^##\s+Ideas worth stealing\s*$/im);
    if (!m) { shardCount++; continue; }
    const start = m.index + m[0].length;
    const rest = body.slice(start);
    const next = rest.search(/^##\s+/m);
    const section = next === -1 ? rest : rest.slice(0, next);
    const items = section
      .split(/\n(?=\s*(?:\d+\.|[-*])\s+)/)
      .map((s) => s.trim())
      .filter((s) => s.length > 40);
    shardCount++;
    for (const it of items) {
      const cites = [...it.matchAll(/([A-Za-z0-9_./@+-]+\.[A-Za-z0-9]+):(\d+)/g)]
        .map((x) => `${x[1]}:${x[2]}`);
      repoIdeas.push({ shard, text: it.replace(/\s+/g, ' ').trim(), cites });
    }
  }
  out.push({ repo, ideas: repoIdeas });
}

const lines = [];
lines.push('# Consolidated "ideas worth stealing"');
lines.push('');
lines.push('Extracted verbatim from the shard reports under `docs/research/<repo>/shards/`.');
lines.push('Each line carries the shard it came from and the file:line references it');
lines.push('makes. **This is raw material, not a proposal** — the proposals live in');
lines.push('`docs/research/AUGUST-IMPROVEMENTS.md` and every one of them is checked');
lines.push('against `docs/research/august-baseline.md` first.');
lines.push('');
for (const { repo, ideas } of out) {
  lines.push(`## ${repo} — ${ideas.length} ideas across the shards read so far`);
  lines.push('');
  for (const i of ideas) {
    lines.push(`- **[${i.shard}]** ${i.text}`);
  }
  lines.push('');
}
writeFileSync(OUTFILE, lines.join('\n'), 'utf8');
console.log(`wrote ${OUTFILE}`);
for (const { repo, ideas } of out) console.log(`  ${repo}: ${ideas.length} ideas`);
console.log(`shards with reports: ${shardCount}`);
