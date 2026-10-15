"""Who may author an agent's capability definition.

Derived from the DeepSeek-Bot dive: in that design the HOST declares each role's
authority and a worker cannot edit it. August had the same intent — `subagent.py`
withheld `create_agent` from children because it "would let a child redefine its
own permissions" — but the rule stopped at the tool SURFACE, and two of the three
doors (`update_agent`, `delete_agent`) were not even in that set. Measured before
the fix, a turn with `permissions=['read_file']` could write itself `['all']`,
rewrite an unrelated agent's permissions and model routing, and delete both that
stranger and its own root — with no session at all, and in guardMode 'full',
which is what every Bot DM and room session gets.
"""

from __future__ import annotations

import asyncio
import json

import pytest
from app.json_narrowing import as_dict
from app.services import self_config_tools
from app.services.tools import agent_registry
from app.services.workbench import context as wb_context
from app.services.workbench import sessions as sessions_mod
from app.services.workbench.sessions import create_workbench_session


def _run(coro: object) -> dict[str, object]:
    return json.loads(asyncio.run(coro))  # type: ignore[arg-type]


def _in_session(agent_id: str) -> str:
    """Bind a chat to `agent_id` and make it the executing session. Returns the reset token."""
    sess = create_workbench_session()
    sess.agentId = agent_id
    sessions_mod._sessions[sess.id] = sess
    return wb_context.currentSessionId.set(sess.id)


class TestCapabilityDefinitionIsNotModelWritable:
    def test_self_widen_is_refused_and_the_record_is_unchanged(self, isolatedData):
        scoped = agent_registry.createAgent(name='Scoped', permissions=['read_file'], actor='test')
        token = _in_session(scoped['id'])
        try:
            out = _run(self_config_tools.updateAgent(scoped['id'], permissions=['all']))
            assert out['status'] == 'error', out
            # The read-back is the proof, not the message: the stored record
            # must still hold exactly what the human door gave it.
            assert agent_registry.getAgent(scoped['id'])['permissions'] == ['read_file']
        finally:
            wb_context.currentSessionId.reset(token)

    def test_every_authority_field_is_named_on_refusal(self, isolatedData):
        a = agent_registry.createAgent(name='Peer', permissions=['web_search'], actor='test')
        out = _run(
            self_config_tools.updateAgent(a['id'], permissions=['all'], tools=['run_command'], model_alias='big')
        )
        assert out['status'] == 'error'
        text = str(out['error'])
        for label in ('permissions', 'tools', 'model routing'):
            assert label in text, text

    def test_descriptive_fields_stay_writable(self, isolatedData):
        """Control: the gate names capability fields, it is not a blanket block."""
        a = agent_registry.createAgent(name='Worker', role='Researcher', actor='test')
        out = _run(self_config_tools.updateAgent(a['id'], name='Renamed', role='Digger', description='d'))
        assert out['status'] == 'success', out
        stored = agent_registry.getAgent(a['id'])
        assert stored['name'] == 'Renamed' and stored['role'] == 'Digger' and stored['description'] == 'd'

    def test_the_human_door_still_authors_authority(self, isolatedData):
        """Control: this is a model-door rule, not a registry rule."""
        a = agent_registry.createAgent(name='Someday', actor='test')
        agent_registry.updateAgent(a['id'], {'permissions': ['run_command']}, actor='ui')
        assert agent_registry.getAgent(a['id'])['permissions'] == ['run_command']

    def test_creating_an_agent_with_a_capability_list_is_refused(self, isolatedData):
        out = _run(self_config_tools.createAgent(name='Escalator', permissions=['all'], tools=['run_command']))
        assert out['status'] == 'error', out
        assert not [a for a in agent_registry.listAgents() if a['name'] == 'Escalator']

    def test_no_session_does_not_mean_unrestricted(self, isolatedData):
        """The ContextVar default is a plain chat, not a free pass."""
        token = wb_context.currentSessionId.set('')
        try:
            a = agent_registry.createAgent(name='Fresh', permissions=['read_file'], actor='test')
            out = _run(self_config_tools.updateAgent(a['id'], permissions=['all']))
            assert out['status'] == 'error'
            assert agent_registry.getAgent(a['id'])['permissions'] == ['read_file']
        finally:
            wb_context.currentSessionId.reset(token)

    def test_the_tools_no_longer_advertise_a_knob_that_cannot_work(self, isolatedData):
        """A schema field the handler always refuses would be a UI lie."""
        from app.services import self_config_tools as sct
        from app.services import tool_registry

        sct.register()
        for name in ('create_agent', 'update_agent'):
            entry = tool_registry.get(name)
            assert entry is not None, name
            props = as_dict(as_dict(entry.get('parameters')).get('properties'))
            for gone in ('permissions', 'tools', 'modelAlias'):
                assert gone not in props, f'{name} still advertises {gone}'


