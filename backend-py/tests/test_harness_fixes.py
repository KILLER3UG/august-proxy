"""Regression tests for the audit & harness upgrade pass (Phases 1-5).

Covers: tool_use input accumulation, tool_result translation, stop→stop_sequences,
/v1/models key fix, user-role compaction summaries, SSE key stripping, sandbox
relative-path escape, exit-code surfacing, quota endpoint, responses streaming
rejection, stream rules, and the per-model capability profile.
"""

from __future__ import annotations

import json

import pytest
from app.adapters import anthropic as anthropic_adapter
from app.adapters import openai as openai_adapter
from app.adapters.stream_state import AnthropicNativeStreamState
from app.main import app
from app.services.memory.context_compressor import (
    _isSummaryMessage,
    buildSummaryMessage,
)
from app.services.sandbox.policy import SandboxResult
from fastapi.testclient import TestClient

# ── 1. Critical: tool_use input_json_delta accumulation ──────────────────


def test_anthropic_native_stream_state_accumulates_tool_input():
    st = AnthropicNativeStreamState()
    st.process_content_block_start(
        {'type': 'content_block_start', 'index': 0, 'content_block': {'type': 'tool_use', 'id': 'tu_1', 'name': 'read_file'}}
    )
    st.process_content_block_delta(
        {'type': 'content_block_delta', 'index': 0, 'delta': {'type': 'input_json_delta', 'partial_json': '{"path": "a'}}
    )
    st.process_content_block_delta(
        {'type': 'content_block_delta', 'index': 0, 'delta': {'type': 'input_json_delta', 'partial_json': '.py"}'}}
    )
    st.process_content_block_stop({'type': 'content_block_stop', 'index': 0})
    toolUses = st.get_tool_uses()
    assert len(toolUses) == 1
    # The empty-input bug: without accumulation this was {} and managed tools
    # executed with empty arguments.
    assert toolUses[0]['input'] == {'path': 'a.py'}


def test_anthropic_native_stream_state_malformed_input_kept_raw():
    st = AnthropicNativeStreamState()
    st.process_content_block_start(
        {'type': 'content_block_start', 'index': 0, 'content_block': {'type': 'tool_use', 'id': 'tu_1', 'name': 'run_command'}}
    )
    st.process_content_block_delta(
        {'type': 'content_block_delta', 'index': 0, 'delta': {'type': 'input_json_delta', 'partial_json': '{"command": '}}
    )
    st.process_content_block_stop({'type': 'content_block_stop', 'index': 0})
    toolUses = st.get_tool_uses()
    # Unparseable JSON must not silently become {} — the loop self-heals on the
    # `_raw` marker instead of executing with empty args.
    assert toolUses[0]['input'].get('_raw') == '{"command": '


# ── 2. translateMessages preserves tool_result blocks ────────────────────


def test_translate_messages_preserves_tool_results():
    messages = [
        {'role': 'assistant', 'content': [{'type': 'tool_use', 'id': 'tu_1', 'name': 'read_file', 'input': {'path': 'a.py'}}]},
        {'role': 'user', 'content': [{'type': 'tool_result', 'tool_use_id': 'tu_1', 'content': 'file contents'}]},
    ]
    out = anthropic_adapter.translateMessages(messages)
    roles = [m.get('role') for m in out]
    assert 'tool' in roles
    toolMsg = next(m for m in out if m.get('role') == 'tool')
    assert toolMsg['tool_call_id'] == 'tu_1'
    assert toolMsg['content'] == 'file contents'


# ── 3. _openaiToAnthropicBody stop → stop_sequences ──────────────────────


def test_openai_to_anthropic_body_maps_stop_to_stop_sequences():
    body = openai_adapter._openaiToAnthropicBody(
        {
            'model': 'claude-x',
            'messages': [{'role': 'user', 'content': 'hi'}],
            'stop': ['END'],
            'temperature': 0.2,
        }
    )
    assert 'stop_sequences' in body
    assert body['stop_sequences'] == ['END']
    assert 'stop' not in body


# ── 4. SSE writers strip internal keys ───────────────────────────────────


def test_sse_writers_strip_internal_event_type():
    from app.adapters.sse_format import write_sse_data_only, write_sse_event

    line = write_sse_data_only({'_event_type': 'chat.completion.chunk', 'choices': []})
    payload = json.loads(line[len('data: ') :].strip())
    assert '_event_type' not in payload

    event_line = write_sse_event('message_start', {'_event_type': 'x', 'type': 'message_start'})
    payload = json.loads(event_line.split('data: ', 1)[1].strip())
    assert '_event_type' not in payload


# ── 5. Sandbox: relative-path escape + always-on exit code ───────────────


def test_path_looks_outside_workspace_catches_relative_escape(tmp_path):
    from app.services.sandbox.paths import path_looks_outside_workspace

    ws = str(tmp_path)
    assert path_looks_outside_workspace('../../etc/passwd', ws) is True
    assert path_looks_outside_workspace('..\\..\\evil.txt', ws) is True
    assert path_looks_outside_workspace('cat', ws) is False
    assert path_looks_outside_workspace('src/main.py', ws) is False


