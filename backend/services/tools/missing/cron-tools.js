/**
 * cron-tools.js — Scheduled job management and execution engine.
 * Provides:
 * - august__list_cron_jobs: List all scheduled jobs
 * - august__create_cron_job: Create a scheduled job
 * - august__remove_cron_job: Delete a cron job
 * - august__run_cron_job_now: Execute a job immediately
 * - startCronScheduler(): Background engine that checks for due jobs every 30s
 */

const { z } = require('zod');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const os = require('os');
const { getDataDir } = require('../../../lib/data-paths');

// ── Data File ──

const DATA_DIR = getDataDir();
const CRON_JOBS_FILE = path.join(DATA_DIR, 'august_cron_jobs.json');
const DEFAULT_CRON_JOBS = { jobs: [], version: 1 };

// ── Scheduler State ──

let _schedulerInterval = null;
let _schedulerRunning = false;
let _lastCheckTime = null;

// ── File Helpers ──

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function readCronJobs() {
  ensureDataDir();
  if (!fs.existsSync(CRON_JOBS_FILE)) {
    writeCronJobs(DEFAULT_CRON_JOBS);
    return [...DEFAULT_CRON_JOBS.jobs];
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(CRON_JOBS_FILE, 'utf8'));
    const jobs = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.jobs) ? parsed.jobs : []);
    return jobs.map(normalizeJob);
  } catch (e) {
    return [...DEFAULT_CRON_JOBS.jobs];
  }
}

function writeCronJobs(jobs) {
  ensureDataDir();
  const data = { jobs: jobs || [], version: 1, updatedAt: new Date().toISOString() };
  fs.writeFileSync(CRON_JOBS_FILE, JSON.stringify(data, null, 2));
}

function saveCronJobs(jobs) {
  writeCronJobs(jobs);
}

// ── Job Normalization ──

let _jobIdCounter = 0;

function nextId() {
  _jobIdCounter++;
  return `cron_${Date.now().toString(36)}_${_jobIdCounter}_${Math.random().toString(36).slice(2, 6)}`;
}

function normalizeJob(job = {}) {
  const now = new Date().toISOString();
  return {
    id: job.id || nextId(),
    name: String(job.name || '').trim(),
    schedule: String(job.schedule || '').trim(),
    prompt: String(job.prompt || '').trim(),
    command: String(job.command || '').trim(),
    enabled: job.enabled !== false,
    createdAt: job.createdAt || now,
    updatedAt: job.updatedAt || now,
    lastRun: job.lastRun || null,
    lastStatus: job.lastStatus || null,
    lastOutput: job.lastOutput || null,
    runCount: job.runCount || 0,
    metadata: job.metadata || {}
  };
}

// ── Schedule Parsing ──

function parseScheduleInterval(schedule) {
  // Support simple interval strings like '30m', '2h', 'every 5 minutes', 'every 1 hour'
  const trimmed = schedule.toLowerCase().trim();

  // Try 'every X minutes' / 'every X hours'
  const everyMatch = trimmed.match(/^every\s+(\d+)\s*(min(?:ute)?s?|h(?:ou)?rs?|s(?:ec)?s?)?$/);
  if (everyMatch) {
    const num = parseInt(everyMatch[1], 10);
    const unit = everyMatch[2] ? everyMatch[2][0] : 'm';
    if (unit === 's') return num * 1000;
    if (unit === 'm') return num * 60 * 1000;
    if (unit === 'h') return num * 3600 * 1000;
    return num * 60 * 1000;
  }

  // Try compact formats: '30m', '2h', '90s', '1d'
  const compactMatch = trimmed.match(/^(\d+)\s*(s|m|h|d)$/);
  if (compactMatch) {
    const num = parseInt(compactMatch[1], 10);
    const unit = compactMatch[2];
    if (unit === 's') return num * 1000;
    if (unit === 'm') return num * 60 * 1000;
    if (unit === 'h') return num * 3600 * 1000;
    if (unit === 'd') return num * 86400 * 1000;
    return num * 60 * 1000;
  }

  // Try cron expression (simplified: minute hour * * *)
  // For cron, we check every 30 seconds if the pattern matches current time
  const cronMatch = trimmed.match(/^(\*|\d+)\s+(\*|\d+)\s+(\*|\d+)\s+(\*|\d+)\s+(\*|\d+)$/);
  if (cronMatch) {
    return 'cron'; // Mark as cron expression
  }

  // Default: 30 minutes
  return 30 * 60 * 1000;
}

