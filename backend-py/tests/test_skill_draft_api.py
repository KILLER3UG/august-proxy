"""Pending skill draft endpoint — body + existing-body for out-of-band diffing."""

from __future__ import annotations

import pytest
from fastapi import HTTPException


def _seed_draft(name: str, draft_path, body: str = 'Run the tests first.\n'):
    from app.services.memory_store import _conn

    draft_path.write_text(
        f'---\nname: {name}\ndescription: A test skill\ntrigger: auth error\ncategory: evolving\n---\n\n{body}',
        encoding='utf-8',
    )
    _conn().execute(
        'INSERT INTO pending_skills (name, description, trigger_text, draft_path, source_session_id, status) '
        'VALUES (?, ?, ?, ?, ?, ?)',
        (name, 'A test skill', 'auth error', str(draft_path), None, 'pending'),
    )
    _conn().commit()


@pytest.mark.asyncio
async def test_draft_returns_stripped_body(brain_ready, tmp_path):
    from app.routers.brain import getSkillDraft

    draft = tmp_path / '.pending_jwt-debug.md'
    _seed_draft('jwt-debug', draft, body='Debug JWT expiry.\n')
    out = await getSkillDraft('jwt-debug')
    assert out['name'] == 'jwt-debug'
    assert out['body'] == 'Debug JWT expiry.'
    assert out['existingBody'] is None


@pytest.mark.asyncio
async def test_draft_returns_existing_body_when_skill_exists(brain_ready, tmp_path, isolatedSkills):
    from app.routers.brain import getSkillDraft
    from app.services import skill_service

    skill_service.createSkill(
        'jwt-debug', 'Existing skill', 'The old body.', trigger='auth', category='evolving', createdBy='agent'
    )
    draft = tmp_path / '.pending_jwt-debug.md'
    _seed_draft('jwt-debug', draft, body='The new body.')
    out = await getSkillDraft('jwt-debug')
    assert out['existingBody'] == 'The old body.'
    assert out['body'] == 'The new body.'


@pytest.mark.asyncio
async def test_draft_404_when_unknown(brain_ready):
    from app.routers.brain import getSkillDraft

    with pytest.raises(HTTPException) as exc:
        await getSkillDraft('no-such-skill')
    assert exc.value.status_code == 404
