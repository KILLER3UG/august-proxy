"""Part 17 Phase B acceptance — project skills (third root + shadowing).

Plan acceptance for Phase B (docs/plans/2026-08-29-project-scoped-memory.md):
  * root resolution — ``<ws>/.aug/skills/`` joins ahead of agent + bundled,
    home is NOT a project root (Tasks home stays folderless)
  * shadowing — same-name project entry wins in get/list/search/catalogue;
    ``overrides`` labels what it shadows
  * two-workspace cache-key isolation — catalogue(wsA) never leaks entries
    to catalogue(wsB) (memo keyed on (workspace, roots, mtimes))
  * delete-override safety — deleteSkill(ws) removes ONLY the project
    override; a global name without a project entry is refused
  * relevant-skills merge — the Tier-3 block ranks project skills too
  * model-facing tools — load_skill/list_skills resolve the session
    workspace via the ContextVar (project skills visible to the model)
"""

from __future__ import annotations

import shutil
from pathlib import Path

import pytest
from app.services import skill_service
from app.services.skill_service import SkillValidationError


def _mkSkillDir(root: Path, name: str, description: str, body: str = 'Do work.') -> None:
    d = root / name
    d.mkdir(parents=True, exist_ok=True)
    (d / 'SKILL.md').write_text(
        '---\n'
        f'name: {name}\n'
        f'description: {description}\n'
        'category: testing\n'
        'created_by: agent\n'
        '---\n\n'
        f'{body}\n',
        'utf-8',
    )


def _cleanProject(ws: Path) -> None:
    p = ws / '.aug' / 'skills'
    if p.exists():
        shutil.rmtree(p, ignore_errors=True)


@pytest.fixture()
def isolated(monkeypatch, tmp_path):
    """Fresh catalogue state + a sandboxed AGENT root.

    ``_agentSkillsDir`` is redirected to a per-test tmp dir so agent-scope
    fixtures never touch the user's real agent skills directory.
    """
    skill_service._bust_prompt_skills_cache()
    skill_service._flat_migrate_done = True  # skip repo-root flat migration scan
    agent_root = tmp_path / 'agent-skills'
    monkeypatch.setattr(skill_service, '_agentSkillsDir', lambda: agent_root)
    yield agent_root
    skill_service._bust_prompt_skills_cache()


# ---------------------------------------------------------------- roots


def test_project_root_joins_ahead_of_agent_and_bundled(isolated, tmp_path):
    ws = tmp_path / 'ws-rootorder'
    ws.mkdir()
    _mkSkillDir(ws / '.aug' / 'skills', 'root-proj', 'from project root')
    got = skill_service.get('root-proj', str(ws))
    assert got is not None and got['scope'] == 'project'
    scopes = {s['name']: s['scope'] for s in skill_service.list_all(str(ws))}
    assert scopes['root-proj'] == 'project'
    # without the workspace the project skill is invisible (legacy behavior)
    assert skill_service.get('root-proj') is None


def test_home_is_not_a_project_root(isolated, tmp_path):
    home = Path.home()
    # The Tasks home must not become a skills root: createSkill with the
    # home path routes to the AGENT root, and <home>/.aug/skills is never
    # scanned as a project root.
    skill_service.createSkill(
        'home-not-project', 'home should go agent scope', 'Body here.',
        created_by='agent', workspace=str(home),
    )
    try:
        assert not (home / '.aug' / 'skills' / 'home-not-project').exists()
        got = skill_service.get('home-not-project', str(home))
        assert got is not None and got.get('scope') == 'agent'
    finally:
        skill_service.deleteSkill('home-not-project')


def test_blank_workspace_matches_legacy_no_workspace(isolated):
    # No workspace → legacy two-root behavior, and scope tags still apply
    scopes = {s['name']: s['scope'] for s in skill_service.list_all(None)}
    assert all(v in ('agent', 'bundled') for v in scopes.values())
    # '' and None behave identically (the router sends '' for "no workspace")
    a = [s['name'] for s in skill_service.list_all(None)]
    b = [s['name'] for s in skill_service.list_all('')]
    assert a == b


# --------------------------------------------------------------- shadowing


def test_project_shadows_agent_same_name(isolated, tmp_path):
    ws = tmp_path / 'ws-shadow'
    ws.mkdir()
    _mkSkillDir(isolated, 'shadow-me', 'global copy', body='Global body.')
    _mkSkillDir(ws / '.aug' / 'skills', 'shadow-me', 'project copy', body='Project body.')
    try:
        got = skill_service.get('shadow-me', str(ws))
        assert got is not None
        assert str(got['instructions']).startswith('Project body')
        assert got['scope'] == 'project'
        # global view unchanged
        g = skill_service.get('shadow-me')
        assert g is not None and g['scope'] == 'agent'
        # search honors shadowing too
        hits = skill_service.search('shadow', workspace=str(ws))
        assert any(s['name'] == 'shadow-me' and s['scope'] == 'project' for s in hits)
        # catalogue carries the overrides label
        cat = skill_service.catalogue(str(ws))
        entry = next(e for e in cat if e['name'] == 'shadow-me')
        assert entry['scope'] == 'project' and entry['overrides'] == 'agent'
    finally:
        _cleanProject(ws)