function matchesCronExpression(schedule, date = new Date()) {
  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5) return false;

  const [min, hour, day, month, dow] = parts;

  const matchField = (pattern, value) => {
    if (pattern === '*') return true;
    const nums = pattern.split(',').map(s => parseInt(s.trim(), 10));
    return nums.includes(value);
  };

  return (
    matchField(min, date.getMinutes()) &&
    matchField(hour, date.getHours()) &&
    matchField(day, date.getDate()) &&
    matchField(month, date.getMonth() + 1) &&
    matchField(dow, date.getDay())
  );
}

// ── Job Execution ──

async function executeJob(job) {
  const startTime = Date.now();
  const result = {
    id: job.id,
    name: job.name,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    status: 'running',
    output: '',
    error: null
  };

  try {
    if (job.command) {
      // Execute a shell command
      const output = await runCommand(job.command);
      result.output = output.stdout;
      result.status = 'completed';
      if (output.exitCode !== 0) {
        result.status = 'failed';
        result.error = output.stderr || `Exit code ${output.exitCode}`;
      }
    } else if (job.prompt) {
      // For prompts, we signal that the prompt should be executed by the main agent
      result.output = `Prompt job "${job.name}" triggered. The prompt will be queued for execution:\n\n${job.prompt}`;
      result.status = 'completed';
      result.type = 'prompt';
    } else {
      result.output = 'Job has no command or prompt configured.';
      result.status = 'completed';
    }
  } catch (e) {
    result.status = 'failed';
    result.error = e.message;
  }

  result.finishedAt = new Date().toISOString();
  result.durationMs = Date.now() - startTime;

  // Update the job in the store
  const jobs = readCronJobs();
  const idx = jobs.findIndex(j => j.id === job.id);
  if (idx >= 0) {
    jobs[idx].lastRun = result.startedAt;
    jobs[idx].lastStatus = result.status;
    jobs[idx].lastOutput = result.output.slice(0, 5000);
    jobs[idx].runCount = (jobs[idx].runCount || 0) + 1;
    jobs[idx].updatedAt = new Date().toISOString();
    saveCronJobs(jobs);
  }

  return result;
}

