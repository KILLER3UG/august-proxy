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
