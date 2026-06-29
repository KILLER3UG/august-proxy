"""
Skill manifest — builds the skill catalogue and loads SKILL.md payloads (Phase 3).

The manifest is an ultra-lightweight text description of every available skill
that lives in the system prompt (Tier 1 <user_state>). The payload loader
reads the full SKILL.md content for BM25-auto-primed skills and returns
concatenated content for <primed_playbooks> (Tier 3).
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any


# ── Manifest builder ────────────────────────────────────────────────────


def build_skill_manifest(skills: list[dict]) -> str:
    """Build an ultra-lightweight text manifest.

    Format: 'skill_name: description'
    ~800 tokens for 100 skills. Always in system prompt.
    """
    if not skills:
        return ""

    lines: list[str] = []
    for s in skills:
        name = s.get("name", "") if isinstance(s, dict) else str(s)
        desc = s.get("description", "") if isinstance(s, dict) else ""
        trigger = s.get("trigger", "") if isinstance(s, dict) else ""

        if desc:
            line = f"{name}: {desc}"
        else:
            line = name
        if trigger:
            line += f" (trigger: {trigger})"
        lines.append(line)

    return "\n".join(lines)


# ── Payload loader (mtime-cached) ───────────────────────────────────────


_cache: dict[str, str] = {}       # name → content
_mtime_cache: dict[str, float] = {}  # path → last mtime


def load_skill_payloads(skill_names: list[str], skills_dir: str | Path | None = None) -> str:
    """Read SKILL.md files for the given skill names.

    Returns concatenated content. Cached by file mtime — skills don't change
    often, so we avoid re-reading on every assembly.

    ``skills_dir``: path to the skills directory. Defaults to
    ``data/skills/`` relative to the project root.
    """
    if not skill_names:
        return ""

    if skills_dir is None:
        from app.config import settings
        skills_dir = settings.data_dir / "skills"

    skills_dir = Path(skills_dir)
    if not skills_dir.exists():
        return ""

    parts: list[str] = []
    for name in skill_names:
        # Check cache first
        cached = _cache.get(name)
        if cached is not None:
            parts.append(cached)
            continue

        # Find the SKILL.md file
        skill_dir = skills_dir / name
        skill_file = skill_dir / "SKILL.md"
        if not skill_file.exists():
            # Try as a flat file
            skill_file = skills_dir / f"{name}.md"
        if not skill_file.exists():
            continue

        # Check mtime
        try:
            mtime = skill_file.stat().st_mtime
            cached_mtime = _mtime_cache.get(str(skill_file))
            if cached_mtime == mtime and name in _cache:
                parts.append(_cache[name])
                continue
        except OSError:
            pass

        try:
            content = skill_file.read_text(encoding="utf-8")
            _cache[name] = content
            try:
                _mtime_cache[str(skill_file)] = skill_file.stat().st_mtime
            except OSError:
                pass
            parts.append(content)
        except Exception:
            pass

    return "\n\n---\n\n".join(parts)


def clear_cache() -> None:
    """Clear the mtime cache (e.g., after a skill is added/removed)."""
    _cache.clear()
    _mtime_cache.clear()
