// Phase 3 spot-check: verify the file:line citations in shard reports against
// the clone, and report which files each shard actually claims to have read.
//
// READ-ONLY against the clones.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')),
  '../..',
  'docs/research',
);
/* Clone roots are MACHINE STATE, not part of the repo: they live under a temp
 * directory and will vanish. Override the base with AUGUST_RESEARCH_CLONES
 * (the directory that holds pi/ simulide/ deepseek-harness/), otherwise the
 * historical default is used. The three repo URLs and the exact commits are in
 * docs/research/STATUS.md — a verifier that cannot say how to recreate what it
 * verifies is one nobody can re-run. */
const CLONE_BASE =
  process.env.AUGUST_RESEARCH_CLONES || 'C:/Users/rober/AppData/Local/Temp/harness-research';
const EXPECTED_COMMITS = { pi: '58c0b02', simulide: 'a7d9fc9', 'deepseek-harness': '687f282e' };
const CLONE_URLS = {
  pi: 'https://github.com/earendil-works/pi',
  simulide: 'https://github.com/Arcachofo/SimulIDE-dev',
  'deepseek-harness': 'https://github.com/deepseek-ai/deepseek-harness',
};

const repo = process.argv[2] || 'pi';
const only = process.argv[3]; // optional: a specific shard name
const clone = path.join(CLONE_BASE, repo);
const shardDir = path.join(ROOT, repo, 'shards');

/* FAIL LOUDLY when the clone is gone. Without this the file reader returns 0
 * lines for every path and the run reports hundreds of "bad citations" — a
 * true failure with a misleading cause. Checking here names the real one, and
 * gives the command that recreates it. */
if (!existsSync(clone) || !existsSync(path.join(clone, '.git'))) {
  console.error(
    `[check-citations] the ${repo} clone is missing at ${clone}.
` +
      `  Recreate it with:
` +
      `    git clone --filter=blob:none ${CLONE_URLS[repo]} "${clone}"
` +
      `    git -C "${clone}" checkout ${EXPECTED_COMMITS[repo]}
` +
      `  (or point AUGUST_RESEARCH_CLONES at a directory that holds ${repo}/).`,
  );
  process.exit(2);
}

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

/* The per-shard ledger IS the manifest, filtered by owner-shard (column 4);
 * status is column 5 and note column 6. It used to live in a second file per
 * shard (`<shard>.rows.tsv`, 115 files / 4.3 MB), and the two copies drifted:
 * pi/durable#2's ledger carried 29 rows the manifest assigns to durable#1 and
 * kept older note text. A ledger with two sources is a ledger with none. */
const manifestRows = readFileSync(path.join(ROOT, repo, 'manifest.tsv'), 'utf8')
  .split('\n').slice(1).filter((l) => l.trim()).map((l) => l.split('\t'));
const ledgerFor = (shard) =>
  manifestRows
    .filter((f) => (f[3] || '').trim() === shard)
    .map((f) => ({ path: (f[0] || '').trim(), status: (f[4] || '').trim(), note: (f[5] || '').trim() }));
const manifestFiles = new Set(manifestRows.map((f) => f[0]));
// A bare path like "README.md" is ambiguous when the repo has many files with
// that basename; a citation to it cannot be resolved to one file, so it is
// not checkable and must not be counted as bad.
const basenameCount = new Map();
for (const p of manifestFiles) {
  const b = p.split('/').pop();
  basenameCount.set(b, (basenameCount.get(b) || 0) + 1);
}
const ambiguous = (rel) => (basenameCount.get(rel.split('/').pop()) || 0) > 1;
const uniqueFiles = (rel) => manifestFiles.has(rel) && !ambiguous(rel);

const reports = readdirSync(shardDir).filter((f) => f.endsWith('.md') && (!only || f === `${only}.md`));
let grandChecked = 0, grandBad = 0, grandShards = 0, grandSkipped = 0;

