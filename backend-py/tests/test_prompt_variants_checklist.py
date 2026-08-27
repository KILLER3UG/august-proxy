"""§9.3 #5 completion checklist + #6 per-model-family prompt variants.

The checklist is the model's OWN pre-completion self-check (user ruling:
never a critic gate, never answer-withholding). Variants add a short
family-framing block to the system prompt; temperature=1-with-effort lives
in providers.py (wire-level, covered by provider tests).
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services.workbench import prompt_variants as pv  # noqa: E402


class TestModelFamily:
    @pytest.mark.parametrize(
        ('model', 'family'),
        [
            ('claude-sonnet-4-20250514', 'anthropic'),
            ('anthropic/claude-3.5', 'anthropic'),
            ('gpt-5', 'openai'),
            ('o3-mini', 'openai'),
            ('deepseek-chat', 'deepseek'),
            ('deepseek-reasoner', 'deepseek'),
            ('gemini-2.5-pro', 'gemini'),
            ('qwen3-max', 'qwen'),
            ('mistral-large', 'mistral'),
            ('llama3-70b', 'llama'),
            ('some-gateway/custom-model', ''),
            ('', ''),
        ],
    )
    def testDetection(self, model: str, family: str) -> None:
        assert pv.model_family(model) == family

    def testVariantBlocks(self) -> None:
        assert '<model_family_notes>' in pv.family_prompt_variant('claude-x')
        assert pv.family_prompt_variant('unknown-model') == ''


class TestSystemPromptMounts:
    def _session(self, model: str):
        from app.services.workbench.sessions import WorkbenchSession

        return WorkbenchSession(id='prompt-test', model=model)

    def testChecklistPresentWithTools(self) -> None:
        from app.services.workbench.workbench import buildSystemPrompt

        text = buildSystemPrompt(self._session('claude-x'), tools=[{'name': 'read_file'}])
        assert '<completion_checklist>' in text
        assert 'no other gate stands between you and your answer' in text

    def testChecklistAbsentWithoutTools(self) -> None:
        from app.services.workbench.workbench import buildSystemPrompt

        text = buildSystemPrompt(self._session('claude-x'), tools=[])
        assert '<completion_checklist>' not in text

    def testFamilyVariantInjected(self) -> None:
        from app.services.workbench.workbench import buildSystemPrompt

        text = buildSystemPrompt(self._session('deepseek-chat'), tools=[{'name': 'read_file'}])
        assert '<model_family_notes>' in text
        assert 'strict JSON' in text

    def testUnknownFamilyNoVariant(self) -> None:
        from app.services.workbench.workbench import buildSystemPrompt

        text = buildSystemPrompt(self._session('custom-unknown'), tools=[{'name': 'read_file'}])
        assert '<model_family_notes>' not in text
