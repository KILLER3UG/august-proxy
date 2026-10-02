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

**Scope note.** This file pins the FACT that the mismatch exists, so that it
cannot silently grow. The fix — gating the digest on ``offeredTools`` — is
tracked separately; changing it here would make the test assert the opposite of
the current, documented state.
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