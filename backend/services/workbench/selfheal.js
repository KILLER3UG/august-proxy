// ── Self-healing: detect common tool errors and add hints so the model can fix them ──
// Updated for Windows/PowerShell-native environment (Claude Code runs locally on Windows).

// Bash commands that will FAIL in a Windows PowerShell environment,
// with their PowerShell equivalents. This is the PRIMARY detection direction.
const BASH_IN_WINDOWS = [
    { bash: 'grep ',     ps: 'Select-String' },
    { bash: "grep\t",    ps: 'Select-String' },
    { bash: 'ls ',       ps: 'Get-ChildItem' },
    { bash: 'ls\n',      ps: 'Get-ChildItem' },
    { bash: 'cat ',      ps: 'Get-Content' },
    { bash: 'rm -rf',    ps: 'Remove-Item -Recurse -Force' },
    { bash: 'rm -f ',    ps: 'Remove-Item -Force' },
    { bash: 'chmod ',    ps: 'Set-Acl or icacls' },
    { bash: 'chown ',    ps: 'Set-Acl' },
    { bash: 'sudo ',     ps: 'Start-Process -Verb RunAs (Run as Administrator)' },
    { bash: 'touch ',    ps: 'New-Item -Type File' },
    { bash: 'mkdir -p',  ps: 'New-Item -ItemType Directory -Force' },
    { bash: 'apt ',      ps: 'winget or choco' },
    { bash: 'apt-get ',  ps: 'winget or choco' },
    { bash: 'yum ',      ps: 'winget or choco' },
    { bash: 'brew ',     ps: 'winget or choco' },
    { bash: 'which ',    ps: 'Get-Command' },
    { bash: 'find ',     ps: 'Get-ChildItem -Recurse' },
    { bash: 'head -',    ps: 'Get-Content -TotalCount N' },
    { bash: 'tail -',    ps: 'Get-Content -Tail N' },
    { bash: 'wc -l',     ps: '(Get-Content file).Count' },
    { bash: 'sed -',     ps: '(Get-Content file) -replace' },
    { bash: 'awk ',      ps: 'Select-Object or ForEach-Object' },
    { bash: 'export ',   ps: '$env:VARNAME = "value"' },
    { bash: 'source ',   ps: '. (dot-source)' },
    { bash: 'echo $',    ps: 'Write-Host $env:VARNAME' },
    { bash: 'curl ',     ps: 'Invoke-WebRequest or Invoke-RestMethod' },
    { bash: 'wget ',     ps: 'Invoke-WebRequest -OutFile' },
    { bash: 'kill ',     ps: 'Stop-Process -Id' },
    { bash: 'ps aux',    ps: 'Get-Process' },
    { bash: 'df -',      ps: 'Get-PSDrive' },
    { bash: 'du -',      ps: 'Get-ChildItem -Recurse | Measure-Object -Property Length -Sum' },
];

// PowerShell cmdlets that will FAIL in a bash/unix environment.
// Secondary detection: kept for legacy compatibility if ever invoked from a unix context.
const PS_CMDLETS = [
    'Get-ChildItem', 'Select-Object', 'Where-Object', 'Get-Content',
    'Write-Host', 'Set-Location', 'Get-Location', 'Test-Path',
    'New-Item', 'Remove-Item', 'Copy-Item', 'Move-Item',
    'Out-File', 'Format-Table', 'Format-List', 'ForEach-Object',
    'Sort-Object', 'Measure-Object', 'Group-Object', 'Compare-Object',
    'Invoke-Expression', 'Start-Process', 'Get-Process', 'Stop-Process'
];

function detectError(content) {
    if (!content || typeof content !== 'string') return false;
    const lower = content.toLowerCase();
    return (
        lower.includes('error:') ||
        lower.includes('exit code') ||
        lower.includes('command not found') ||
        lower.includes('not found') ||
        lower.includes('not recognized as') ||       // Windows "not recognized as a cmdlet"
        lower.includes('cannot find path') ||         // Windows path errors
        lower.includes('no such file or directory') ||
        lower.includes('permission denied') ||
        lower.includes('access is denied') ||         // Windows permission error
        lower.includes('syntax error') ||
        lower.includes('unknown command') ||
        lower.includes('is not recognized') ||        // Windows command not found
        lower.includes('exited with code') ||
        lower.includes('failed with exit')
        || (lower.includes('browser-use') && (lower.includes('mcp servers: none') || lower.includes('mcpservers: none') || lower.includes('no mcp server')))
    );
}