def test_sandbox_result_always_surfaces_exit_code():
    r = SandboxResult(ok=True, stdout='all good', exit_code=0)
    text = r.as_tool_text()
    assert 'Exit code: 0' in text
    r2 = SandboxResult(ok=False, stdout='boom', exit_code=1)
    assert 'Exit code: 1' in r2.as_tool_text()


# ── 6. Compaction summaries are user-role (Anthropic-safe) ───────────────


def test_compaction_summary_message_is_user_role():
    msg = buildSummaryMessage([{'role': 'user', 'content': 'x'}], 'the summary')
    assert msg['role'] == 'user'
    assert _isSummaryMessage(msg) is True
    # A user message merely starting with the marker is NOT a summary.
    assert _isSummaryMessage({'role': 'user', 'content': '<<compressed_summary'}) is False
    # Legacy system-role summaries stay detectable.
    legacy = dict(msg, role='system')
    assert _isSummaryMessage(legacy) is True


# ── 7. /v1/models reads modelProfiles (camelCase) ────────────────────────


def test_models_endpoint_served_shape(isolatedData):
    """The SERVED /v1/models returns the OpenAI-compatible list shape.

    /v1/models is part of the gated external surface (audit finding: it used
    to shadow the auth-gated proxy route), so the shape is asserted with a
    valid gateway key.
    """
    import json as _json
    from pathlib import Path

    from app.config import settings

    Path(isolatedData, 'config.json').write_text(
        _json.dumps({'gateway': {'externalAccess': {'enabled': True}}}),
        encoding='utf-8',
    )
    settings.reload()
    settings.gatewayApiKey = 'top-secret'
    client = TestClient(app)
    r = client.get('/v1/models', headers={'Authorization': 'Bearer top-secret'})
    assert r.status_code == 200
    body = r.json()
    assert body.get('object') == 'list'
    assert isinstance(body.get('data'), list)


# ── 8. /api/providers/quota endpoint ─────────────────────────────────────


def test_quota_endpoint_contract(isolatedData):
    client = TestClient(app)
    r = client.get('/api/providers/quota')
    assert r.status_code == 200
    body = r.json()
    assert 'results' in body
    r2 = client.get('/api/providers/quota?provider=DoesNotExist&model=xyz')
    assert r2.status_code == 200
    assert r2.json()['model'] == 'xyz'
    assert r2.json()['used'] == 0
    assert r2.json()['limit'] is None


# ── 9. /v1/responses streaming ───────────────────────────────────────────


def test_responses_event_line_format():
    from app.adapters.openai import _responsesEventLine

    line = _responsesEventLine(
        {'_event_type': 'response.output_text.delta', 'type': 'response.output_text.delta', 'delta': 'Hi'}
    )
    assert line.startswith('event: response.output_text.delta\n')
    assert '"_event_type"' not in line
    assert '"delta": "Hi"' in line

    plain = _responsesEventLine({'type': 'response.completed', 'response': {'id': 'r_1'}})
    assert plain.startswith('event: response.completed\n')


def test_responses_endpoint_no_longer_rejects_streaming(isolatedData):
    """stream:true is now wired (upstream-native pass-through). The request
    proceeds past the old 400; with no reachable provider it fails upstream
    instead of returning the 'not supported' rejection."""
    client = TestClient(app)
    r = client.post('/v1/responses', json={'model': 'x', 'input': 'hi', 'stream': True})
    assert r.status_code != 400
    body = r.json()
    assert 'not supported' not in str(body).lower()


# ── 10. Stream rules ─────────────────────────────────────────────────────


def test_stream_rule_matcher():
    from app.services.workbench.providers import _match_stream_rule

    assert _match_stream_rule('I will now read the file') is None
    assert _match_stream_rule("I'll use the read_file tool to check it") == 'narrated_tool_call'
    # Shape-anchored (A8): a fenced JSON with only a name is a config payload,
    # not a tool call — only name + arguments/input matches.
    assert _match_stream_rule('```json\n{"name": "read_file"}') is None
    assert (
        _match_stream_rule('```json\n{"name": "read_file", "arguments": {"path": "x"}}')
        == 'code_fence_tool_call'
    )
    assert (
        _match_stream_rule('```json\n{"tool": "web_search", "input": {"query": "q"}}')
        == 'code_fence_tool_call'
    )
    assert _match_stream_rule('plain answer without tools') is None


# ── 11. Per-model capability profile ─────────────────────────────────────