for (const rf of reports) {
  const body = readFileSync(path.join(shardDir, rf), 'utf8');
  const shard = rf.replace(/\.md$/, '');

  // 1. file:line citations of the form <path>:<line> or <path>:<a>-<b>
  const re = /`?([A-Za-z0-9_./@+-]+\.[A-Za-z0-9]+):(\d+)(?:-(\d+))?`?/g;
  let m;
  const bad = [];
  const soft = [];
  let checked = 0;
  /* Citations whose basename is ambiguous or absent from the manifest are NOT
   * checkable, and are skipped — counted, never silently dropped. The first
   * version reported "3154 checked, 0 bad" while skipping another ~3.7k, which
   * reads as full coverage of a corpus more than half of which was never
   * looked at. */
  let skipped = 0;
  const seen = new Set();
  while ((m = re.exec(body)) !== null) {
    const rel = m[1];
    const line = Number(m[2]);
    const end = m[3] ? Number(m[3]) : null;
    if (!uniqueFiles(rel)) { skipped++; continue; } // ambiguous or absent from the manifest
    const key = `${rel}:${line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    checked++;
    const n = linesOf(rel);
    if (n === 0) { bad.push(`${rel}:${line} (file unreadable/empty)`); continue; }
    if (line > n) { bad.push(`${rel}:${line} (file has ${n} lines)`); continue; }
    if (end && end > n) soft.push(`${rel}:${line}-${end} (file has ${n} lines; start is valid)`);
  }

  // 2. files the ledger claims this shard covered (manifest.tsv, owner-shard column)
  const perFile = (body.match(/^### /gm) || []).length;
  const ledger = ledgerFor(shard);
  let ledgerRows = ledger.length, ledgerRead = 0, ledgerSkip = 0, ledgerNoNote = 0;
  for (const row of ledger) {
    if (row.status === 'read') ledgerRead++;
    else if (row.status === 'skipped') ledgerSkip++;
    if (!row.note) ledgerNoNote++;
  }

  // 3. do the report's per-file headers match the ledger paths?
  const headers = [...body.matchAll(/^### (.+)$/gm)].map((x) => x[1].trim());
  const headerSet = new Set(headers);

  // 4. COMPLETENESS: every path the ledger claims must appear in the report body.
  //    A file with a ledger row but no mention in the report is a silent skip.
  let notMentioned = 0;
  const notMentionedSample = [];
  for (const row of ledger) {
    const p = row.path;
    if (!p) continue;
    const base = p.split('/').pop();
    if (!body.includes(p) && !body.includes(base)) {
      notMentioned++;
      if (notMentionedSample.length < 4) notMentionedSample.push(p);
    }
  }

  grandChecked += checked; grandBad += bad.length; grandShards++; grandSkipped += skipped;
  const flag = bad.length ? 'FAIL' : 'ok  ';
  console.log(`${flag} ${shard.padEnd(32)} cites=${String(checked).padStart(4)} bad=${String(bad.length).padStart(3)} soft=${String(soft.length).padStart(3)} skipped=${String(skipped).padStart(4)}  perFileSections=${String(perFile).padStart(4)}  ledger=${String(ledgerRows).padStart(4)} (read=${ledgerRead} skipped=${ledgerSkip}) noNote=${ledgerNoNote}  notMentionedInReport=${notMentioned}`);
  for (const b of bad.slice(0, 5)) console.log(`      BAD CITATION ${b}`);
  for (const b of soft.slice(0, 3)) console.log(`      SOFT (range end past EOF) ${b}`);
  for (const b of notMentionedSample) console.log(`      NOT MENTIONED IN REPORT ${b}`);
}
console.log(
  `
${repo}: ${grandShards} shard reports, ${grandChecked} citations checked, ` +
    `${grandBad} bad, ${grandSkipped} uncheckable (ambiguous/absent basename) — ` +
    'line NUMBERS only; content is never compared',
);
// A verifier that prints FAIL and exits 0 cannot gate anything: the wrapper
// treats the run as green and a regression in the corpus ships unread.
if (grandBad > 0) process.exitCode = 1;
