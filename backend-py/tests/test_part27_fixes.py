"""Part 27 fix-wave regressions.

Locks in the Tier-1/2/3 fixes the parallel audit surfaced:
  * sandbox read-only / network bypasses (env/sudo prefix, no-space redirect)
  * credential-read hardline covering non-RSA keys + git/netrc stores
  * submit_clarify registered with a questions array-of-objects schema
  * episodic_timeline scope fencing (the boot-index privacy leak)
"""

from __future__ import annotations

import pytest
from app.services.sandbox.backends.fallback import _first_word, soft_preflight
from app.services.sandbox.hardline import _CREDENTIAL_READ_PATTERN
from app.services.sandbox.policy import SandboxPolicy

WS = r'C:\Users\rober\proj'


@pytest.fixture(scope='module', autouse=True)
def _ensure_tools_registered():
    from app.services import tool_definitions as toolDefsModule
    from app.services.tool_registry import listTools

    if not listTools():
        toolDefsModule.registerAll()


def _ro() -> SandboxPolicy:
    return SandboxPolicy(mode='read-only', workspace_root=WS)


def _ww_no_net() -> SandboxPolicy:
    return SandboxPolicy(mode='workspace-write', workspace_root=WS, network=False)


class TestSandboxBypasses:
    def test_invocation_wrapper_resolves_to_real_command(self):
        assert _first_word('env rm notes.txt') == 'rm'
        assert _first_word('sudo curl http://x') == 'curl'
        assert _first_word('command rm x') == 'rm'

    def test_read_only_blocks_wrapped_delete(self):
        assert soft_preflight('env rm notes.txt', _ro()) is not None
        assert soft_preflight('command rm x', _ro()) is not None

    def test_read_only_blocks_nospace_and_numbered_redirect(self):
        assert soft_preflight('echo x>/etc/passwd', _ro()) is not None
        assert soft_preflight('echo x>./f', _ro()) is not None
        assert soft_preflight('cmd 2>/tmp/err', _ro()) is not None

    def test_network_off_blocks_wrapped_and_chained(self):
        assert soft_preflight('sudo curl http://x', _ww_no_net()) is not None
        assert soft_preflight('true && wget http://x', _ww_no_net()) is not None

    def test_legit_in_workspace_write_still_allowed(self):
        # A workspace-write command writing inside the workspace is fine.
        assert soft_preflight('echo x > ok.txt', _ww_no_net()) is None


class TestCredentialHardline:
    def test_non_rsa_keys_and_stores_matched(self):
        for cmd in (
            'cat ~/.ssh/id_ecdsa',
            'cat ~/.ssh/id_dsa',
            'cat ~/.git-credentials',
            'cat ~/.netrc',
            'cat ~/.aws/config',
            'cat ~/.ssh/id_rsa',
        ):
            assert _CREDENTIAL_READ_PATTERN.search(cmd), cmd

    def test_ordinary_file_not_matched(self):
        assert not _CREDENTIAL_READ_PATTERN.search('cat src/app.py')


class TestClarifyTool:
    def test_submit_clarify_registered(self):
        from app.services import tool_registry

        names = {
            (t.get('name') or (t.get('function') or {}).get('name'))
            for t in tool_registry.listTools()
        }
        assert 'submit_clarify' in names

    def test_clarify_schema_requires_questions_array(self):
        from app.services import tool_registry

        tool = next(
            t
            for t in tool_registry.listTools()
            if (t.get('name') or (t.get('function') or {}).get('name')) == 'submit_clarify'
        )
        schema = tool.get('input_schema') or (tool.get('function') or {}).get('parameters') or {}
        assert 'questions' in (schema.get('properties') or {})
        assert 'questions' in (schema.get('required') or [])
        item = schema['properties']['questions']['items']
        assert 'question' in (item.get('properties') or {})

    def test_submit_clarify_bucketed_not_other(self):
        from app.services.tool_policy import prompt_bucket

        assert prompt_bucket('submit_clarify') != 'other'


class TestTimelineScope:
    def test_write_stamps_scope_and_index_filters(self, isolatedData):  # noqa: ARG002
        from app.services.memory_store import init as mem_init
        from app.services.memory_store.brain import brain_index_snippet
        from app.services.memory_store.rest import write_timeline_event

        mem_init()
        write_timeline_event('s-global', 'global secret ask', category='workbench', scope='global')
        write_timeline_event('s-bot', 'bot private ask', category='workbench', scope='bot:alpha')

        # A global session's boot index must NOT contain the bot-private line.
        global_block = brain_index_snippet(scope='global')
        assert 'global secret ask' in global_block
        assert 'bot private ask' not in global_block

        # The bot's own scope sees its private line.
        bot_block = brain_index_snippet(scope='bot:alpha')
        assert 'bot private ask' in bot_block
