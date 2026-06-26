"""
Skill service — discover, load, search skills from skills/ directory.
"""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any, Optional

SKILLS_DIR = Path(__file__).resolve().parent.parent.parent.parent / "skills"


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
        "instructions": body,
        "updatedAt": stat.st_mtime,
    }


def list_all() -> list[dict[str, Any]]:
    """Discover all skills from the skills/ directory."""
    if not SKILLS_DIR.is_dir():
        return []

    skills = []
    for entry in sorted(SKILLS_DIR.iterdir()):
        if not entry.is_dir():
            continue
        md = entry / "SKILL.md"
        if md.exists():
            parsed = _parse_skill(md)
            if parsed:
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
    """Get a single skill by name."""
    for s in list_all():
        if s["name"] == name:
            return s
    return None
