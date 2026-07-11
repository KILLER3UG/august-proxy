"""Characterization tests for app.lib helpers — pure, low-risk surface.

Documents current behavior before any lib refactor. No network, no real DB.
"""

from __future__ import annotations

import asyncio
import os
from pathlib import Path

import pytest

from app.lib import paths, secrets, tokens
from app.lib.retry import retryWithBackoff


class TestPaths:
    def test_data_dir_respects_env(self, tmp_path, monkeypatch):
        monkeypatch.setenv('AUGUST_DATA_DIR', str(tmp_path))
        assert paths.dataDir() == Path(tmp_path)

    def test_data_path_joins_parts(self, tmp_path, monkeypatch):
        monkeypatch.setenv('AUGUST_DATA_DIR', str(tmp_path))
        p = paths.dataPath('a', 'b.json')
        assert p == Path(tmp_path) / 'a' / 'b.json'

    def test_data_dir_default_is_repo_data(self, monkeypatch):
        monkeypatch.delenv('AUGUST_DATA_DIR', raising=False)
        d = paths.dataDir()
        assert d.name == 'data'
        # Default walks up from lib/ → app/ → backend-py/ → repo root / data
        assert d.is_absolute()


class TestSecrets:
    def test_mask_empty_returns_none(self):
        assert secrets.mask('') is None

    def test_mask_short_value(self):
        # Current behavior: '••••' + full short value
        assert secrets.mask('ab') == '••••ab'

    def test_mask_long_value_keeps_prefix_and_suffix(self):
        out = secrets.mask('sk-abcdefghijklmnopqrstuvwxyz', visible=4)
        assert out is not None
        assert out.startswith('sk-')
        assert out.endswith('wxyz')
        assert '••••' in out


class TestTokens:
    def test_estimate_empty_is_zero(self):
        assert tokens.estimate('') == 0

    def test_estimate_chars_div_4(self):
        assert tokens.estimate('abcd') == 1
        assert tokens.estimate('abcdefgh') == 2

    def test_estimate_messages_sums_content(self):
        msgs = [
            {'content': 'abcd'},  # 1
            {'content': 'abcdefgh'},  # 2
            {'role': 'user'},  # empty content → 0
        ]
        assert tokens.estimateMessages(msgs) == 3


class TestRetry:
    def test_retry_succeeds_first_try(self):
        async def ok():
            return 42

        assert asyncio.run(retryWithBackoff(ok, maxRetries=2, baseDelay=0.01)) == 42

    def test_retry_eventually_succeeds(self):
        calls = {'n': 0}

        async def flaky():
            calls['n'] += 1
            if calls['n'] < 3:
                raise ConnectionError('temp')
            return 'done'

        assert asyncio.run(retryWithBackoff(flaky, maxRetries=3, baseDelay=0.01)) == 'done'
        assert calls['n'] == 3

    def test_retry_exhausts_and_raises(self):
        async def always_fail():
            raise ConnectionError('nope')

        with pytest.raises(ConnectionError):
            asyncio.run(retryWithBackoff(always_fail, maxRetries=1, baseDelay=0.01))
