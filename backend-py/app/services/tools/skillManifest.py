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

def buildSkillManifest(skills: list[dict]) -> str:
    """Build an ultra-lightweight text manifest.

    Format: 'skill_name: description'
    ~800 tokens for 100 skills. Always in system prompt.
    """
    if not skills:
        return ''
    lines: list[str] = []
    for s in skills:
        name = s.get('name', '') if isinstance(s, dict) else str(s)
        desc = s.get('description', '') if isinstance(s, dict) else ''
        trigger = s.get('trigger', '') if isinstance(s, dict) else ''
        if desc:
            line = f'{name}: {desc}'
        else:
            line = name
        if trigger:
            line += f' (trigger: {trigger})'
        lines.append(line)
    return '\n'.join(lines)
_cache: dict[str, str] = {}
_mtimeCache: dict[str, float] = {}

def loadSkillPayloads(skillNames: list[str], skillsDir: str | Path | None=None) -> str:
    """Read SKILL.md files for the given skill names.

    Returns concatenated content. Cached by file mtime — skills don't change
    often, so we avoid re-reading on every assembly.

    ``skills_dir``: path to the skills directory. Defaults to
    ``data/skills/`` relative to the project root.
    """
    if not skillNames:
        return ''
    if skillsDir is None:
        from app.config import settings
        skillsDir = settings.dataDir / 'skills'
    skillsDir = Path(skillsDir)
    if not skillsDir.exists():
        return ''
    parts: list[str] = []
    for name in skillNames:
        cached = _cache.get(name)
        if cached is not None:
            parts.append(cached)
            continue
        skillDir = skillsDir / name
        skillFile = skillDir / 'SKILL.md'
        if not skillFile.exists():
            skillFile = skillsDir / f'{name}.md'
        if not skillFile.exists():
            continue
        try:
            mtime = skillFile.stat().st_mtime
            cachedMtime = _mtimeCache.get(str(skillFile))
            if cachedMtime == mtime and name in _cache:
                parts.append(_cache[name])
                continue
        except OSError:
            pass
        try:
            content = skillFile.read_text(encoding='utf-8')
            _cache[name] = content
            try:
                _mtimeCache[str(skillFile)] = skillFile.stat().st_mtime
            except OSError:
                pass
            parts.append(content)
        except Exception:
            pass
    return '\n\n---\n\n'.join(parts)

def clearCache() -> None:
    """Clear the mtime cache (e.g., after a skill is added/removed)."""
    _cache.clear()
    _mtimeCache.clear()