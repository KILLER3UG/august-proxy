"""Skill quality scoring — 5 dimensions, 0-100 score.

Part of Better Harness Plan Phase 3.4.
Dimensions: Discovery (20), Effectiveness (30), Completeness (20), Freshness (15), Safety (15).
"""

from __future__ import annotations

import logging
import re
from datetime import datetime, timedelta, timezone

logger = logging.getLogger(__name__)

_DANGEROUS_PATTERNS = re.compile(r'(rm -rf|DROP TABLE|--force|shutil\.rmtree|format\(|DELETE FROM)', re.I)
_UNBOUNDED_PATTERNS = re.compile(r'(all files|every file|glob\(\*\*|\*\.py)', re.I)


def _parse_ts(raw: str | None) -> datetime | None:
    """Parse a skill timestamp into an aware UTC datetime.

    Accepts epoch seconds (float/int — the skill curator stores
    ``time.time()``) and ISO-8601 strings (aware or naive; naive values
    are treated as UTC). Returns None when unparsable.
    """
    if not raw:
        return None
    if isinstance(raw, (int, float)):
        try:
            return datetime.fromtimestamp(float(raw), tz=timezone.utc)
        except (ValueError, OSError, OverflowError):
            return None
    try:
        dt = datetime.fromisoformat(str(raw))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    except (ValueError, TypeError):
        return None


def score_skill(
    name: str,
    description: str,
    body: str,
    trigger: str | None,
    category: str | None,
    use_count: int = 0,
    last_used_at: str | None = None,
    created_at: str | None = None,
    patched_at: str | None = None,
) -> dict:
    """Score a skill across 5 dimensions. Returns {score, breakdown}."""
    breakdown: dict[str, int] = {}

    # Discovery (20): has trigger, description clear, category set, name valid
    discovery = 0
    if trigger and len(trigger) > 3:
        discovery += 8
    if description and 5 < len(description) <= 60:
        discovery += 6
    if category:
        discovery += 3
    if name and re.match(r'^[a-z0-9][a-z0-9._-]*$', name):
        discovery += 3
    breakdown['discovery'] = min(discovery, 20)

    # Effectiveness (30): use_count > 0, recent use, no failures
    effectiveness = 0
    if use_count > 0:
        effectiveness += 10
    last_used = _parse_ts(last_used_at)
    if last_used is not None:
        age = datetime.now(timezone.utc) - last_used
        if age < timedelta(days=30):
            effectiveness += 10
        elif age < timedelta(days=90):
            effectiveness += 5
    if use_count >= 3:
        effectiveness += 10  # Repeated use = proven value
    breakdown['effectiveness'] = min(effectiveness, 30)

    # Completeness (20): body length, steps, expected output, failure guidance
    completeness = 0
    if body and len(body) > 200:
        completeness += 5
    if body and re.search(r'^\s*(\d+\.|[-*])\s+', body, re.M):
        completeness += 5  # Has numbered/bulleted steps
    if body and re.search(r'(expected|output|result|returns)', body, re.I):
        completeness += 5
    if body and re.search(r'(failure|error|fallback|if.*fails|blocked)', body, re.I):
        completeness += 5
    breakdown['completeness'] = min(completeness, 20)

    # Freshness (15): created/patched within 90/180 days
    freshness = 0
    reference_date = patched_at or created_at
    ref = _parse_ts(reference_date)
    if ref is not None:
        age = datetime.now(timezone.utc) - ref
        if age < timedelta(days=90):
            freshness = 15
        elif age < timedelta(days=180):
            freshness = 8
    else:
        freshness = 8  # Unknown age — neutral
    breakdown['freshness'] = freshness

    # Safety (15): no dangerous commands, bounded scope
    safety = 15
    if body:
        if _DANGEROUS_PATTERNS.search(body):
            safety -= 8
        if _UNBOUNDED_PATTERNS.search(body):
            safety -= 7
    breakdown['safety'] = max(safety, 0)

    total = sum(breakdown.values())
    return {'score': total, 'breakdown': breakdown}
