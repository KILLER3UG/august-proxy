/**
 * doctor.js — Health diagnostics for computer use.
 * Inspired by Hermes's computer_use/doctor.py pattern.
 *
 * Performs platform-specific health checks for the computer use backend.
 */

const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

// ── Health Check Results ──

class HealthCheckResult {
  constructor(name, status, message, details = {}) {
    this.name = name;
    this.status = status; // 'ok', 'warning', 'error'
    this.message = message;
    this.details = details;
  }
}

// ── Platform-Specific Checks ──

/**
 * Check macOS permissions (Accessibility, Screen Recording).
 */
function checkMacOSPermissions() {
  const checks = [];

  // Check if we're on macOS
  if (os.platform() !== 'darwin') {
    return checks;
  }

  // Check Accessibility permission
  try {
    const result = execSync(
      'osascript -e "tell application \\"System Events\\" to return name of first process"',
      { encoding: 'utf8', timeout: 5000 }
    );
    checks.push(new HealthCheckResult(
      'macOS Accessibility',
      'ok',
      'Accessibility permission granted',
      { output: result.trim() }
    ));
  } catch (error) {
    checks.push(new HealthCheckResult(
      'macOS Accessibility',
      'error',
      'Accessibility permission not granted',
      {
        solution: 'Grant Accessibility permission in System Settings > Privacy & Security > Accessibility',
        error: error.message
      }
    ));
  }

  // Check Screen Recording permission
  try {
    // Try to capture a small screenshot
    execSync('screencapture -x -t png /tmp/test_screenshot.png', { timeout: 5000 });
    checks.push(new HealthCheckResult(
      'macOS Screen Recording',
      'ok',
      'Screen Recording permission granted'
    ));
  } catch (error) {
    checks.push(new HealthCheckResult(
      'macOS Screen Recording',
      'warning',
      'Screen Recording permission may not be granted',
      {
        solution: 'Grant Screen Recording permission in System Settings > Privacy & Security > Screen Recording'
      }
    ));
  }

  return checks;
}

/**
 * Check Windows UI Automation availability.
 */
function checkWindowsUIAutomation() {
  const checks = [];

  if (os.platform() !== 'win32') {
    return checks;
  }

  // Check if UI Automation is available
  try {
    // PowerShell command to check UI Automation
    const result = execSync(
      'powershell -Command "Add-Type -AssemblyName UIAutomationClient; [System.Windows.Automation.AutomationElement]::RootElement"',
      { encoding: 'utf8', timeout: 10000 }
    );
    checks.push(new HealthCheckResult(
      'Windows UI Automation',
      'ok',
      'UI Automation available'
    ));
  } catch (error) {
    checks.push(new HealthCheckResult(
      'Windows UI Automation',
      'warning',
      'Could not verify UI Automation',
      { error: error.message }
    ));
  }

  return checks;
}

/**
 * Check Linux display server (X11/Wayland).
 */
function checkLinuxDisplayServer() {
  const checks = [];

  if (os.platform() !== 'linux') {
    return checks;
  }

  // Check display server
  const displayServer = process.env.WAYLAND_DISPLAY ? 'wayland' : process.env.DISPLAY ? 'x11' : 'none';

  if (displayServer === 'none') {
    checks.push(new HealthCheckResult(
      'Linux Display Server',
      'error',
      'No display server detected',
      {
        solution: 'Ensure X11 or Wayland is running',
        env: { DISPLAY: process.env.DISPLAY, WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY }
      }
    ));
  } else {
    checks.push(new HealthCheckResult(
      'Linux Display Server',
      'ok',
      `${displayServer.toUpperCase()} detected`,
      { displayServer }
    ));
  }

  // Check for xdotool (X11) or ydotool (Wayland)
  if (displayServer === 'x11') {
    try {
      execSync('which xdotool', { encoding: 'utf8', timeout: 2000 });
      checks.push(new HealthCheckResult(
        'xdotool',
        'ok',
        'xdotool available for X11 automation'
      ));
    } catch {
      checks.push(new HealthCheckResult(
        'xdotool',
        'warning',
        'xdotool not found',
        { solution: 'Install xdotool for X11 automation support' }
      ));
    }
  }

  return checks;
}

/**
 * Check cua-driver binary availability.
 */
