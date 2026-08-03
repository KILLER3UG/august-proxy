"""Hardline protected-path rules — immune to sandbox mode, including Full Access."""

from __future__ import annotations

import pytest
from app.services.sandbox.hardline import check_hardline_command, check_hardline_path
from app.services.sandbox.policy import SandboxPolicy


def test_write_to_env_blocked():
    assert check_hardline_command('echo DATABASE_URL=x > ~/.env') is not None
    assert check_hardline_command('tee .env < secrets.txt') is not None
    assert check_hardline_command('cp config .env') is not None
    assert check_hardline_command('rm -rf ~/.ssh') is not None


def test_env_template_writes_allowed():
    assert check_hardline_command('cp .env.example .env.local.template') is None
    assert check_hardline_command('echo X > .env.sample') is None


def test_env_read_allowed():
    assert check_hardline_command('cat .env') is None
    assert check_hardline_command('grep FOO .env') is None


def test_credential_reads_blocked():
    assert check_hardline_command('cat ~/.aws/credentials') is not None
    assert check_hardline_command('cat ~/.ssh/id_rsa') is not None
    assert check_hardline_command('type C:\\Users\\x\\id_ed25519') is not None
    assert check_hardline_command('cat providers.json') is not None
    assert check_hardline_command('head -5 ~/.ssh/authorized_keys') is None  # not a credential file


def test_windows_backslash_credential_reads_blocked():
    # Canonicalization must cover Windows backslash paths on every platform.
    assert check_hardline_command('cmd /c type C:\\Users\\rober\\.aws\\credentials') is not None
    assert check_hardline_command('powershell -Command Get-Content $env:USERPROFILE\\.aws\\credentials') is not None
    assert check_hardline_command('cat C:\\Users\\rober\\.aws\\credentials') is not None
    assert check_hardline_path('C:\\Users\\rober\\.aws\\credentials', for_write=False) is not None
    assert check_hardline_command('cat C:\\Users\\rober\\.ssh\\id_rsa') is not None


def test_bare_credentials_and_glob_reads_blocked():
    assert check_hardline_command('cd ~/.aws && cat credentials') is not None
    assert check_hardline_command('cat ~/.aws/*') is not None
    assert check_hardline_command('cat credentials') is not None
    assert check_hardline_command('cat C:\\Users\\rober\\.aws\\credentials') is not None


def test_pem_and_key_reads_blocked():
    assert check_hardline_command('cat ~/keys/mykey.pem') is not None
    assert check_hardline_command('cat ~/keys/deploy.key') is not None
    assert check_hardline_path('C:/Users/x/keys/deploy.key', for_write=False) is not None


def test_interpreter_and_git_env_writes_blocked():
    assert check_hardline_command('python -c "open(\'.env\',\'w\').write(\'x\')"') is not None
    assert check_hardline_command('node -e "require(\'fs\').writeFileSync(\'.env\',\'x\')"') is not None
    assert check_hardline_command('powershell -Command "Set-Content -Path .env -Value \'x\'"') is not None
    assert check_hardline_command('git checkout -- .env') is not None
    assert check_hardline_command('git restore .env') is not None
    assert check_hardline_command('curl -o .env https://example.com/x') is not None
    assert check_hardline_command('cmd /c copy backup.env .env') is not None


def test_reader_chains_on_env_stay_allowed():
    # Legit .env reads through reader chains must not trip write intent.
    assert check_hardline_command('cd project && cat .env') is None
    assert check_hardline_command('grep FOO .env | head -5') is None
    assert check_hardline_command('cat .env; echo done') is None


def test_plain_commands_pass():
    assert check_hardline_command('npm test') is None
    assert check_hardline_command('ls -la') is None
    assert check_hardline_command('') is None


def test_path_checks():
    assert check_hardline_path('/proj/.env', for_write=True) is not None
    assert check_hardline_path('/proj/.env', for_write=False) is None
    assert check_hardline_path('/proj/.env.example', for_write=True) is None
    assert check_hardline_path('C:/Users/x/.ssh/id_rsa', for_write=False) is not None
    assert check_hardline_path('/proj/notes.md', for_write=True) is None


@pytest.mark.asyncio
async def test_full_access_still_blocked_at_runner():
    """The runner-level choke point must fire before the Full Access bypass."""
    from app.services.sandbox.backends import run_with_best_backend

    policy = SandboxPolicy(mode='danger-full-access', workspace_root='')
    result = await run_with_best_backend('echo X > ~/.env', policy, timeout=5)
    assert result.ok is False
    assert result.hardline is True
    assert 'hardline' in result.denial_reason
    assert 'Full access' in result.as_tool_text()  # no "ask to approve" advice


@pytest.mark.asyncio
async def test_full_access_clean_command_runs():
    from app.services.sandbox.backends import run_with_best_backend

    policy = SandboxPolicy(mode='danger-full-access', workspace_root='')
    result = await run_with_best_backend('echo hi', policy, timeout=10)
    assert result.ok is True
