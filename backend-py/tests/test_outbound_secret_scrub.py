"""Outbound credential scrub — DS Bot item 7 (`secrets.js`), tested at the wire.

The tool-boundary guard already denies a secret-shaped write and redacts a
protected-path read. Neither covers how a credential actually leaves: it rides
into the transcript once — pasted by the user, quoted by a log line, printed by a
command whose path looked harmless — and is then re-sent to whichever gateway is
active on **every later turn**. The reference closes that at the request door,
replacing the value with `[secret:<NAME>]` so the machine's own credential
inventory never travels in a prompt body.

**The door is the transport, not the serializer.** A first version wired this
into `dump_openai_upstream_body` / `dump_anthropic_upstream_body` and a review
round proved it covered neither of the two real paths: the workbench dumps an
empty request and then ASSIGNS `body['messages']` afterwards
(`workbench/providers.py`), and the `/v1` proxy forwards the caller's parsed body
verbatim (`adapters/openai.py`). `BaseProviderClient` has exactly two `self.client`
calls (`requestJson`, `streamSse`), so those are where every provider body —
chat, streaming, title generation, probes, proxy, sub-agents — actually leaves.
These tests therefore drive a real client through a mocked httpx transport and
assert on what the provider would receive.

Matched by VALUE, never by pattern: this path serves every chat request, and a
pattern scrub would rewrite key-shaped text a user pasted precisely to ask why
their own key returns 401.
"""

from __future__ import annotations

import json
import os

import pytest
from app.providers.clients.base import BaseProviderClient
from app.services import config_service
from app.services.hooks import secret_guard

PROVIDER_KEY = 'sk-proj-aaaaaaaaaaaaaaaaaaaa1111'
GATEWAY_KEY = 'gw-key-bbbbbbbbbbbbbbbbbbbb2222'
ENV_KEY = 'zz-cccccccccccccccccccc3333'
URL = 'https://gateway.test/v1/chat/completions'


@pytest.fixture(autouse=True)
def _resetCache():
    secret_guard._invalidateOutbound()
    yield
    secret_guard._invalidateOutbound()
    os.environ.pop('ACME_SERVICE_API_KEY', None)
    from app.config import settings

    settings.gatewayApiKey = None


@pytest.fixture
def configured(isolatedData):
    """One provider key, the gateway key, one env-backed token.

    Written through `saveProvidersStore` — the real door, which is also what
    fires the invalidation the cache depends on. Monkeypatching the reader would
    test the matcher and miss both wiring bugs this file exists to catch.
    """
    config_service.saveProvidersStore(
        {
            'providers': [
                {'id': 'openai', 'name': 'openai-test', 'apiKey': PROVIDER_KEY, 'enabled': True},
                # Too short to scrub by: substring-replacing three characters
                # would mangle ordinary prose.
                {'id': 'tiny', 'name': 'tiny', 'apiKey': 'abc', 'enabled': True},
            ]
        }
    )
    from app.config import settings

    settings.gatewayApiKey = GATEWAY_KEY
    os.environ['ACME_SERVICE_API_KEY'] = ENV_KEY
    secret_guard._invalidateOutbound()


def _client(sent: list[dict[str, object]]) -> BaseProviderClient:
    """A real client whose transport records exactly the body httpx would send."""
    import httpx

    def handler(request: httpx.Request) -> httpx.Response:
        sent.append(json.loads(request.content.decode('utf-8')))
        return httpx.Response(200, json={'choices': [{'message': {'content': 'ok'}}]})

    client = BaseProviderClient({'name': 'test', 'baseUrl': 'https://gateway.test/v1'})
    client._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    return client


def _wire(body: dict[str, object]) -> dict[str, object]:
    sent: list[dict[str, object]] = []
    import asyncio

    asyncio.run(_client(sent).requestJson('POST', URL, {'x-api-key': PROVIDER_KEY}, body))
    assert sent, 'nothing was sent'
    return sent[0]


