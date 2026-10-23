"""A scripted provider: drive the real loop with no network and no API credit.

The bench otherwise needs a live model to exercise the loop, which makes the
behaviour that most deserves checking — what the loop sends after a tool round,
how it reacts to a truncated answer, whether a repair reaches the wire — the
behaviour that is hardest to look at. This replaces only the transport: the
client is a queue of canned rounds, and every request body the loop built is
recorded, so an assertion is about what would have gone to the provider.

Contract it implements is the two methods `call_openai_workbench` actually uses
(`resolveApiKey`, `chat_completions_stream`) and yields OpenAI chunk-shaped
dicts, because that is what the real client yields. Anything richer (usage,
reasoning, retries) is expressible by putting those keys in the chunk.

Script format (JSON), one entry per round:

    {"rounds": [
      {"content": "reading it now", "toolCalls": [{"name": "read_file",
        "arguments": {"path": "a.txt"}}]},
      {"content": "the file says hi"}
    ]}

or, for byte-exact control, {"chunks": [ ...raw chunk dicts... ]}.
"""

from __future__ import annotations

import copy
import json
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, AsyncIterator

from app.json_narrowing import as_dict, as_list, as_str


def text_round(text: str, finish: str = 'stop') -> list[dict[str, Any]]:
    """Chunks for an assistant turn that only answers."""
    return [
        {'choices': [{'index': 0, 'delta': {'role': 'assistant', 'content': text}}]},
        {'choices': [{'index': 0, 'delta': {}, 'finish_reason': finish}]},
    ]


def tool_round(calls: list[dict[str, Any]], text: str = '', finish: str = 'tool_calls') -> list[dict[str, Any]]:
    """Chunks for an assistant turn that issues tool calls.

    `calls` is `[{'name': ..., 'arguments': {...}}]`; ids are minted here, so a
    script that never mentions an id still produces a pairing the loop must
    honour — which is the part worth testing.
    """
    chunks: list[dict[str, Any]] = []
    if text:
        chunks.append({'choices': [{'index': 0, 'delta': {'role': 'assistant', 'content': text}}]})
    for i, call in enumerate(calls):
        cid = as_str(call.get('id')) or f'call_{uuid.uuid4().hex[:12]}'
        chunks.append({
            'choices': [{
                'index': 0,
                'delta': {
                    'tool_calls': [{
                        'index': i,
                        'id': cid,
                        'type': 'function',
                        'function': {
                            'name': as_str(call.get('name')),
                            'arguments': json.dumps(as_dict(call.get('arguments'), {})),
                        },
                    }]
                },
            }]
        })
    chunks.append({'choices': [{'index': 0, 'delta': {}, 'finish_reason': finish}]})
    return chunks


@dataclass
class ScriptedClient:
    """The provider the loop talks to when a script, not a network, answers."""

    rounds: list[list[dict[str, Any]]] = field(default_factory=list)
    #: Every request body the loop built, in order — the thing assertions read.
    requests: list[dict[str, Any]] = field(default_factory=list)
    model: str = 'scripted'
    _index: int = 0

    def resolveApiKey(self) -> str:  # noqa: N802 - the real client's spelling
        return 'scripted-key-not-a-secret'

    async def chat_completions_stream(
        self, body: dict[str, Any], apiKey: str | None = None
    ) -> AsyncIterator[dict[str, Any]]:
        self.requests.append(copy.deepcopy(body))
        if self._index >= len(self.rounds):
            # A script that runs out is a bug in the script, not a hang: say so
            # through the same error shape the loop already surfaces.
            self._index += 1
            yield {'type': 'error', 'error': {'message': 'scripted provider: script exhausted'}}
            return
        for chunk in self.rounds[self._index]:
            yield chunk
        self._index += 1

    @property
    def rounds_used(self) -> int:
        return min(self._index, len(self.rounds))


def load_script(path: str | Path) -> ScriptedClient:
    """Build a client from a JSON script file."""
    raw = json.loads(Path(path).read_text(encoding='utf-8'))
    if not isinstance(raw, dict):
        # A bare array used to raise AttributeError on `.get`, which the
        # runner's (OSError, ValueError) guard did not catch: a mistyped script
        # printed a traceback instead of the typed input error.
        raise ValueError('script root must be a JSON object with a "rounds" list')
    return build_client(as_list(raw.get('rounds'), []))


def build_client(rounds: list[Any]) -> ScriptedClient:
    """Build a client from round specs (see the module docstring)."""
    scripted: list[list[dict[str, Any]]] = []
    for entry in rounds:
        spec = as_dict(entry, {})
        chunks = spec.get('chunks')
        if isinstance(chunks, list) and chunks:
            scripted.append([as_dict(c, {}) for c in chunks])
            continue
        calls = [as_dict(c, {}) for c in as_list(spec.get('toolCalls'), [])]
        finish = as_str(spec.get('finishReason'))
        if calls:
            scripted.append(tool_round(calls, as_str(spec.get('content')), finish or 'tool_calls'))
        else:
            scripted.append(text_round(as_str(spec.get('content')), finish or 'stop'))
    return ScriptedClient(rounds=scripted)


SCRIPTED_PROVIDER_ID = 'scripted'
SCRIPTED_MODEL = 'scripted-model'


def arm_providers_store() -> None:
    """Put one synthetic provider in the store so a scripted run can start.

    The loop refuses to turn with no configured provider, and that gate is worth
    keeping — so the scripted run satisfies it with a fake entry rather than
    patching the gate. Everything after resolution (prompt assembly, tool
    dispatch, the round loop, the transcript) stays the real code path; only the
    transport is scripted.
    """
    from app.services import config_service

    store = config_service.getProvidersStore()
    providers = [
        as_dict(p, {}) for p in as_list(store.get('providers'), [])
        if as_str(as_dict(p, {}).get('id')) != SCRIPTED_PROVIDER_ID
    ]
    providers.append({
        'id': SCRIPTED_PROVIDER_ID,
        'name': 'Scripted (no network)',
        'baseUrl': 'http://127.0.0.1:9',
        'apiFormat': 'openaiChat',
        'apiKey': 'scripted-key-not-a-secret',
        'enabled': True,
        'defaultModel': SCRIPTED_MODEL,
        'models': [{'id': SCRIPTED_MODEL, 'name': SCRIPTED_MODEL, 'enabled': True}],
    })
    store['providers'] = providers
    store['defaultProvider'] = SCRIPTED_PROVIDER_ID
    config_service.saveProvidersStore(store)


def install(client: ScriptedClient) -> Any:
    """Route the workbench's provider lookups at `client`.

    The seam is the module attribute, because every caller imports it inside its
    own function (`from app.providers.clients import getClient`) and so resolves
    it at call time — patching here therefore reaches the real loop without the
    loop knowing it is being tested. Returns what to hand `uninstall`.
    """
    from app.providers import clients as clients_module

    previous = clients_module.getClient

    def _scripted_client(provider: object = None) -> ScriptedClient:
        return client

    clients_module.getClient = _scripted_client  # type: ignore[assignment]
    return previous


def uninstall(previous: Any) -> None:
    from app.providers import clients as clients_module

    clients_module.getClient = previous  # type: ignore[assignment]
