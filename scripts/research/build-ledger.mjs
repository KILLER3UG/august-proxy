// Coverage-ledger builder for the three-repo harness study.
//
// READ-ONLY with respect to the clones: it only runs `git ls-files` and `stat`.
// It never executes repository code, and never runs install/build/postinstall.
//
// Outputs, per repo:
//   docs/research/<repo>/manifest.tsv   path \t size \t type \t owner-shard \t status \t note
//   docs/research/<repo>/shard-sizes.tsv  shard \t files \t bytes \t KB \t read-bytes
//
// A file is "readable" unless it is generated/vendored/binary; the shard budget is
// measured in READABLE bytes, so generated payloads never inflate a shard.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const TMP = path.join(process.env.LOCALAPPDATA, 'Temp', 'harness-research');
const OUT = 'C:/Dev/august-proxy/docs/research';

const REPOS = {
  pi: path.join(TMP, 'pi'),
  simulide: path.join(TMP, 'simulide'),
  'deepseek-harness': path.join(TMP, 'deepseek-harness'),
};

const MAX_FILES = 260;      // per shard
const MAX_READ_BYTES = 2_600_000; // per shard, readable text only

// ------------------------------------------------------------------ classify
const EXT_TYPE = [
  [/\.(png|jpg|jpeg|gif|svg|webp|ico|icns|bmp|tiff|woff2?|ttf|otf|eot|mp3|wav|mp4|webm|mov|avi|pdf|zip|gz|tar|7z|exe|dll|so|dylib|bin)$/i, 'assets'],
  [/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py|swift|cpp|h|hpp|cc|cxx|m|mm|rs|go|java|kt|cs|rb|php|lua|sh|bash|zsh|ps1|bat|cmd)$/i, 'source'],
  [/\.(md|mdx|txt|rst|adoc)$/i, 'docs'],
  [/\.(json|jsonl|yaml|yml|toml|ini|conf|cfg|env|lock|properties|editorconfig)$/i, 'config'],
  [/\.(css|scss|less)$/i, 'source'],
];