class TestDeleteRefusesWhatOrphans:
    def test_an_agent_cannot_delete_itself(self, isolatedData):
        caller = agent_registry.createAgent(name='Me', actor='test')
        token = _in_session(caller['id'])
        try:
            out = _run(self_config_tools.deleteAgent(caller['id']))
            assert out['status'] == 'error'
            assert agent_registry.getAgent(caller['id']) is not None
        finally:
            wb_context.currentSessionId.reset(token)

    def test_deleting_an_ancestor_is_refused(self, isolatedData):
        root = agent_registry.createAgent(name='Root', actor='test')
        kid = agent_registry.createAgent(name='Kid', parentId=root['id'], actor='test')
        token = _in_session(kid['id'])
        try:
            out = _run(self_config_tools.deleteAgent(root['id']))
            assert out['status'] == 'error', out
            assert agent_registry.getAgent(root['id']) is not None
        finally:
            wb_context.currentSessionId.reset(token)

    def test_deleting_a_branch_with_children_is_refused(self, isolatedData):
        parent = agent_registry.createAgent(name='Parent', actor='test')
        agent_registry.createAgent(name='Child', parentId=parent['id'], actor='test')
        out = _run(self_config_tools.deleteAgent(parent['id']))
        assert out['status'] == 'error', out
        assert agent_registry.getAgent(parent['id']) is not None

    def test_a_leaf_still_deletes_through_the_roster(self, isolatedData):
        """Control: the guard refuses the orphaning cases, not every delete —
        and it goes through roster.delete_bot so the Bot's private footprint
        (bot:<id> facts, DM rows, rooms, canonical chat) cascades with it."""
        from app.services.bot_mode import roster

        leaf = agent_registry.createAgent(name='Teammate', actor='test')
        bot = roster.get_bot(leaf['id'])
        assert bot is not None
        out = _run(self_config_tools.deleteAgent(leaf['id']))
        assert out['status'] == 'success', out
        assert agent_registry.getAgent(leaf['id']) is None

    def test_the_default_assistant_bot_is_undeletable_from_the_model_door(self, isolatedData):
        """The UI route was fixed to route through roster for exactly this;
        the tool was the legacy path that still bypassed it."""
        from app.services.bot_mode import roster

        default = roster.ensure_default_bot()
        out = _run(self_config_tools.deleteAgent(default['id']))
        assert out['status'] == 'error', out
        assert agent_registry.getAgent(default['id']) is not None


