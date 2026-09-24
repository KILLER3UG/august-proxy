"""Provider-native quota observations — truthful numbers only.

August never guesses a provider's quota. Two things can produce a real one:

1. **Standard rate-limit response headers.** Providers that publish
   ``x-ratelimit-limit`` / ``-remaining`` / ``-reset`` (or the ``-requests`` /
   ``-tokens`` bucket variants, or the IETF ``ratelimit-*`` spelling) state
   their own budget on every response. We copy those values verbatim into a
   small in-process store keyed by ``(provider, model, bucket)``.
2. **An opt-in, user-declared quota endpoint** with data-driven JSON
   extractors — see ``app/services/quota_endpoint.py``.

Everything else stays on the existing local-usage estimate. A row only reports
``source='native'`` when a real limit was observed, and observations older than
``_OBSERVATION_TTL_S`` stop counting so a day-old header never reads as the
provider's current budget.
"""

from __future__ import annotations

import logging
import os
import re
import threading
import time
from dataclasses import dataclass

from app.json_narrowing import as_str

logger = logging.getLogger(__name__)

# An observation is a statement about "right now". An hour later it is history,
# so it must not be rendered as the provider's live quota.
_OBSERVATION_TTL_S = 3600.0

# Buckets, most-preferred first when several are published on one response.
# 'tokens' is preferred because the local rows it decorates are token counts.
BUCKET_TOKENS = 'tokens'
BUCKET_REQUESTS = 'requests'
BUCKET_GENERIC = 'generic'
_BUCKET_PREFERENCE = (BUCKET_TOKENS, BUCKET_REQUESTS, BUCKET_GENERIC)

# Full header stem (after the ``x-ratelimit-`` / ``ratelimit-`` prefix) →
# (field, bucket). Matching the whole stem is what keeps the per-bucket
# spellings from collapsing into the generic one.
_HEADER_STEMS: dict[str, tuple[str, str]] = {
    'limit': ('limit', BUCKET_GENERIC),
    'remaining': ('remaining', BUCKET_GENERIC),
    'reset': ('reset', BUCKET_GENERIC),
    'limit-requests': ('limit', BUCKET_REQUESTS),
    'remaining-requests': ('remaining', BUCKET_REQUESTS),
    'reset-requests': ('reset', BUCKET_REQUESTS),
    'limit-tokens': ('limit', BUCKET_TOKENS),
    'remaining-tokens': ('remaining', BUCKET_TOKENS),
    'reset-tokens': ('reset', BUCKET_TOKENS),
    'limit-input-tokens': ('limit', BUCKET_TOKENS),
    'remaining-input-tokens': ('remaining', BUCKET_TOKENS),
    'limit-output-tokens': ('limit', BUCKET_TOKENS),
    'remaining-output-tokens': ('remaining', BUCKET_TOKENS),
}

_DURATION_RE = re.compile(r'^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m(?!s))?(?:(\d+(?:\.\d+)?)s)?$')
# Anything below this is a relative duration, at or above it an epoch stamp.
_EPOCH_FLOOR = 1_000_000_000


@dataclass(frozen=True)
class QuotaObservation:
    """One provider-stated budget reading. Every field is provider-reported."""

    provider: str
    model: str
    bucket: str
    limit: float | None
    remaining: float | None
    reset_at: float | None
    observed_at: float

    @property
    def used(self) -> float | None:
        """Provider-side consumption: limit - remaining, only when both exist."""
        if self.limit is None or self.remaining is None:
            return None
        return max(0.0, self.limit - self.remaining)

    @property
    def age_s(self) -> float:
        return max(0.0, time.time() - self.observed_at)

    def to_dict(self) -> dict:
        return {
            'provider': self.provider,
            'model': self.model,
            'bucket': self.bucket,
            'limit': self.limit,
            'remaining': self.remaining,
            'resetAt': self.reset_at,
            'observedAt': self.observed_at,
        }


def _float(value: object) -> float | None:
    """Parse a numeric header value; anything else is 'not stated'."""
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    text = as_str(value).strip()
    if not text:
        return None
    try:
        return float(text)
    except ValueError:
        return None


def parse_reset_seconds(value: object, *, now: float | None = None) -> float | None:
    """Read a rate-limit reset hint into an absolute epoch (seconds).

    Providers publish three shapes, all seen in the wild:
      * a duration — ``6m0s``, ``1h30m``, ``20s``
      * a bare epoch — ``1789000000``
      * an ISO-8601 timestamp — ``2026-09-24T10:00:00Z``

    A bare number below the epoch floor is treated as a relative delay in
    seconds, which is how gateways that drop the unit still mean "from now".
    """
    if isinstance(value, bool) or value is None:
        return None
    reference = time.time() if now is None else now
    if isinstance(value, (int, float)):
        number = float(value)
    else:
        text = as_str(value).strip()
        if not text:
            return None
        try:
            number = float(text)
        except ValueError:
            match = _DURATION_RE.match(text)
            if match:
                hours, minutes, seconds = (float(g) if g else 0.0 for g in match.groups())
                return reference + hours * 3600 + minutes * 60 + seconds
            try:
                from datetime import datetime

                iso = text[:-1] + '+00:00' if text.endswith('Z') else text
                parsed = datetime.fromisoformat(iso)
                if parsed.tzinfo is None:
                    from datetime import timezone

                    parsed = parsed.replace(tzinfo=timezone.utc)
                return parsed.timestamp()
            except ValueError:
                return None
    if number >= _EPOCH_FLOOR:
        return number
    if number < 0:
        return None
    return reference + number