function classify(file, repo) {
  const p = file.toLowerCase();
  const base = path.basename(p);
  const ext = path.extname(p);

  // --- generated / vendored / binary (checked first) --------------------------
  if (/(^|\/)node_modules\//.test(p)) return 'generated-vendored';
  if (/(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|Cargo\.lock|poetry\.lock|uv\.lock)$/.test(p)) return 'generated-vendored';
  if (/(^|\/)\.i18n\.yaml$/.test(p)) return 'generated-vendored';
  if (repo === 'deepseek-harness' && p.startsWith('snapshots/')) return 'generated-vendored';
  if (repo === 'deepseek-harness' && p.startsWith('vendor/')) return 'generated-vendored';
  if (repo === 'deepseek-harness' && p.startsWith('native/')) return 'generated-vendored';
  if (repo === 'deepseek-harness' && /\.schema\.json$/.test(p)) return 'generated-vendored';
  if (repo === 'deepseek-harness' && p === 'docs/persistence-schema.json') return 'generated-vendored';
  if (repo === 'deepseek-harness' && p.startsWith('patches/')) return 'generated-vendored';
  if (repo === 'deepseek-harness' && p.startsWith('website/')) return 'generated-vendored';
  if (repo === 'deepseek-harness' && p.startsWith('.agents/notes/') && p.endsWith('/manifest.json')) return 'generated-vendored';
  if (/(^|\/)(CHANGELOG(\.md)?$|\.gitignore$|\.gitattributes$)/.test(p)) return 'config';
  if (/\.(png|jpg|jpeg|gif|svg|webp|ico|icns|bmp|tiff|woff2?|ttf|otf|eot|mp3|wav|mp4|webm|mov|avi|pdf|zip|gz|tar|7z|exe|dll|so|dylib|bin)$/i.test(base)) return 'assets';
  if (repo === 'deepseek-harness' && /\.(xlsx|docx|pptx)$/i.test(base)) return 'assets';

  // --- tests ------------------------------------------------------------------
  if (/(^|\/)(tests?|__tests__|test[-_]?suite|spec)\//.test(p)) return 'tests';
  if (/\.(test|spec)\.[a-z]+$/i.test(base)) return 'tests';
  if (/(^|\/)test_[^/]*\.(py|ts|js|mjs|rs)$/i.test(base)) return 'tests';
  if (/(^|\/)[^/]*_test\.(py|ts|js|go|rs)$/i.test(base)) return 'tests';
  if (repo === 'pi' && p.startsWith('packages/') && /\.(test|spec)\.ts$/.test(base)) return 'tests';
  if (/(^|\/)(pi-test|test)\.(sh|ps1|bat|mjs)$/i.test(base)) return 'build-CI';

  // --- build / CI -------------------------------------------------------------
  if (/(^|\/)\.github\//.test(p)) return 'build-CI';
  if (/(^|\/)\.circleci\//.test(p) || /(^|\/)Jenkinsfile$/.test(p)) return 'build-CI';
  if (/(^|\/)(Dockerfile|docker-compose[^/]*|Makefile|\.pre-commit-config\.yaml)$/i.test(base)) return 'build-CI';
  if (repo === 'simulide' && /(^|\/)(SimulIDE\.pri|build_XX|.*\.pro|.*\.pri)$/i.test(p)) return 'build-CI';
  if (repo === 'pi' && p.startsWith('scripts/')) return 'build-CI';
  if (repo === 'deepseek-harness' && p.startsWith('scripts/')) return 'build-CI';
  if (/(^|\/)\.(eslintrc|prettierrc|tsconfig|editorconfig|babel|nvmrc|npmrc|node-version|releaserc|commitlintrc|swcrc|watchman|gitignore|gitattributes|dockerignore)/.test(p) || /^\.[a-z0-9_-]*(rc|json|ya?ml)$/.test(base)) return 'config';

  // --- examples ---------------------------------------------------------------
  if (/(^|\/)examples?\//.test(p)) return 'examples';
  if (/(^|\/)sample[s]?\//.test(p)) return 'examples';

  // --- docs -------------------------------------------------------------------
  if (/\.(md|mdx|rst|adoc|txt)$/i.test(base)) return 'docs';
  if (/(^|\/)readme(\.[a-z]+)?$/i.test(base)) return 'docs';
  if (/(^|\/)(changelog|license|copying)(\.[a-z]+)?$/i.test(base)) return 'docs';

  for (const [re, t] of EXT_TYPE) if (re.test(base)) return t;
  if (ext === '') return 'config';
  return 'source';
}

// ------------------------------------------------------------------ base shard
function baseShard(repo, file) {
  const p = file;
  if (repo === 'pi') {
    if (p.startsWith('packages/ai/src/') || p.startsWith('packages/ai/scripts/')) return 'ai-provider-core';
    if (p.startsWith('packages/ai/test/')) return 'ai-provider-tests';
    if (p.startsWith('packages/agent/') || p.startsWith('packages/chord/')) return 'agent-loop-core';
    if (p.startsWith('packages/coding-agent/src/')) return 'coding-agent-src';
    if (p.startsWith('packages/coding-agent/test/')) return 'coding-agent-tests';
    if (p.startsWith('packages/coding-agent/examples/') || p.startsWith('packages/coding-agent/docs/')) return 'coding-agent-examples-docs';
    if (p.startsWith('packages/durable/')) return 'durable';
    if (p.startsWith('packages/tui/')) return 'tui';
    if (p.startsWith('packages/codemode/') || p.startsWith('packages/mcp/') || p.startsWith('packages/env/') || p.startsWith('packages/telemetry/')) return 'codemode-mcp-env-telemetry';
    if (p.startsWith('packages/evals/')) return 'evals';
    if (p.startsWith('scripts/') || p.startsWith('.github/') || p.startsWith('.pi/')) return 'scripts-ci';
    return 'repo-root';
  }
  if (repo === 'simulide') {
    if (p.startsWith('src/simulator/') || p.startsWith('src/lib/')) return 'simulator-core';
    if (/^src\/components\/(logic|output|switches|meters|micro|subcircuits|connectors)\//.test(p)) return 'components-digital';
    if (/^src\/components\//.test(p)) return 'components-analog';
    if (p.startsWith('src/microsim/')) return 'microsim';
    if (p.startsWith('src/gui/')) return 'gui';
    if (p.startsWith('src/angel/')) return 'angel-jit';
    if (p.startsWith('src/icons/')) return 'icons-assets';
    if (p.startsWith('resources/')) return 'resources';
    return 'build-root';
  }
  // deepseek-harness
  if (p.startsWith('packages/core/')) return 'dsh-core';
  if (p.startsWith('packages/llm/') || p.startsWith('packages/compaction/')) return 'dsh-llm-compaction';
  if (p.startsWith('packages/session/') || p.startsWith('packages/session-query/')) return 'dsh-session';
  if (p.startsWith('packages/subagent/') || p.startsWith('packages/experimental/agent-team') || p.startsWith('packages/experimental/tool-agent-team')) return 'dsh-subagent';
  if (p.startsWith('packages/skill/') || p.startsWith('packages/spill/') || p.startsWith('packages/todo/') || p.startsWith('packages/goal/')) return 'dsh-skill-goal';
  if (p.startsWith('packages/sandbox/') || p.startsWith('packages/fs/') || p.startsWith('packages/storage/')) return 'dsh-sandbox-fs';
  if (p.startsWith('packages/shell/') || p.startsWith('packages/terminal/') || p.startsWith('packages/subprocess/') || p.startsWith('packages/workflow/')) return 'dsh-shell';
  if (p.startsWith('packages/interaction/') || p.startsWith('packages/guard/') || p.startsWith('packages/plan/') || p.startsWith('packages/preset/') || p.startsWith('packages/mcp/') || p.startsWith('packages/lsp/')) return 'dsh-interaction';
  if (p.startsWith('packages/web/') || p.startsWith('packages/jobs/') || p.startsWith('packages/deliverables/') || p.startsWith('packages/feedback/') || p.startsWith('packages/attachment/') || p.startsWith('packages/credentials/') || p.startsWith('packages/context/')) return 'dsh-web-context';
  if (/^packages\/client\/ui-(chat|conversation|trajectory|tool)\//.test(p)) return 'dsh-client-chat';
  if (/^packages\/client\/ui-(approval|plan|subagent|agent-preset|user-questions|goal|workflow-run|schedule|brand-official|deepseek-model-label)\//.test(p)) return 'dsh-client-agents-ui';
  if (/^packages\/client\/ui-(primitives|theme|layout|dockkit|commands|shortcuts|slots)\//.test(p)) return 'dsh-client-primitives';
  if (/^packages\/client\/ui-settings/.test(p)) return 'dsh-client-settings';
  if (/^packages\/client\/ui-sidebar/.test(p) || /^packages\/client\/ui-(workspace|renderer|session|file-upload|resources|modules|connection|locale|product-analytics)\//.test(p)) return 'dsh-client-sidebar';
  if (p.startsWith('packages/client/')) return 'dsh-client-rest';
  if (p.startsWith('packages/api/') || p.startsWith('packages/sdk/') || p.startsWith('packages/acp/')) return 'dsh-api';
  if (p.startsWith('packages/bundle/') || p.startsWith('packages/boot/')) return 'dsh-boot-bundle';
  if (/^packages\/experimental\/(inspector|session-inspector|claude-code-mods|cua-macos|webworker-runtime|webworker-packer)\//.test(p)) return 'dsh-experimental-inspect';
  if (p.startsWith('packages/experimental/')) return 'dsh-experimental-rest';
  if (p.startsWith('packages/util/') || p.startsWith('packages/typert/') || p.startsWith('packages/host/') || p.startsWith('packages/extensions/') || p.startsWith('packages/telemetry/') || p.startsWith('packages/identity/') || p.startsWith('packages/workspace/') || p.startsWith('packages/settings/')) return 'dsh-platform';
  if (p.startsWith('packages/ptc-runtime/') || p.startsWith('packages/ssh/')) return 'dsh-remote-ptc';
  if (p.startsWith('packages/test-support/')) return 'dsh-test-support';
  if (p.startsWith('apps/desktop/')) return 'dsh-apps-desktop';
  if (p.startsWith('apps/web/')) return 'dsh-apps-web';
  if (p.startsWith('apps/cli/')) return 'dsh-apps-cli';
  if (p.startsWith('.agents/notes/')) {
    if (/^\.agents\/notes\/(proposed|rejected)\//.test(p)) return 'dsh-notes-proposed';
    if (/^\.agents\/notes\/archived\/architecture\//.test(p)) return 'dsh-notes-arch';
    if (/^\.agents\/notes\/archived\/feature\//.test(p)) return 'dsh-notes-arch-feature';
    if (/^\.agents\/notes\/archived\/bug-fix\//.test(p)) return 'dsh-notes-arch-bugfix';
    if (/^\.agents\/notes\/archived\//.test(p)) return 'dsh-notes-archived-rest';
    if (/^\.agents\/notes\/implemented\/architecture\//.test(p)) return 'dsh-notes-impl-arch';
    if (/^\.agents\/notes\/implemented\//.test(p)) return 'dsh-notes-impl-rest';
    return 'dsh-notes-index';
  }
  if (p.startsWith('snapshots/')) return 'dsh-snapshots';
  if (p.startsWith('docs/subsystems/')) return 'dsh-docs-subsystems';
  if (p.startsWith('docs/persistence-changes/') || p.startsWith('docs/user/')) return 'dsh-docs-persistence';
  if (p.startsWith('docs/')) return 'dsh-docs-rest';
  if (p.startsWith('scripts/')) return 'dsh-scripts';
  return 'dsh-repo-root';
}

// ------------------------------------------------------------------ splitting
// Number of leading path segments every file in the group shares.
function commonDepth(items) {
  const parts = items.map((r) => r.path.split('/'));
  let d = 0;
  while (parts.every((s) => s.length > d + 1)) {
    const seg = parts[0][d];
    if (!parts.every((s) => s[d] === seg)) break;
    d++;
  }
  return d;
}

function splitGroup(name, items) {
  if (items.length <= MAX_FILES && items.reduce((a, r) => a + r.readBytes, 0) <= MAX_READ_BYTES) {
    return [[name, items]];
  }
  const depth = commonDepth(items);
  const buckets = new Map();
  for (const it of items) {
    const seg = it.path.split('/')[depth];
    const key = seg === undefined ? '__root__' : seg;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(it);
  }
  if (buckets.size <= 1) {
    // Cannot split on this axis: a single directory still over budget.
    return [[name, items]];
  }
  const out = [];
  for (const [seg, group] of [...buckets.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    out.push(...splitGroup(`${name}/${seg}`, group));
  }
  return out;
}

function repack(name, groups) {
  // Merge small leaf groups back together so shard count stays sane.
  const out = [];
  let cur = [];
  let curBytes = 0;
  for (const [gname, gitems] of groups) {
    const gb = gitems.reduce((a, r) => a + r.readBytes, 0);
    if (cur.length && (cur.length + gitems.length > MAX_FILES || curBytes + gb > MAX_READ_BYTES)) {
      out.push([name, cur]);
      cur = []; curBytes = 0;
    }
    cur.push(...gitems);
    curBytes += gb;
  }
  if (cur.length) out.push([name, cur]);
  return out.map(([n, its], i) => [out.length > 1 ? `${n}#${i + 1}` : n, its]);
}

// ------------------------------------------------------------------ run
for (const [repo, dir] of Object.entries(REPOS)) {
  const files = execFileSync('git', ['-C', dir, 'ls-files'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\n').filter(Boolean);

  const rows = files.map((f) => {
    let size = 0;
    try { size = fs.statSync(path.join(dir, f)).size; } catch { /* gitlink */ }
    const type = classify(f, repo);
    const generated = type === 'generated-vendored' || type === 'assets';
    return { path: f, size, type, shard: baseShard(repo, f), readBytes: generated ? 0 : size };
  });

  // group by base shard
  const base = new Map();
  for (const r of rows) {
    if (!base.has(r.shard)) base.set(r.shard, []);
    base.get(r.shard).push(r);
  }

  const finalShards = [];
  for (const [name, items] of base) {
    items.sort((a, b) => a.path.localeCompare(b.path));
    if (items.length <= MAX_FILES && items.reduce((a, r) => a + r.readBytes, 0) <= MAX_READ_BYTES) {
      finalShards.push([name, items]);
      continue;
    }
    const groups = splitGroup(name, items);
    finalShards.push(...repack(name, groups));
  }

  // stable ordering
  const order = new Map(finalShards.map(([n], i) => [n, i]));
  finalShards.sort((a, b) => order.get(a[0]) - order.get(b[0]));
  const outRows = [];
  for (const [name, items] of finalShards) {
    items.sort((a, b) => a.path.localeCompare(b.path));
    for (const it of items) it.shard = name;   // re-tag with the FINAL shard name
    outRows.push(...items);
  }

  const esc = (v) => String(v).replace(/\t/g, ' ').replace(/\r?\n/g, ' ');
  const body = outRows.map((r) => [r.path, r.size, r.type, r.shard, 'pending', ''].map(esc).join('\t'));
  fs.mkdirSync(path.join(OUT, repo, 'shards'), { recursive: true });
  fs.writeFileSync(path.join(OUT, repo, 'manifest.tsv'),
    'path\tsize\ttype\towner-shard\tstatus\tnote\n' + body.join('\n') + '\n', 'utf8');

  const sizes = new Map();
  for (const r of outRows) {
    const s = sizes.get(r.shard) || { files: 0, bytes: 0, read: 0 };
    s.files++; s.bytes += r.size; s.read += r.readBytes;
    sizes.set(r.shard, s);
  }
  const sLines = ['shard\tfiles\tbytes\tKB\tread-KB'];
  for (const [n, s] of sizes) sLines.push(`${n}\t${s.files}\t${s.bytes}\t${Math.round(s.bytes / 1024)}\t${Math.round(s.read / 1024)}`);
  fs.writeFileSync(path.join(OUT, repo, 'shard-sizes.tsv'), sLines.join('\n') + '\n', 'utf8');

  const readMB = (outRows.reduce((a, r) => a + r.readBytes, 0) / 1048576).toFixed(1);
  console.log(`\n### ${repo}: ${outRows.length} files, ${(outRows.reduce((a, r) => a + r.size, 0) / 1048576).toFixed(1)} MB total, ${readMB} MB readable, ${sizes.size} shards`);
  const over = [...sizes.entries()].filter(([, s]) => s.files > MAX_FILES * 1.15 || s.read > MAX_READ_BYTES * 1.15);
  for (const [n, s] of over) console.log(`  OVERSIZE ${n}: ${s.files} files, ${Math.round(s.read / 1024)} KB readable`);
}
