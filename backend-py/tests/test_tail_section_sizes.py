"""``tailSectionSizes`` — the producer behind the composer's context meter.

The keys are named ``…Bytes`` and the UI prints them as bytes, so a character
count would under-report any prompt containing non-ASCII text (a Chinese
transcript, an emoji, a `µ` in a unit name). The per-skill map exists for the
same reason the totals do: "Skills & memory: 4 kB" cannot answer which skill
cost it.
"""

from __future__ import annotations

from app.services.workbench.workbench import tailSectionSizes


def test_sizes_are_utf8_bytes_not_characters():
    sizes = tailSectionSizes('héllo', 'µ', None, None)
    assert sizes['memoryBytes'] == len('héllo'.encode('utf-8')) == 6
    assert sizes['skillsBytes'] == len('µ'.encode('utf-8')) == 2
    assert sizes['stateBytes'] == 0
    assert sizes['nudgeBytes'] == 0
    assert sizes['skillsByName'] == {}


def test_absent_blocks_report_measured_zero():
    """A zero means "not injected this turn" — the display layer owns "unknown"."""
    sizes = tailSectionSizes(None, None, None, None)
    assert sizes == {
        'memoryBytes': 0,
        'skillsBytes': 0,
        'stateBytes': 0,
        'nudgeBytes': 0,
        'skillsByName': {},
    }


def test_skill_detail_drops_anonymous_and_zero_entries():
    sizes = tailSectionSizes(
        None,
        '- a: x\n- b: y',
        None,
        None,
        {'canvas': 12, 'review': 0, '': 7, 'unicode-µ': 3},
    )
    assert sizes['skillsByName'] == {'canvas': 12, 'unicode-µ': 3}
