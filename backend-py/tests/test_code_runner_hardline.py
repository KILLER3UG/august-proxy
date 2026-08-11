"""Parity: the embedded code-mode hardline guard (code_runner._GUARD_TEMPLATE)
must agree with the real ``app.services.sandbox.hardline`` module on a
command/path corpus. The guard is a port rendered into every code run — a
drift in the permissive direction would let a code-mode block read
credential files that the typed ``run_command`` tool blocks.
"""

from __future__ import annotations

import os

import pytest
from app.services.sandbox import hardline
from app.services.workbench import code_runner

_COMMAND_CORPUS = [
    # Credential reads — must be BLOCKED.
    'cat providers.json',
    'cat ~/.ssh/id_rsa',
    'cat ~/.aws/credentials',
    'cat C:\\Users\\me\\.aws\\credentials',
    'python -c "print(open(\'providers.json\').read())"',
    'powershell -c "Get-Content providers.json"',
    'cat "providers.json"',
    'type C:\\data\\providers.json',
    'cat ~/.ssh/mykey.pem',
    # Protected WRITES — must be BLOCKED (even with a pure-reader prefix).
    'echo "x" > .env',
    'rm providers.json',
    'cp .env /tmp/backup.env',
    'git checkout -- .env',
    'sed -i s/a/b/ .env',
    'find . -delete -name "*.env"',
    'cat .env >> backups.txt',
    # Allowed — must NOT be blocked.
    'cat .env',
    'cat .env.example',
    'ls -la',
    'grep -r secret .',
    'cat .ssh/config',
    'echo ok',
    'cd /tmp && ls',
    'python -c "print(42)"',
    'cat notes.txt',
]

_READ_PATH_CORPUS = [
    'C:\\x\\providers.json',  # blocked
    'C:\\Users\\me\\.ssh\\id_rsa',  # blocked
    '/home/u/.aws/credentials',  # blocked
    '/tmp/keys.pem',  # blocked
    '/workspace/.env',  # allowed (reads of .env stay allowed by design)
    '/workspace/src/main.py',  # allowed
    '/workspace/notes.txt',  # allowed
]

_WRITE_PATH_CORPUS = [
    'C:\\x\\.env',  # blocked
    'C:\\x\\.env.example',  # allowed (template)
    'C:\\x\\providers.json',  # blocked
    'C:\\x\\.ssh\\authorized_keys',  # blocked
    'C:\\x\\src\\main.py',  # allowed
]


def _execGuard() -> dict:
    """Exec the generated runner source (guard + preamble) and return its
    namespace. os.environ is snapshotted/restored — the preamble scrubs
    AUGUST_*/API_KEY vars, which must not leak into the test process."""
    source = code_runner.build_runner_source(user_block='', workspace_path='')
    ns: dict = {}
    saved = dict(os.environ)
    try:
        exec(compile(source, '<code_runner_guard>', 'exec'), ns)  # noqa: S102
    finally:
        os.environ.clear()
        os.environ.update(saved)
    return ns


@pytest.fixture(scope='module')
def guardNs() -> dict:
    return _execGuard()


def test_guard_is_embedded(guardNs: dict) -> None:
    assert callable(guardNs.get('_hardline_check_command'))
    assert callable(guardNs.get('_hardline_check_path'))


def test_command_parity(guardNs: dict) -> None:
    mismatches = []
    for cmd in _COMMAND_CORPUS:
        real = hardline.check_hardline_command(cmd)
        embedded = guardNs['_hardline_check_command'](cmd)
        if bool(real) != bool(embedded):
            mismatches.append((cmd, real, embedded))
    assert not mismatches, f'command parity mismatches: {mismatches}'


def test_read_path_parity(guardNs: dict) -> None:
    mismatches = []
    for path in _READ_PATH_CORPUS:
        real = hardline.check_hardline_path(path, for_write=False)
        embedded = guardNs['_hardline_check_path'](path, for_write=False)
        if bool(real) != bool(embedded):
            mismatches.append((path, real, embedded))
    assert not mismatches, f'read-path parity mismatches: {mismatches}'


def test_write_path_parity(guardNs: dict) -> None:
    mismatches = []
    for path in _WRITE_PATH_CORPUS:
        real = hardline.check_hardline_path(path, for_write=True)
        embedded = guardNs['_hardline_check_path'](path, for_write=True)
        if bool(real) != bool(embedded):
            mismatches.append((path, real, embedded))
    assert not mismatches, f'write-path parity mismatches: {mismatches}'


def test_generated_guard_blocks_credential_read(guardNs: dict) -> None:
    """The concrete attack the fix targets: a code-mode run_command that
    reads provider secrets must be refused."""
    with pytest.raises(PermissionError):
        # The preamble's run_command raises PermissionError on denial.
        source = code_runner.build_runner_source(
            user_block='run_command("cat providers.json")', workspace_path=''
        )
        ns: dict = {}
        saved = dict(os.environ)
        try:
            exec(compile(source, '<code_runner_block>', 'exec'), ns)  # noqa: S102
            ns['run_command']('cat providers.json')
        finally:
            os.environ.clear()
            os.environ.update(saved)
