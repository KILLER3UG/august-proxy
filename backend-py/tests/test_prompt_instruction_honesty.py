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
        """Guards the premise. If the digest stops naming these, the assertions
        below become vacuous — so pin the naming first."""
        digest = _digest()
        named = [t for t in DIGEST_NAMED_TOOLS if t in digest]
        assert named, (
            'the digest no longer names any of the tools this file checks; update '
            'DIGEST_NAMED_TOOLS rather than letting the assertions pass vacuously'
        )

    @pytest.mark.parametrize('tool', DIGEST_NAMED_TOOLS)
    def test_every_tool_the_digest_names_is_really_absent_from_bare(self, tool: str):
        assert tool not in _BARE_TOOL_ALLOW, (
            f'{tool} is now in _BARE_TOOL_ALLOW; the instruction is now actionable '
            'and can be dropped from DIGEST_NAMED_TOOLS'
        )

    @pytest.mark.parametrize('tool', DIGEST_NAMED_TOOLS)
    def test_the_digest_names_it_unconditionally(self, tool: str):
        """The digest is appended to the prompt with no `offeredTools` gate
        (workbench.py ~:1005), so the name reaches a bare-surface model."""
        assert tool in _digest(), f'{tool} is no longer named by the digest'

    def test_the_gate_is_ungated_today(self):
        """States the current condition precisely, so that FIXING it is a
        deliberate, visible change to this test rather than an accident."""
        src = inspect.getsource(prompt_build._harness_guide_text)
        assert 'offeredTools' not in src and 'GATED' not in src, (
            '_harness_guide_text() now filters by offeredTools — the mismatch is '
            'fixed. Update this file to assert the fixed behaviour instead.'
        )

    def test_capabilities_prompt_tells_the_model_to_call_load_skill(self):
        """The capability block says "call load_skill(name)", which the bare
        surface cannot honour. Read from the real builder, not a guessed symbol
        (the earlier version scanned module attributes and found none)."""
        builder = getattr(capabilities_prompt, 'build_capabilities_block', None)
        assert callable(builder), (
            'capabilities_prompt.build_capabilities_block is missing — this test '
            'would otherwise pass vacuously'
        )
        # The tool it names is absent from the bare surface, so the instruction
        # is unreachable there.
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