"""Per-model pricing: the price you store is the price you are billed at.

Before this, cost came from one hardcoded family table whose *last resort* was
$3/$15 per 1M — so an unmatched local model (`llama3.1:8b` misses the
`llama-3` substring, `qwen3:0.6b` over Ollama matches nothing hosted) was
billed at Claude Sonnet prices for tokens that cost nothing, and there was no
way to tell August otherwise: no per-model price field existed.

These tests pin the resolution order (env → configured price → the `free` flag
→ table → default) and, just as importantly, the honesty of the answer: a
figure that came from the table or the default reports ``estimated=True``,
because a readout that cannot tell "you typed this" from "we guessed this"
presents a guess as a bill.

Also pinned, because both are quiet data-loss bugs: ``0.0`` is a price and not
an absence, and a saved price must survive the provider GET serialization —
a field the form cannot read back is a field nobody can set.
"""

from __future__ import annotations

import pytest

# One model per pricing shape, so precedence is measured between neighbours in
# a single store rather than inferred across two separate fixtures.
_MODELS = [
    # Explicit pair that contradicts the table (claude-sonnet* would be 3/15).
    {'id': 'claude-sonnet-4-5', 'priceInPerM': 1.0, 'priceOutPerM': 2.0},
    # 0.0 must read as "this host charges nothing", not as "unset". Its id
    # matches no table row, so a null-collapse here would bill it $3/$15.
    {'id': 'llama3.1:8b-instruct', 'priceInPerM': 0.0, 'priceOutPerM': 0.0},
    # The pre-existing `free` flag, with no price fields at all.
    {'id': 'mistral-small:latest', 'free': True},
    # Table match, nothing configured.
    {'id': 'gpt-5-mini', 'name': 'gpt-5-mini'},
    # No table match, nothing configured: the last-resort default.
    {'id': 'totally-unknown-encoder', 'name': 'totally-unknown-encoder'},
    # Half a price: the set half is fact, the other half is the table's guess.
    {'id': 'gpt-4o-partial', 'priceInPerM': 7.5},
    # Garbage values must not become prices.
    {'id': 'broken-price', 'priceInPerM': -3.0, 'priceOutPerM': 'free'},
]


@pytest.fixture(autouse=True)
def _no_stale_price_index():
    from app.services import cost_estimator

    cost_estimator.invalidate_price_cache()
    yield
    cost_estimator.invalidate_price_cache()


@pytest.fixture()
def priced(isolatedData):
    """One isolated data dir holding both providers.json and the brain SQLite,
    so a test can price a model and then read the usage endpoint for it."""
    from app.services import config_service

    config_service.saveProvidersStore(
        {
            'providers': [
                {
                    'id': 'p1',
                    'name': 'P1',
                    'apiFormat': 'openaiChat',
                    'baseUrl': 'http://localhost:11434/v1',
                    'enabled': True,
                    'models': [dict(m, source='manual') for m in _MODELS],
                }
            ]
        }
    )
    return isolatedData


def _price(model_id: str):
    from app.services import cost_estimator

    return cost_estimator.price_for_model(model_id)


class TestResolutionOrder:
    def test_a_configured_price_beats_the_family_table(self, priced):
        p = _price('claude-sonnet-4-5')
        assert (p.in_per_m, p.out_per_m) == (1.0, 2.0)
        assert p.source == 'model'
        assert p.estimated is False, 'a price the user typed is not a guess'

    def test_zero_is_a_price_not_an_absence(self, priced):
        p = _price('llama3.1:8b-instruct')
        assert (p.in_per_m, p.out_per_m) == (0.0, 0.0)
        assert p.estimated is False

    def test_the_free_flag_prices_a_model_at_zero(self, priced):
        # `free` was already stored, badged in the model list and used to rank
        # the picker — while no cost path read it, so a free model still got a
        # table or default price.
        p = _price('mistral-small:latest')
        assert (p.in_per_m, p.out_per_m) == (0.0, 0.0)
        assert p.source == 'free'
        assert p.estimated is False

    def test_an_env_override_beats_a_configured_price(self, priced, monkeypatch):
        monkeypatch.setenv('AUGUST_PRICE_IN_PER_M', '0.5')
        monkeypatch.setenv('AUGUST_PRICE_OUT_PER_M', '0.9')
        p = _price('claude-sonnet-4-5')
        assert (p.in_per_m, p.out_per_m) == (0.5, 0.9)
        assert p.source == 'env'

    def test_a_malformed_env_override_falls_through(self, priced, monkeypatch):
        monkeypatch.setenv('AUGUST_PRICE_IN_PER_M', 'not-a-number')
        p = _price('claude-sonnet-4-5')
        assert (p.in_per_m, p.out_per_m) == (1.0, 2.0), 'the stored price still answers'


