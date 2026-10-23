"""Timestamp format for mutable facts.

SQLite's ``datetime('now')`` truncates to whole seconds. The memory-delta lane
compares a session's creation stamp (which has sub-second precision) against
``facts.updated_at``; a fact written in the same wall-clock second as the
session used to be invisible. Every fact WRITER therefore stores a fixed-width
UTC stamp with microseconds, produced here so the spelling cannot drift.

The delta predicate compares these strings directly. Fixed-width
``YYYY-MM-DD HH:MM:SS.ffffff`` text sorts chronologically; SQLite's
``julianday`` only resolves to milliseconds and would re-open the same-ms
edge. Existing second-resolution rows compare as ``.000000`` and correctly
sort before a later stamp in that same second.
"""

from datetime import datetime, timezone


def utc_now_text() -> str:
    return datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S.%f')