class TestAbsentDefinitionMeansInherit:
    NAMES = ['read_file', 'write_file', 'run_command', 'web_search', 'update_state']

    def _survivors(self, agent: dict[str, object]) -> list[str]:
        from app.services.workbench.subagent import _toolAllowed

        return [n for n in self.NAMES if _toolAllowed(agent, n)]

    def test_a_registered_bot_with_no_definition_reaches_the_tools(self, isolatedData):
        """Every Bot the roster creates has `permissions: []` — measured on the
        real store. Reading that as "allowed nothing" gave a delegated worker an
        empty surface, so delegating to a named teammate did nothing at all."""
        bare = agent_registry.createAgent(name='Bare', actor='test')
        assert bare['permissions'] == []
        assert self._survivors(bare) == self.NAMES
        assert agent_registry.evaluateAgentTool(bare['id'], 'read_file')['allowed'] is True

    def test_a_declared_set_still_scopes(self, isolatedData):
        """Control: inheriting is only for the ABSENT case, so this is not a
        blanket allow — a declared list still denies everything outside it."""
        scoped = agent_registry.createAgent(name='Scoped', permissions=['read_'], actor='test')
        assert self._survivors(scoped) == ['read_file']
        denied = agent_registry.evaluateAgentTool(scoped['id'], 'run_command')
        assert denied['allowed'] is False

    def test_explicit_all_still_means_all(self, isolatedData):
        alls = agent_registry.createAgent(name='All', permissions=['all'], actor='test')
        assert self._survivors(alls) == self.NAMES

    def test_a_declared_child_still_narrows_under_a_declared_parent(self, isolatedData):
        """The two halves compose into the security property.

        `evaluateAgentTool` falls back to the parent, so a child's OWN surface
        question can answer yes from the parent's list — the spawn-time ceiling
        is what intersects them. Together they leave only what BOTH allow.
        """
        from app.services.workbench.subagent import _lineageCeiling

        parent = agent_registry.createAgent(name='P', permissions=['read_file', 'web_search'], actor='test')
        child = agent_registry.createAgent(
            name='C', parentId=parent['id'], permissions=['read_file', 'write_file'], actor='test'
        )
        assert agent_registry.deriveChildPermissions(parent['id'], child['id']) == ['read_file']
        sess = create_workbench_session()
        sess.agentId = parent['id']
        sessions_mod._sessions[sess.id] = sess
        ceiling = _lineageCeiling(sess, child, child['id'])
        assert ceiling == {'read_file'}
        assert [n for n in self._survivors(child) if ceiling is None or n in ceiling] == ['read_file']

    def test_an_all_child_under_a_scoped_parent_is_still_bounded(self, isolatedData):
        """`"all"` in the CHILD must not launder the parent's restriction away."""
        from app.services.workbench.subagent import _lineageCeiling

        parent = agent_registry.createAgent(name='P', permissions=['read_file'], actor='test')
        child = agent_registry.createAgent(name='C', parentId=parent['id'], permissions=['all'], actor='test')
        sess = create_workbench_session()
        sess.agentId = parent['id']
        sessions_mod._sessions[sess.id] = sess
        assert _lineageCeiling(sess, child, child['id']) == {'read_file'}


class TestLineageCeilingIsApplied:
    def test_it_reads_the_field_the_session_actually_has(self, isolatedData):
        """`session.agent_id` is not a member of WorkbenchSession (the field is
        `agentId`), so the guard around the old call could never be true and
        `deriveChildPermissions` was computed, discarded, and never ran."""
        parent = agent_registry.createAgent(name='P', permissions=['read_file'], actor='test')
        child = agent_registry.createAgent(name='C', parentId=parent['id'], permissions=['all'], actor='test')
        sess = create_workbench_session()
        sess.agentId = parent['id']
        sessions_mod._sessions[sess.id] = sess

        from app.services.workbench.subagent import _lineageCeiling

        assert _lineageCeiling(sess, child, child['id']) == {'read_file'}

        # Red proof for the name bug: a session carrying `agent_id` (the spelling
        # the old guard read) produces no ceiling at all.
        class _OldShape:
            agent_id = parent['id']

        assert _lineageCeiling(_OldShape(), child, child['id']) is None

    def test_no_ceiling_when_nothing_in_the_line_declares_one(self, isolatedData):
        parent = agent_registry.createAgent(name='P', actor='test')
        child = agent_registry.createAgent(name='C', parentId=parent['id'], actor='test')
        sess = create_workbench_session()
        sess.agentId = parent['id']
        sessions_mod._sessions[sess.id] = sess

        from app.services.workbench.subagent import _lineageCeiling

        assert _lineageCeiling(sess, child, child['id']) is None

    def test_a_turn_with_no_agent_bound_gets_no_ceiling(self, isolatedData):
        """A plain chat is not a position in the hierarchy — and not a wildcard
        either: the ceiling stays None and the parent's own surface still bounds."""
        child = agent_registry.createAgent(name='C', permissions=['read_file'], actor='test')
        from app.services.workbench.subagent import _lineageCeiling

        assert _lineageCeiling(create_workbench_session(), child, child['id']) is None

    def test_a_synthetic_general_worker_is_not_gated_by_a_real_lineage(self, isolatedData):
        parent = agent_registry.createAgent(name='P', permissions=['read_file'], actor='test')
        sess = create_workbench_session()
        sess.agentId = parent['id']
        sessions_mod._sessions[sess.id] = sess
        synth = {'id': 'general', 'permissions': ['all'], '_synthetic': True}
        from app.services.workbench.subagent import _lineageCeiling

        assert _lineageCeiling(sess, synth, 'general') is None