def test_shadowing_visible_via_load_bodies_and_skill_body(isolated, tmp_path):
    ws = tmp_path / 'ws-body'
    ws.mkdir()
    _mkSkillDir(ws / '.aug' / 'skills', 'body-proj', 'project', body='Proj wins.')
    try:
        text = skill_service.skill_body('body-proj', str(ws))
        assert text is not None and text.startswith('Proj wins')
        bodies = skill_service.load_bodies(['body-proj'], workspace=str(ws))
        assert 'Proj wins' in bodies
        # without the workspace the project skill is invisible
        assert skill_service.skill_body('body-proj') is None
    finally:
        _cleanProject(ws)


def test_patch_copy_on_writes_into_project_root(isolated, tmp_path):
    # Patching a global skill with a workspace copies it INTO the project
    # root — the workspace's customized shadow — leaving the global intact.
    ws = tmp_path / 'ws-cow'
    ws.mkdir()
    _mkSkillDir(isolated, 'cow-skill', 'original description', body='Original.')
    try:
        skill_service.patchSkill('cow-skill', body='Customized.', workspace=str(ws))
        proj = ws / '.aug' / 'skills' / 'cow-skill' / 'SKILL.md'
        assert proj.exists()
        got = skill_service.get('cow-skill', str(ws))
        assert got is not None and got['scope'] == 'project'
        # canonical-body normalization wraps agent-authored bodies in the
        # What/When/How/Pitfalls/Verification template — the patch text is
        # embedded, not necessarily at offset 0.
        assert 'Customized.' in str(got['instructions'])
        # global untouched
        g = skill_service.get('cow-skill')
        assert g is not None and g['scope'] == 'agent'
        assert str(g['instructions']).startswith('Original')
    finally:
        _cleanProject(ws)


# ------------------------------------------------------------ cache isolation


def test_two_workspace_cache_isolation(isolated, tmp_path):
    wsA = tmp_path / 'ws-cache-a'
    wsB = tmp_path / 'ws-cache-b'
    wsA.mkdir()
    wsB.mkdir()
    _mkSkillDir(wsA / '.aug' / 'skills', 'cache-alpha', 'skill in ws-cache-a')
    _mkSkillDir(wsB / '.aug' / 'skills', 'cache-beta', 'skill in ws-cache-b')
    try:
        catA = skill_service.catalogue(str(wsA))
        catB = skill_service.catalogue(str(wsB))
        # each workspace sees only its own project skill — no cross-leak
        # through the shared catalogue memo
        namesA = {e['name'] for e in catA}
        namesB = {e['name'] for e in catB}
        assert 'cache-alpha' in namesA and 'cache-alpha' not in namesB
        assert 'cache-beta' in namesB and 'cache-beta' not in namesA
        # home catalogue stays free of project entries
        assert not any(e.get('scope') == 'project' for e in skill_service.catalogue())
    finally:
        _cleanProject(wsA)
        _cleanProject(wsB)


# ------------------------------------------------------- delete-override safety


def test_delete_removes_only_project_override(isolated, tmp_path):
    ws = tmp_path / 'ws-del'
    ws.mkdir()
    _mkSkillDir(isolated, 'del-shadow', 'global del copy', body='Global.')
    _mkSkillDir(ws / '.aug' / 'skills', 'del-shadow', 'proj del copy', body='Proj.')
    try:
        out = skill_service.deleteSkill('del-shadow', str(ws))
        assert out['scope'] == 'project' and out.get('override_removed') is True
        # global intact
        g = skill_service.get('del-shadow')
        assert g is not None and g['scope'] == 'agent'
        assert not (ws / '.aug' / 'skills' / 'del-shadow').exists()
    finally:
        _cleanProject(ws)


