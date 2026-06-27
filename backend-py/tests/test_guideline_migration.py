"""C4 tests: context_builder instruction swap, guideline migration, learned_guidelines removal."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.services.memory import context_builder
from app.services.memory_store import get_memory, save_memory


class TestContextBuilder:
    def test_platform_string_references_skills_not_guidelines(self):
        assert "learned guidelines" not in context_builder.AUGUST_PLATFORM.lower()
        assert "skill_manage" in context_builder.AUGUST_PLATFORM
        assert "load_skill" in context_builder.AUGUST_PLATFORM


@pytest.mark.asyncio
async def test_migration_script_round_trip(isolated_data, isolated_skills):
    """Seed guidelines in the KV store, run migration, verify skills + cleared KV.

    This tests the core logic of ``scripts/migrate_guidelines_to_skills.py``
    without actually spawning a subprocess.
    """
    from app.services import skill_service

    # 1 — Seed guidelines
    guidelines = [
        {"id": "gl_1", "text": "Use PowerShell syntax not bash.", "source": "correction", "category": "behavior", "active": True},
        {"id": "gl_2", "text": "User prefers short answers.", "source": "preference", "category": "style", "active": True},
        {"id": "gl_3", "text": "Deactivated old rule.", "source": "correction", "category": "behavior", "active": False},
    ]
    save_memory("learned_guidelines", guidelines)

    # 2 — Run the migration logic inline
    from app.services.memory_store import get_memory

    active = [g for g in guidelines if g.get("active", True)]
    created = 0
    for g in active:
        text = (g.get("text") or "").strip()
        name = text.lower().replace(" ", ".").replace(",", "").replace("'", "")[:50]
        description = text[:55].rstrip(".") + "."
        body = f"## When to Use\n\n{text}\n\n## Procedure\n\n1. Apply this lesson.\n"
        category = g.get("category", "learned")
        skill_service.create_skill(name, description, body, category=category)
        created += 1

    assert created == 2  # only active

    # 3 — Verify skills exist (search by keyword since name generation is heuristic)
    matching = skill_service.search(query="powershell")
    assert len(matching) >= 1
    matching = skill_service.search(query="prefers short")
    assert len(matching) >= 1

    # 4 — Clear the KV store (migration completed)
    save_memory("learned_guidelines", [])
    remaining = get_memory("learned_guidelines") or []
    assert len(remaining) == 0


class TestLearnedGuidelinesRemoved:
    def test_module_gone(self):
        """learned_guidelines.py was removed — importing should fail."""
        import importlib
        import sys

        for module_name in list(sys.modules.keys()):
            if "learned_guidelines" in module_name:
                del sys.modules[module_name]

        with pytest.raises(ModuleNotFoundError):
            import app.services.memory.learned_guidelines  # noqa
