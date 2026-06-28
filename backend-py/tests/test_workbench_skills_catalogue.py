"""Chunk 3 — skills progressive disclosure.

Asserts the Claude-Code-style pattern:
  * `build_system_prompt(session)` contains an ``## Available Skills``
    section listing EVERY discoverable skill (name + description).
  * `load_skill("<known>")` returns the full SKILL.md body (frontmatter
    stripped).
  * The skill tools (load_skill/list_skills/skill_manage) appear in the
    workbench tool list (re-asserted from Chunk 1).
"""
from __future__ import annotations

import pytest

from app.services import skill_service
from app.services.tool_registry import list_tools
from app.services.workbench.workbench import (
    WorkbenchSession,
    build_system_prompt,
)


SKILL_MD = """---
name: {name}
description: {desc}
trigger: {trigger}
category: testing
---

# {title}

Do the thing:
1. step one
2. step two
"""


def _make_skill(bundled_root, name, desc, trigger="", title=None):
    d = bundled_root / name
    d.mkdir(parents=True, exist_ok=True)
    (d / "SKILL.md").write_text(
        SKILL_MD.format(name=name, desc=desc, trigger=trigger, title=title or name),
        "utf-8",
    )


class TestCatalogue:
    def test_catalogue_lists_all_discoverable_skills(self, isolated_skills):
        agent_root, bundled_root = isolated_skills
        _make_skill(bundled_root, "alpha", "Alpha skill does X.")
        _make_skill(bundled_root, "beta", "Beta skill does Y.", trigger="when beta")

        cat = skill_service.catalogue()
        names = {c["name"] for c in cat}
        assert {"alpha", "beta"} <= names
        alpha = next(c for c in cat if c["name"] == "alpha")
        assert alpha["description"] == "Alpha skill does X."
        beta = next(c for c in cat if c["name"] == "beta")
        assert beta["trigger"] == "when beta"

    def test_catalogue_metadata_only(self, isolated_skills):
        """Catalogue must NOT include the full instructions body."""
        _, bundled_root = isolated_skills
        _make_skill(bundled_root, "gamma", "Gamma skill.")
        cat = skill_service.catalogue()
        gamma = next(c for c in cat if c["name"] == "gamma")
        assert "instructions" not in gamma
        assert set(gamma.keys()) <= {"name", "description", "trigger", "category"}


class TestSystemPromptSkillsSection:
    def test_prompt_contains_skills_section(self, isolated_skills):
        _, bundled_root = isolated_skills
        _make_skill(bundled_root, "alpha", "Alpha skill does X.")
        _make_skill(bundled_root, "beta", "Beta skill does Y.", trigger="when beta")

        session = WorkbenchSession(id="wb_skills")
        prompt = build_system_prompt(session)

        assert "## Available Skills" in prompt

        # Every discoverable skill appears with its description.
        assert "alpha: Alpha skill does X." in prompt
        assert "beta: Beta skill does Y." in prompt
        assert "(trigger: when beta)" in prompt

        # Instructions body must NOT be in the prompt (progressive disclosure).
        assert "step one" not in prompt
        assert "step two" not in prompt

    def test_prompt_includes_load_skill_instruction(self, isolated_skills):
        _, bundled_root = isolated_skills
        _make_skill(bundled_root, "alpha", "Alpha skill.")
        prompt = build_system_prompt(WorkbenchSession(id="wb_skills"))
        assert "load_skill" in prompt

    def test_no_skills_section_when_empty(self, isolated_skills):
        """No skills → no spurious empty section."""
        prompt = build_system_prompt(WorkbenchSession(id="wb_skills"))
        assert "## Available Skills" not in prompt


class TestLoadSkillReturnsBody:
    @pytest.mark.asyncio
    async def test_load_skill_returns_full_body(self, isolated_skills):
        _, bundled_root = isolated_skills
        _make_skill(bundled_root, "alpha", "Alpha skill does X.", title="Alpha")

        from app.services.tool_definitions import _load_skill
        result = await _load_skill("alpha")
        # Full SKILL.md body is returned (frontmatter stripped by the parser).
        assert "Alpha" in result
        assert "step one" in result
        assert "step two" in result
        # Frontmatter must be stripped.
        assert "---" not in result


class TestSkillToolsPresent:
    def test_skill_tools_in_registry(self):
        # Ensure the registry is populated (autouse module fixture not shared
        # across files, so register defensively here).
        from app.services import tool_definitions as tool_defs_module
        if not list_tools():
            tool_defs_module.register_all()
        names = {t["function"]["name"] for t in list_tools()}
        for expected in ("load_skill", "list_skills", "skill_manage"):
            assert expected in names, f"skill tool {expected} missing from registry"
