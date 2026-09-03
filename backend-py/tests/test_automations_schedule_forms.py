"""Part 19 Phase B — natural-language schedule forms for routines.

``create_routine``'s own error message advertises ``daily 09:00`` (and the
RoutinesPane picker will emit ``weekly mon 09:00``-style picks), but
``parse_schedule`` only accepted ``every Nh`` and 5-field cron — following
the tool's advice produced ``unsupported schedule: 'daily 09:00'``. These
tests pin the normalized forms:
  * ``daily HH:MM`` → cron ``M H * * *``
  * ``weekly <day> [at] HH:MM`` → cron ``M H * * D``
  * case/``at``-word tolerance; invalid times still fail loudly.
"""

from __future__ import annotations

import pytest
from app.services.automations_schedule import compute_next_run_at, parse_schedule


class TestDailyForm:
    def test_daily_hhmm_parses_as_cron(self):
        d = parse_schedule('daily 09:00')
        assert d['kind'] == 'cron'
        assert d['expr'] == '0 9 * * *'

    def test_daily_pm_minutes(self):
        d = parse_schedule('daily 17:30')
        assert d['expr'] == '30 17 * * *'

    def test_daily_case_insensitive_and_at(self):
        assert parse_schedule('Daily 08:00')['expr'] == '0 8 * * *'
        assert parse_schedule('daily at 08:00')['expr'] == '0 8 * * *'

    def test_daily_next_run_is_that_time(self):
        # compute_next_run_at returns an ISO UTC instant; the local wall time
        # it corresponds to depends on the host tz — assert the cron-expected
        # minutes/hour in UTC by parsing the same expression as cron.
        from datetime import datetime
        from datetime import timezone as _tz

        tz = 'UTC'
        nxt = compute_next_run_at('daily 09:00', tz)
        assert isinstance(nxt, str)
        dt = datetime.fromisoformat(nxt)
        assert dt.tzinfo is not None
        # With tz=UTC the returned instant must sit at 09:00 UTC.
        assert (dt.hour, dt.minute) == (9, 0), nxt

    def test_daily_invalid_time_fails_loudly(self):
        with pytest.raises(ValueError):
            parse_schedule('daily 25:00')
        with pytest.raises(ValueError):
            parse_schedule('daily 09:99')
        with pytest.raises(ValueError):
            parse_schedule('daily')


class TestWeeklyForm:
    def test_weekly_day_hhmm(self):
        d = parse_schedule('weekly mon 09:00')
        assert d['kind'] == 'cron'
        # Cron dow 1 = Monday.
        assert d['expr'] == '0 9 * * 1'

    def test_weekly_day_at_hhmm(self):
        assert parse_schedule('weekly fri at 18:30')['expr'] == '30 18 * * 5'

    def test_weekly_full_day_names(self):
        assert parse_schedule('weekly monday 09:00')['expr'] == '0 9 * * 1'
        assert parse_schedule('weekly sunday 09:00')['expr'] == '0 9 * * 0'

    def test_weekly_unknown_day_fails(self):
        with pytest.raises(ValueError):
            parse_schedule('weekly someday 09:00')


class TestExistingFormsUnchanged:
    def test_every_interval_still_works(self):
        assert parse_schedule('every 30m')['kind'] == 'interval'

    def test_plain_cron_still_works(self):
        assert parse_schedule('0 9 * * *')['kind'] == 'cron'

    def test_garbage_still_fails(self):
        with pytest.raises(ValueError):
            parse_schedule('sometime soon')