class TestEstimatesSaySo:
    def test_a_table_match_is_reported_as_estimated(self, priced):
        p = _price('gpt-5-mini')
        assert (p.in_per_m, p.out_per_m) == (1.25, 10.0)
        assert p.source == 'table'
        assert p.estimated is True

    def test_an_unmatched_model_gets_the_default_and_the_flag(self, priced):
        p = _price('totally-unknown-encoder')
        assert (p.in_per_m, p.out_per_m) == (3.0, 15.0)
        assert p.source == 'unknown'
        assert p.estimated is True

    def test_a_half_set_price_keeps_its_own_half_and_flags_the_guess(self, priced):
        p = _price('gpt-4o-partial')
        assert p.in_per_m == 7.5, 'the configured half is honored'
        assert p.out_per_m == 10.0, 'the missing half falls to the gpt-4o table row'
        assert p.source == 'model'
        assert p.estimated is True, 'half a price is still half a guess'

    def test_unusable_stored_values_never_become_prices(self, priced):
        # A negative and a non-numeric price must not produce a negative bill
        # or a crash; the model falls back exactly as if nothing were set.
        p = _price('broken-price')
        assert p.in_per_m > 0 and p.out_per_m > 0
        assert p.estimated is True


class TestCostMath:
    def test_session_cost_usd_still_bills_cache_hits_at_the_discount(self, priced):
        from app.services.cost_estimator import session_cost_usd

        # claude-sonnet-4-5 is configured at 1.0/2.0 per 1M.
        usd = session_cost_usd('claude-sonnet-4-5', 1_000_000, 1_000_000)
        assert usd == pytest.approx(3.0)
        split = session_cost_usd(
            'claude-sonnet-4-5', 1_000_000, 1_000_000, cache_hit=800_000, cache_miss=200_000
        )
        assert split == pytest.approx(200_000 * 1.0 / 1e6 + 800_000 * 0.1 * 1.0 / 1e6 + 2.0)
        assert split < usd, 'a cache hit must reduce the bill'

    def test_a_free_model_costs_nothing_end_to_end(self, priced):
        from app.services.cost_estimator import session_cost_usd

        assert session_cost_usd('llama3.1:8b-instruct', 5_000_000, 900_000) == 0.0
        assert session_cost_usd('mistral-small:latest', 5_000_000, 900_000) == 0.0


class TestIndexIsReadOncePerChange:
    def test_the_store_is_parsed_once_across_many_priced_calls(self, priced):
        import json

        from app.services import cost_estimator

        real_loads = json.loads
        calls = {'n': 0}

        def _counting_loads(text, *a, **kw):
            calls['n'] += 1
            return real_loads(text, *a, **kw)

        monkey = pytest.MonkeyPatch()
        monkey.setattr(cost_estimator.json, 'loads', _counting_loads)
        try:
            for _ in range(50):
                cost_estimator.price_for_model('claude-sonnet-4-5')
        finally:
            monkey.undo()
        assert calls['n'] == 1, (
            f'parsed providers.json {calls["n"]}x for 50 priced events — the '
            'usage endpoint sums over 500, so this must be once per change'
        )

    def test_saving_the_store_invalidates_the_index(self, priced):
        from app.services import config_service, cost_estimator

        assert cost_estimator.price_for_model('claude-sonnet-4-5').in_per_m == 1.0
        store = config_service.getProvidersStore()
        store['providers'][0]['models'][0]['priceInPerM'] = 9.0
        config_service.saveProvidersStore(store)  # must bust the index itself
        assert cost_estimator.price_for_model('claude-sonnet-4-5').in_per_m == 9.0


