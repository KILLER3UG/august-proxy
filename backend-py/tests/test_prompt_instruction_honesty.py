"""Instruction honesty — the prompt must not name a tool the surface cannot call.

**Why this file exists.** A previous version of this test asserted against
``prompt_build.HARNESS_GUIDE``, a symbol that does not exist (the real one is
``_HARNESS_GUIDE_DIGEST`), so the assertion evaluated an empty string and passed
vacuously while the underlying defect was live. It was caught by a review that
flipped the assertion to ``False`` and saw it still pass. This version asserts
against the real rendered text, and the drift test at the bottom is what would
catch the next rename.

**The defect class.** The system prompt tells the model to call tools the
active capability surface has removed:

* ``_BARE_TOOL_ALLOW`` (``loop/surface.py``) is the surface a downgraded or
  weak model receives — deliberately only file tools, the shell, state/todo
  updates and the memory trio.
* ``_HARNESS_GUIDE_DIGEST`` (``prompt_build.py:120``) names ``load_skill``,
  ``module_context``, ``harness_propose`` and ``submit_plan``, and is appended
  UNGATED. On a bare surface those four are absent, so every mention is a
  dead instruction.
* ``<clarify_policy>`` is injected on the stated premise that
  ``submit_clarify`` is "loop-intercepted, not registered" — but
  ``system_tools.py:498`` registers it, and it is in neither the bare allowlist
  nor ``AUGUST_CORE_TOOLS``.

Both reference harnesses treat this as a bug rather than a style issue: hermes
adds a sentence only when the tool is actually in the session ("the sentence
would name a tool the model cannot call"), and deepseek denies a call to a
hidden tool *before* policy evaluation, with a ``reachableFrom`` hint, because
"the model reads a bare `unknown tool`` for a tool the prompt just declared and
concludes the deployment is broken".

The repo already fixed this class once, for memory CRUD — see the comment in
``_BARE_TOOL_ALLOW`` ("with only ``remember`` offered, that instruction is
unreachable"). The skills/harness instructions were never given the same
treatment.

**Scope note.** The digest half of this class was FIXED first — `prompt_build.harness_guide_for`
takes the offered surface and drops the tool-directed lines a surface cannot honour, which is what
`TestBareSurfaceInstructionHonesty` below pins. `CLARIFY_BLOCK` was the remaining ungated case and is
now gated on `submit_clarify` being offered; `TestRenderedPromptHonesty` pins that, the single
`<capabilities>` element, and the `questions` bound. Keep the premise guards even after the fixes:
they are what stops a future edit re-introducing the mismatch silently.
"""

from __future__ import annotations

import inspect

import pytest
from app.services import capabilities_prompt
from app.services.workbench import prompt_build
from app.services.workbench.loop.surface import _BARE_TOOL_ALLOW

# Tools the ungated digest names that the bare surface does not offer.
DIGEST_NAMED_TOOLS = ('load_skill', 'module_context', 'harness_propose', 'submit_plan')


def _digest() -> str:
    """The real harness digest. Asserts the symbol exists, so a rename fails
    here instead of silently emptying the assertion (the previous bug)."""
    text = getattr(prompt_build, '_HARNESS_GUIDE_DIGEST', None)
    assert isinstance(text, str) and text, (
        'prompt_build._HARNESS_GUIDE_DIGEST is missing or empty — the symbol was '
        'renamed or removed, and this test would otherwise pass vacuously'
    )
    return text


class TestBareSurfaceInstructionHonesty:
    def test_the_digest_names_exactly_the_tools_we_expect(self):
        """Guards the premise. If the tool-directed lines move or disappear,
        the assertions below become vacuous — so pin the tagging first."""
        tagged = [tool for tool, _line in prompt_build._HARNESS_GUIDE_TOOL_LINES]
        assert set(tagged) == set(DIGEST_NAMED_TOOLS), (
            f'the tagged lines are {tagged}, but this file checks {list(DIGEST_NAMED_TOOLS)}'
        )
        assert _digest(), 'the base digest is empty'

    @pytest.mark.parametrize('tool', DIGEST_NAMED_TOOLS)
    def test_every_tool_the_digest_mentions_is_absent_from_bare(self, tool: str):
        assert tool not in _BARE_TOOL_ALLOW, (
            f'{tool} is now in _BARE_TOOL_ALLOW; the instruction is actionable '
            'there and can be dropped from DIGEST_NAMED_TOOLS'
        )

    def test_a_bare_surface_hears_about_none_of_them(self):
        """The fix. `harness_guide_for` must not name a tool the bare surface
        lacks — that was the live defect."""
        guide = prompt_build.harness_guide_for(set(_BARE_TOOL_ALLOW))
        for tool in DIGEST_NAMED_TOOLS:
            assert tool not in guide, (
                f'the guide still names {tool!r} on a surface that does not offer it'
            )

    def test_a_full_surface_hears_about_all_of_them(self):
        """The other half: filtering must not silently drop real guidance."""
        full = {'load_skill', 'module_context', 'harness_propose', 'submit_plan'}
        guide = prompt_build.harness_guide_for(full)
        for tool in DIGEST_NAMED_TOOLS:
            assert tool in guide, f'{tool} is offered but the guide never mentions it'

    def test_the_loop_explanation_survives_on_every_surface(self):
        """The unconditional half must always be present — it is the part that
        teaches the model the loop contract the schemas omit."""
        for surface in (set(), set(_BARE_TOOL_ALLOW), {'load_skill'}):
            guide = prompt_build.harness_guide_for(surface)
            assert 'update_state' in guide
            assert 'Validation Error' in guide

    def test_no_surface_information_keeps_the_loop_explanation(self):
        """`None` means the caller has no surface. It gets the unconditional
        half — the same as an empty set — because guessing that a tool IS
        available is exactly the bug this gate exists to stop."""
        guide = prompt_build.harness_guide_for(None)
        assert guide == prompt_build.harness_guide_for(set())
        assert 'update_state' in guide
        assert 'Validation Error' in guide

    def test_capabilities_prompt_names_load_skill_and_bare_cannot(self):
        """The capability block says "call load_skill(name)"; the bare surface
        cannot honour it. Assert the real builder exists so this cannot pass
        vacuously (the earlier version of this file scanned a symbol that did
        not exist)."""
        builder = getattr(capabilities_prompt, 'build_capabilities_block', None)
        assert callable(builder), 'capabilities_prompt.build_capabilities_block is missing'
        assert 'load_skill' not in _BARE_TOOL_ALLOW


