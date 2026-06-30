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
from app.services import skillService
from app.services.tool_registry import listTools
from app.services.workbench.workbench import WorkbenchSession, buildSystemPrompt
SKILL_MD = '---\nname: {name}\ndescription: {desc}\ntrigger: {trigger}\ncategory: testing\n---\n\n# {title}\n\nDo the thing:\n1. step one\n2. step two\n'

def _makeSkill(bundledRoot, name, desc, trigger='', title=None):
    d = bundledRoot / name
    d.mkdir(parents=True, exist_ok=True)
    (d / 'SKILL.md').write_text(SKILL_MD.format(name=name, desc=desc, trigger=trigger, title=title or name), 'utf-8')

class TestCatalogue:

    def testCatalogueListsAllDiscoverableSkills(self, isolatedSkills):
        agentRoot, bundledRoot = isolatedSkills
        _makeSkill(bundledRoot, 'alpha', 'Alpha skill does X.')
        _makeSkill(bundledRoot, 'beta', 'Beta skill does Y.', trigger='when beta')
        cat = skillService.catalogue()
        names = {c['name'] for c in cat}
        assert {'alpha', 'beta'} <= names
        alpha = next((c for c in cat if c['name'] == 'alpha'))
        assert alpha['description'] == 'Alpha skill does X.'
        beta = next((c for c in cat if c['name'] == 'beta'))
        assert beta['trigger'] == 'when beta'

    def testCatalogueMetadataOnly(self, isolatedSkills):
        """Catalogue must NOT include the full instructions body."""
        __, bundledRoot = isolatedSkills
        _makeSkill(bundledRoot, 'gamma', 'Gamma skill.')
        cat = skillService.catalogue()
        gamma = next((c for c in cat if c['name'] == 'gamma'))
        assert 'instructions' not in gamma
        assert set(gamma.keys()) <= {'name', 'description', 'trigger', 'category'}

class TestSystemPromptSkillsSection:

    def testPromptContainsSkillsSection(self, isolatedSkills):
        __, bundledRoot = isolatedSkills
        _makeSkill(bundledRoot, 'alpha', 'Alpha skill does X.')
        _makeSkill(bundledRoot, 'beta', 'Beta skill does Y.', trigger='when beta')
        session = WorkbenchSession(id='wb_skills')
        prompt = buildSystemPrompt(session)
        assert '## Available Skills' in prompt
        assert 'alpha: Alpha skill does X.' in prompt
        assert 'beta: Beta skill does Y.' in prompt
        assert '(trigger: when beta)' in prompt
        assert 'step one' not in prompt
        assert 'step two' not in prompt

    def testPromptIncludesLoadSkillInstruction(self, isolatedSkills):
        __, bundledRoot = isolatedSkills
        _makeSkill(bundledRoot, 'alpha', 'Alpha skill.')
        prompt = buildSystemPrompt(WorkbenchSession(id='wb_skills'))
        assert 'load_skill' in prompt

    def testNoSkillsSectionWhenEmpty(self, isolatedSkills):
        """No skills → no spurious empty section."""
        prompt = buildSystemPrompt(WorkbenchSession(id='wb_skills'))
        assert '## Available Skills' not in prompt

class TestLoadSkillReturnsBody:

    @pytest.mark.asyncio
    async def testLoadSkillReturnsFullBody(self, isolatedSkills):
        __, bundledRoot = isolatedSkills
        _makeSkill(bundledRoot, 'alpha', 'Alpha skill does X.', title='Alpha')
        from app.services.tool_definitions import _loadSkill
        result = await _loadSkill('alpha')
        assert 'Alpha' in result
        assert 'step one' in result
        assert 'step two' in result
        assert '---' not in result

class TestSkillToolsPresent:

    def testSkillToolsInRegistry(self):
        from app.services import tool_definitions as toolDefsModule
        if not listTools():
            toolDefsModule.register_all()
        names = {t['function']['name'] for t in listTools()}
        for expected in ('load_skill', 'list_skills', 'skill_manage'):
            assert expected in names, f'skill tool {expected} missing from registry'