def test_model_capability_profile_bare_surface(isolatedData):
    import json as _json

    from app.lib.paths import dataPath
    from app.services.workbench import workbench as wb

    store = {
        'providers': [
            {
                'id': 'zen',
                'name': 'Zen',
                'apiFormat': 'openaiChat',
                'apiKey': 'k',
                'baseUrl': 'https://example.com/v1',
                'enabled': True,
                'models': [
                    {
                        'id': 'weak-model',
                        'name': 'Weak',
                        'toolSurface': 'bare',
                        'maxTools': 0,
                    }
                ],
            }
        ]
    }
    dataPath('providers.json').write_text(_json.dumps(store), 'utf-8')

    session = wb.WorkbenchSession(id='sess_1', model='weak-model', provider='Zen', messages=[])
    synthetic = [
        {'name': 'run_command'},
        {'name': 'web_search'},
        {'name': 'read_file'},
        {'name': 'edit_lines'},
    ]
    filtered = wb._applyModelCapabilityProfile(session, synthetic)
    names = {wb._toolDefName(t) for t in filtered}
    assert names == {'run_command', 'read_file', 'edit_lines'}
    assert 'web_search' not in names


def test_bare_tool_allowlist_matches_registry(isolatedData):
    """Every _BARE_TOOL_ALLOW name must be a registered tool.

    Regression guard: the allowlist once referenced legacy names
    (edit_file / list_files / read_multiple_files / get_session_info) that
    the registry never registered, so bare-surface models silently lost
    file listing and editing.
    """
    from app.services.tool_definitions import registerAll
    from app.services.tool_registry import listTools
    from app.services.workbench import workbench as wb

    registerAll()
    # The registry stores OpenAI-format defs — the name lives at
    # t['function']['name'], not the top level.
    registered = {str(t['function']['name']) for t in listTools()}
    dead = wb._BARE_TOOL_ALLOW - registered
    assert not dead, f'_BARE_TOOL_ALLOW references unregistered tools: {sorted(dead)}'


def test_model_capability_profile_max_tools(isolatedData):
    import json as _json

    from app.lib.paths import dataPath
    from app.services.workbench import workbench as wb

    store = {
        'providers': [
            {
                'id': 'zen',
                'name': 'Zen',
                'apiFormat': 'openaiChat',
                'apiKey': 'k',
                'baseUrl': 'https://example.com/v1',
                'enabled': True,
                'models': [{'id': 'small-tools', 'name': 'Small', 'maxTools': 2}],
            }
        ]
    }
    dataPath('providers.json').write_text(_json.dumps(store), 'utf-8')

    session = wb.WorkbenchSession(id='sess_1', model='small-tools', provider='Zen', messages=[])
    synthetic = [{'name': f'tool_{i}'} for i in range(10)]
    filtered = wb._applyModelCapabilityProfile(session, synthetic)
    assert len(filtered) == 2


# ── 12. Routing evidence records failures, not hardcoded wins ────────────


def test_routing_evidence_ok_uses_real_outcome(isolatedData):
    from app.services.routing_evidence import get_suggestions, record_turn

    record_turn(session_id='s1', task_type='bugfix', model='m-a', provider='p', ok=False)
    record_turn(session_id='s2', task_type='bugfix', model='m-a', provider='p', ok=True)
    suggestions = get_suggestions('bugfix', min_samples=2)
    assert suggestions
    assert suggestions[0]['winRate'] == 0.5


# ── 13. Verifier gate: only the DECLARED verification command counts ─────


def test_verifier_verdict_requires_declared_command():
    from app.services.tool_registrations.system_tools import _verificationVerdict

    echoReceipt = {'name': 'run_command', 'command': 'echo ok', 'content': 'Exit code: 0\nok'}
    testReceipt = {
        'name': 'run_command',
        'command': 'pytest -q',
        'content': 'Exit code: 0\n5 passed',
    }
    # Without a declared command, any passing receipt satisfies the gate.
    verdict, _ = _verificationVerdict([echoReceipt])
    assert verdict == 'pass'
    # With a declared command, `echo ok` must NOT satisfy it.
    verdict, _ = _verificationVerdict([echoReceipt], expected_command='pytest -q')
    assert verdict == 'none'
    # The declared command's own receipt passes.
    verdict, _ = _verificationVerdict([echoReceipt, testReceipt], expected_command='pytest -q')
    assert verdict == 'pass'


def test_version_sync():
    """The 7 version files must agree (package.json, locks, Cargo)."""
    import json
    import re
    from pathlib import Path

    root = Path(__file__).resolve().parent.parent.parent
    versions = [
        json.loads((root / 'package.json').read_text('utf-8'))['version'],
        json.loads((root / 'frontend/desktop/package.json').read_text('utf-8'))['version'],
        json.loads((root / 'frontend/desktop/src-tauri/tauri.conf.json').read_text('utf-8'))['version'],
        re.search(r'^version\s*=\s*"([^"]+)"', (root / 'frontend/desktop/src-tauri/Cargo.toml').read_text('utf-8'), re.M).group(1),
        re.search(
            r'^name = "august-desktop"[\s\S]*?^version = "([^"]+)"',
            (root / 'frontend/desktop/src-tauri/Cargo.lock').read_text('utf-8'),
            re.M,
        ).group(1),
        json.loads((root / 'package-lock.json').read_text('utf-8'))['version'],
        json.loads((root / 'package-lock.json').read_text('utf-8'))['packages']['frontend/desktop']['version'],
    ]
    assert len(set(versions)) == 1, f'version mismatch: {versions}'
