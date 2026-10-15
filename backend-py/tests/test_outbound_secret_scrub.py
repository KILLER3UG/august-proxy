"""Outbound credential scrub — DS Bot item 7 (`secrets.js`), tested on the wire.

The tool-boundary guard already denies a write that carries a secret and redacts
a read of a protected path. Neither covers how a credential actually leaves: it
rides into the transcript once — pasted by the user, quoted by a log line,
printed by a command whose path looked harmless — and is then re-sent to
whichever gateway is active on **every later turn**. DeepSeek-Bot closes that at
the request door, replacing the value with `[secret:<NAME>]` so the machine's own
credential inventory never travels in a prompt body.

The whole design risk here is a false positive: `dump_*_upstream_body` is the one
serialization path every chat request takes, and AGENTS.md marks it "a wrong key
breaks all chat". So the scrub matches VALUES this install holds, never
key-shaped text, and these tests assert on the serialized body rather than on the
helper — a unit test of the matcher would pass even if the door never called it.
"""

from __future__ import annotations

import json
import os

import pytest
from app.models.anthropic import dump_anthropic_upstream_body
from app.models.openai import dump_openai_upstream_body
from app.services import config_service
from app.services.hooks import secret_guard

PROVIDER_KEY = 'sk-proj-aaaaaaaaaaaaaaaaaaaa1111'
GATEWAY_KEY = 'gw-key-bbbbbbbbbbbbbbbbbbbb2222'
ENV_KEY = 'zz-cccccccccccccccccccc3333'


@pytest.fixture(autouse=True)
def _resetCache():
    secret_guard._invalidateOutbound()
    yield
    secret_guard._invalidateOutbound()


@pytest.fixture
def configured(isolatedData):
    """One provider key, the gateway key, and one env-backed token.

    Written through `saveProvidersStore` — the real door, which is also what
    fires the invalidation the scrub's cache depends on. Monkeypatching the
    reader would have tested the matcher and missed both wiring bugs this file
    exists to catch.
    """
    config_service.saveProvidersStore(
        {
            'providers': [
                {'id': 'openai', 'name': 'openai-test', 'apiKey': PROVIDER_KEY, 'enabled': True},
                # A credential too short to scrub by: substring-replacing three
                # characters would mangle ordinary prose.
                {'id': 'tiny', 'name': 'tiny', 'apiKey': 'abc', 'enabled': True},
            ]
        }
    )
    from app.config import settings

    settings.gatewayApiKey = GATEWAY_KEY
    os.environ['ACME_SERVICE_TOKEN'] = ENV_KEY
    secret_guard._invalidateOutbound()
    yield
    settings.gatewayApiKey = None
    os.environ.pop('ACME_SERVICE_TOKEN', None)
    secret_guard._invalidateOutbound()


def _bodyWith(text: str) -> dict[str, object]:
    return {
        'model': 'gpt-test',
        'messages': [{'role': 'user', 'content': text}],
    }


class TestTheDoorScrubbs:
    def test_a_provider_key_in_the_transcript_never_reaches_the_wire(self, configured):
        body = dump_openai_upstream_body(
            _bodyWith(f'here is the key: {PROVIDER_KEY} — why does it 401?')
        )
        wire = json.dumps(body)
        assert PROVIDER_KEY not in wire, 'the credential shipped verbatim'
        assert '[secret:OPENAI_TEST]' in wire, wire

    def test_the_anthropic_door_scrubs_the_system_and_the_messages(self, configured):
        body = dump_anthropic_upstream_body(
            {
                'model': 'claude-test',
                'system': f'contact {GATEWAY_KEY} for access',
                'messages': [{'role': 'user', 'content': f'and {ENV_KEY} too'}],
            }
        )
        wire = json.dumps(body)
        assert GATEWAY_KEY not in wire and ENV_KEY not in wire
        assert '[secret:GATEWAY]' in wire
        assert '[secret:ACME_SERVICE_TOKEN]' in wire

    def test_a_nested_tool_result_and_a_tool_definition_are_scrubbed(self, configured):
        body = dump_openai_upstream_body(
            {
                'model': 'gpt-test',
                'messages': [
                    {
                        'role': 'user',
                        'content': [
                            {'type': 'text', 'text': f'log said {PROVIDER_KEY}'},
                        ],
                    }
                ],
                'tools': [
                    {
                        'type': 'function',
                        'function': {'name': 'x', 'description': f'uses {PROVIDER_KEY}'},
                    }
                ],
            }
        )
        wire = json.dumps(body)
        assert PROVIDER_KEY not in wire, 'a nested leaf was skipped'
        assert wire.count('[secret:OPENAI_TEST]') == 2, wire

    def test_every_later_turn_repeats_it(self, configured):
        """The leak is not one request: the value is in the persisted history."""
        for _ in range(3):
            assert PROVIDER_KEY not in json.dumps(
                dump_openai_upstream_body(_bodyWith(f'again {PROVIDER_KEY}'))
            )


