// Emits the shard dispatch list (JSON) for the Phase 2 fan-out.
// Reads only the manifests; touches nothing else.
import { readFileSync } from 'node:fs';

const ROOT = 'C:/Dev/august-proxy/docs/research';
const CLONES = {
  pi: 'C:/Users/rober/AppData/Local/Temp/harness-research/pi',
  simulide: 'C:/Users/rober/AppData/Local/Temp/harness-research/simulide',
  'deepseek-harness': 'C:/Users/rober/AppData/Local/Temp/harness-research/deepseek-harness',
};

const LENSES = {
  pi: [
    'agent loop and turn lifecycle', 'tool definition / execution / validation',
    'steering and queued messages', 'session storage / branching / compaction',
    'context management', 'provider / model abstraction',
    'extension / plugin / skill mechanisms', 'system prompt philosophy and size',
    'error and abort handling', 'UI / TUI rendering and streaming', 'config', 'testing approach',
  ],
  simulide: [
    'overall architecture', 'simulation engine core (event scheduling, solver, time stepping)',
    'component / plugin model and how components are registered and extended',
    'circuit / project file format and serialization', 'scripting and embedded-code support',
    'UI / editor / canvas architecture', 'undo / redo', 'performance techniques',
    'build system and packaging', 'testing',
    'what would make circuit simulation viable as an August tool or skill for logic-circuit coursework',
  ],
  'deepseek-harness': [
    'agent loop and tool-calling flow', 'how reasoning / thinking content is handled and streamed',
    'prompt construction and caching strategy (cache-hit optimisation, prefix stability)',
    'context window management and compaction', 'model-specific adaptations and fallbacks',
    'memory / learning mechanisms', 'subagent or parallel execution',
    'tool-call reliability (retries, malformed output handling, timeouts)',
    'UI / UX patterns (minimalism, progress feedback)', 'config', 'evals / testing',
  ],
};

const only = process.argv[2] ? process.argv[2].split(',') : Object.keys(CLONES);
const out = [];
for (const repo of only) {
  const tsv = readFileSync(`${ROOT}/${repo}/manifest.tsv`, 'utf8');
  const shards = new Map();
  for (const line of tsv.split('\n').slice(1)) {
    if (!line) continue;
    const f = line.split('\t');
    if (!shards.has(f[3])) shards.set(f[3], { files: 0, bytes: 0, readKB: 0 });
    const s = shards.get(f[3]);
    s.files++; s.bytes += Number(f[1] || 0);
  }
  const sizes = readFileSync(`${ROOT}/${repo}/shard-sizes.tsv`, 'utf8').split('\n').slice(1);
  const readKB = new Map();
  for (const l of sizes) { if (!l) continue; const f = l.split('\t'); readKB.set(f[0], Number(f[4] || 0)); }
  for (const [shard, s] of shards) {
    out.push({
      repo, shard,
      clone: CLONES[repo],
      manifest: `${ROOT}/${repo}/manifest.tsv`,
      report: `${ROOT}/${repo}/shards/${shard}.md`,
      files: s.files,
      readKB: readKB.get(shard) || 0,
      lenses: LENSES[repo],
    });
  }
}
process.stdout.write(JSON.stringify(out, null, 0));
