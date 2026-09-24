"""Characterization tests for CamelModel on the skills router.

Proves SkillFileWrite uses snake_case Python fields with camelCase JSON
aliases, and that SkillCreate/SkillPatch validate as expected.
"""
from __future__ import annotations

import pytest
from app.routers.skills import SkillCreate, SkillFileWrite, SkillPatch


def test_skill_file_write_serializes_file_path_by_alias():
    body = SkillFileWrite(file_path='scripts/run.py', content='print(1)')
    dumped = body.model_dump(by_alias=True)
    assert dumped['filePath'] == 'scripts/run.py'
    assert dumped['content'] == 'print(1)'
    assert 'file_path' not in dumped


def test_skill_file_write_accepts_camelcase_file_path_input():
    body = SkillFileWrite.model_validate(
        {'filePath': 'references/docs.md', 'content': '# docs'}
    )
    assert body.file_path == 'references/docs.md'
    assert body.content == '# docs'


def test_skill_file_write_accepts_snake_case_via_populate_by_name():
    body = SkillFileWrite(file_path='templates/a.md', content='x')
    assert body.file_path == 'templates/a.md'
    assert body.content == 'x'


def test_skill_create_basic_validation():
    body = SkillCreate(
        name='my-skill',
        description='A short description.',
        body='# Skill\n\nBody markdown.',
        trigger='when needed',
        category='tools',
    )
    assert body.name == 'my-skill'
    assert body.description == 'A short description.'
    assert body.body == '# Skill\n\nBody markdown.'
    assert body.trigger == 'when needed'
    assert body.category == 'tools'
    dumped = body.model_dump(by_alias=True)
    assert dumped['name'] == 'my-skill'
    assert dumped['description'] == 'A short description.'


def test_skill_create_defaults():
    body = SkillCreate(
        name='plain',
        description='Desc.',
        body='body',
    )
    assert body.trigger == ''
    assert body.category == 'uncategorized'


def test_skill_patch_basic_validation():
    body = SkillPatch(body='new body', description='new desc')
    assert body.body == 'new body'
    assert body.description == 'new desc'
    assert body.trigger is None
    assert body.category is None

    partial = SkillPatch.model_validate({'trigger': 'on demand', 'category': 'ops'})
    assert partial.trigger == 'on demand'
    assert partial.category == 'ops'
    assert partial.body is None


@pytest.mark.asyncio
async def test_get_skill_answers_camel_case_like_the_list_endpoint(monkeypatch):
    """GET /api/skills/{name} handed back the raw snake_case parse while
    GET /api/skills built camelCase rows, so the detail pane's
    ``selected.createdBy`` read undefined and every skill — including one the
    agent authored — was labelled "bundled"."""
    from app.routers import skills

    monkeypatch.setattr(
        skills.skill_service,
        'get',
        lambda name, workspace=None: {
            'name': name,
            'description': 'd',
            'created_by': 'agent',
            'enabled': True,
        },
    )
    out = await skills.getSkill('acme-skill')
    assert out['createdBy'] == 'agent'
    assert out['usageCount'] == 0


@pytest.mark.asyncio
async def test_a_bundled_skill_reports_an_empty_author_not_a_crash(monkeypatch):
    from app.routers import skills

    monkeypatch.setattr(
        skills.skill_service, 'get', lambda name, workspace=None: {'name': name}
    )
    out = await skills.getSkill('plain')
    assert out['createdBy'] == ''