class TestWhatItMustNotDo:
    def test_key_shaped_text_the_user_pasted_survives(self, configured):
        """The control that keeps this safe to run on every request.

        A pattern scrub would rewrite this string and the model could no longer
        answer a question about the user's own key. Value matching is what makes
        the door survivable, so the test asserts the non-match.
        """
        text = 'try sk-proj-XXXXXXXXXXXXXXXXXXXXXXXX and sk-ant-foobar12345678901234567890'
        body = dump_openai_upstream_body(_bodyWith(text))
        assert text in json.dumps(body), 'key-SHAPED text was rewritten — this is pattern matching'

    def test_a_credential_shorter_than_the_floor_is_ignored(self, configured):
        body = dump_openai_upstream_body(_bodyWith('the abc thing works'))
        assert 'the abc thing works' in json.dumps(body)

    def test_an_install_with_no_credentials_is_byte_identical(self, isolatedData):
        """Nothing configured ⇒ the scrub must be inert."""
        config_service.saveProvidersStore({'providers': []})
        from app.config import settings

        settings.gatewayApiKey = None
        secret_guard._invalidateOutbound()
        original = _bodyWith('plain question, nothing secret')
        snapshot = json.dumps(original, sort_keys=True)
        assert json.dumps(dump_openai_upstream_body(original), sort_keys=True) == snapshot

    def test_structure_and_types_survive_the_walk(self, configured):
        body = dump_openai_upstream_body(
            {
                'model': 'gpt-test',
                'max_tokens': 64,
                'stream': True,
                'stop': ['a', 'b'],
                'metadata': {'nested': {'deep': [1, None, True]}},
                'messages': [{'role': 'user', 'content': f'x {PROVIDER_KEY}'}],
            }
        )
        assert body['max_tokens'] == 64
        assert body['stream'] is True
        assert body['stop'] == ['a', 'b']
        assert body['metadata'] == {'nested': {'deep': [1, None, True]}}
        assert list(body['messages'][0].keys()) == ['role', 'content']  # type: ignore[index]

    def test_the_marker_never_carries_the_value_or_an_ugly_label(self, configured):
        wire = json.dumps(dump_openai_upstream_body(_bodyWith(f'{PROVIDER_KEY} and {ENV_KEY}')))
        assert PROVIDER_KEY not in wire and ENV_KEY not in wire
        assert '[secret:OPENAI_TEST] and [secret:ACME_SERVICE_TOKEN]' in json.loads(wire)['messages'][0]['content']
        # The label is the provider's NAME, which the user chose; nothing about
        # the value leaks through the sanitizer.
        assert 'sk-proj' not in wire and 'zz-cccc' not in wire


class TestARotatedKeyIsNotStale:
    def test_saving_the_store_rebuilds_the_value_set(self, configured):
        """A key edited in Settings must stop being shipped, and the new one too.

        Cached forever, this would scrub a value nobody holds any more and let
        the CURRENT key through. Goes through `saveProvidersStore`, because that
        is the door that fires the invalidation — a test that cleared the cache
        by hand would pass with the wiring missing.
        """
        assert PROVIDER_KEY not in json.dumps(dump_openai_upstream_body(_bodyWith(PROVIDER_KEY)))

        rotated = 'sk-proj-uuuuuuuuuuuuuuuuuuuu9999'
        config_service.saveProvidersStore(
            {'providers': [{'id': 'openai', 'name': 'openai-test', 'apiKey': rotated}]}
        )
        body = json.dumps(dump_openai_upstream_body(_bodyWith(f'old {PROVIDER_KEY} new {rotated}')))
        assert rotated not in body, 'the rotated key was not picked up'
        assert PROVIDER_KEY in body, 'the retired key is still being rewritten'