class TestClarifyBlockPremise:
    def test_submit_clarify_is_registered_despite_the_comment_saying_otherwise(self):
        """workbench.py's comment says `submit_clarify` is "not registered", so
        `<clarify_policy>` is injected unconditionally. It IS registered — the
        stated reason for the ungated block is stale."""
        from app.services import tool_definitions as tool_defs
        from app.services.tool_registry import listTools

        if not listTools():
            tool_defs.registerAll()
        names = {
            (t.get('name') or (t.get('function') or {}).get('name'))
            for t in listTools()
        }
        assert 'submit_clarify' in names, (
            'submit_clarify is registered, so the <clarify_policy> comment '
            '("loop-intercepted, not registered") is stale'
        )
        assert 'submit_clarify' not in _BARE_TOOL_ALLOW


class TestRenderedPromptHonesty:
    """The fixes, asserted against the RENDERED prompt rather than a comment."""

    @staticmethod
    def _prompt(tools: list[str]) -> str:
        from app.services.workbench import workbench as wb

        session = wb.createWorkbenchSession(provider='', agentId='build', guardMode='full')
        return wb.buildSystemPrompt(session, tools=[{'name': n} for n in tools])

    def test_clarify_policy_is_dropped_when_the_tool_is_not_offered(self):
        prompt = self._prompt(['read_file', 'run_command'])
        assert '<clarify_policy>' not in prompt
        assert 'submit_clarify' not in prompt, (
            'the prompt still instructs a tool this surface cannot call'
        )

    def test_clarify_policy_survives_when_the_tool_is_offered(self):
        """The other half: gating must not quietly delete a real capability's
        instructions — the pager contract lives in this block."""
        prompt = self._prompt(['submit_clarify', 'read_file'])
        assert '<clarify_policy>' in prompt
        assert '`questions` array' in prompt

    def test_the_capabilities_element_is_not_nested_in_itself(self):
        """`build_capabilities_block` returns the complete element; the caller
        wrapped it again, so every prompt carried `<capabilities>` twice."""
        from app.services.capabilities_prompt import build_capabilities_block

        built = build_capabilities_block(['read_file'], catalogue=[], compact_skills=True)
        assert built.startswith('<capabilities>')
        assert built.rstrip().endswith('</capabilities>')

        prompt = self._prompt(['read_file', 'load_skill'])
        # Counting substrings lies: the <intake> manifest names the tag in prose
        # ("details in <capabilities>"), which is a reference, not a wrapper.
        # The defect was a nested ELEMENT, so count the tags on their own line.
        lines = [line.strip() for line in prompt.splitlines()]
        assert lines.count('<capabilities>') == 1, (
            f'{lines.count("<capabilities>")} element-opening lines — the double wrap is back'
        )
        assert lines.count('</capabilities>') == 1

    def test_the_clarify_questions_array_is_bounded(self):
        """The pager renders any count, so the bound has to live in the schema."""
        from app.services.tool_registrations.system_tools import _CLARIFY_SCHEMA

        questions = _CLARIFY_SCHEMA['properties']['questions']
        assert questions['maxItems'] == 4
        # Prompt text and schema must say the same thing.
        assert 'at most 4 questions' in _segClarify()

    def test_the_prompt_text_still_names_the_tool_the_gate_checks(self):
        """Drift guard: if `submit_clarify` is renamed, the gate above checks a
        name that no longer appears anywhere and passes vacuously."""
        assert 'submit_clarify' in _segClarify()


def _segClarify() -> str:
    from app.services.workbench.prompt_segments_cache import CLARIFY_BLOCK

    assert CLARIFY_BLOCK, 'CLARIFY_BLOCK was renamed or emptied — the gate would pass vacuously'
    return CLARIFY_BLOCK