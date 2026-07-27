"""Workbench model-call retry: detection, backoff math, policy, sleep, aggregator."""

import asyncio
import time

from app.services.workbench import workbench as wb
from app.services.workbench.stream_translate import AnthropicWorkbenchStreamAggregator

# ── retryable detection ────────────────────────────────────────────────


def test_retryable_by_status():
    assert wb._isRetryableModelError({'error': 'x', 'errorStatus': 429})
    assert wb._isRetryableModelError({'error': 'x', 'errorStatus': 503})
    assert wb._isRetryableModelError({'error': 'x', 'errorStatus': 500})
    assert not wb._isRetryableModelError({'error': 'x', 'errorStatus': 404})
    assert not wb._isRetryableModelError({'error': 'x', 'errorStatus': 401})


def test_retryable_by_message_markers():
    assert wb._isRetryableModelError({'error': '[429] Provider rate limit exceeded'})
    assert wb._isRetryableModelError({'error': 'Stream error: upstream Overloaded'})
    assert wb._isRetryableModelError({'error': 'connection reset by peer'})
    assert not wb._isRetryableModelError({'error': 'invalid api key'})
    assert not wb._isRetryableModelError({})  # no error → not retryable


# ── backoff math ───────────────────────────────────────────────────────


def test_delay_honors_retry_after_and_caps_it():
    policy = {'maxRetries': 10, 'baseDelayMs': 1000, 'maxDelayMs': 30000}
    # Provider says wait 5s → use it.
    assert wb._modelRetryDelayMs(1, {'retryAfterMs': 5000}, policy) == 5000
    # Provider says wait 2 minutes → capped at maxDelayMs.
    assert wb._modelRetryDelayMs(1, {'retryAfterMs': 120000}, policy) == 30000


def test_delay_exponential_backoff_with_jitter():
    policy = {'maxRetries': 10, 'baseDelayMs': 1000, 'maxDelayMs': 30000}
    d1 = wb._modelRetryDelayMs(1, {}, policy)
    d5 = wb._modelRetryDelayMs(5, {}, policy)
    assert 1000 <= d1 <= 1400  # base + jitter(0..400)
    assert 16000 <= d5 <= 16400  # 1000 * 2^4 + jitter
    # Never exceeds the cap (+ jitter).
    d10 = wb._modelRetryDelayMs(10, {}, policy)
    assert d10 <= 30400


# ── policy config overrides ────────────────────────────────────────────


def test_policy_defaults_and_overrides(monkeypatch):
    from app.services import config_service

    assert wb._modelRetryPolicy() == {'maxRetries': 10, 'baseDelayMs': 1000, 'maxDelayMs': 30000}

    monkeypatch.setattr(
        config_service,
        'getConfig',
        lambda: {'workbench': {'retry': {'maxRetries': 3, 'baseDelayMs': 500}}},
    )
    policy = wb._modelRetryPolicy()
    assert policy['maxRetries'] == 3
    assert policy['baseDelayMs'] == 500
    assert policy['maxDelayMs'] == 30000  # untouched default


# ── interruptible sleep ────────────────────────────────────────────────


async def test_interruptible_sleep_returns_early_on_cancel(monkeypatch):
    from app.lib import async_subprocess

    event = asyncio.Event()
    token = async_subprocess.current_subprocess_cancel.set(event)
    try:
        event.set()  # already cancelled
        t0 = time.monotonic()
        await wb._interruptibleSleep(5)
        assert time.monotonic() - t0 < 1  # did not sleep the full 5s
    finally:
        async_subprocess.current_subprocess_cancel.reset(token)


# ── aggregator propagates retry metadata ───────────────────────────────


def test_aggregator_captures_status_and_retry_after():
    agg = AnthropicWorkbenchStreamAggregator()
    agg.on_event({'type': 'error', 'status': 429, 'body': 'rate limited', 'retryAfterMs': 7000})
    assert agg.error is not None and '429' in agg.error
    assert agg.error_status == 429
    assert agg.error_retry_after_ms == 7000
