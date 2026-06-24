/**
 * curator.js — Background skill maintenance orchestrator.
 * Inspired by Hermes's curator.py pattern.
 *
 * Runs inactivity-triggered (not cron): when agent is idle and last run
 * was older than interval_hours, spawns a review pass.
 *
 * Manages skill lifecycle: active → stale → archived.
 * Optional LLM consolidation pass for umbrella-building.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const skillUsage = require('./skill-usage');

// ── Paths ──

const SKILLS_DIR = path.join(os.homedir(), '.august', 'skills');
const CURATOR_STATE_FILE = path.join(SKILLS_DIR, '.curator_state');
const CURATOR_LOGS_DIR = path.join(os.homedir(), '.august', 'logs', 'curator');

// ── Defaults ──

const DEFAULTS = {
  intervalHours: 24 * 7,      // 7 days
  minIdleHours: 2,
  staleAfterDays: 30,
  archiveAfterDays: 90,
  consolidate: false          // LLM umbrella-building off by default
};

// ── State Persistence ──

function _readState() {
  try {
    if (!fs.existsSync(CURATOR_STATE_FILE)) return null;
    const raw = fs.readFileSync(CURATOR_STATE_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function _writeState(state) {
  const dir = path.dirname(CURATOR_STATE_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmpFile = CURATOR_STATE_FILE + '.tmp';
  fs.writeFileSync(tmpFile, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmpFile, CURATOR_STATE_FILE);
}

function _nowIso() {
  return new Date().toISOString();
}

function _hoursSince(isoTimestamp) {
  if (!isoTimestamp) return Infinity;
  const then = new Date(isoTimestamp).getTime();
  const now = Date.now();
  return (now - then) / (1000 * 60 * 60);
}

// ── Configuration ──

function _getConfig() {
  try {
    const { getConfig } = require('../../lib/config');
    const config = getConfig();
    return config.curator || {};
  } catch {
    return {};
  }
}

function _getIntervalHours() {
  const config = _getConfig();
  return config.interval_hours || DEFAULTS.intervalHours;
}

function _getMinIdleHours() {
  const config = _getConfig();
  return config.min_idle_hours || DEFAULTS.minIdleHours;
}

function _getStaleAfterDays() {
  const config = _getConfig();
  return config.stale_after_days || DEFAULTS.staleAfterDays;
}

function _getArchiveAfterDays() {
  const config = _getConfig();
  return config.archive_after_days || DEFAULTS.archiveAfterDays;
}

function _isConsolidateEnabled() {
  const config = _getConfig();
  return config.consolidate === true;
}

function _isEnabled() {
  const config = _getConfig();
  return config.enabled !== false; // Default to true
}

function isPaused() {
  const state = _readState();
  return state?.paused === true;
}

function pause() {
  const state = _readState() || {};
  state.paused = true;
  _writeState(state);
}

function unpause() {
  const state = _readState() || {};
  state.paused = false;
  _writeState(state);
}

// ── Scheduling Gate ──

function shouldRunNow() {
  if (!_isEnabled()) return false;
  if (isPaused()) return false;

  const state = _readState();
  if (!state?.last_run_at) {
    // First run: seed to now and defer by one interval
    _writeState({
      ...state,
      last_run_at: _nowIso(),
      paused: false,
      run_count: 0
    });
    return false;
  }

  const hoursSinceLastRun = _hoursSince(state.last_run_at);
  return hoursSinceLastRun >= _getIntervalHours();
}

function maybeRunCurator() {
  if (!shouldRunNow()) return false;

  const minIdleHours = _getMinIdleHours();
  // In a real implementation, we'd check agent idle time
  // For now, we just run when shouldRunNow() is true
  return runCuratorReview();
}

// ── Automatic State Transitions ──

function applyAutomaticTransitions() {
  const staleAfterDays = _getStaleAfterDays();
  const archiveAfterDays = _getArchiveAfterDays();
  const now = new Date();

  const staleCutoff = new Date(now.getTime() - staleAfterDays * 24 * 60 * 60 * 1000);
  const archiveCutoff = new Date(now.getTime() - archiveAfterDays * 24 * 60 * 60 * 1000);

  const transitions = [];
  const agentSkills = skillUsage.agentCreatedReport();

  for (const skill of agentSkills) {
    // Pinned skills bypass all transitions
    if (skill.pinned) continue;

    const anchor = new Date(skill.last_activity_at || skill.created_at);
    const currentState = skill.state;

    if (anchor <= archiveCutoff && currentState !== skillUsage.STATES.ARCHIVED) {
      // Archive
      skillUsage.archiveSkill(skill.name);
      transitions.push({
        name: skill.name,
        from: currentState,
        to: skillUsage.STATES.ARCHIVED,
        reason: `inactive for >${archiveAfterDays} days`
      });
    } else if (anchor <= staleCutoff && currentState === skillUsage.STATES.ACTIVE) {
      // Mark stale
      skillUsage.setState(skill.name, skillUsage.STATES.STALE);
      transitions.push({
        name: skill.name,
        from: currentState,
        to: skillUsage.STATES.STALE,
        reason: `inactive for >${staleAfterDays} days`
      });
    } else if (anchor > staleCutoff && currentState === skillUsage.STATES.STALE) {
      // Reactivate
      skillUsage.setState(skill.name, skillUsage.STATES.ACTIVE);
      transitions.push({
        name: skill.name,
        from: currentState,
        to: skillUsage.STATES.ACTIVE,
        reason: 'activity detected'
      });
    }
  }

  return transitions;
}

// ── Skill Discovery for Curation ──

function _discoverCurationCandidates() {
  const candidates = [];
  const dirs = [SKILLS_DIR];

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith('.')) continue; // Skip hidden dirs

        const skillName = entry.name;
        if (!skillUsage.isCurationEligible(skillName)) continue;

        // Seed record if missing
        skillUsage.seedRecordIfMissing(skillName);

        const record = skillUsage.getRecord(skillName);
        candidates.push({
          name: skillName,
          record,
          path: path.join(dir, skillName)
        });
      }
    } catch {}
  }

  return candidates;
}

// ── LLM Consolidation Pass ──

const CURATOR_REVIEW_PROMPT = `
You are a skill library curator for August Proxy. Your job is to review the skill library
and identify opportunities to consolidate narrow, session-specific skills into broader
"umbrella" skills that capture class-level knowledge.

RULES:
1. NEVER touch bundled or hub-installed skills (only agent-created skills)
2. NEVER delete skills - only archive them
3. NEVER touch pinned skills
4. A collection of hundreds of narrow skills where each captures one session's specific bug
   is a FAILURE of the library

STRATEGIES:
1. Merge into existing umbrella: If a narrow skill fits under an existing broad skill,
   merge its content into the umbrella and archive the narrow one.
2. Create new umbrella: If multiple narrow skills share a domain but no umbrella exists,
   create a new umbrella skill that captures the class-level knowledge.
3. Demote to references: If content is too specific for an umbrella but worth keeping,
   move it to the references/ subdirectory of a related skill.

OUTPUT FORMAT:
Respond with a YAML block listing your recommendations:
\`\`\`yaml
consolidations:
  - action: merge|create|demote
    source: <skill-name-to-archive>
    target: <umbrella-skill-name-or-null>
    reason: <brief explanation>
\`\`\`
`;

function _buildConsolidationPrompt(candidates) {
  const skillList = candidates.map(c => {
    const record = c.record || {};
    return `- ${c.name}: uses=${record.use_count || 0}, views=${record.view_count || 0}, state=${record.state || 'active'}`;
  }).join('\n');

  return `${CURATOR_REVIEW_PROMPT}\n\nCurrent agent-created skills:\n${skillList}`;
}

// ── Report Writing ──

function _writeRunReport(runData) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const reportDir = path.join(CURATOR_LOGS_DIR, timestamp);

  if (!fs.existsSync(reportDir)) {
    fs.mkdirSync(reportDir, { recursive: true });
  }

  // Machine-readable run.json
  const runJsonPath = path.join(reportDir, 'run.json');
  fs.writeFileSync(runJsonPath, JSON.stringify(runData, null, 2), 'utf8');

  // Human-readable REPORT.md
  const reportMdPath = path.join(reportDir, 'REPORT.md');
  const reportMd = _generateReportMarkdown(runData);
  fs.writeFileSync(reportMdPath, reportMd, 'utf8');

  return reportDir;
}

function _generateReportMarkdown(runData) {
  const lines = [
    '# Curator Run Report',
    '',
    `**Date:** ${runData.timestamp}`,
    `**Duration:** ${runData.duration_seconds?.toFixed(1) || 'N/A'}s`,
    '',
    '## Automatic State Transitions',
    ''
  ];

  if (runData.transitions.length === 0) {
    lines.push('No transitions occurred.');
  } else {
    lines.push('| Skill | From | To | Reason |');
    lines.push('|-------|------|-----|--------|');
    for (const t of runData.transitions) {
      lines.push(`| ${t.name} | ${t.from} | ${t.to} | ${t.reason} |`);
    }
  }

  lines.push('', '## LLM Consolidation', '');

  if (runData.consolidation?.consolidations?.length) {
    lines.push('| Action | Source | Target | Reason |');
    lines.push('|--------|--------|--------|--------|');
    for (const c of runData.consolidation.consolidations) {
      lines.push(`| ${c.action} | ${c.source} | ${c.target || 'N/A'} | ${c.reason} |`);
    }
  } else {
    lines.push('No consolidation recommendations.');
  }

  lines.push('', '## Summary', '');
  lines.push(`- Transitions: ${runData.transitions.length}`);
  lines.push(`- Consolidation recommendations: ${runData.consolidation?.consolidations?.length || 0}`);
  lines.push(`- Skills reviewed: ${runData.candidates_count || 0}`);

  return lines.join('\n');
}

// ── Main Orchestrator ──

function runCuratorReview(options = {}) {
  const { dryRun = false, synchronous = false, consolidate = false } = options;

  const startTime = Date.now();
  const state = _readState() || {};

  // 1. Apply automatic state transitions
  const transitions = applyAutomaticTransitions();

  // 2. Discover curation candidates
  const candidates = _discoverCurationCandidates();

  // 3. LLM consolidation (optional, off by default)
  let consolidationResult = null;
  const shouldConsolidate = consolidate || _isConsolidateEnabled();
  if (shouldConsolidate && candidates.length > 0 && !dryRun) {
    // In a real implementation, this would spawn an LLM agent
    // For now, we just log that consolidation would run
    consolidationResult = {
      consolidations: [],
      note: 'LLM consolidation not yet implemented'
    };
  }

  const duration = (Date.now() - startTime) / 1000;

  // 4. Build run data
  const runData = {
    timestamp: _nowIso(),
    duration_seconds: duration,
    transitions,
    candidates_count: candidates.length,
    consolidation: consolidationResult,
    dry_run: dryRun
  };

  // 5. Write report (unless dry run)
  let reportPath = null;
  if (!dryRun) {
    reportPath = _writeRunReport(runData);
  }

  // 6. Update state
  if (!dryRun) {
    state.last_run_at = _nowIso();
    state.last_run_duration_seconds = duration;
    state.last_run_summary = `${transitions.length} transitions, ${candidates.length} candidates`;
    state.last_report_path = reportPath;
    state.run_count = (state.run_count || 0) + 1;
    _writeState(state);
  }

  return {
    success: true,
    transitions,
    candidates_count: candidates.length,
    consolidation: consolidationResult,
    duration_seconds: duration,
    report_path: reportPath,
    dry_run: dryRun
  };
}

// ── Public API ──

function getState() {
  return _readState();
}

function getStatus() {
  const state = _readState();
  const config = {
    enabled: _isEnabled(),
    interval_hours: _getIntervalHours(),
    stale_after_days: _getStaleAfterDays(),
    archive_after_days: _getArchiveAfterDays(),
    consolidate: _isConsolidateEnabled(),
    paused: isPaused()
  };

  return {
    config,
    state: state || {
      last_run_at: null,
      run_count: 0,
      paused: false
    },
    should_run_now: shouldRunNow()
  };
}

module.exports = {
  DEFAULTS,
  shouldRunNow,
  maybeRunCurator,
  applyAutomaticTransitions,
  runCuratorReview,
  getState,
  getStatus,
  pause,
  unpause,
  isPaused
};
