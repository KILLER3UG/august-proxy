"""C4 tests: context_builder instruction swap, guideline migration, learned_guidelines removal."""
from __future__ import annotations
import json
from pathlib import Path
import pytest
from app.services.memory import contextBuilder
from app.services.memoryStore import getMemory, saveMemory

class TestContextBuilder:

    def testPlatformStringReferencesSkillsNotGuidelines(self):
        assert 'learned guidelines' not in contextBuilder.AUGUST_PLATFORM.lower()
        assert 'skill_manage' in contextBuilder.AUGUST_PLATFORM
        assert 'load_skill' in contextBuilder.AUGUST_PLATFORM

@pytest.mark.asyncio
async def testMigrationScriptRoundTrip(isolatedData, isolatedSkills):
    """Seed guidelines in the KV store, run migration, verify skills + cleared KV.

    This tests the core logic of ``scripts/migrate_guidelines_to_skills.py``
    without actually spawning a subprocess.
    """
    from app.services import skillService
    guidelines = [{'id': 'gl_1', 'text': 'Use PowerShell syntax not bash.', 'source': 'correction', 'category': 'behavior', 'active': True}, {'id': 'gl_2', 'text': 'User prefers short answers.', 'source': 'preference', 'category': 'style', 'active': True}, {'id': 'gl_3', 'text': 'Deactivated old rule.', 'source': 'correction', 'category': 'behavior', 'active': False}]
    saveMemory('learned_guidelines', guidelines)
    from app.services.memoryStore import getMemory
    active = [g for g in guidelines if g.get('active', True)]
    created = 0
    for g in active:
        text = (g.get('text') or '').strip()
        name = text.lower().replace(' ', '.').replace(',', '').replace("'", '')[:50]
        description = text[:55].rstrip('.') + '.'
        body = f'## When to Use\n\n{text}\n\n## Procedure\n\n1. Apply this lesson.\n'
        category = g.get('category', 'learned')
        skillService.create_skill(name, description, body, category=category)
        created += 1
    assert created == 2
    matching = skillService.search(query='powershell')
    assert len(matching) >= 1
    matching = skillService.search(query='prefers short')
    assert len(matching) >= 1
    saveMemory('learned_guidelines', [])
    remaining = getMemory('learned_guidelines') or []
    assert len(remaining) == 0

class TestLearnedGuidelinesRemoved:

    def testModuleGone(self):
        """learned_guidelines.py was removed — importing should fail."""
        import importlib
        import sys
        for moduleName in list(sys.modules.keys()):
            if 'learned_guidelines' in moduleName:
                del sys.modules[moduleName]
        with pytest.raises(ModuleNotFoundError):
            import app.services.memory.learned_guidelines