class TestTheTransportDoor:
    def test_a_provider_key_in_the_transcript_never_reaches_the_wire(self, configured):
        wire = _wire({'model': 'gpt-test', 'messages': [{'role': 'user', 'content': f'key: {PROVIDER_KEY}'}]})
        text = json.dumps(wire)
        assert PROVIDER_KEY not in text, 'the credential shipped verbatim'
        assert '[secret:OPENAI_TEST]' in text, text

    def test_the_workbench_assembly_pattern_is_covered(self, configured):
        """The exact bug a review round found: dump first, assign messages after.

        `workbench/providers.py` builds the body from an EMPTY request and then
        sets `body['messages']`, so a serializer-level scrub sees no transcript
        at all. This is the shape of the real call, asserted on the wire.
        """
        from app.models.openai import ChatCompletionRequest, dump_openai_upstream_body

        body = dump_openai_upstream_body(ChatCompletionRequest(model='gpt-test'))
        body['messages'] = [{'role': 'user', 'content': f'my {PROVIDER_KEY} fails'}]
        # The dump itself never saw the transcript — that is the point.
        assert PROVIDER_KEY in json.dumps(body), 'the dump scrubbed something it should not own'
        wire = json.dumps(_wire(body))
        assert PROVIDER_KEY not in wire, 'the transcript-side credential escaped'
        assert '[secret:OPENAI_TEST]' in wire

    def test_the_gateway_key_and_an_env_credential_are_scrubbed_too(self, configured):
        wire = json.dumps(
            _wire(
                {
                    'model': 'gpt-test',
                    'system': f'register with {GATEWAY_KEY}',
                    'messages': [{'role': 'user', 'content': f'and {ENV_KEY}'}],
                }
            )
        )
        assert GATEWAY_KEY not in wire and ENV_KEY not in wire
        assert '[secret:GATEWAY]' in wire and '[secret:ACME_SERVICE_API_KEY]' in wire

    def test_the_auth_header_is_never_touched(self, configured):
        """The key belongs in the header; scrubbing there would break all chat."""
        sentHeaders: list[dict[str, str]] = []
        import httpx

        def handler(request: httpx.Request) -> httpx.Response:
            sentHeaders.append(dict(request.headers))
            return httpx.Response(200, json={'ok': True})

        client = BaseProviderClient({'name': 'test'})
        client._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        import asyncio

        asyncio.run(client.requestJson('POST', URL, {'x-api-key': PROVIDER_KEY}, {'model': 'm'}))
        assert PROVIDER_KEY in str(sentHeaders[0].get('x-api-key')), 'auth was mangled'

    def test_nested_blocks_and_tool_definitions_are_scrubbed(self, configured):
        wire = json.dumps(
            _wire(
                {
                    'model': 'gpt-test',
                    'messages': [
                        {'role': 'user', 'content': [{'type': 'text', 'text': f'log {PROVIDER_KEY}'}]}
                    ],
                    'tools': [{'function': {'name': 'x', 'description': f'uses {PROVIDER_KEY}'}}],
                }
            )
        )
        assert PROVIDER_KEY not in wire, 'a nested leaf was skipped'
        assert wire.count('[secret:OPENAI_TEST]') == 2, wire

    def test_the_streaming_path_uses_the_same_door(self, configured):
        import asyncio

        sent: list[dict[str, object]] = []

        async def _run() -> None:
            import httpx

            def handler(request: httpx.Request) -> httpx.Response:
                sent.append(json.loads(request.content.decode('utf-8')))
                return httpx.Response(
                    200, headers={'content-type': 'text/event-stream'}, content=b'data: [DONE]\n\n'
                )

            client = BaseProviderClient({'name': 'test'})
            client._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
            async for _ in client.streamSse(
                URL, {'x-api-key': PROVIDER_KEY}, {'model': 'm', 'messages': [{'role': 'user', 'content': PROVIDER_KEY}]}
            ):
                pass

        asyncio.run(_run())
        assert sent and PROVIDER_KEY not in json.dumps(sent[0]), sent


