/**
 * curator.js — Memory curator for guideline consolidation and long-term archiving.
 *
 * Complements the skills curator (services/skills/curator.js) which handles
 * skill lifecycle. This curator focuses on learned guideline hygiene.
 *
 * Operations:
 *   1. Similarity merge — detect and merge duplicate/overlapping guidelines
 *   2. Confidence rollup — boost frequently-confirmed guidelines, demote stale ones
 *   3. Long-term archive — move very old + low-confidence guidelines to a JSONL archive
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  listLearnedGuidelines,
  readLearnedGuidelines,
  writeLearnedGuidelines,
  setLearnedGuidelineStatus,
  normalizeGuidelineText
} = require('./learned-guidelines');

const ARCHIVE_DIR = path.join(os.homedir(), '.august', 'logs', 'curator');
const SIMILARITY_THRESHOLD = 0.6; // Jaccard index threshold for merging

// ── Similarity ──

function tokenSet(text) {
  return new Set(
    normalizeGuidelineText(text || '')
      .toLowerCase()
      .split(/\s+/)
      .filter(w => w.length > 2)
  );
}

function jaccardSimilarity(a, b) {
  const setA = tokenSet(a);
  const setB = tokenSet(b);
  if (setA.size === 0 && setB.size === 0) return 1;
  const intersection = new Set([...setA].filter(x => setB.has(x)));
  const union = new Set([...setA, ...setB]);
  return intersection.size / union.size;
}

// ── Consolidation ──

function findSimilarGroups(items) {
  const groups = [];
  const assigned = new Set();

  for (let i = 0; i < items.length; i++) {
    if (assigned.has(i)) continue;
    const group = { indices: [i], texts: [items[i].text], avgConfidence: items[i].confidence || 0 };
    assigned.add(i);

    for (let j = i + 1; j < items.length; j++) {
      if (assigned.has(j)) continue;
      const sim = jaccardSimilarity(items[i].text, items[j].text);
      if (sim >= SIMILARITY_THRESHOLD) {
        group.indices.push(j);
        group.texts.push(items[j].text);
        group.avgConfidence = (group.avgConfidence + (items[j].confidence || 0)) / 2;
        assigned.add(j);
      }
    }

    if (group.indices.length > 1) {
      groups.push(group);
    }
  }

  return groups;
}

function mergeGroup(group, items) {
  // Keep the highest-confidence text, merge metadata
  const members = group.indices.map(i => items[i]);
  const best = members.reduce((a, b) => ((a.confidence || 0) >= (b.confidence || 0) ? a : b));

  // Create merged text
  const mergedText = members
    .map(m => m.text)
    .filter(t => t.length > 0)
    .sort((a, b) => b.length - a.length)[0]; // longest = most specific

  return {
    text: mergedText || best.text,
    source: best.source || 'curator_merge',
    confidence: Math.min(1, members.reduce((s, m) => s + (m.confidence || 0), 0) / members.length + 0.1),
    count: members.reduce((s, m) => s + (m.count || 1), 0),
    merged_from: members.map(m => m.id)
  };
}

function consolidateGuidelines() {
  const items = listLearnedGuidelines({ status: 'active' });
  const groups = findSimilarGroups(items);
  const results = [];

  for (const group of groups) {
    const merged = mergeGroup(group, items);

    // Create the consolidated entry
    const { upsertLearnedGuideline } = require('./learned-guidelines');
    const saved = upsertLearnedGuideline(merged.text, {
      source: merged.source,
      confidence: merged.confidence,
      status: 'active'
    });

    // Archive the originals
    for (const idx of group.indices) {
      const original = items[idx];
      if (original.text !== merged.text) {
        setLearnedGuidelineStatus(original.id, 'archived', {
          reason: `merged into "${merged.text.slice(0, 80)}"`,
          actor: 'curator'
        });
      }
    }

    results.push({
      consolidated: merged.text.slice(0, 100),
      confidence: merged.confidence,
      count: merged.count,
      mergedIds: merged.merged_from
    });
  }

  return results;
}

// ── Long-term archive ──

function archiveOldGuidelines(maxAgeDays = 90) {
  const items = readLearnedGuidelines();
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  const archived = [];
  const kept = [];

  for (const item of items) {
    const lastSeen = new Date(item.lastSeenAt || item.createdAt).getTime();
    const isLowConfidence = (item.confidence || 0) < 0.4;
    const isOld = lastSeen < cutoff;

    if (isOld && isLowConfidence && item.status !== 'rejected') {
      archived.push(item);
    } else {
      kept.push(item);
    }
  }

  if (archived.length === 0) return [];

  // Write archived items to JSONL
  fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  const archiveFile = path.join(ARCHIVE_DIR, `guidelines_archive_${Date.now()}.jsonl`);
  const stream = fs.createWriteStream(archiveFile, { flags: 'a' });
  for (const item of archived) {
    stream.write(JSON.stringify(item) + '\n');
  }
  stream.end();

  // Remove archived items from active store
  const archiveIds = new Set(archived.map(a => a.id));
  writeLearnedGuidelines(kept.filter(k => !archiveIds.has(k.id)));

  return archived.map(a => ({
    id: a.id,
    text: a.text.slice(0, 80),
    archived_to: archiveFile
  }));
}

// ── Full run ──

function runCuratorReview() {
  const results = {
    consolidated: [],
    archived: []
  };

  try {
    results.consolidated = consolidateGuidelines();
  } catch (err) {
    console.warn('[MemoryCurator] Consolidation error:', err.message);
  }

  try {
    results.archived = archiveOldGuidelines();
  } catch (err) {
    console.warn('[MemoryCurator] Archive error:', err.message);
  }

  if (results.consolidated.length > 0 || results.archived.length > 0) {
    console.log(`[MemoryCurator] ${results.consolidated.length} consolidated, ${results.archived.length} archived`);
  }

  return results;
}

module.exports = {
  consolidateGuidelines,
  archiveOldGuidelines,
  runCuratorReview,
  jaccardSimilarity
};