class TestFieldsReachTheClient:
    def test_the_provider_get_serializes_prices_including_zero(self, priced):
        from app.routers.providers import _provider_to_dict
        from app.services import config_service

        out = _provider_to_dict(config_service.getProvidersAsModels()[0])
        rows = {m['id']: m for m in out['models']}
        assert (rows['claude-sonnet-4-5']['priceInPerM'], rows['claude-sonnet-4-5']['priceOutPerM']) == (1.0, 2.0)
        assert rows['llama3.1:8b-instruct']['priceInPerM'] == 0.0, '0.0 must not become null'
        assert rows['gpt-5-mini']['priceInPerM'] is None, 'unset stays unset'

    @pytest.mark.asyncio
    async def test_add_model_persists_prices(self, priced):
        from app.models.config import ModelCreate
        from app.routers.providers import addModel
        from app.services import config_service

        await addModel('p1', ModelCreate(id='priced-new', price_in_per_m=0.4, price_out_per_m=1.6))
        model = next(
            m for m in config_service.getProvidersAsModels()[0].models if m.id == 'priced-new'
        )
        assert (model.price_in_per_m, model.price_out_per_m) == (0.4, 1.6)

    @pytest.mark.asyncio
    async def test_an_explicit_null_clears_the_price_and_zero_keeps_it(self, priced):
        from app.models.config import ModelUpdate
        from app.routers.providers import updateModel
        from app.services import config_service

        def entry(model_id: str) -> dict:
            store = config_service.getProvidersStore()
            return next(m for m in store['providers'][0]['models'] if m['id'] == model_id)

        await updateModel('p1', 'claude-sonnet-4-5', ModelUpdate(name='Renamed'))
        assert 'priceInPerM' in entry('claude-sonnet-4-5'), (
            'an unrelated edit must not wipe a stored price'
        )

        await updateModel(
            'p1', 'claude-sonnet-4-5', ModelUpdate(price_in_per_m=None, price_out_per_m=None)
        )
        assert 'priceInPerM' not in entry('claude-sonnet-4-5')
        assert _falls_back_to_a_guess('claude-sonnet-4-5')

        await updateModel('p1', 'gpt-5-mini', ModelUpdate(price_in_per_m=0.0, price_out_per_m=0.0))
        assert entry('gpt-5-mini')['priceInPerM'] == 0.0


def _falls_back_to_a_guess(model_id: str) -> bool:
    """True once the model is priced from the table/default instead of itself."""
    from app.services import cost_estimator

    return cost_estimator.price_for_model(model_id).estimated


class TestTheDisplaysThatCouldNeverShowANumber:
    """Three money readouts were structurally pinned to zero, and each was a
    *read* mismatch rather than a missing calculation:

    * the cost card asked ``get_stats`` for ``estimatedInputCost`` /
      ``estimatedTotalCost``; get_stats returned only ``estimatedCost``, so the
      card printed $0.00 beside a real total one line away;
    * the Traffic table read a per-entry ``totalCost`` / ``estimatedCost`` that
      no writer ever set, so every row said $0.0000;
    * ``session.totalCost`` was serialized and rendered by the Runs page but
      never assigned.

    These pin that all three now carry a number, and that the number is priced
    per model instead of by one flat rate applied to everything.
    """

    @staticmethod
    def _tracker(monkeypatch):
        from app.services import logger as req_logger

        fresh = req_logger.RequestTracker()
        monkeypatch.setattr(req_logger, '_tracker', fresh)
        return fresh

    @staticmethod
    def _record(tracker, model: str, inp: int, out: int) -> None:
        req_id = tracker.startRequest({'model': model, 'provider': 'p1'})
        tracker.capture_tokens(req_id, inp, out)
        tracker.endRequest(req_id, {})

    def test_stats_price_each_model_at_its_own_rate(self, priced, monkeypatch):
        tracker = self._tracker(monkeypatch)
        # 1M in + 1M out of a $1.25/$10 model and a $15/$75 model. The old code
        # billed both at a flat 3.0/15.0, which answers 6.0 and 30.0 instead.
        self._record(tracker, 'gpt-5-mini', 1_000_000, 1_000_000)
        self._record(tracker, 'claude-opus-4-1', 1_000_000, 1_000_000)
        stats = tracker.get_stats()
        assert stats['estimatedInputCost'] == pytest.approx(16.25)
        assert stats['estimatedOutputCost'] == pytest.approx(85.0)
        assert stats['estimatedTotalCost'] == pytest.approx(101.25)
        assert stats['estimatedCost'] == pytest.approx(101.25)

    def test_stats_carry_the_exact_key_names_the_readers_ask_for(self, priced, monkeypatch):
        # /api/overview does `stats.get('estimatedInputCost') or
        # stats.get('inputCost')` — a synonym here renders as $0, so the names
        # are the contract and are pinned as names.
        tracker = self._tracker(monkeypatch)
        self._record(tracker, 'gpt-5-mini', 500_000, 250_000)
        stats = tracker.get_stats()
        for key in (
            'estimatedInputCost',
            'estimatedOutputCost',
            'estimatedTotalCost',
            'estimatedCost',
            'costEstimated',
        ):
            assert key in stats, f'{key} missing — readers fall back to 0.0 silently'
        assert stats['estimatedTotalCost'] > 0.0

    def test_stats_report_a_free_session_as_exact(self, priced, monkeypatch):
        tracker = self._tracker(monkeypatch)
        self._record(tracker, 'llama3.1:8b-instruct', 900_000, 100_000)
        stats = tracker.get_stats()
        assert stats['estimatedTotalCost'] == 0.0
        assert stats['costEstimated'] is False, 'a price of 0 here is a fact, not a guess'

    def test_stats_flag_a_table_guessed_session_as_estimated(self, priced, monkeypatch):
        tracker = self._tracker(monkeypatch)
        self._record(tracker, 'gpt-5-mini', 1000, 100)
        assert tracker.get_stats()['costEstimated'] is True

    def test_a_finished_request_carries_its_own_cost(self, priced, monkeypatch):
        tracker = self._tracker(monkeypatch)
        self._record(tracker, 'claude-opus-4-1', 10_000, 2_000)
        entry = tracker.getLog()[0]
        # 10k in at 15/1M + 2k out at 75/1M.
        assert entry['estimatedCost'] == pytest.approx(0.15 + 0.15)
        assert entry['costEstimated'] is True


