"""Conformance: the UI's Turn Limits panel only names keys the backend accepts.

The panel's copy is product text, so its table is hand-written. That is fine —
but it means a key renamed, removed, or never added server-side would render a
control that silently 400s on save, with the failure showing up as a toast the
user has to interpret. This file makes that a build failure instead.

It also pins the one promise the panel makes in prose: every bound it shows
must be a key `validatePatch` actually accepts (i.e. in `allowedKeys`), and
every numeric key the backend accepts for these families must be shown — so a
bound cannot exist with no way to set it, which is exactly how the runaway
backstop became documented-but-unreachable in the first place.
"""

from __future__ import annotations

import json
import pathlib
import re
from typing import Any

from app.services import brain_config_service as bcs

_PANEL = (
    pathlib.Path(__file__).resolve().parents[2]
    / 'frontend'
    / 'desktop'
    / 'src'
    / 'sections'
    / 'settings'
    / 'TurnLimitsSection.tsx'
)

# The families the panel is responsible for. Anything numeric the backend
# accepts in these families and the panel does not show is a bound with no UI.
_OWNED_FAMILIES = (
    'maxWorkbenchToolLoops',
    'budgetSoftUsd',
    'budgetSoftTokens',
    'budgetWallClockSec',
    'runawayNudgeRounds',
    'runawayStopRounds',
)


def _panel_keys() -> list[str]:
    if not _PANEL.exists():  # pragma: no cover - only when running outside the repo
        return []
    src = _PANEL.read_text('utf-8')
    return re.findall(r"^\s*key:\s*'([A-Za-z0-9_]+)',", src, re.MULTILINE)


class TestPanelKeysAreRealConfigKeys:
    def test_the_panel_exists(self):
        assert _PANEL.exists(), f'missing panel source: {_PANEL}'

    def test_every_key_the_panel_shows_is_accepted_by_the_backend(self):
        for key in _panel_keys():
            assert key in bcs.allowedKeys, (
                f'TurnLimitsSection renders {key!r}, which validatePatch rejects '
                '(unknown field) — the control would 400 on save'
            )

    def test_every_bound_in_these_families_is_shown(self):
        shown = set(_panel_keys())
        missing = [k for k in _OWNED_FAMILIES if k in bcs.allowedKeys and k not in shown]
        assert not missing, (
            f'the backend accepts these but the panel renders no control for them: {missing}. '
            'A bound with no UI is how the runaway backstop became unreachable.'
        )

    def test_the_panel_keys_and_the_owned_families_are_the_same_set(self):
        assert set(_panel_keys()) == set(_OWNED_FAMILIES)


class TestRunawayDefaultsAreAbsentNotZero:
    """The guard's "unset" sentinel is -1, and `_snakeToCamel` starts from
    `_defaultsCamel()`. A default of 0 made the key PRESENT, so the guard's
    nudge fallback was unreachable and "set only a hard stop" became a silent
    kill at the stop threshold with no warning."""

    def test_unarmed_runaway_keys_default_to_absent(self):
        defaults = bcs.getDefaults()
        for key in ('runawayNudgeRounds', 'runawayStopRounds'):
            assert defaults.get(key) is None, (
                f'{key} defaults to {defaults.get(key)!r}; the guard reads 0 as '
                '"configured, do not nudge". It must be absent.'
            )

    def test_zero_is_still_a_legal_written_value(self):
        assert bcs.validatePatch({'runawayStopRounds': 0})[0], '0 must stay writable to disarm'

    def test_setting_only_the_stop_still_produces_a_nudge(self, monkeypatch):
        """End to end through the guard: the documented behaviour in
        `guards._runawayBudget`'s docstring must actually occur."""
        from app.services.workbench.loop import guards

        monkeypatch.setattr(bcs, 'getRuntimeConfig', lambda: {'runawayStopRounds': 40})
        nudge, stop = guards._runawayBudget()
        assert stop == 40
        assert nudge > 0, (
            'a hard stop with no warning is the silent-kill case; the nudge must '
            'fall back rather than read as "configured at 0"'
        )


class TestConfiguredPricesSurviveTheApiRoundTrip:
    """`runaway*` were previously absent from `allowedKeys`, so a PUT naming them
    was rejected with 400 and a hand-edited config.json value was dropped before
    the guard could read it. That is the 'documented but no door' defect."""

    def test_a_runaway_patch_validates(self):
        ok, err = bcs.validatePatch(
            {'runawayNudgeRounds': 25, 'runawayStopRounds': 40}
        )
        assert ok, err

    def test_the_snake_key_maps_both_ways(self):
        assert bcs.snakeToCamel['runaway_nudge_rounds'] == 'runawayNudgeRounds'
        assert bcs.camelToSnake['runawayStopRounds'] == 'runaway_stop_rounds'

    def test_out_of_range_is_refused_with_a_message(self):
        ok, err = bcs.validatePatch({'runawayStopRounds': 10_000_000})
        assert not ok and 'between' in err