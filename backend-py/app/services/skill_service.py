"""
Skill service — discover, load, search, and author skills.

Skills are markdown directories (one SKILL.md each). Two roots are scanned:
  * BUNDLED  — <repo>/skills/         (built-in skills shipped with the repo)
  * AGENT    — <data_dir>/skills/     (agent-authored skills; lessons live here)

Agent-authored skills carry ``created_by: agent`` provenance so the curator
(C3) can manage their lifecycle without touching built-ins. Both roots are
read by list_all/get so the model can load lessons as skills.
"""

from __future__ import annotations

import re
import shutil
from pathlib import Path
from typing import Any, Optional

SKILLS_DIR = Path(__file__).resolve().parent.parent.parent.parent / "skills"


def _agent_skills_dir() -> Path:
    """Agent-authored skills root. Lazily reads the configured data_dir."""
    try:
        from app.config import settings  # local import avoids cycles
        base = Path(settings.data_dir)
    except Exception:
        base = SKILLS_DIR.parent / "data"
    return base / "skills"


def _skill_roots() -> list[Path]:
    """Search roots in precedence order — agent first wins on name clash."""
    return [_agent_skills_dir(), SKILLS_DIR]


# ── Authoring standards (ported from backend/services/skills/learn-command.js) ──

_NAME_PATTERN = re.compile(r"^[a-z0-9][a-z0-9._-]*$")
_NAME_MAX = 64
_DESCRIPTION_MAX = 60
_MARKETING_WORDS = [
    "revolutionary", "cutting-edge", "state-of-the-art", "best-in-class",
    "game-changing", "transformative", "innovative", "powerful", "advanced",
    "seamless", "intuitive", "robust", "enterprise-grade", "world-class",
]
_BODY_SECTION_ORDER = [
    "Title", "When to Use", "Prerequisites", "How to Run",
    "Quick Reference", "Procedure", "Pitfalls", "Verification",
]


class SkillValidationError(ValueError):
    """Raised when a skill fails authoring-standards validation."""


def _validate_name(name: str) -> None:
    if not name:
        raise SkillValidationError("Skill name is required.")
    if len(name) > _NAME_MAX:
        raise SkillValidationError(f"Skill name exceeds {_NAME_MAX} chars.")
    if not _NAME_PATTERN.match(name):
        raise SkillValidationError(
            "Skill name must match ^[a-z0-9][a-z0-9._-]*$ (lowercase, dotted/hyphenated)."
        )


def _validate_description(description: str) -> None:
    if not description:
        raise SkillValidationError("Skill description is required.")
    desc = description.strip()
    if len(desc) > _DESCRIPTION_MAX:
        raise SkillValidationError(
            f"Skill description exceeds {_DESCRIPTION_MAX} chars (got {len(desc)})."
        )
    lowered = desc.lower()
    found = [w for w in _MARKETING_WORDS if w in lowered]
    if found:
        raise SkillValidationError(
            f"Skill description contains marketing words: {', '.join(found)}."
        )


# ── Parsing / rendering ───────────────────────────────────────────────


def _parse_skill(path: Path) -> Optional[dict[str, Any]]:
    try:
        text = path.read_text("utf-8")
    except Exception:
        return None

    m = re.match(r"^---\s*\n(.*?)\n---\s*\n(.*)", text, re.DOTALL)
    if not m:
        return None

    frontmatter = {}
    for line in m.group(1).split("\n"):
        if ":" in line:
            key, _, val = line.partition(":")
            frontmatter[key.strip()] = val.strip()

    body = m.group(2).strip()
    if not body:
        return None

    stat = path.stat()
    return {
        "name": frontmatter.get("name", path.parent.name),
        "description": frontmatter.get("description", ""),
        "trigger": frontmatter.get("trigger", ""),
        "category": frontmatter.get("category", "uncategorized"),
        "enabled": frontmatter.get("disabled", "false").lower() != "true",
        "created_by": frontmatter.get("created_by", ""),
        "instructions": body,
        "path": str(path),
        "updatedAt": stat.st_mtime,
    }


def _render_skill_md(frontmatter: dict[str, Any], body: str) -> str:
    lines = ["---"]
    for key in ("name", "description", "trigger", "category", "created_by"):
        val = frontmatter.get(key)
        if val:
            lines.append(f"{key}: {val}")
    lines.append("---")
    lines.append("")
    lines.append(body.strip())
    return "\n".join(lines) + "\n"


def _skill_md_path(name: str, *, create_roots: bool = False) -> Optional[Path]:
    """Resolve the SKILL.md path for an existing skill across roots."""
    for root in _skill_roots():
        md = root / name / "SKILL.md"
        if md.exists():
            return md
    return None


def _agent_skill_dir(name: str) -> Path:
    return _agent_skills_dir() / name


# ── Read API ──────────────────────────────────────────────────────────


def list_all() -> list[dict[str, Any]]:
    """Discover all skills from both the agent and bundled roots."""
    skills: list[dict[str, Any]] = []
    seen: set[str] = set()
    for root in _skill_roots():
        if not root.is_dir():
            continue
        for entry in sorted(root.iterdir()):
            if not entry.is_dir():
                continue
            md = entry / "SKILL.md"
            if not md.exists():
                continue
            parsed = _parse_skill(md)
            if not parsed:
                continue
            if parsed["name"] in seen:
                continue  # agent-root copy already wins
            seen.add(parsed["name"])
            skills.append(parsed)
    return skills


def search(query: str = "", category: str = "", enabled_only: bool = True) -> list[dict[str, Any]]:
    """Search skills by name, description, trigger, or category."""
    all_skills = list_all()
    q = query.lower().strip()

    results = []
    for s in all_skills:
        if enabled_only and not s["enabled"]:
            continue
        if category and s.get("category", "") != category:
            continue
        if q:
            if (q in s["name"].lower()
                    or q in s.get("description", "").lower()
                    or q in s.get("trigger", "").lower()):
                results.append(s)
        else:
            results.append(s)
    return results