class TestWhatItMustNotDo:
    def test_key_shaped_text_the_user_pasted_survives(self, configured):
        """The control that keeps this safe to run on every request.

        Value matching is the whole reason this door can exist on the main path:
        a pattern scrub would rewrite this string and the model could no longer
        answer a question about the user's own key.
        """
        text = 'try sk-proj-XXXXXXXXXXXXXXXXXXXXXXXX and sk-ant-foobar12345678901234567890'
        wire = json.dumps(_wire({'model': 'gpt-test', 'messages': [{'role': 'user', 'content': text}]}))
        assert text in wire, 'key-SHAPED text was rewritten — this is pattern matching'

    def test_a_credential_shorter_than_the_floor_is_ignored(self, configured):
        wire = json.dumps(_wire({'model': 'gpt-test', 'messages': [{'role': 'user', 'content': 'the abc thing'}]}))
        assert 'the abc thing' in wire

    def test_an_install_with_no_credentials_is_byte_identical(self, isolatedData):
        config_service.saveProvidersStore({'providers': []})
        from app.config import settings

        settings.gatewayApiKey = None
        secret_guard._invalidateOutbound()
        original = {'model': 'm', 'messages': [{'role': 'user', 'content': 'plain question'}], 'stream': True}
        assert _wire(dict(original)) == original

    def test_structure_and_types_survive_the_walk(self, configured):
        wire = _wire(
            {
                'model': 'gpt-test',
                'max_tokens': 64,
                'stream': True,
                'stop': ['a', 'b'],
                'metadata': {'nested': {'deep': [1, None, True]}},
                'messages': [{'role': 'user', 'content': f'x {PROVIDER_KEY}'}],
            }
        )
        assert wire['max_tokens'] == 64 and wire['stream'] is True and wire['stop'] == ['a', 'b']
        assert wire['metadata'] == {'nested': {'deep': [1, None, True]}}
        assert list(wire['messages'][0].keys()) == ['role', 'content']  # type: ignore[index]

    def test_a_escaped_or_split_value_is_named_as_a_limit(self, configured):
        """Unicode-escaped or split-across-blocks forms are NOT caught.

        Documented, not fixed: closing them means rewriting sibling leaves, and a
        credential split into two tool outputs is a different threat model than
        the one this door is for. The test exists so the limit cannot silently
        become a promise.
        """
        escaped = json.dumps({'v': PROVIDER_KEY}).replace('sk-proj', 'sk\\u002dproj')
        assert 'sk\\u002d' in escaped
        assert secret_guard.scrubOutboundText(escaped) == escaped

    def test_the_marker_carries_no_part_of_the_value(self, configured):
        wire = json.dumps(_wire({'model': 'm', 'messages': [{'role': 'user', 'content': PROVIDER_KEY}]}))
        assert 'sk-proj' not in wire
        assert '[secret:OPENAI_TEST]' in wire


class TestTheInventoryIsBounded:
    def test_a_database_password_in_the_env_is_deliberately_NOT_scrubbed(self, configured):
        """The false positive this door must not create.

        `_PASSWORD` / `_SECRET` / generic `_TOKEN` names are excluded: a user
        pasting their own database password so the model can write it into a
        compose file would otherwise get a file containing `[secret:DB_PASSWORD]`
        and no way to see why. Provider keys are the inventory the install works
        FROM; a password the user is typing is content they work WITH.
        """
        password = 'super-secret-db-pass-1234'
        os.environ['ACME_DB_PASSWORD'] = password
        secret_guard._invalidateOutbound()
        wire = json.dumps(_wire({'model': 'm', 'messages': [{'role': 'user', 'content': password}]}))
        assert password in wire, 'a user-typed password was rewritten out from under them'

    def test_an_unreadable_store_fails_open_without_disabling_the_gate(self, configured):
        """A read failure must not be cached as "no credentials exist".

        Failing open is correct (this runs on every request); caching the empty
        result would leave the door off until the process restarts, silently.
        """
        original = config_service.getProvidersStore

        def boom(*_a, **_kw):
            raise RuntimeError('store locked')

        config_service.getProvidersStore = boom  # type: ignore[assignment]
        try:
            secret_guard._invalidateOutbound()
            wire = json.dumps(_wire({'model': 'm', 'messages': [{'role': 'user', 'content': PROVIDER_KEY}]}))
            assert PROVIDER_KEY in wire, 'a failed read should not invent a marker'
        finally:
            config_service.getProvidersStore = original  # type: ignore[assignment]
        secret_guard._invalidateOutbound()
        recovered = json.dumps(_wire({'model': 'm', 'messages': [{'role': 'user', 'content': PROVIDER_KEY}]}))
        assert PROVIDER_KEY not in recovered, 'the gate stayed off after a transient read failure'

    def test_a_provider_named_after_its_own_key_does_not_echo_it(self, configured):
        """The marker must not become the leak it replaced."""
        config_service.saveProvidersStore(
            {'providers': [{'id': 'weird', 'name': f'acme {PROVIDER_KEY}', 'apiKey': PROVIDER_KEY}]}
        )
        secret_guard._invalidateOutbound()
        wire = json.dumps(_wire({'model': 'm', 'messages': [{'role': 'user', 'content': PROVIDER_KEY}]}))
        assert wire.count(PROVIDER_KEY) == 0, wire
        assert '[secret:' in wire