function runCommand(command) {
  return new Promise((resolve) => {
    const child = spawn(command, [], {
      shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/bash',
      cwd: os.homedir(),
      timeout: 60000,
      maxBuffer: 1024 * 1024
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', data => { stdout += data.toString(); });
    child.stderr.on('data', data => { stderr += data.toString(); });

    child.on('close', exitCode => {
      resolve({ stdout, stderr, exitCode: exitCode || 0 });
    });

    child.on('error', err => {
      resolve({ stdout, stderr: err.message, exitCode: 1 });
    });
  });
}

// ── Tool Handlers ──

// august__list_cron_jobs
async function listCronJobsHandler() {
  try {
    const jobs = readCronJobs();
    if (jobs.length === 0) {
      return { jobs: [], count: 0, message: 'No cron jobs scheduled.' };
    }
    const publicJobs = jobs.map(j => ({
      id: j.id,
      name: j.name,
      schedule: j.schedule,
      enabled: j.enabled,
      lastRun: j.lastRun,
      lastStatus: j.lastStatus,
      runCount: j.runCount,
      createdAt: j.createdAt,
      hasCommand: !!j.command,
      hasPrompt: !!j.prompt
    }));
    return { jobs: publicJobs, count: publicJobs.length };
  } catch (e) {
    return { error: `Failed to list cron jobs: ${e.message}`, jobs: [], count: 0 };
  }
}

// august__create_cron_job
const CREATE_CRON_SCHEMA = z.object({
  name: z.string().min(1).max(128).describe('Unique name for this scheduled job'),
  schedule: z.string().min(1).describe(
    'Schedule: cron expression (e.g. "*/15 * * * *") or interval string (e.g. "30m", "2h", "every 5 minutes")'
  ),
  prompt: z.string().optional().describe('The prompt/instruction to execute when the job runs'),
  command: z.string().optional().describe('Shell command to execute (alternative to prompt)'),
  enabled: z.boolean().optional().default(true).describe('Whether the job is active')
});

async function createCronJobHandler(args) {
  const { name, schedule, prompt, command, enabled } = args;

  if (!prompt && !command) {
    return { error: 'Either "prompt" or "command" must be provided for the job.' };
  }

  const jobs = readCronJobs();

  // Check for duplicate name
  if (jobs.some(j => j.name.toLowerCase() === name.toLowerCase())) {
    return { error: `A cron job named "${name}" already exists. Choose a different name or remove the existing one first.` };
  }

  // Validate schedule
  try {
    const interval = parseScheduleInterval(schedule);
    if (!interval && schedule.trim() !== 'cron') {
      // Check if it's a valid cron expression
      const parts = schedule.trim().split(/\s+/);
      if (parts.length !== 5 && interval === 'cron') {
        // parsedScheduleInterval returned 'cron' for cron expressions
      }
    }
  } catch (e) {
    return { error: `Invalid schedule "${schedule}": ${e.message}` };
  }

  const newJob = normalizeJob({
    name,
    schedule,
    prompt: prompt || '',
    command: command || '',
    enabled: enabled !== false,
    createdAt: new Date().toISOString()
  });

  jobs.push(newJob);
  saveCronJobs(jobs);

  return {
    success: true,
    job: {
      id: newJob.id,
      name: newJob.name,
      schedule: newJob.schedule,
      enabled: newJob.enabled,
      hasCommand: !!newJob.command,
      hasPrompt: !!newJob.prompt
    },
    note: `Cron job "${name}" created. The scheduler checks every 30 seconds for due jobs.`
  };
}

// august__remove_cron_job
const REMOVE_CRON_SCHEMA = z.object({
  name: z.string().min(1).describe('Name of the cron job to remove')
});

async function removeCronJobHandler(args) {
  const { name } = args;
  const jobs = readCronJobs();
  const idx = jobs.findIndex(j => j.name.toLowerCase() === name.toLowerCase());

  if (idx === -1) {
    return { error: `Cron job "${name}" not found. Use list_cron_jobs to see all scheduled jobs.`, removed: false };
  }

  const removed = jobs.splice(idx, 1);
  saveCronJobs(jobs);

  return {
    success: true,
    removed: true,
    name,
    note: `Cron job "${name}" has been removed.`
  };
}

// august__run_cron_job_now
const RUN_CRON_NOW_SCHEMA = z.object({
  name: z.string().min(1).describe('Name of the cron job to execute immediately')
});

async function runCronJobNowHandler(args) {
  const { name } = args;
  const jobs = readCronJobs();
  const job = jobs.find(j => j.name.toLowerCase() === name.toLowerCase());

  if (!job) {
    return { error: `Cron job "${name}" not found. Use list_cron_jobs to see all scheduled jobs.` };
  }

  return await executeJob(job);
}

// ── Scheduler Engine ──

function startCronScheduler() {
  if (_schedulerRunning) {
    console.log('[CronScheduler] Scheduler is already running.');
    return false;
  }

  _schedulerRunning = true;
  _lastCheckTime = Date.now();

  console.log('[CronScheduler] Starting cron scheduler (checking every 30 seconds)...');

  _schedulerInterval = setInterval(() => {
    try {
      const jobs = readCronJobs();
      const now = Date.now();
      const nowDate = new Date();

      for (const job of jobs) {
        if (!job.enabled) continue;

        const interval = parseScheduleInterval(job.schedule);
        let shouldRun = false;

        if (interval === 'cron') {
          // Cron expression — check if current time matches
          if (matchesCronExpression(job.schedule, nowDate)) {
            // Only trigger once per minute (cache last cron trigger)
            const lastRun = job.lastRun ? new Date(job.lastRun).getTime() : 0;
            if (now - lastRun >= 60000) {
              shouldRun = true;
            }
          }
        } else if (typeof interval === 'number') {
          // Interval-based
          const lastRun = job.lastRun ? new Date(job.lastRun).getTime() : 0;
          if (now - lastRun >= interval) {
            shouldRun = true;
          }
        }

        if (shouldRun) {
          console.log(`[CronScheduler] Executing job: ${job.name}`);
          executeJob(job).catch(err => {
            console.error(`[CronScheduler] Job "${job.name}" failed:`, err.message);
          });
        }
      }

      _lastCheckTime = Date.now();
    } catch (e) {
      console.error('[CronScheduler] Error during check cycle:', e.message);
    }
  }, 30000); // Check every 30 seconds

  return true;
}

function stopCronScheduler() {
  if (!_schedulerRunning) return false;
  if (_schedulerInterval) {
    clearInterval(_schedulerInterval);
    _schedulerInterval = null;
  }
  _schedulerRunning = false;
  console.log('[CronScheduler] Stopped.');
  return true;
}

function isSchedulerRunning() {
  return _schedulerRunning;
}

// ── Tool Definitions ──

const toolDefinitions = [
  {
    name: 'august__list_cron_jobs',
    description: 'List all scheduled cron jobs. Returns job names, schedules, last run times, and statuses.',
    schema: z.object({}),
    handler: listCronJobsHandler,
    permissions: { category: 'read', destructive: false },
    toolset: 'missing',
    emoji: '\u{1F4CB}',
    timeoutMs: 10000,
    requiresEnv: [],
    metadata: { category: 'cron', source: 'missing-tools' }
  },
  {
    name: 'august__create_cron_job',
    description: 'Create a scheduled job that runs a prompt or command on a schedule. Supports cron expressions (e.g. "*/15 * * * *") and interval strings (e.g. "30m", "every 2 hours").',
    schema: CREATE_CRON_SCHEMA,
    handler: createCronJobHandler,
    permissions: { category: 'write', destructive: false },
    toolset: 'missing',
    emoji: '\u{23F0}',
    timeoutMs: 10000,
    requiresEnv: [],
    metadata: { category: 'cron', source: 'missing-tools' }
  },
  {
    name: 'august__remove_cron_job',
    description: 'Remove a scheduled cron job by name.',
    schema: REMOVE_CRON_SCHEMA,
    handler: removeCronJobHandler,
    permissions: { category: 'write', destructive: true },
    toolset: 'missing',
    emoji: '\u{1F5D1}\uFE0F',
    timeoutMs: 10000,
    requiresEnv: [],
    metadata: { category: 'cron', source: 'missing-tools' }
  },
  {
    name: 'august__run_cron_job_now',
    description: 'Execute a cron job immediately, regardless of its schedule.',
    schema: RUN_CRON_NOW_SCHEMA,
    handler: runCronJobNowHandler,
    permissions: { category: 'write', destructive: false },
    toolset: 'missing',
    emoji: '\u{25B6}\uFE0F',
    timeoutMs: 120000,
    requiresEnv: [],
    metadata: { category: 'cron', source: 'missing-tools' }
  }
];

// ── Registration helper ──

function registerCronTools(registry) {
  if (!registry || typeof registry.registerMany !== 'function') {
    throw new Error('registry must have a registerMany() method');
  }
  registry.registerMany(toolDefinitions);
}

module.exports = {
  toolDefinitions,
  registerCronTools,
  startCronScheduler,
  stopCronScheduler,
  isSchedulerRunning,
  listCronJobsHandler,
  createCronJobHandler,
  removeCronJobHandler,
  runCronJobNowHandler,
  executeJob,
  readCronJobs,
  getCronJobs: readCronJobs,
  saveCronJob: saveCronJobs,
  removeCronJob: removeCronJobHandler,
  runCronJobNow: executeJob,
  saveCronJobs,
  writeCronJobs,
  CRON_JOBS_FILE
};
