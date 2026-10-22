// Phase 3 spot-check: verify the file:line citations in shard reports against
// the clone, and report which files each shard actually claims to have read.
//
// READ-ONLY against the clones.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = 'C:/Dev/august-proxy/docs/research';
const CLONES = {
  pi: 'C:/Users/rober/AppData/Local/Temp/harness-research/pi',
  simulide: 'C:/Users/rober/AppData/Local/Temp/harness-research/simulide',
  'deepseek-harness': 'C:/Users/rober/AppData/Local/Temp/harness-research/deepseek-harness',
};

const repo = process.argv[2] || 'pi';
const only = process.argv[3]; // optional: a specific shard name
const clone = CLONES[repo];
const shardDir = path.join(ROOT, repo, 'shards');

// line counts per file in the clone
const lineCount = new Map();
function linesOf(rel) {
  if (lineCount.has(rel)) return lineCount.get(rel);
  const abs = path.join(clone, rel);
  let n = 0;
  try {
    const body = readFileSync(abs, 'utf8');
    n = body.split('\n').length;
  } catch { n = 0; }
  lineCount.set(rel, n);
  return n;
}

const manifestFiles = new Set(
  readFileSync(path.join(ROOT, repo, 'manifest.tsv'), 'utf8')
    .split('\n').slice(1).filter(Boolean).map((l) => l.split('\t')[0]),
);

const reports = readdirSync(shardDir).filter((f) => f.endsWith('.md') && (!only || f === `${only}.md`));
let grandChecked = 0, grandBad = 0, grandShards = 0;

for (const rf of reports) {
  const body = readFileSync(path.join(shardDir, rf), 'utf8');
  const shard = rf.replace(/\.md$/, '');

  // 1. file:line citations of the form <path>:<line> or <path>:<a>-<b>
  const re = /`?([A-Za-z0-9_./@+-]+\.[A-Za-z0-9]+):(\d+)(?:-(\d+))?`?/g;
  let m;
  const bad = [];
  let checked = 0;
  const seen = new Set();
  while ((m = re.exec(body)) !== null) {
    const rel = m[1];
    const line = Number(m[2]);
    const end = m[3] ? Number(m[3]) : null;
    if (!manifestFiles.has(rel)) continue;      // not a file of this repo -> ignore
    const key = `${rel}:${line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    checked++;
    const n = linesOf(rel);
    if (n === 0) { bad.push(`${rel}:${line} (file unreadable/empty)`); continue; }
    if (line > n) { bad.push(`${rel}:${line} (file has ${n} lines)`); continue; }
    if (end && end > n) { bad.push(`${rel}:${line}-${end} (file has ${n} lines)`); }
  }

  // 2. files the report claims to have covered
  const perFile = (body.match(/^### /gm) || []).length;
  const rowsPath = path.join(shardDir, `${shard}.rows.tsv`);
  let ledgerRows = 0, ledgerRead = 0, ledgerSkip = 0, ledgerNoNote = 0;
  if (existsSync(rowsPath)) {
    const rl = readFileSync(rowsPath, 'utf8').split('\n').filter((l) => l.trim());
    ledgerRows = rl.length;
    for (const l of rl) {
      const f = l.split('\t');
      const st = (f[1] || '').trim();
      const note = (f[2] || '').trim();
      if (st === 'read') ledgerRead++;
      else if (st === 'skipped') ledgerSkip++;
      if (!note) ledgerNoNote++;
    }
  }

  // 3. do the report's per-file headers match the ledger paths?
  const headers = [...body.matchAll(/^### (.+)$/gm)].map((x) => x[1].trim());
  const headerSet = new Set(headers);

  // 4. COMPLETENESS: every path the ledger claims must appear in the report body.
  //    A file with a ledger row but no mention in the report is a silent skip.
  let notMentioned = 0;
  const notMentionedSample = [];
  if (existsSync(rowsPath)) {
    for (const l of readFileSync(rowsPath, 'utf8').split('\n')) {
      if (!l.trim()) continue;
      const p = l.split('\t')[0].trim();
      if (!p) continue;
      const base = p.split('/').pop();
      if (!body.includes(p) && !body.includes(base)) {
        notMentioned++;
        if (notMentionedSample.length < 4) notMentionedSample.push(p);
      }
    }
  }

  grandChecked += checked; grandBad += bad.length; grandShards++;
  const flag = bad.length ? 'FAIL' : 'ok  ';
  console.log(`${flag} ${shard.padEnd(32)} cites=${String(checked).padStart(4)} bad=${String(bad.length).padStart(3)}  perFileSections=${String(perFile).padStart(4)}  ledger=${String(ledgerRows).padStart(4)} (read=${ledgerRead} skipped=${ledgerSkip}) noNote=${ledgerNoNote}  notMentionedInReport=${notMentioned}`);
  for (const b of bad.slice(0, 5)) console.log(`      BAD CITATION ${b}`);
  for (const b of notMentionedSample) console.log(`      NOT MENTIONED IN REPORT ${b}`);
}
console.log(`\n${repo}: ${grandShards} shard reports, ${grandChecked} citations checked, ${grandBad} bad`);
