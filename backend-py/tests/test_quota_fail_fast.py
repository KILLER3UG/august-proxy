"""Latency fix 2 — quota/billing 429s must fail fast, not burn a 40-80 s
retry stack.

Measured live (2026-09-02): Ifron's free-tier refusal —
``[429] Free model requires Team balance greater than $4.99`` — was retried
3× at client level (each 10-18 s upstream round trip) AND 3× at turn level
(backoff 1.3/2.2/4.3 s): ~80 s of wall clock to surface an error that is
deterministic. The marker list must catch the "requires ... balance" family,
and the turn-level retry must not re-send.
"""

from __future__ import annotations

from app.services.workbench import workbench as wb


class TestQuotaFailFast:
    def test_balance_requirement_marker_is_not_retryable(self):
        """The exact live error string must classify as non-retryable."""
        resp = {
            'error': 'Free model requires Team balance greater than $4.999999. (request id: x)',
            'errorStatus': 429,
        }
        assert wb._isRetryableModelError(resp) is False, (
            'a balance/billing requirement 429 is deterministic — retrying '
            'burned 80s live; it must fail fast'
        )

    def test_balance_marker_catchall(self):
        for msg in (
            'requires team balance',
            'Team balance is too low',
            'balance greater than',
            'insufficient balance for free model',
        ):
            assert wb._isRetryableModelError({'error': msg, 'errorStatus': 429}) is False, msg

    def test_plain_rate_limit_still_retryable(self):
        """A genuine rate limit (no billing marker) stays retryable."""
        resp = {'error': 'Rate limit exceeded — too many requests, retry later', 'errorStatus': 429}
        assert wb._isRetryableModelError(resp) is True

    def test_plain_503_still_retryable(self):
        resp = {'error': 'Service unavailable, try again', 'errorStatus': 503}
        assert wb._isRetryableModelError(resp) is True

    def test_billing_word_in_empty_response_hint_stays_retryable(self):
        """The guard comment: August's own 'billing/credits' hint appears in
        empty-response errors that must stay retryable — adding 'balance'
        must not flip that."""
        resp = {'error': 'empty response — check API key, billing/credits', 'errorStatus': None}
        assert wb._isRetryableModelError(resp) is True