class TestAuthorityIsEnforcedNotMerelyWithheld:
    """A name removed from the surface was never refused at execution: `tool_call`
    takes an arbitrary name and only consulted `_blocked_tools`, so a read-only
    worker could write a file by naming it."""

    @pytest.fixture(autouse=True)
    def _registry(self, isolatedData):
        # The deny set is expressed over the registry's universe, so it has to be
        # populated — an empty registry would make every assertion vacuously pass.
        from app.services.tool_registrations import register_all

        register_all()

    def test_a_read_only_tier_denies_every_write(self, isolatedData):
        from app.services.workbench.subagent import _workerDeniedNames

        agent = agent_registry.createAgent(name='W', actor='test')
        denied = _workerDeniedNames(agent, create_workbench_session(), {'read_file'}, set(), None)
        assert 'write_file' in denied
        assert 'run_command' in denied
        assert 'read_file' not in denied

    def test_a_worker_that_inherits_denies_nothing_extra(self, isolatedData):
        """The control that keeps this from being a footgun: an agent with no
        declared permission list must NOT have the whole universe denied. This is
        why the set is built from the exclusions and `_toolAllowed` is consulted
        only when a list was actually declared."""
        from app.services.workbench.subagent import _SUBAGENT_NEVER_TOOLS, _workerDeniedNames

        agent = agent_registry.createAgent(name='W', actor='test')
        denied = _workerDeniedNames(agent, create_workbench_session(), None, set(), None)
        assert denied == frozenset(_SUBAGENT_NEVER_TOOLS)

    def test_a_declared_list_denies_outside_it(self, isolatedData):
        from app.services.workbench.subagent import _workerDeniedNames

        agent = agent_registry.createAgent(name='W', permissions=['read_file'], actor='test')
        denied = _workerDeniedNames(agent, create_workbench_session(), None, set(), None)
        assert 'write_file' in denied and 'read_file' not in denied

    def test_the_bridge_refuses_a_denied_tool_named_directly(self, isolatedData):
        from app.services.tools.tool_bridges import handleToolCall
        from app.services.workbench.context import currentSubagentDenied, currentSubagentDepth

        depth = currentSubagentDepth.set(1)
        denied = currentSubagentDenied.set(frozenset({'write_file'}))
        try:
            out = asyncio.run(handleToolCall('write_file', json.dumps({'path': 'x.txt', 'content': 'hi'})))
            assert 'not permitted' in str(out), out
        finally:
            currentSubagentDepth.reset(depth)
            currentSubagentDenied.reset(denied)

    def test_the_bridge_still_refuses_the_never_tools(self, isolatedData):
        """Control: the pre-existing refusal still holds, and the new one is
        additive rather than a replacement."""
        from app.services.tools.tool_bridges import handleToolCall
        from app.services.workbench.context import currentSubagentDenied, currentSubagentDepth

        depth = currentSubagentDepth.set(1)
        denied = currentSubagentDenied.set(frozenset({'remember'}))
        try:
            out = asyncio.run(handleToolCall('remember', json.dumps({'key': 'k', 'value': 'v'})))
            assert 'Blocked' in str(out), out
        finally:
            currentSubagentDepth.reset(depth)
            currentSubagentDenied.reset(denied)

    def test_a_root_turn_is_not_restricted_by_a_worker_denial(self, isolatedData):
        """Default ContextVar value = not inside a worker: the bridge must not
        start refusing the parent turn's own tools."""
        from app.services.tools.tool_bridges import handleToolCall

        out = asyncio.run(handleToolCall('list_agents', '{}'))
        assert 'not permitted' not in str(out), out

    def test_the_whole_agent_surface_is_closed_to_children(self, isolatedData):
        from app.services.workbench.subagent import _SUBAGENT_NEVER_TOOLS

        for name in ('create_agent', 'update_agent', 'delete_agent', 'set_agent_mode'):
            assert name in _SUBAGENT_NEVER_TOOLS, name