class TestARotatedKeyIsNotStale:
    def test_saving_the_store_rebuilds_the_value_set(self, configured):
        """A key edited in Settings must stop being shipped, and the new one too.

        Goes through `saveProvidersStore`, because that is the door that fires the
        invalidation — a test that cleared the cache by hand would pass with the
        wiring missing.
        """
        assert PROVIDER_KEY not in json.dumps(_wire({'model': 'm', 'messages': [{'content': PROVIDER_KEY}]}))

        rotated = 'sk-proj-uuuuuuuuuuuuuuuuuuuu9999'
        config_service.saveProvidersStore(
            {'providers': [{'id': 'openai', 'name': 'openai-test', 'apiKey': rotated}]}
        )
        wire = json.dumps(
            _wire({'model': 'm', 'messages': [{'role': 'user', 'content': f'old {PROVIDER_KEY} new {rotated}'}]})
        )
        assert rotated not in wire, 'the rotated key was not picked up'
        assert PROVIDER_KEY in wire, 'the retired key is still being rewritten'


class TestPersistedErrorSamples:
    """The outbound door protects what is SENT; this is the door that protects what
    is STORED. A provider's auth rejection routinely echoes part of the credential
    back, and `turn_outcomes` persisted that string verbatim before this — then the
    lesson promotion, the telemetry surfaces and `harness_eval` all read it back."""

    _LIVE = 'sk-live-AAAAAAAAAAAAAAAAAAAA'
    _PASTED = 'sk-live-BBBBBBBBBBBBBBBBBBBB'   # not this install's value

    def _install_holds(self, monkeypatch):
        from app.config import settings

        monkeypatch.setattr(settings, 'gatewayApiKey', self._LIVE, raising=False)
        return settings

    def test_a_credential_this_install_holds_is_not_stored(self, isolatedData, monkeypatch):
        from app.services.turn_outcomes import _redactedSampleError

        self._install_holds(monkeypatch)
        msg = f'Stream error HTTP 401: invalid api key {self._LIVE} provided'
        out = _redactedSampleError(msg)
        assert self._LIVE not in out, f'the key survived into the persisted sample: {out!r}'
        assert '401' in out and 'invalid api key' in out, f'lost the diagnosis: {out!r}'

    def test_key_shaped_text_the_user_pasted_survives(self, isolatedData, monkeypatch):
        """The control that keeps this from becoming a pattern scrub: a key-shaped
        string this install does not hold is CONTENT. The user pastes their own key
        to ask why it 401s, and rewriting that would break the thing they asked."""
        from app.services.turn_outcomes import _redactedSampleError

        self._install_holds(monkeypatch)
        msg = f'why does this fail? provider said: bad key {self._PASTED}'
        assert self._PASTED in _redactedSampleError(msg)

    def test_the_funnel_applies_it_so_no_caller_can_skip(self, isolatedData, monkeypatch):
        """`_candidate_classes` is the one place both writers pass through, so the
        redaction cannot be forgotten at a new call site."""
        from app.services import turn_outcomes as t

        self._install_holds(monkeypatch)
        seen: list[str] = []

        def fake_scrub(value):
            seen.append(value if isinstance(value, str) else '')
            return str(value).replace(self._LIVE, '[redacted]')

        import app.services.hooks.secret_guard as sg

        monkeypatch.setattr(sg, 'scrubOutboundBody', fake_scrub)
        classes = t._candidate_classes('auth', f'401 {self._LIVE}', ())
        assert seen, 'the funnel never reached the scrub'
        assert all(self._LIVE not in c.sample for c in classes), [c.sample for c in classes]

    def test_a_mounterous_sample_is_capped(self, isolatedData):
        from app.services.turn_outcomes import _SAMPLE_ERROR_CAP, _redactedSampleError

        out = _redactedSampleError('x' * (_SAMPLE_ERROR_CAP * 3))
        assert len(out) == _SAMPLE_ERROR_CAP