function checkCuaDriver() {
  const checks = [];

  // Check common locations
  const commonPaths = os.platform() === 'win32'
    ? [
        path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'cua-driver', 'cua-driver.exe'),
        path.join(os.homedir(), '.august', 'bin', 'cua-driver.exe')
      ]
    : [
        path.join(os.homedir(), '.august', 'bin', 'cua-driver'),
        '/usr/local/bin/cua-driver',
        '/opt/homebrew/bin/cua-driver'
      ];

  // Check PATH
  try {
    const cmd = os.platform() === 'win32' ? 'where cua-driver' : 'which cua-driver';
    const result = execSync(cmd, { encoding: 'utf8', timeout: 2000 }).trim();
    checks.push(new HealthCheckResult(
      'cua-driver',
      'ok',
      `cua-driver found in PATH: ${result.split('\n')[0]}`,
      { path: result.split('\n')[0] }
    ));
    return checks;
  } catch {}

  // Check common locations
  for (const p of commonPaths) {
    try {
      const fs = require('fs');
      if (fs.existsSync(p)) {
        checks.push(new HealthCheckResult(
          'cua-driver',
          'ok',
          `cua-driver found at: ${p}`,
          { path: p }
        ));
        return checks;
      }
    } catch {}
  }

  checks.push(new HealthCheckResult(
    'cua-driver',
    'error',
    'cua-driver binary not found',
    {
      solution: 'Install cua-driver from https://github.com/august-proxy/cua-driver',
      searchPaths: commonPaths
    }
  ));

  return checks;
}

/**
 * Check configuration.
 */
function checkConfiguration() {
  const checks = [];

  try {
    const { getConfig } = require('../../lib/config');
    const config = getConfig();
    const computerUseConfig = config.computer_use || {};

    if (computerUseConfig.enabled === false) {
      checks.push(new HealthCheckResult(
        'Configuration',
        'warning',
        'Computer use is disabled in config',
        { config: computerUseConfig }
      ));
    } else {
      checks.push(new HealthCheckResult(
        'Configuration',
        'ok',
        'Computer use configuration present',
        { config: computerUseConfig }
      ));
    }
  } catch (error) {
    checks.push(new HealthCheckResult(
      'Configuration',
      'warning',
      'Could not read configuration',
      { error: error.message }
    ));
  }

  return checks;
}

// ── Main Health Check ──

/**
 * Run all health checks.
 * @returns {Object} - Health check results
 */
function runHealthChecks() {
  const platform = os.platform();
  const checks = [];

  // Run platform-specific checks
  switch (platform) {
    case 'darwin':
      checks.push(...checkMacOSPermissions());
      break;
    case 'win32':
      checks.push(...checkWindowsUIAutomation());
      break;
    case 'linux':
      checks.push(...checkLinuxDisplayServer());
      break;
  }

  // Run common checks
  checks.push(...checkCuaDriver());
  checks.push(...checkConfiguration());

  // Calculate overall status
  const hasErrors = checks.some(c => c.status === 'error');
  const hasWarnings = checks.some(c => c.status === 'warning');

  let overallStatus;
  if (hasErrors) {
    overallStatus = 'error';
  } else if (hasWarnings) {
    overallStatus = 'warning';
  } else {
    overallStatus = 'ok';
  }

  return {
    platform,
    overall: overallStatus,
    checks,
    timestamp: new Date().toISOString()
  };
}

/**
 * Format health check results as human-readable report.
 */
function formatHealthReport(results) {
  const lines = [
    `# Computer Use Health Report`,
    '',
    `**Platform:** ${results.platform}`,
    `**Overall:** ${results.overall.toUpperCase()}`,
    `**Timestamp:** ${results.timestamp}`,
    '',
    '## Checks',
    ''
  ];

  for (const check of results.checks) {
    const icon = check.status === 'ok' ? '✅' : check.status === 'warning' ? '⚠️' : '❌';
    lines.push(`### ${icon} ${check.name}`);
    lines.push(`**Status:** ${check.status}`);
    lines.push(`**Message:** ${check.message}`);
    if (Object.keys(check.details).length > 0) {
      lines.push('**Details:**');
      lines.push('```json');
      lines.push(JSON.stringify(check.details, null, 2));
      lines.push('```');
    }
    lines.push('');
  }

  return lines.join('\n');
}

module.exports = {
  HealthCheckResult,
  runHealthChecks,
  formatHealthReport,
  checkMacOSPermissions,
  checkWindowsUIAutomation,
  checkLinuxDisplayServer,
  checkCuaDriver,
  checkConfiguration
};
