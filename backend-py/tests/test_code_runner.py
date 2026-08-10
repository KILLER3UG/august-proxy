"""Security boundary tests for the code-mode runner (model-authored Python).

Code mode is not a separate execution surface — it runs through the sandbox
like any command — but the generated runner source must still enforce the
workspace bind and scrub secrets from the child environment.
"""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
from pathlib import Path

from app.services.workbench.code_runner import (
    build_runner_source,
    extract_fenced_python,
    format_result,
    runner_command,
    runner_path,
)


def _run_script(source: str, cwd: Path) -> subprocess.CompletedProcess[str]:
    script = cwd / 'runner_test.py'
    script.write_text(source, encoding='utf-8')
    return subprocess.run(
        [sys.executable, '-I', '-u', str(script)],
        capture_output=True,
        text=True,
        timeout=60,
        cwd=str(cwd),
    )


def test_extract_fenced_python_takes_last_block():
    text = '```python\nprint(1)\n```\nthen\n```python\nprint(2)\n```'
    assert extract_fenced_python(text) == 'print(2)'
    assert extract_fenced_python('no fence here') is None


def test_build_runner_source_contains_workspace_bind_and_scrub():
    src = build_runner_source('print("hi")', r'C:\ws')
    assert '_bind' in src
    assert 'path outside workspace' in src
    assert '_API_KEY' in src
    assert "_k.startswith('AUGUST_')" in src
    assert 'print("hi")' in src


def test_runner_path_stays_inside_workspace(tmp_path):
    run_dir, path = runner_path(str(tmp_path), 'sess_1', 3)
    assert Path(path).resolve().is_relative_to(tmp_path.resolve())
    assert Path(run_dir).name == 'code_runs'
    # No workspace → temp dir fallback, never cwd.
    _dir, no_ws_path = runner_path('', 'sess_1', 3)
    assert Path(no_ws_path).is_absolute()


def test_write_file_outside_workspace_raises(tmp_path):
    """The model's code must not be able to write outside the workspace."""
    source = build_runner_source(
        "write_file('../escape.txt', 'pwned')\nprint('no-raise')", str(tmp_path)
    )
    proc = _run_script(source, tmp_path)
    combined = (proc.stdout or '') + (proc.stderr or '')
    assert 'PermissionError' in combined or 'path outside workspace' in combined
    assert not (tmp_path.parent / 'escape.txt').exists()


def test_read_file_outside_workspace_raises(tmp_path):
    source = build_runner_source(
        "print(read_file(r'" + str(tmp_path.parent / 'secrets.txt') + "'))", str(tmp_path)
    )
    proc = _run_script(source, tmp_path)
    combined = (proc.stdout or '') + (proc.stderr or '')
    assert 'PermissionError' in combined or 'path outside workspace' in combined


def test_env_secrets_scrubbed_before_model_code(tmp_path):
    """AUGUST_*/_API_KEY/_SECRET vars must not be visible to the model's code."""
    os.environ['AUGUST_TEST_SECRET'] = 'super-secret-value'
    os.environ['MYPROVIDER_API_KEY'] = 'key-12345'
    os.environ['UNRELATED_VAR'] = 'should-stay'
    try:
        source = build_runner_source(
            "import os\n"
            "print('AUGUST_TEST_SECRET' in os.environ)\n"
            "print('MYPROVIDER_API_KEY' in os.environ)\n"
            "print('UNRELATED_VAR' in os.environ)\n"
            "print(os.environ.get('AUGUST_TEST_SECRET', 'gone'))",
            str(tmp_path),
        )
        proc = _run_script(source, tmp_path)
        lines = [line.strip() for line in (proc.stdout or '').splitlines() if line.strip()]
        assert lines[0] == 'False', f'secret var visible: {proc.stdout}'
        assert lines[1] == 'False', f'api key visible: {proc.stdout}'
        assert lines[2] == 'True', f'unrelated var scrubbed: {proc.stdout}'
        assert 'gone' in lines[3]
    finally:
        os.environ.pop('AUGUST_TEST_SECRET', None)
        os.environ.pop('MYPROVIDER_API_KEY', None)
        os.environ.pop('UNRELATED_VAR', None)


def test_runner_command_uses_isolated_python(tmp_path):
    script = tmp_path / 'x.py'
    script.write_text('print("ok")', encoding='utf-8')
    cmd = runner_command(str(script))
    assert cmd.startswith('python -I -u ')
    assert str(script) in cmd


def test_format_result_caps_output():
    big = 'x' * (30 * 1024)
    out = format_result(big)
    assert len(out) < 25 * 1024
    assert 'truncated' in out
    assert format_result('short') == 'short'
