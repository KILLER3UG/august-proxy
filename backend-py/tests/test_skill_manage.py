"""Skill authoring surface tests (C1).

Behavior-focused: create/patch/delete/write_file/remove_file, validation,
copy-on-write for bundled skills, and the skill_manage tool + REST router.
Tests never touch the repo's real skills/ dir — both roots are redirected.
"""

import pytest
from app.services import skill_service
from app.services.skill_service import SkillValidationError


@pytest.fixture
def isolatedSkills(tmp_path, monkeypatch):
    """Redirect both skill roots to temp dirs."""
    agentRoot = tmp_path / 'agent-skills'
    bundledRoot = tmp_path / 'bundled-skills'
    agentRoot.mkdir()
    bundledRoot.mkdir()
    monkeypatch.setattr(skill_service, '_agentSkillsDir', lambda: agentRoot)
    monkeypatch.setattr(skill_service, 'SKILLS_DIR', bundledRoot)
    return (agentRoot, bundledRoot)


def testCreateSkillRoundTrip(isolatedSkills):
    agentRoot, __ = isolatedSkills
    skill = skill_service.createSkill(
        'py-test-thing',
        'Does a useful thing for tests.',
        '## When to Use\n\nWhen testing skill creation.\n',
        category='test',
    )
    assert skill['name'] == 'py-test-thing'
    assert skill.get('created_by') == 'agent'
    names = [s['name'] for s in skill_service.list_all()]
    assert 'py-test-thing' in names
    fetched = skill_service.get('py-test-thing')
    assert fetched is not None
    assert 'testing skill creation' in fetched['instructions']
    assert (agentRoot / 'py-test-thing' / 'SKILL.md').exists()


def testCreateSkillValidation(isolatedSkills):
    with pytest.raises(SkillValidationError):
        skill_service.createSkill('Bad Name', 'Valid desc.', 'body')
    with pytest.raises(SkillValidationError):
        skill_service.createSkill('ok', 'x' * 61, 'body')
    with pytest.raises(SkillValidationError):
        skill_service.createSkill('ok', 'A powerful seamless tool', 'body')
    with pytest.raises(SkillValidationError):
        skill_service.createSkill('ok', 'Valid desc.', '   ')


def testDuplicateCreateRefused(isolatedSkills):
    skill_service.createSkill('dup', 'First one.', 'body')
    with pytest.raises(SkillValidationError):
        skill_service.createSkill('dup', 'Second one.', 'body')


def testPatchSkillCopyOnWriteBundled(isolatedSkills):
    __, bundledRoot = isolatedSkills
    bdir = bundledRoot / 'bundled-thing'
    bdir.mkdir()
    (bdir / 'SKILL.md').write_text(
        '---\nname: bundled-thing\ndescription: A bundled skill.\n---\n\nOld body.\n', 'utf-8'
    )
    skill_service.patchSkill('bundled-thing', body='## When to Use\n\nNew body.\n')
    assert 'Old body.' in (bundledRoot / 'bundled-thing' / 'SKILL.md').read_text('utf-8')
    fetched = skill_service.get('bundled-thing')
    assert 'New body.' in fetched['instructions']
    assert 'Old body.' not in fetched['instructions']


def testPatchSkillAgent(isolatedSkills):
    skill_service.createSkill('ap', 'Agent patch.', 'Original body.')
    skill_service.patchSkill('ap', body='Updated body.')
    fetched = skill_service.get('ap')
    assert 'Updated body.' in fetched['instructions']
    assert 'Original body.' not in fetched['instructions']


def testWriteAndRemoveSkillFile(isolatedSkills):
    skill_service.createSkill('files', 'Has support files.', 'body.')
    skill_service.writeSkillFile('files', 'scripts/run.py', "print('hi')")
    with pytest.raises(SkillValidationError):
        skill_service.writeSkillFile('files', '../escape.txt', 'x')
    skill_service.removeSkillFile('files', 'scripts/run.py')
    with pytest.raises(SkillValidationError):
        skill_service.removeSkillFile('files', 'scripts/run.py')
    with pytest.raises(SkillValidationError):
        skill_service.removeSkillFile('files', 'SKILL.md')


def testDeleteSkillAgentOnly(isolatedSkills):
    __, bundledRoot = isolatedSkills
    bdir = bundledRoot / 'bundled-del'
    bdir.mkdir()
    (bdir / 'SKILL.md').write_text('---\nname: bundled-del\ndescription: x.\n---\n\nbody\n', 'utf-8')
    with pytest.raises(SkillValidationError):
        skill_service.deleteSkill('bundled-del')
    skill_service.createSkill('agent-del', 'To be deleted.', 'body.')
    result = skill_service.deleteSkill('agent-del')
    assert result['deleted'] is True
    assert skill_service.get('agent-del') is None


@pytest.mark.asyncio
async def testSkillManageToolCreatePatchDelete(isolatedSkills):
    from app.services.tool_definitions import _skillManage

    out = await _skillManage('create', name='tool-skill', description='Via tool.', body='body.')
    assert "Created skill 'tool-skill'" in out
    assert skill_service.get('tool-skill') is not None
    out = await _skillManage('patch', name='tool-skill', body='Patched body.')
    assert "Patched skill 'tool-skill'" in out
    assert 'Patched body.' in skill_service.get('tool-skill')['instructions']
    out = await _skillManage('delete', name='tool-skill')
    assert "Deleted skill 'tool-skill'" in out
    assert skill_service.get('tool-skill') is None


@pytest.mark.asyncio
async def testSkillManageToolValidationSurface(isolatedSkills):
    from app.services.tool_definitions import _skillManage

    out = await _skillManage('create', name='UPPER', description='ok.', body='body.')
    assert out.startswith('Error:')
    out = await _skillManage('bogus', name='x', description='ok.', body='body.')
    assert 'unknown skill_manage action' in out


def _client():
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from app.routers import skills as skillsRouter

    app = FastAPI()
    app.include_router(skillsRouter.router)
    return TestClient(app)


def testSkillsRouterCreateGetDelete(isolatedSkills):
    client = _client()
    r = client.post('/api/skills', json={'name': 'r-skill', 'description': 'Via router.', 'body': 'body.'})
    assert r.status_code == 200, r.text
    r = client.get('/api/skills/r-skill')
    assert r.status_code == 200
    assert r.json()['name'] == 'r-skill'
    r = client.delete('/api/skills/r-skill')
    assert r.status_code == 200
    r = client.get('/api/skills/r-skill')
    assert r.status_code == 404


def testSkillsRouterValidation400(isolatedSkills):
    client = _client()
    r = client.post('/api/skills', json={'name': 'Bad Name', 'description': 'ok.', 'body': 'body.'})
    assert r.status_code == 400
