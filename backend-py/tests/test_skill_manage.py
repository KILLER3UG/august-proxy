"""Skill authoring surface tests (C1).

Behavior-focused: create/patch/delete/write_file/remove_file, validation,
copy-on-write for bundled skills, and the skill_manage tool + REST router.
Tests never touch the repo's real skills/ dir — both roots are redirected.
"""
import pytest
from app.services import skillService
from app.services.skill_service import SkillValidationError

@pytest.fixture
def isolatedSkills(tmp_path, monkeypatch):
    """Redirect both skill roots to temp dirs."""
    agentRoot = tmp_path / 'agent-skills'
    bundledRoot = tmp_path / 'bundled-skills'
    agentRoot.mkdir()
    bundledRoot.mkdir()
    monkeypatch.setattr(skillService, '_agent_skills_dir', lambda: agentRoot)
    monkeypatch.setattr(skillService, 'SKILLS_DIR', bundledRoot)
    return (agentRoot, bundledRoot)

def testCreateSkillRoundTrip(isolatedSkills):
    agentRoot, __ = isolatedSkills
    skill = skillService.create_skill('py-test-thing', 'Does a useful thing for tests.', '## When to Use\n\nWhen testing skill creation.\n', category='test')
    assert skill['name'] == 'py-test-thing'
    assert skill.get('created_by') == 'agent'
    names = [s['name'] for s in skillService.list_all()]
    assert 'py-test-thing' in names
    fetched = skillService.get('py-test-thing')
    assert fetched is not None
    assert 'testing skill creation' in fetched['instructions']
    assert (agentRoot / 'py-test-thing' / 'SKILL.md').exists()

def testCreateSkillValidation(isolatedSkills):
    with pytest.raises(SkillValidationError):
        skillService.create_skill('Bad Name', 'Valid desc.', 'body')
    with pytest.raises(SkillValidationError):
        skillService.create_skill('ok', 'x' * 61, 'body')
    with pytest.raises(SkillValidationError):
        skillService.create_skill('ok', 'A powerful seamless tool', 'body')
    with pytest.raises(SkillValidationError):
        skillService.create_skill('ok', 'Valid desc.', '   ')

def testDuplicateCreateRefused(isolatedSkills):
    skillService.create_skill('dup', 'First one.', 'body')
    with pytest.raises(SkillValidationError):
        skillService.create_skill('dup', 'Second one.', 'body')

def testPatchSkillCopyOnWriteBundled(isolatedSkills):
    __, bundledRoot = isolatedSkills
    bdir = bundledRoot / 'bundled-thing'
    bdir.mkdir()
    (bdir / 'SKILL.md').write_text('---\nname: bundled-thing\ndescription: A bundled skill.\n---\n\nOld body.\n', 'utf-8')
    skillService.patch_skill('bundled-thing', body='## When to Use\n\nNew body.\n')
    assert 'Old body.' in (bundledRoot / 'bundled-thing' / 'SKILL.md').read_text('utf-8')
    fetched = skillService.get('bundled-thing')
    assert 'New body.' in fetched['instructions']
    assert 'Old body.' not in fetched['instructions']

def testPatchSkillAgent(isolatedSkills):
    skillService.create_skill('ap', 'Agent patch.', 'Original body.')
    skillService.patch_skill('ap', body='Updated body.')
    fetched = skillService.get('ap')
    assert 'Updated body.' in fetched['instructions']
    assert 'Original body.' not in fetched['instructions']

def testWriteAndRemoveSkillFile(isolatedSkills):
    skillService.create_skill('files', 'Has support files.', 'body.')
    skillService.write_skill_file('files', 'scripts/run.py', "print('hi')")
    with pytest.raises(SkillValidationError):
        skillService.write_skill_file('files', '../escape.txt', 'x')
    skillService.remove_skill_file('files', 'scripts/run.py')
    with pytest.raises(SkillValidationError):
        skillService.remove_skill_file('files', 'scripts/run.py')
    with pytest.raises(SkillValidationError):
        skillService.remove_skill_file('files', 'SKILL.md')

def testDeleteSkillAgentOnly(isolatedSkills):
    __, bundledRoot = isolatedSkills
    bdir = bundledRoot / 'bundled-del'
    bdir.mkdir()
    (bdir / 'SKILL.md').write_text('---\nname: bundled-del\ndescription: x.\n---\n\nbody\n', 'utf-8')
    with pytest.raises(SkillValidationError):
        skillService.delete_skill('bundled-del')
    skillService.create_skill('agent-del', 'To be deleted.', 'body.')
    result = skillService.delete_skill('agent-del')
    assert result['deleted'] is True
    assert skillService.get('agent-del') is None

@pytest.mark.asyncio
async def testSkillManageToolCreatePatchDelete(isolatedSkills):
    from app.services.tool_definitions import _skillManage
    out = await _skillManage('create', name='tool-skill', description='Via tool.', body='body.')
    assert "Created skill 'tool-skill'" in out
    assert skillService.get('tool-skill') is not None
    out = await _skillManage('patch', name='tool-skill', body='Patched body.')
    assert "Patched skill 'tool-skill'" in out
    assert 'Patched body.' in skillService.get('tool-skill')['instructions']
    out = await _skillManage('delete', name='tool-skill')
    assert "Deleted skill 'tool-skill'" in out
    assert skillService.get('tool-skill') is None

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