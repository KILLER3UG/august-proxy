const test = require('node:test');
const assert = require('node:assert/strict');

const {
    classifyCriticalAction
} = require('../services/permissions/critical-actions');

test('recursive delete is critical', () => {
    const r = classifyCriticalAction({
        toolName: 'august__filesystem_delete',
        args: { path: 'C:/Users/me/somewhere', recursive: true }
    });
    assert.equal(r.critical, true);
    assert.ok(r.reasons.includes('recursive_delete'));
});

test('non-recursive delete in user dir is not critical', () => {
    const r = classifyCriticalAction({
        toolName: 'august__filesystem_delete',
        args: { path: 'C:/Users/me/file.txt', recursive: false }
    });
    assert.equal(r.critical, false);
});

test('delete inside C:\\Windows is critical (system dir)', () => {
    const r = classifyCriticalAction({
        toolName: 'august__filesystem_delete',
        args: { path: 'C:\\Windows\\System32\\driver.txt' }
    });
    assert.equal(r.critical, true);
    assert.ok(r.reasons.includes('system_dir_mutation'));
});

test('destructive shell rm -rf is critical', () => {
    const r = classifyCriticalAction({
        toolName: 'august__system_exec',
        args: { command: 'rm -rf C:/Users/me/some-folder' }
    });
    assert.equal(r.critical, true);
    assert.ok(r.reasons.includes('destructive_shell'));
});

test('PowerShell Remove-Item -Recurse -Force is critical', () => {
    const r = classifyCriticalAction({
        toolName: 'august__system_exec',
        args: { command: 'Remove-Item -Path C:/foo -Recurse -Force' }
    });
    assert.equal(r.critical, true);
    assert.ok(r.reasons.includes('destructive_shell'));
});

test('package install is critical', () => {
    const r = classifyCriticalAction({
        toolName: 'august__system_exec',
        args: { command: 'npm install left-pad' }
    });
    assert.equal(r.critical, true);
    assert.ok(r.reasons.includes('package_install'));
});

test('service-manager command is critical', () => {
    const r = classifyCriticalAction({
        toolName: 'august__system_exec',
        args: { command: 'sc create Foo binPath= "C:\\foo.exe"' }
    });
    assert.equal(r.critical, true);
    assert.ok(r.reasons.includes('service_manager'));
});

test('env set is critical', () => {
    const r = classifyCriticalAction({
        toolName: 'august__system_env',
        args: { action: 'set', name: 'PATH', value: 'x' }
    });
    assert.equal(r.critical, true);
    assert.ok(r.reasons.includes('env_mutation'));
});

test('env delete is critical', () => {
    const r = classifyCriticalAction({
        toolName: 'august__system_env',
        args: { action: 'delete', name: 'SECRET' }
    });
    assert.equal(r.critical, true);
    assert.ok(r.reasons.includes('env_mutation'));
});

test('env get is not critical', () => {
    const r = classifyCriticalAction({
        toolName: 'august__system_env',
        args: { action: 'get', name: 'PATH' }
    });
    assert.equal(r.critical, false);
});

test('kill non-August process is critical', () => {
    const r = classifyCriticalAction({
        toolName: 'august__system_process',
        args: { action: 'stop', pid: 1234 }
    });
    assert.equal(r.critical, true);
    assert.ok(r.reasons.includes('process_control'));
    assert.ok(r.reasons.includes('kill_non_august_process'));
});

test('process list is not critical', () => {
    const r = classifyCriticalAction({
        toolName: 'august__system_process',
        args: { action: 'list' }
    });
    assert.equal(r.critical, false);
});

test('security.* setting update is critical', () => {
    const r = classifyCriticalAction({
        toolName: 'august__settings_update',
        args: { key_path: 'security.filesystemScope', value: 'root' }
    });
    assert.equal(r.critical, true);
    assert.ok(r.reasons.includes('security_config_mutation'));
});

test('non-security setting update is not critical by default', () => {
    const r = classifyCriticalAction({
        toolName: 'august__settings_update',
        args: { key_path: 'theme.mode', value: 'dark' }
    });
    assert.equal(r.critical, false);
});

test('agent deletion is critical', () => {
    const r = classifyCriticalAction({
        toolName: 'august__agents_manage',
        args: { action: 'delete', agent: { id: 'build' } }
    });
    assert.equal(r.critical, true);
    assert.ok(r.reasons.includes('agent_deletion'));
});

test('audit log deletion is critical (integrity)', () => {
    const r = classifyCriticalAction({
        toolName: 'august__filesystem_delete',
        args: { path: 'C:/Users/me/august_audit_log.jsonl' }
    });
    assert.equal(r.critical, true);
    assert.ok(r.reasons.includes('audit_or_rollback_integrity'));
});

test('benign tool invocation is not critical', () => {
    const r = classifyCriticalAction({
        toolName: 'august__system_info',
        args: {}
    });
    assert.equal(r.critical, false);
    assert.deepEqual(r.reasons, []);
});

test('shutdown command is critical', () => {
    const r = classifyCriticalAction({
        toolName: 'august__system_exec',
        args: { command: 'shutdown /s /t 0' }
    });
    assert.equal(r.critical, true);
    assert.ok(r.reasons.includes('system_shutdown'));
});