function buildHints(content) {
    const hints = [];
    const lower = String(content || '').toLowerCase();

    if (
        lower.includes('browser-use') &&
        (lower.includes('mcp servers: none') || lower.includes('mcpservers: none') || lower.includes('no mcp server'))
    ) {
        hints.push(
            `[Proxy Self-Heal]: Browser Use imported without an MCP server. ` +
            `This is usually a plugin-import shape problem, not proof that browser automation is unavailable. ` +
            `Import https://github.com/browser-use/browser-use again with enable_mcp=true, then use the browser-use MCP recipe: ` +
            `uvx --from browser-use[cli] browser-use --mcp. ` +
            `If Chromium is missing, install it with: uvx --from browser-use[cli] browser-use install. ` +
            `Restart MCP servers and retry before stopping.`
        );
    }

    if (
        lower.includes('browser-use') &&
        (lower.includes('cli addon is not installed') || lower.includes('chromium') || lower.includes('chrome is missing'))
    ) {
        hints.push(
            `[Proxy Self-Heal]: Browser Use setup needs the CLI extra and a browser runtime. ` +
            `Use uvx --from browser-use[cli] browser-use --mcp for the MCP server, and run ` +
            `uvx --from browser-use[cli] browser-use install if Chromium is missing.`
        );
    }

    // ── PRIMARY: Bash-in-Windows detection ──
    // Claude Code runs locally on Windows in PowerShell. Bash commands will fail.
    const foundBash = BASH_IN_WINDOWS.filter(({ bash }) => content.includes(bash));
    if (foundBash.length > 0) {
        const replacements = foundBash
            .map(({ bash, ps }) => `\`${bash.trim()}\` → \`${ps}\``)
            .join(', ');
        hints.push(
            `[Proxy Self-Heal]: Bash command detected in a PowerShell/Windows environment. ` +
            `These commands will not work here. Use PowerShell equivalents: ${replacements}. ` +
            `Do NOT stop — fix and retry.`
        );
    }

    // ── SECONDARY: PowerShell-in-bash detection (legacy, for non-Windows contexts) ──
    const foundPs = PS_CMDLETS.filter(cmd => content.includes(cmd));
    if (foundPs.length > 0 && foundBash.length === 0) {
        // Only fire this if we're NOT already in the bash-in-windows case
        const equivalents = {
            'Get-ChildItem': 'ls, find, tree',
            'Select-Object': 'cut, awk, grep',
            'Where-Object': 'grep, awk',
            'Get-Content': 'cat, less, head, tail',
            'Write-Host': 'echo, printf',
            'Set-Location': 'cd',
            'Get-Location': 'pwd',
            'Test-Path': 'test -e, [ -f ]',
            'New-Item': 'mkdir, touch',
            'Remove-Item': 'rm, rmdir',
            'Copy-Item': 'cp',
            'Move-Item': 'mv',
            'Out-File': '>, tee',
            'Format-Table': 'column, printf',
            'Format-List': 'cat with formatting',
            'ForEach-Object': 'for, xargs',
            'Sort-Object': 'sort',
            'Measure-Object': 'wc',
            'Group-Object': 'sort | uniq -c',
            'Compare-Object': 'diff, comm',
            'Invoke-Expression': 'eval, source',
            'Start-Process': 'nohup, &, bg',
            'Get-Process': 'ps',
            'Stop-Process': 'kill, pkill'
        };
        const replacements = foundPs.map(c => `${c} → ${equivalents[c] || 'unix equivalent'}`).join(', ');
        hints.push(`[Proxy Self-Heal]: You used PowerShell commands (${foundPs.join(', ')}) in a bash/unix shell. Use bash equivalents instead: ${replacements}. Do NOT stop — fix the command and try again.`);
    }

    // Windows-specific "not recognized" errors
    if (content.includes('is not recognized') || content.includes('cannot be found')) {
        if (foundBash.length === 0 && foundPs.length === 0) {
            hints.push(
                `[Proxy Self-Heal]: Command not recognized in PowerShell. ` +
                `Check the command name, ensure it is installed (winget/choco), ` +
                `or use the full path. Use Get-Command to check availability. Do NOT stop.`
            );
        }
    }

    // Windows path separator issues (forward slashes in paths that need backslashes or vice versa)
    if (content.includes('cannot find path') && content.includes('/')) {
        hints.push(
            `[Proxy Self-Heal]: Windows path error with forward slashes detected. ` +
            `PowerShell generally accepts both / and \\ but some commands require \\. ` +
            `Try using Join-Path or $PSScriptRoot for reliable path construction.`
        );
    }

    // Generic permission denied
    if (content.includes('Access is denied') || content.includes('Permission denied')) {
        hints.push(
            `[Proxy Self-Heal]: Permission denied. ` +
            `Try running with elevated permissions (Start-Process -Verb RunAs), ` +
            `checking ACLs with Get-Acl, or writing to a different directory. ` +
            `Do NOT stop — fix the command and try again.`
        );
    }

    // Generic catch-all — M2.7 self-evolution hint
    if (hints.length === 0) {
        hints.push(
            `[Proxy Self-Heal]: The previous command failed. ` +
            `Analyze the error message carefully: identify the root cause, ` +
            `form a hypothesis, test it with a simpler diagnostic command, ` +
            `then apply the targeted fix. Do NOT stop — keep iterating until it works.`
        );
    }

    return hints;
}

function enhanceToolResult(content) {
    if (!detectError(content)) return content;

    const hints = buildHints(content);
    const hintBlock = '\n\n' + hints.join('\n');

    return content + hintBlock;
}

function applySelfHealToMessages(messages) {
    if (!Array.isArray(messages)) return messages;
    messages.forEach(m => {
        if (m.role === 'tool' && typeof m.content === 'string') {
            m.content = enhanceToolResult(m.content);
        }
    });
    return messages;
}

module.exports = { enhanceToolResult, applySelfHealToMessages };