def get(name: str) -> Optional[dict[str, Any]]:
    """Get a single skill by name (agent root takes precedence)."""
    for s in list_all():
        if s["name"] == name:
            return s
    return None


# ── Authoring API (create / patch / delete / write_file / remove_file) ──


def _ensure_agent_root() -> Path:
    root = _agent_skills_dir()
    root.mkdir(parents=True, exist_ok=True)
    return root


def _copy_on_write(name: str) -> Path:
    """If a skill only exists in the bundled root, copy it to the agent root
    so it can be patched/extended without mutating built-ins. Returns the
    agent-root skill directory."""
    agent_dir = _agent_skill_dir(name)
    if agent_dir.exists():
        return agent_dir
    bundled_md = SKILLS_DIR / name / "SKILL.md"
    if not bundled_md.exists():
        raise SkillValidationError(
            f"Skill '{name}' not found; cannot patch a non-existent skill."
        )
    _ensure_agent_root()
    bundled_dir = bundled_md.parent
    shutil.copytree(bundled_dir, agent_dir)
    return agent_dir


def _safe_join(skill_dir: Path, rel_path: str) -> Path:
    """Join rel_path under skill_dir, refusing traversal escapes."""
    target = (skill_dir / rel_path).resolve()
    if not target.is_relative_to(skill_dir.resolve()):
        raise SkillValidationError(
            f"file_path '{rel_path}' escapes the skill directory."
        )
    return target


def create_skill(
    name: str,
    description: str,
    body: str,
    *,
    trigger: str = "",
    category: str = "uncategorized",
    created_by: str = "agent",
) -> dict[str, Any]:
    """Create a new agent-authored skill."""
    _validate_name(name)
    _validate_description(description)
    if not body.strip():
        raise SkillValidationError("Skill body is required.")

    if get(name):
        raise SkillValidationError(f"Skill '{name}' already exists.")

    agent_dir = _ensure_agent_root() / name
    agent_dir.mkdir(parents=True, exist_ok=False)
    frontmatter = {
        "name": name,
        "description": description.strip(),
        "trigger": trigger.strip(),
        "category": category.strip() or "uncategorized",
        "created_by": created_by,
    }
    (agent_dir / "SKILL.md").write_text(_render_skill_md(frontmatter, body), "utf-8")
    parsed = _parse_skill(agent_dir / "SKILL.md")
    return parsed or {"name": name, "description": description}


def patch_skill(
    name: str,
    *,
    body: Optional[str] = None,
    description: Optional[str] = None,
    trigger: Optional[str] = None,
    category: Optional[str] = None,
) -> dict[str, Any]:
    """Patch an existing skill (copy-on-write for bundled skills)."""
    existing = get(name)
    if not existing:
        raise SkillValidationError(f"Skill '{name}' not found.")

    if description is not None:
        _validate_description(description)

    agent_dir = _copy_on_write(name)
    md = agent_dir / "SKILL.md"
    text = md.read_text("utf-8")
    m = re.match(r"^---\s*\n(.*?)\n---\s*\n(.*)", text, re.DOTALL)
    if not m:
        raise SkillValidationError(f"Skill '{name}' has malformed frontmatter.")
    frontmatter: dict[str, Any] = {}
    for line in m.group(1).split("\n"):
        if ":" in line:
            key, _, val = line.partition(":")
            frontmatter[key.strip()] = val.strip()
    current_body = m.group(2).strip()

    if description is not None:
        frontmatter["description"] = description.strip()
    if trigger is not None:
        frontmatter["trigger"] = trigger.strip()
    if category is not None:
        frontmatter["category"] = (category.strip() or "uncategorized")
    frontmatter.setdefault("created_by", "agent")

    new_body = current_body if body is None else body.strip()
    md.write_text(_render_skill_md(frontmatter, new_body), "utf-8")
    parsed = _parse_skill(md)
    return parsed or {"name": name, "description": frontmatter.get("description", "")}


def write_skill_file(name: str, file_path: str, content: str) -> dict[str, Any]:
    """Write a support file (scripts/ references/ templates/) into a skill dir."""
    if not get(name):
        raise SkillValidationError(f"Skill '{name}' not found.")
    agent_dir = _copy_on_write(name)
    target = _safe_join(agent_dir, file_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, "utf-8")
    return {"name": name, "file": file_path, "bytes": len(content)}


def remove_skill_file(name: str, file_path: str) -> dict[str, Any]:
    """Remove a support file from a skill dir (SKILL.md itself is untouched)."""
    if not get(name):
        raise SkillValidationError(f"Skill '{name}' not found.")
    agent_dir = _copy_on_write(name)
    target = _safe_join(agent_dir, file_path)
    if target.name == "SKILL.md":
        raise SkillValidationError("Use delete_skill to remove a skill, not remove_skill_file.")
    if not target.exists():
        raise SkillValidationError(f"File '{file_path}' not found in skill '{name}'.")
    target.unlink()
    return {"name": name, "removed": file_path}


def delete_skill(name: str) -> dict[str, Any]:
    """Delete an agent-authored skill. Refuses bundled skills."""
    agent_dir = _agent_skill_dir(name)
    if not agent_dir.exists():
        bundled = SKILLS_DIR / name
        if bundled.exists():
            raise SkillValidationError(
                f"Refusing to delete bundled skill '{name}'. Archive via the curator instead."
            )
        raise SkillValidationError(f"Skill '{name}' not found.")
    shutil.rmtree(agent_dir)
    return {"name": name, "deleted": True}
