/**
 * Critical-action classification.
 *
 * Determines whether a tool invocation requires explicit `confirm-mutation`
 * EVEN in `guardMode: 'full'`. Locked decision 2: critical actions are
 * never silent regardless of guard mode.
 *
 * Returns `{ critical: boolean, reasons: string[] }`.
 */

const SYSTEM_DIR_PATTERNS = [
    /^[A-Za-z]:[\/\\]Windows([\/\\]|$)/i,
    /^[A-Za-z]:[\/\\]Program Files([\/\\]|$)/i,
    /^[A-Za-z]:[\/\\]Program Files \(x86\)([\/\\]|$)/i,
    /^\/usr([\/]|$)/,
    /^\/etc([\/]|$)/,
    /^\/var([\/]|$)/,
    /^\/Library([\/]|$)/,
    /^\/System([\/]|$)/
];

const DESTRUCTIVE_SHELL_PATTERNS = [
    /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r|-rf|-fr)\b/,                 // rm -rf
    /\bRemove-Item\b[\s\S]*-Recurse[\s\S]*-Force\b/,                                   // PowerShell Remove-Item -Recurse -Force
    /\bFormat-[A-Za-z]+\b/,                                                            // Format-Volume, Format-Disk, etc.
    /\b(del|rd)\s+\/s\s+\/q\b/i,                                                      // Windows del /s /q, rd /s /q
    /\brmdir\s+\/s\s+\/q\b/i
];

const PACKAGE_INSTALL_PATTERNS = [
    /\bnpm\s+(install|i|add)\b/,
    /\bpnpm\s+(install|i|add)\b/,
    /\byarn\s+(install|add)\b/,
    /\bwinget\s+(install|add)\b/i,
    /\bchoco\s+install\b/i,
    /\bapt(-get)?\s+install\b/,
    /\byum\s+install\b/,
    /\bbrew\s+install\b/,
    /\bscoop\s+install\b/i
];

const SERVICE_MANAGER_PATTERNS = [
    /\bsc\s+(create|delete|config|start|stop)\b/i,
    /\bsystemctl\s+(enable|disable|start|stop|restart|mask)\b/,
    /\bnet\s+(start|stop)\b/i,
    /\breg\s+(add|delete|import)\b/i
];

function isSystemPath(p) {
    if (!p || typeof p !== 'string') return false;
    return SYSTEM_DIR_PATTERNS.some(rx => rx.test(p));
}

function matchesAny(haystack, patterns) {
    if (typeof haystack !== 'string') return false;
    return patterns.some(rx => rx.test(haystack));
}

/**
 * Classify whether a tool invocation is critical.
 *
 * @param {object} input
 * @param {string} input.toolName
 * @param {object} [input.args] - tool arguments (may be undefined)
 * @param {string} [input.operation] - 'read' | 'write' | 'delete' | ...
 * @returns {{critical: boolean, reasons: string[]}}
 */
function classifyCriticalAction({ toolName, args = {}, operation } = {}) {
    const reasons = [];
    const name = String(toolName || '');

    // 1. Filesystem operations
    if (name === 'august__filesystem_delete') {
        if (args && args.recursive === true) {
            reasons.push('recursive_delete');
        }
        if (args && args.path && isSystemPath(String(args.path))) {
            reasons.push('system_dir_mutation');
        }
    }

    if (name === 'august__filesystem_move' || name === 'august__filesystem_copy') {
        if (args && args.destination && isSystemPath(String(args.destination))) {
            reasons.push('system_dir_mutation');
        }
        if (args && args.path && isSystemPath(String(args.path))) {
            reasons.push('system_dir_mutation');
        }
    }

    if (name === 'august__filesystem_write' || name === 'august__filesystem_copy' || name === 'august__filesystem_move') {
        // broad filesystem writes inside allowed roots but unknown target: not critical by default
        // (will still go through MUTATING_WORKBENCH_TOOLS gate).
    }

    // 2. Shell / process / env mutations
    if (name === 'august__system_exec') {
        const cmd = args && args.command ? String(args.command) : '';
        if (matchesAny(cmd, DESTRUCTIVE_SHELL_PATTERNS)) {
            reasons.push('destructive_shell');
        }
        if (matchesAny(cmd, PACKAGE_INSTALL_PATTERNS)) {
            reasons.push('package_install');
        }
        if (matchesAny(cmd, SERVICE_MANAGER_PATTERNS)) {
            reasons.push('service_manager');
        }
        if (cmd && /\bshutdown\b|\breboot\b|\bStop-Computer\b|\bRestart-Computer\b/i.test(cmd)) {
            reasons.push('system_shutdown');
        }
    }

    if (name === 'august__system_process') {
        if (args && (args.action === 'stop' || args.action === 'start')) {
            reasons.push('process_control');
            if (args.action === 'stop' && args.pid && !args.ownedByAugust) {
                reasons.push('kill_non_august_process');
            }
        }
    }

    if (name === 'august__system_env') {
        if (args && (args.action === 'set' || args.action === 'delete')) {
            reasons.push('env_mutation');
        }
    }

    // 3. August self-management mutations
    if (name === 'august__settings_update') {
        if (typeof args?.key_path === 'string' && args.key_path.startsWith('security.')) {
            reasons.push('security_config_mutation');
        }
    }

    if (name === 'august__agents_manage' && args && args.action === 'delete') {
        reasons.push('agent_deletion');
    }

    // 4. Audit / rollback file integrity
    if (name === 'august__filesystem_delete' && args && typeof args.path === 'string') {
        const p = String(args.path).toLowerCase();
        if (p.includes('august_audit_log') || p.includes('august_rollback')) {
            reasons.push('audit_or_rollback_integrity');
        }
    }

    // 5. Operation flag overrides (defensive)
    if (operation === 'critical') reasons.push('explicit_critical');

    // Dedupe
    const unique = Array.from(new Set(reasons));
    return { critical: unique.length > 0, reasons: unique };
}

module.exports = {
    classifyCriticalAction,
    // Exported for tests
    _internals: {
        isSystemPath,
        SYSTEM_DIR_PATTERNS,
        DESTRUCTIVE_SHELL_PATTERNS,
        PACKAGE_INSTALL_PATTERNS,
        SERVICE_MANAGER_PATTERNS
    }
};
