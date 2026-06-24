/**
 * skill-usage.js — Sidecar telemetry for skill usage tracking.
 * Inspired by Hermes's skill_usage.py pattern.
 *
 * Tracks per-skill usage metrics: use counts, view counts, lifecycle states.
 * All telemetry lives in ~/.august/skills/.usage.json as a sidecar file.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// ── Paths ──

const SKILLS_DIR = path.join(os.homedir(), '.august', 'skills');
const USAGE_FILE = path.join(SKILLS_DIR, '.usage.json');
const ARCHIVE_DIR = path.join(SKILLS_DIR, '.archive');
const BUNDLED_MANIFEST = path.join(SKILLS_DIR, '.bundled_manifest');

// ── Constants ──

const STATES = {
  ACTIVE: 'active',
  STALE: 'stale',
  ARCHIVED: 'archived'
};

const PROTECTED_BUILTINS = new Set(['plan']);

// ── File Safety (atomic writes) ──
// August runs as a single Node.js process, so we rely on atomic
// write-to-temp + rename rather than OS-level file locking.
// rename() is atomic on both Windows and Unix within the same filesystem.

// ── Record Management ──

function _emptyRecord() {
  return {
    created_by: null,
    use_count: 0,
    view_count: 0,
    last_used_at: null,
    last_viewed_at: null,
    patch_count: 0,
    last_patched_at: null,
    created_at: new Date().toISOString(),
    state: STATES.ACTIVE,
    pinned: false,
    archived_at: null
  };
}

function _nowIso() {
  return new Date().toISOString();
}

function _readUsageFile() {
  try {
    if (!fs.existsSync(USAGE_FILE)) return {};
    const raw = fs.readFileSync(USAGE_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function _writeUsageFile(data) {
  const dir = path.dirname(USAGE_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  // Atomic write: write to temp file then rename
  const tmpFile = USAGE_FILE + '.tmp';
  fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmpFile, USAGE_FILE);
}

// ── Public API: Activity Derivation ──

function latestActivityAt(record) {
  if (!record) return null;
  const timestamps = [
    record.last_used_at,
    record.last_viewed_at,
    record.last_patched_at
  ].filter(Boolean);
  if (timestamps.length === 0) return record.created_at;
  return timestamps.sort().reverse()[0];
}

function activityCount(record) {
  if (!record) return 0;
  return (record.use_count || 0) + (record.view_count || 0) + (record.patch_count || 0);
}

// ── Public API: Provenance Tracking ──

function _readBundledManifestNames() {
  try {
    if (!fs.existsSync(BUNDLED_MANIFEST)) return new Set();
    const lines = fs.readFileSync(BUNDLED_MANIFEST, 'utf8').split('\n');
    return new Set(lines.map(l => l.split(':')[0].trim()).filter(Boolean));
  } catch {
    return new Set();
  }
}

function isAgentCreated(skillName) {
  const bundled = _readBundledManifestNames();
  // If manifest doesn't exist, we can't determine provenance.
  // Default to false (conservative — don't curate unless we know it's agent-created).
  if (bundled.size === 0 && !fs.existsSync(BUNDLED_MANIFEST)) return false;
  return !bundled.has(skillName);
}

function isCurationEligible(skillName) {
  if (PROTECTED_BUILTINS.has(skillName)) return false;
  // Agent-created skills are always eligible
  if (isAgentCreated(skillName)) return true;
  // Bundled built-ins are eligible only if prune_builtins is enabled
  // For now, return false for bundled
  return false;
}

// ── Public API: Counter Bumps ──

function bumpUse(skillName) {
  const data = _readUsageFile();
  if (!data[skillName]) data[skillName] = _emptyRecord();
  data[skillName].use_count = (data[skillName].use_count || 0) + 1;
  data[skillName].last_used_at = _nowIso();
  _writeUsageFile(data);
}

function bumpPatch(skillName) {
  const data = _readUsageFile();
  if (!data[skillName]) data[skillName] = _emptyRecord();
  data[skillName].patch_count = (data[skillName].patch_count || 0) + 1;
  data[skillName].last_patched_at = _nowIso();
  _writeUsageFile(data);
}

// ── Public API: Lifecycle Mutations ──

function markAgentCreated(skillName) {
  if (!isCurationEligible(skillName)) return false;
  const data = _readUsageFile();
  if (!data[skillName]) data[skillName] = _emptyRecord();
  data[skillName].created_by = 'agent';
  _writeUsageFile(data);
  return true;
}

function setState(skillName, state) {
  if (!isCurationEligible(skillName)) return false;
  if (!Object.values(STATES).includes(state)) return false;
  const data = _readUsageFile();
  if (!data[skillName]) data[skillName] = _emptyRecord();
  data[skillName].state = state;
  if (state === STATES.ARCHIVED) {
    data[skillName].archived_at = _nowIso();
  }
  _writeUsageFile(data);
  return true;
}

function setPinned(skillName, pinned) {
  if (!isCurationEligible(skillName)) return false;
  const data = _readUsageFile();
  if (!data[skillName]) data[skillName] = _emptyRecord();
  data[skillName].pinned = !!pinned;
  _writeUsageFile(data);
  return true;
}

function forget(skillName) {
  const data = _readUsageFile();
  if (data[skillName]) {
    delete data[skillName];
    _writeUsageFile(data);
  }
}

// ── Public API: Archive/Restore ──

function archiveSkill(skillName) {
  const skillDir = path.join(SKILLS_DIR, skillName);
  if (!fs.existsSync(skillDir)) return false;

  // Ensure archive directory exists
  if (!fs.existsSync(ARCHIVE_DIR)) {
    fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  }

  // Handle collision by appending timestamp
  let targetDir = path.join(ARCHIVE_DIR, skillName);
  if (fs.existsSync(targetDir)) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '');
    targetDir = `${targetDir}_${timestamp}`;
  }

  fs.renameSync(skillDir, targetDir);
  setState(skillName, STATES.ARCHIVED);
  return true;
}

function restoreSkill(skillName) {
  const archiveDir = path.join(ARCHIVE_DIR, skillName);
  if (!fs.existsSync(archiveDir)) return false;

  const targetDir = path.join(SKILLS_DIR, skillName);
  if (fs.existsSync(targetDir)) return false; // Would shadow existing

  fs.renameSync(archiveDir, targetDir);
  setState(skillName, STATES.ACTIVE);
  return true;
}

// ── Public API: Reporting ──

function agentCreatedReport() {
  const data = _readUsageFile();
  const report = [];
  for (const [name, record] of Object.entries(data)) {
    if (record.created_by === 'agent' && isCurationEligible(name)) {
      report.push({
        name,
        use_count: record.use_count || 0,
        view_count: record.view_count || 0,
        patch_count: record.patch_count || 0,
        last_activity_at: latestActivityAt(record),
        state: record.state || STATES.ACTIVE,
        pinned: record.pinned || false,
        created_at: record.created_at
      });
    }
  }
  return report;
}

function usageReport() {
  const data = _readUsageFile();
  const report = [];
  for (const [name, record] of Object.entries(data)) {
    report.push({
      name,
      created_by: record.created_by || 'unknown',
      use_count: record.use_count || 0,
      view_count: record.view_count || 0,
      patch_count: record.patch_count || 0,
      last_activity_at: latestActivityAt(record),
      state: record.state || STATES.ACTIVE,
      pinned: record.pinned || false,
      created_at: record.created_at
    });
  }
  return report;
}

function getRecord(skillName) {
  const data = _readUsageFile();
  return data[skillName] || null;
}

function seedRecordIfMissing(skillName) {
  const data = _readUsageFile();
  if (!data[skillName]) {
    data[skillName] = _emptyRecord();
    _writeUsageFile(data);
  }
}

// ── Exports ──

module.exports = {
  STATES,
  PROTECTED_BUILTINS,
  latestActivityAt,
  activityCount,
  isAgentCreated,
  isCurationEligible,
  bumpUse,
  bumpPatch,
  markAgentCreated,
  setState,
  setPinned,
  forget,
  archiveSkill,
  restoreSkill,
  agentCreatedReport,
  usageReport,
  getRecord,
  seedRecordIfMissing
};