def parse_rate_limit_headers(headers: dict[str, str] | None) -> dict[str, dict[str, float | None]]:
    """Group standard rate-limit headers into ``{bucket: {field: value}}``.

    Only the published, standard spellings are read — this never infers a
    limit from an unrelated header, and a bucket with no stated values is
    simply absent from the result.
    """
    if not headers:
        return {}
    lowered = {as_str(k).lower(): as_str(v) for k, v in headers.items() if k}
    buckets: dict[str, dict[str, float | None]] = {}
    now = time.time()
    for name, value in lowered.items():
        if name.startswith('x-ratelimit-'):
            stem = name[len('x-ratelimit-') :]
        elif name.startswith('ratelimit-'):
            stem = name[len('ratelimit-') :]
        else:
            continue
        field, bucket = _HEADER_STEMS.get(stem, (None, BUCKET_GENERIC))
        if field is None:
            continue
        parsed = parse_reset_seconds(value, now=now) if field == 'reset' else _float(value)
        if parsed is None:
            continue
        bucketValues = buckets.setdefault(bucket, {})
        # First stated value wins for a field: a provider that repeats a header
        # with different values is malformed, and the earlier one is the one
        # that accompanied this response body.
        bucketValues.setdefault(field, parsed)
    return buckets


class QuotaObservationStore:
    """Bounded in-process store of provider-stated quota readings."""

    def __init__(self, ttl_s: float | None = None) -> None:
        self.ttl_s = ttl_s if ttl_s is not None else _observation_ttl()
        self._lock = threading.Lock()
        self._entries: dict[tuple[str, str, str], QuotaObservation] = {}

    def record_headers(
        self,
        headers: dict[str, str] | None,
        *,
        provider: str,
        model: str = '',
    ) -> list[QuotaObservation]:
        """Store every rate-limit bucket present on a provider response.

        Returns the stored observations (empty when the response carried no
        standard rate-limit headers — the common, unremarkable case).
        """
        parsed = parse_rate_limit_headers(headers)
        if not parsed:
            return []
        providerName = as_str(provider)
        modelId = as_str(model)
        observedAt = time.time()
        stored: list[QuotaObservation] = []
        with self._lock:
            for bucket, values in parsed.items():
                # A bucket with only a remaining count still tells the user
                # something real, but a quota row needs a limit to be
                # truthful, so keep it and let the row decide.
                observation = QuotaObservation(
                    provider=providerName,
                    model=modelId,
                    bucket=bucket,
                    limit=values.get('limit'),
                    remaining=values.get('remaining'),
                    reset_at=values.get('reset'),
                    observed_at=observedAt,
                )
                self._entries[(providerName, modelId, bucket)] = observation
                stored.append(observation)
        return stored

    def record(
        self,
        *,
        provider: str,
        model: str,
        bucket: str,
        limit: float | None,
        remaining: float | None,
        reset_at: float | None = None,
    ) -> QuotaObservation:
        """Store one reading from a declared quota endpoint."""
        observation = QuotaObservation(
            provider=as_str(provider),
            model=as_str(model),
            bucket=as_str(bucket) or BUCKET_GENERIC,
            limit=limit,
            remaining=remaining,
            reset_at=reset_at,
            observed_at=time.time(),
        )
        with self._lock:
            self._entries[(observation.provider, observation.model, observation.bucket)] = observation
        return observation

    def get(self, provider: str, model: str = '', bucket: str = '') -> QuotaObservation | None:
        """Freshest non-stale reading for a key; stale entries read as absent."""
        key = (as_str(provider), as_str(model), as_str(bucket))
        with self._lock:
            observation = self._entries.get(key)
        if observation is None or observation.age_s > self.ttl_s:
            return None
        return observation

    def best_for(self, provider: str, model: str) -> QuotaObservation | None:
        """Preferred reading for a model: tokens, then requests, then generic.

        A bucket without a stated limit is not a usable quota row, so it is
        skipped in favor of one that actually states a cap.
        """
        for bucket in _BUCKET_PREFERENCE:
            observation = self.get(provider, model, bucket)
            if observation is not None and observation.limit is not None:
                return observation
        return None

    def list_for_provider(self, provider: str) -> list[QuotaObservation]:
        """All fresh readings for one provider (any model/bucket)."""
        name = as_str(provider)
        with self._lock:
            entries = [o for (p, _m, _b), o in self._entries.items() if p == name]
        return [o for o in entries if o.age_s <= self.ttl_s]

    def clear(self) -> None:
        with self._lock:
            self._entries.clear()

    def prune(self) -> int:
        """Drop stale entries; returns how many were removed."""
        with self._lock:
            stale = [key for key, obs in self._entries.items() if obs.age_s > self.ttl_s]
            for key in stale:
                self._entries.pop(key, None)
        return len(stale)


def _observation_ttl() -> float:
    raw = os.environ.get('AUGUST_QUOTA_OBSERVATION_TTL_S', '')
    try:
        value = float(raw)
    except ValueError:
        return _OBSERVATION_TTL_S
    return value if value > 0 else _OBSERVATION_TTL_S


# Process-wide store: observations are per-running-app state, exactly like the
# health monitor's ring buffer — nothing is written to disk.
quota_observations = QuotaObservationStore()


def observation_key(provider: str, model: str = '', bucket: str = '') -> tuple[str, str, str]:
    """The store key for a reading — one place so callers cannot drift."""
    return (as_str(provider), as_str(model), as_str(bucket))