class TestEstimateCostEndpoint:
    @pytest.mark.asyncio
    async def test_it_bills_instead_of_returning_a_confident_zero(self, priced):
        from app.routers.models import CostEstimateBody, estimate_cost

        out = await estimate_cost(
            CostEstimateBody(
                model_id='gpt-5-mini', input_tokens=1_000_000, output_tokens=1_000_000
            )
        )
        assert out['cost'] == pytest.approx(11.25)
        assert out['estimated'] is True, 'the old hardcoded estimated: False was the lie'
        assert out['priceSource'] == 'table'
        assert (out['priceInPerM'], out['priceOutPerM']) == (1.25, 10.0)

    @pytest.mark.asyncio
    async def test_a_priced_model_reports_the_price_as_fact(self, priced):
        from app.routers.models import CostEstimateBody, estimate_cost

        out = await estimate_cost(
            CostEstimateBody(
                model_id='llama3.1:8b-instruct', input_tokens=9_000_000, output_tokens=1_000_000
            )
        )
        assert out['cost'] == 0.0
        assert out['estimated'] is False


class TestPricingCannotRaise:
    """The session-cost accumulation sits inside a ``try`` whose ``except`` only
    logs, so a raising price lookup would lose spend silently instead of
    failing loudly. Nothing on this path may throw.
    """

    @pytest.mark.parametrize(
        'bad',
        ['', None, 'x' * 500, '////', 'CLAUDE-OPUS', 'claude-opus\n', 0, 12345, {'a': 1}],
    )
    def test_hostile_model_values_resolve_without_an_exception(self, priced, bad):
        from app.services import cost_estimator

        price = cost_estimator.price_for_model(bad)
        assert price.in_per_m >= 0.0 and price.out_per_m >= 0.0
        assert isinstance(price.estimated, bool)

    def test_a_cache_split_never_outbills_the_whole_input(self, priced):
        from app.services.cost_estimator import session_cost_usd

        whole = session_cost_usd('claude-sonnet-4-5', 1_000_000, 0)
        all_hit = session_cost_usd('claude-sonnet-4-5', 1_000_000, 0, cache_hit=1_000_000)
        assert all_hit < whole
        assert all_hit >= 0.0


class TestUsageEndpointCarriesProvenance:
    """`GET /api/usage/{session}` feeds the composer chip, so `costEstimated`
    has to be right here or the tilde is decoration on the wrong number. The
    sum is per event and a session can span models, so the flag is an "any of
    them were guessed", not a property of the last one.
    """

    @staticmethod
    def _usage(session_id: str):
        from app.services.memory_store import get_usage, init

        init()
        return get_usage(session_id)

    def test_a_priced_model_reports_an_exact_cost(self, priced):
        from app.services.memory_store import record_usage

        record_usage('s-exact', 'claude-sonnet-4-5', inputTokens=1_000_000, outputTokens=1_000_000)
        usage = self._usage('s-exact')
        assert usage['totalCost'] == pytest.approx(3.0)
        assert usage['costEstimated'] is False

    def test_a_table_guessed_model_says_so(self, priced):
        from app.services.memory_store import record_usage

        record_usage('s-guess', 'gpt-5-mini', inputTokens=1_000_000, outputTokens=1_000_000)
        usage = self._usage('s-guess')
        assert usage['totalCost'] == pytest.approx(11.25)
        assert usage['costEstimated'] is True

    def test_one_guessed_row_makes_a_mixed_session_a_guess(self, priced):
        from app.services.memory_store import record_usage

        record_usage('s-mix', 'claude-sonnet-4-5', inputTokens=1_000_000, outputTokens=0)
        record_usage('s-mix', 'gpt-5-mini', inputTokens=0, outputTokens=1_000_000)
        assert self._usage('s-mix')['costEstimated'] is True

    def test_a_session_with_no_usage_is_zero_and_not_flagged(self, priced):
        usage = self._usage('s-empty')
        assert usage['totalCost'] == 0.0
        assert usage['costEstimated'] is False
