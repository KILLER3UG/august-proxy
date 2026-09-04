"""Part 19 Phase E (2026-09-04, ruling OQ5) — per-Bot memory & skills.

Rides M-2's scope column. Three surfaces:
* the prompt guard line ("You are Bot @<handle> …") for bot-scoped sessions;
* the learned-skill WRITE root lands in the Bot's own folder (botRootFor);
* cross-Bot memory isolation (a bot's notes invisible to another bot).
"""

from __future__ import annotations

import pytest


@pytest.fixture()
def bots(isolatedData):
    from app.services.memory_store import init as init_store
    from app.services.tools import agent_registry

    init_store()
    a = agent_registry.createAgent(name='alpha', description='Alpha', role='')
    b = agent_registry.createAgent(name='beta', description='Beta', role='')
    return {'alpha': str(a['id']), 'beta': str(b['id'])}


def _canonical(agent_id: str):
    from app.services.bot_mode import roster

    return roster.ensure_canonical_bot_chat(agent_id)


@pytest.fixture(autouse=True)
def _resetSessionContext():
    """A leaked currentSessionId re-keys the remember budget / scope
    resolution in later test files (full-suite order dependency) — restore
    the default after every test here."""
    yield
    from app.services.workbench.context import currentSessionId

    currentSessionId.set('')


# ── prompt guard line ─────────────────────────────────────────────────────────


class TestGuardPromptLine:
    def test_bot_chat_prompt_names_the_bot(self, bots):
        from app.services.workbench import workbench as wb

        chat = _canonical(bots['alpha'])
        prompt = wb.buildSystemPrompt(chat)
        assert 'You are Bot @alpha' in prompt
        assert 'not visible to you' in prompt

    def test_regular_session_has_no_guard_line(self, bots):
        from app.services.workbench import workbench as wb

        sess = wb.createWorkbenchSession(provider='', agentId='build', guardMode='full')
        prompt = wb.buildSystemPrompt(sess)
        assert 'You are Bot @' not in prompt


# ── learned-skill write root ─────────────────────────────────────────────────


class TestBotSkillWriteRoot:
    def test_botRootFor_creates_and_paths(self, isolatedData, tmp_path, monkeypatch):
        from app.config import settings

        monkeypatch.setattr(settings, 'dataDir', tmp_path)
        from app.services import skill_service

        root = skill_service.botRootFor('alpha')
        assert root == tmp_path / 'bots' / 'alpha' / 'skills'
        assert root.is_dir()

    def test_createSkill_lands_in_bot_root(self, bots, tmp_path, monkeypatch):
        from app.config import settings

        monkeypatch.setattr(settings, 'dataDir', tmp_path)
        from app.services import skill_service
        from app.services.workbench.context import currentSessionId

        chat = _canonical(bots['alpha'])
        token = currentSessionId.set(chat.id)
        try:
            skill_service.createSkill(
                'alpha-only-skill',
                'A skill only alpha should have',
                'body text',
            )
        finally:
            currentSessionId.reset(token)
        # The scope encodes the agent ID (stable across renames), so the bot
        # root is bots/<agentId>/skills.
        bot_dir = tmp_path / 'bots' / bots['alpha'] / 'skills' / 'alpha-only-skill' / 'SKILL.md'
        assert bot_dir.exists(), 'a bot-scoped createSkill must write to the bot root'
        # And it is visible to alpha but not to beta.
        assert skill_service.get('alpha-only-skill', agent_id=bots['alpha']) is not None
        assert skill_service.get('alpha-only-skill', agent_id=bots['beta']) is None


# ── cross-bot memory isolation (end-to-end via the scope column) ──────────────


class TestCrossBotMemoryIsolation:
    def test_one_bot_cannot_recall_another(self, bots):
        from app.services import memory_store
        from app.services.memory_store import fact_retrieval

        memory_store.save_fact(
            'a:secret', {'fact': 'alpha keeps a private deploy token'}, title='AlphaToken',
            scope=f'bot:{bots["alpha"]}',
        )
        hits_a = fact_retrieval.retrieve_relevant_facts('private deploy token', k=5, scope=f'bot:{bots["alpha"]}')
        hits_b = fact_retrieval.retrieve_relevant_facts('private deploy token', k=5, scope=f'bot:{bots["beta"]}')
        assert any(h['key'] == 'a:secret' for h in hits_a)
        assert not any(h['key'] == 'a:secret' for h in hits_b)
