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


def test_reader_mutating_flags_blocked():
    """Readers with in-place/delete flags must count as writes (regression:
    sed -i / find -delete / awk -i inplace bypassed the guard before)."""
    assert check_hardline_command("sed -i 's/KEY=.*/KEY=evil/' .env") is not None
    assert check_hardline_command('sed -i.bak "s/x/y/" .env') is not None
    assert check_hardline_command('sed --in-place "s/x/y/" .env') is not None
    assert check_hardline_command("awk -i inplace '{print $1}' .env") is not None
    assert check_hardline_command('find . -name .env -delete') is not None
    assert check_hardline_command('find . -name .env -exec rm {} \;') is not None
    assert check_hardline_command('find ~/.ssh -type f -execdir shred {} \;') is not None
    assert check_hardline_command('sort -o .env < other.txt') is not None


def test_reader_plain_uses_still_allowed():
    """Plain reads with the same executables must stay allowed."""
    assert check_hardline_command("sed -n '1,5p' .env") is None
    assert check_hardline_command("awk '{print $1}' .env") is None
    assert check_hardline_command('find . -name .env -print') is None
    assert check_hardline_command('grep KEY .env') is None


# ── 2026-10-10 — the two stores the name list missed ─────────────────────────
# Found by listing what a real install actually keeps rather than by reading the
# pattern: this install's Google Workspace store holds four per-account token
# files, an `oauth_states.json` and `pkce<account>.json` verifiers, all of them
# INSIDE `credentials/` — which the file-anchored `credentials$` pattern matched
# none of. August's own `{dataDir}/config.json` separately holds
# `serviceConnections.github.token` and a Google `accessToken`.

_STORE = 'C:/Users/rober/.google_workspace_mcp'


def test_files_inside_a_credential_store_are_blocked():
    """`credentials$` anchored the read rule on the FILE named `credentials`, so
    every file INSIDE a `credentials/` store read straight through — which is the
    shape a per-account token store actually has."""
    stored = f'{_STORE}/credentials/robertacepayales69@gmail.com.json'
    assert check_hardline_path(stored, for_write=False) is not None
    assert check_hardline_path(stored, for_write=True) is not None
    assert check_hardline_command(f'cat {stored}') is not None


def test_oauth_state_and_verifier_files_are_blocked():
    """The state/verifier material of the exchange, not just the finished
    tokens. The live install keeps these under `credentials/`; both shapes are
    asserted because the rule is the directory, so it must not depend on which
    one a future version of that store uses."""
    for rel in ('credentials/oauth_states.json', 'credentials/pkce@gmail.com.json',
                'oauth_states.json', 'pkce@gmail.com.json'):
        assert check_hardline_path(f'{_STORE}/{rel}', for_write=False) is not None
    assert check_hardline_command('cat ~/.google_workspace_mcp/credentials/oauth_states.json') is not None


def test_other_known_token_stores_are_blocked():
    """Same class, different tool: an SSO cache token is not a file named
    `credentials`, and a Docker `config.json` is secret-bearing only because of
    the directory it lives in."""
    assert check_hardline_path('/home/u/.aws/sso/cache/6f2a1b.json', for_write=False) is not None
    assert check_hardline_path('C:/Users/u/.docker/config.json', for_write=False) is not None
    assert check_hardline_path('/home/u/.kube/config', for_write=False) is not None
    assert check_hardline_command('cat ~/.docker/config.json') is not None


def test_august_own_config_json_blocked(isolatedData):
    """`{dataDir}/config.json` now carries live OAuth tokens."""
    cfg = isolatedData / 'config.json'
    assert check_hardline_path(str(cfg), for_write=False) is not None
    assert check_hardline_path(str(cfg), for_write=True) is not None


def test_ordinary_config_json_stays_readable():
    """The refusal must be the DIRECTORY, never the filename — `config.json` is
    one of the commonest names in any project, and a model told it cannot read
    one reports the file as missing."""
    assert check_hardline_path('/proj/nginx/config.json', for_write=False) is None
    assert check_hardline_path('/proj/apps/desktop/config.json', for_write=True) is None
    assert check_hardline_command('cat config.json') is None
    assert check_hardline_command('cat ./src/config.json') is None


def test_source_named_credentials_is_not_a_token_store():
    """A project module directory called `credentials` is not a token store, so
    the new store rule must not read-refuse it. The store list is dot-anchored
    for exactly that reason.

    Writing there is still refused — but by the pre-existing `_PROTECTED_WRITE_
    PATTERN` component anchor (see the comment at hardline.py:35), which is a
    deliberate line, not something this rule added. The asymmetry is asserted
    rather than smoothed over so the next reader sees both halves.
    """
    source = '/proj/src/credentials/login.tsx'
    assert check_hardline_path(source, for_write=False) is None
    assert check_hardline_command(f'cat {source}') is None
    assert check_hardline_path(source, for_write=True) is not None
    assert check_hardline_path('/proj/docs/credentials.md', for_write=True) is None


def test_stores_are_not_listable():
    from app.services.sandbox.hardline import is_credential_directory

    assert is_credential_directory(_STORE) is True
    assert is_credential_directory(f'{_STORE}/credentials') is True
    assert is_credential_directory('C:/Users/rober/.docker') is True
    # …while an ordinary project folder keeps its file tree.
    assert is_credential_directory('/proj/src/credentials') is False


def test_public_ssh_members_stay_readable():
    """Control for the deliberate `.ssh` decision — the store rule must not
    swallow the one public member (`authorized_keys`) that stays readable."""
    assert check_hardline_command('head -5 ~/.ssh/authorized_keys') is None
    assert check_hardline_path('C:/Users/rober/.ssh/config', for_write=False) is None