def test_delete_rejects_path_traversal_names(isolated, tmp_path):
    # §9 F-1: deleteSkill must validate `name` like create/patch do — a
    # traversal name ('..' or containing separators) must raise BEFORE the
    # project-root join, and the sibling directory must survive.
    ws = tmp_path / 'ws-deltrav'
    ws.mkdir()
    victim = tmp_path / 'victim-dir'
    _mkSkillDir(victim, 'keep', 'victim sibling', body='Survive.')
    _mkSkillDir(ws / '.aug' / 'skills', 'innocent', 'innocent project skill')
    for bad in ('..', '../..', '..\\..\\..', 'a/b', 'a\\b'):
        with pytest.raises(SkillValidationError):
            skill_service.deleteSkill(bad, str(ws))
    assert victim.exists() and (victim / 'keep' / 'SKILL.md').exists()
    assert (ws / '.aug' / 'skills' / 'innocent' / 'SKILL.md').exists()


def test_delete_refused_when_no_project_override(isolated, tmp_path):
    ws = tmp_path / 'ws-delref'
    ws.mkdir()
    _mkSkillDir(isolated, 'del-refuse', 'global only', body='Global.')
    try:
        with pytest.raises(SkillValidationError, match='global scope instead'):
            skill_service.deleteSkill('del-refuse', str(ws))
        # global untouched
        assert skill_service.get('del-refuse') is not None
    finally:
        shutil.rmtree(isolated / 'del-refuse', ignore_errors=True)
        skill_service._bust_prompt_skills_cache()


def test_delete_project_only_skill(isolated, tmp_path):
    # A skill that ONLY exists in the project root: deleteSkill(ws) removes
    # it (project scope); without ws the agent-root path finds nothing.
    ws = tmp_path / 'ws-delproj'
    ws.mkdir()
    _mkSkillDir(ws / '.aug' / 'skills', 'del-projonly', 'project only', body='P.')
    try:
        with pytest.raises(SkillValidationError):
            skill_service.deleteSkill('del-projonly')  # no ws → agent root → not found
        out = skill_service.deleteSkill('del-projonly', str(ws))
        assert out['scope'] == 'project'
        assert skill_service.get('del-projonly', str(ws)) is None
    finally:
        _cleanProject(ws)


# ----------------------------------------------------- relevant-skills merge


def test_relevant_skills_block_ranks_project_skills(isolated, tmp_path):
    from app.services.capabilities_prompt import build_relevant_skills_block

    ws = tmp_path / 'ws-rel'
    ws.mkdir()
    _mkSkillDir(
        ws / '.aug' / 'skills',
        'ws-xyzzy-releases',
        'quux blorple build release helper',
    )
    try:
        block = build_relevant_skills_block('how do I quux the blorple release?', str(ws))
        assert 'ws-xyzzy-releases' in block
        # without the workspace the project skill is not offered
        block2 = build_relevant_skills_block('how do I quux the blorple release?')
        assert 'ws-xyzzy-releases' not in block2
    finally:
        _cleanProject(ws)
        skill_service._bust_prompt_skills_cache()


# ------------------------------------------------- model-facing tool handlers


async def test_load_list_skills_resolve_session_workspace(isolated, tmp_path):
    from app.services.tool_registrations.skill_tools import _listSkills, _loadSkill
    from app.services.workbench import workbench as wb
    from app.services.workbench.context import currentSessionId

    ws = tmp_path / 'ws-tools'
    ws.mkdir()
    _mkSkillDir(ws / '.aug' / 'skills', 'tool-proj', 'quux tool helper', body='Tool body.')
    session = wb.createWorkbenchSession(workspacePath=str(ws))
    sid = str(session.id)
    token = currentSessionId.set(sid)
    try:
        listing = await _listSkills('')
        assert 'tool-proj' in listing
        body = await _loadSkill('tool-proj')
        assert 'Tool body.' in body
    finally:
        currentSessionId.reset(token)
        wb.deleteWorkbenchSession(sid)
        _cleanProject(ws)


async def test_load_skill_gets_project_copy_of_shadowed_name(isolated, tmp_path):
    """Shadowing holds through the model-facing tool path: load_skill on a
    shadowed name returns the PROJECT copy, never the global one."""
    from app.services.tool_registrations.skill_tools import _listSkills, _loadSkill
    from app.services.workbench import workbench as wb
    from app.services.workbench.context import currentSessionId

    ws = tmp_path / 'ws-toolshadow'
    ws.mkdir()
    _mkSkillDir(isolated, 'tool-shadow', 'global tool copy', body='Global tool body.')
    _mkSkillDir(ws / '.aug' / 'skills', 'tool-shadow', 'project tool copy', body='Proj tool body.')
    session = wb.createWorkbenchSession(workspacePath=str(ws))
    sid = str(session.id)
    token = currentSessionId.set(sid)
    try:
        body = await _loadSkill('tool-shadow')
        assert 'Proj tool body' in body
        assert 'Global tool body' not in body
        listing = await _listSkills('')
        assert 'tool-shadow' in listing
    finally:
        currentSessionId.reset(token)
        wb.deleteWorkbenchSession(sid)
        _cleanProject(ws)
