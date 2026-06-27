"""Skill authoring surface tests (C1).

Behavior-focused: create/patch/delete/write_file/remove_file, validation,
copy-on-write for bundled skills, and the skill_manage tool + REST router.
Tests never touch the repo's real skills/ dir — both roots are redirected.
"""
import pytest

from app.services import skill_service
from app.services.skill_service import SkillValidationError


@pytest.fixture
def isolated_skills(tmp_path, monkeypatch):
    """Redirect both skill roots to temp dirs."""
    agent_root = tmp_path / "agent-skills"
    bundled_root = tmp_path / "bundled-skills"
    agent_root.mkdir()
    bundled_root.mkdir()
    monkeypatch.setattr(skill_service, "_agent_skills_dir", lambda: agent_root)
    monkeypatch.setattr(skill_service, "SKILLS_DIR", bundled_root)
    return agent_root, bundled_root


# ── skill_service unit tests ──────────────────────────────────────────


def test_create_skill_round_trip(isolated_skills):
    agent_root, _ = isolated_skills
    skill = skill_service.create_skill(
        "py-test-thing", "Does a useful thing for tests.",
        "## When to Use\n\nWhen testing skill creation.\n",
        category="test",
    )
    assert skill["name"] == "py-test-thing"
    assert skill.get("created_by") == "agent"

    names = [s["name"] for s in skill_service.list_all()]
    assert "py-test-thing" in names

    fetched = skill_service.get("py-test-thing")
    assert fetched is not None
    assert "testing skill creation" in fetched["instructions"]
    assert (agent_root / "py-test-thing" / "SKILL.md").exists()


def test_create_skill_validation(isolated_skills):
    with pytest.raises(SkillValidationError):  # uppercase + space
        skill_service.create_skill("Bad Name", "Valid desc.", "body")
    with pytest.raises(SkillValidationError):  # description > 60 chars
        skill_service.create_skill("ok", "x" * 61, "body")
    with pytest.raises(SkillValidationError):  # marketing words
        skill_service.create_skill("ok", "A powerful seamless tool", "body")
    with pytest.raises(SkillValidationError):  # empty body
        skill_service.create_skill("ok", "Valid desc.", "   ")


def test_duplicate_create_refused(isolated_skills):
    skill_service.create_skill("dup", "First one.", "body")
    with pytest.raises(SkillValidationError):
        skill_service.create_skill("dup", "Second one.", "body")


def test_patch_skill_copy_on_write_bundled(isolated_skills):
    _, bundled_root = isolated_skills
    bdir = bundled_root / "bundled-thing"
    bdir.mkdir()
    (bdir / "SKILL.md").write_text(
        "---\nname: bundled-thing\ndescription: A bundled skill.\n---\n\nOld body.\n",
        "utf-8",
    )

    skill_service.patch_skill("bundled-thing", body="## When to Use\n\nNew body.\n")

    # bundled original untouched (copy-on-write)
    assert "Old body." in (bundled_root / "bundled-thing" / "SKILL.md").read_text("utf-8")
    fetched = skill_service.get("bundled-thing")
    assert "New body." in fetched["instructions"]
    assert "Old body." not in fetched["instructions"]


def test_patch_skill_agent(isolated_skills):
    skill_service.create_skill("ap", "Agent patch.", "Original body.")
    skill_service.patch_skill("ap", body="Updated body.")
    fetched = skill_service.get("ap")
    assert "Updated body." in fetched["instructions"]
    assert "Original body." not in fetched["instructions"]


def test_write_and_remove_skill_file(isolated_skills):
    skill_service.create_skill("files", "Has support files.", "body.")
    skill_service.write_skill_file("files", "scripts/run.py", "print('hi')")

    with pytest.raises(SkillValidationError):  # path traversal refused
        skill_service.write_skill_file("files", "../escape.txt", "x")

    skill_service.remove_skill_file("files", "scripts/run.py")
    with pytest.raises(SkillValidationError):  # already gone
        skill_service.remove_skill_file("files", "scripts/run.py")
    with pytest.raises(SkillValidationError):  # SKILL.md protected
        skill_service.remove_skill_file("files", "SKILL.md")


def test_delete_skill_agent_only(isolated_skills):
    _, bundled_root = isolated_skills
    bdir = bundled_root / "bundled-del"
    bdir.mkdir()
    (bdir / "SKILL.md").write_text(
        "---\nname: bundled-del\ndescription: x.\n---\n\nbody\n", "utf-8"
    )
    with pytest.raises(SkillValidationError):  # bundled refused
        skill_service.delete_skill("bundled-del")

    skill_service.create_skill("agent-del", "To be deleted.", "body.")
    result = skill_service.delete_skill("agent-del")
    assert result["deleted"] is True
    assert skill_service.get("agent-del") is None


# ── skill_manage tool handler ─────────────────────────────────────────


@pytest.mark.asyncio
async def test_skill_manage_tool_create_patch_delete(isolated_skills):
    from app.services.tool_definitions import _skill_manage

    out = await _skill_manage("create", name="tool-skill", description="Via tool.", body="body.")
    assert "Created skill 'tool-skill'" in out
    assert skill_service.get("tool-skill") is not None

    out = await _skill_manage("patch", name="tool-skill", body="Patched body.")
    assert "Patched skill 'tool-skill'" in out
    assert "Patched body." in skill_service.get("tool-skill")["instructions"]

    out = await _skill_manage("delete", name="tool-skill")
    assert "Deleted skill 'tool-skill'" in out
    assert skill_service.get("tool-skill") is None


@pytest.mark.asyncio
async def test_skill_manage_tool_validation_surface(isolated_skills):
    from app.services.tool_definitions import _skill_manage

    out = await _skill_manage("create", name="UPPER", description="ok.", body="body.")
    assert out.startswith("Error:")
    out = await _skill_manage("bogus", name="x", description="ok.", body="body.")
    assert "unknown skill_manage action" in out


# ── REST router ───────────────────────────────────────────────────────


def _client():
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from app.routers import skills as skills_router
    app = FastAPI()
    app.include_router(skills_router.router)
    return TestClient(app)


def test_skills_router_create_get_delete(isolated_skills):
    client = _client()
    r = client.post("/api/skills", json={
        "name": "r-skill", "description": "Via router.", "body": "body.",
    })
    assert r.status_code == 200, r.text

    r = client.get("/api/skills/r-skill")
    assert r.status_code == 200
    assert r.json()["name"] == "r-skill"

    r = client.delete("/api/skills/r-skill")
    assert r.status_code == 200
    r = client.get("/api/skills/r-skill")
    assert r.status_code == 404


def test_skills_router_validation_400(isolated_skills):
    client = _client()
    r = client.post("/api/skills", json={
        "name": "Bad Name", "description": "ok.", "body": "body.",
    })
    assert r.status_code == 400
