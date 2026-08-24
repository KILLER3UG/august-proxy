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
from pathlib import Path
from typing import Optional

from app.json_narrowing import as_str

SKILLS_DIR = Path(__file__).resolve().parent.parent.parent.parent / 'skills'


def _agentSkillsDir() -> Path:
    """Agent-authored skills root. Lazily reads the configured data_dir."""
    try:
        from app.config import settings

        base = Path(settings.dataDir)
    except Exception:
        base = SKILLS_DIR.parent / 'data'
    return base / 'skills'


def _skillRoots() -> list[Path]:
    """Search roots in precedence order — agent first wins on name clash."""
    return [_agentSkillsDir(), SKILLS_DIR]


_NAMEPattern = re.compile('^[a-z0-9][a-z0-9._-]*$')
_NAMEMax = 64
_flat_migrate_done = False
# Catalogue memoization (latency pass 0.16.8): keyed on skill-root dir mtimes
# so create/patch/delete invalidates automatically without explicit busts.
_cat_cache: list[dict[str, object]] | None = None
_cat_cache_key: tuple | None = None


def _root_mtime(root: Path) -> float:
    try:
        return root.stat().st_mtime
    except OSError:
        return 0.0


def _bust_catalogue_cache() -> None:
    """Invalidate the catalogue memo (create/patch/delete paths).

    Root-dir mtime catches folder-level changes, but editing a SKILL.md
    INSIDE a skill folder does not touch the root — so mutations call this
    explicitly.
    """
    global _cat_cache, _cat_cache_key
    _cat_cache = None
    _cat_cache_key = None


_DESCRIPTIONMax = 60
_MARKETINGWords = [
    'revolutionary',
    'cutting-edge',
    'state-of-the-art',
    'best-in-class',
    'game-changing',
    'transformative',
    'innovative',
    'powerful',
    'advanced',
    'seamless',
    'intuitive',
    'robust',
    'enterprise-grade',
    'world-class',
]
_BODYSectionOrder = [
    'Title',
    'When to Use',
    'Prerequisites',
    'How to Run',
    'Quick Reference',
    'Procedure',
    'Pitfalls',
    'Verification',
]


class SkillValidationError(ValueError):
    """Raised when a skill fails authoring-standards validation."""



def _validateName(name: str) -> None:
    if not name:
        raise SkillValidationError('Skill name is required.')
    if len(name) > _NAMEMax:
        raise SkillValidationError(f'Skill name exceeds {_NAMEMax} chars.')
    if not _NAMEPattern.match(name):
        raise SkillValidationError('Skill name must match ^[a-z0-9][a-z0-9._-]*$ (lowercase, dotted/hyphenated).')


def _validateDescription(description: str) -> None:
    if not description:
        raise SkillValidationError('Skill description is required.')
    desc = description.strip()
    if len(desc) > _DESCRIPTIONMax:
        raise SkillValidationError(f'Skill description exceeds {_DESCRIPTIONMax} chars (got {len(desc)}).')
    lowered = desc.lower()
    found = [w for w in _MARKETINGWords if w in lowered]
    if found:
        raise SkillValidationError(f'Skill description contains marketing words: {", ".join(found)}.')



def _parseSkill(path: Path) -> Optional[dict[str, object]]:
    try:
        text = path.read_text('utf-8')
    except Exception:
        return None
    m = re.match('^---\\s*\\n(.*?)\\n---\\s*\\n(.*)', text, re.DOTALL)
    if not m:
        return None
    frontmatter = {}
    for line in m.group(1).split('\n'):
        if ':' in line:
            key, __, val = line.partition(':')
            frontmatter[key.strip()] = val.strip()
    body = m.group(2).strip()
    if not body:
        return None
    stat = path.stat()
    return {
        'name': frontmatter.get('name', path.parent.name),
        'description': frontmatter.get('description', ''),
        'trigger': frontmatter.get('trigger', ''),
        'category': frontmatter.get('category', 'uncategorized'),
        'enabled': frontmatter.get('disabled', 'false').lower() != 'true',
        'created_by': frontmatter.get('created_by', ''),
        'instructions': body,
        'path': str(path),
        'updatedAt': stat.st_mtime,
    }



def list_all() -> list[dict[str, object]]:
    """Discover all skills from both the agent and bundled roots."""
    global _flat_migrate_done
    if not _flat_migrate_done:
        _flat_migrate_done = True
        try:
            migrate_flat_skills()
        except Exception:
            pass
    skills: list[dict[str, object]] = []
    seen: set[str] = set()
    for root in _skillRoots():
        if not root.is_dir():
            continue
        for entry in sorted(root.iterdir()):
            if not entry.is_dir():
                continue
            md = entry / 'SKILL.md'
            if not md.exists():
                continue
            parsed = _parseSkill(md)
            if not parsed:
                continue
            if as_str(parsed['name'], '') in seen:
                continue
            seen.add(as_str(parsed['name'], ''))
            skills.append(parsed)
    return skills


def search(query: str = '', category: str = '', enabledOnly: bool = True) -> list[dict[str, object]]:
    """Search skills by name, description, trigger, or category."""
    allSkills = list_all()
    q = query.lower().strip()
    results = []
    for s in allSkills:
        if enabledOnly and (not s['enabled']):
            continue
        if category and s.get('category', '') != category:
            continue
        if q:
            if (
                q in as_str(s['name'], '').lower()
                or q in as_str(s.get('description'), '').lower()
                or q in as_str(s.get('trigger'), '').lower()
            ):
                results.append(s)
        else:
            results.append(s)
    return results


def get(name: str) -> Optional[dict[str, object]]:
    """Get a single skill by name (agent root takes precedence)."""
    for s in list_all():
        if s['name'] == name:
            return s
    return None


def load_bodies(names: list[str], *, max_chars: int = 24000) -> str:
    """Concatenate SKILL.md bodies for worker preload (progressive disclosure skip)."""
    parts: list[str] = []
    used = 0
    for raw in names:
        name = str(raw or '').strip()
        if not name:
            continue
        skill = get(name)
        if not skill:
            parts.append(f'## skill:{name}\n(not found)')
            continue
        body = str(skill.get('instructions') or skill.get('body') or skill.get('content') or '')
        chunk = f'## skill:{name}\n{body}'.strip()
        if used + len(chunk) > max_chars:
            parts.append(f'## skill:{name}\n(truncated — remaining budget {max(0, max_chars - used)})')
            break
        parts.append(chunk)
        used += len(chunk)
    return '\n\n'.join(parts)


def catalogue() -> list[dict[str, object]]:
    """Compact metadata for every discoverable skill — the skill catalogue.

    Following the Claude-Code progressive-disclosure pattern: only this
    lightweight metadata (name + description + optional trigger) is placed
    in the system prompt so the model knows what skills exist. The full
    SKILL.md body is loaded on demand via the ``load_skill`` tool when the
    model decides a skill is relevant.

    All discoverable skills are surfaced (not just ``enabled`` ones) —
    discovery is the standard. Returns entries sorted by name for stable
    prompt output. Includes ``created_by`` so evolving/agent-authored skills
    can be labeled in the prompt.

    Latency pass 0.16.8: results are memoized against the skill roots'
    mtimes (a cold build parses ~84 SKILL.md files ≈ 0.5s and this used to
    run on MANY turns via the Tier-3 relevance pass). Any create/patch/
    delete bumps the roots' mtime → next call rebuilds automatically.
    """
    global _cat_cache, _cat_cache_key
    try:
        roots = tuple(str(r) for r in _skillRoots())
        marks = tuple(_root_mtime(r) for r in _skillRoots())
        key = (roots, marks)
    except Exception:
        key = None
    if key is not None and _cat_cache is not None and _cat_cache_key == key:
        return _cat_cache
    entries = [
        {
            'name': s['name'],
            'description': s.get('description', ''),
            'trigger': s.get('trigger', ''),
            'category': s.get('category', 'uncategorized'),
            'created_by': s.get('created_by', ''),
        }
        for s in list_all()
    ]
    out = sorted(entries, key=lambda e: as_str(e.get('name'), ''))
    if key is not None:
        _cat_cache = out
        _cat_cache_key = key
    return out


def skill_body(name: str) -> str | None:
    """Full instruction body for a skill, or None when not found."""
    sk = get(name)
    return as_str(sk.get('instructions'), '') if sk else None


def _bust_prompt_skills_cache() -> None:
    """Global bust of skills-related prompt caches.

    Clears the catalogue memo, the prompt-segments cache, and the Tier 1/2
    prompt cache so newly created/patched evolving skills appear in the next
    turn's ``<capabilities>`` block instead of waiting out any TTL.
    """
    global _cat_cache, _cat_cache_key
    _cat_cache = None
    _cat_cache_key = None
    try:
        from app.services.workbench import prompt_segments_cache

        prompt_segments_cache.clear()
    except Exception:
        pass
    try:
        from app.services.workbench.prompt_cache import getCache

        getCache().clear()
    except Exception:
        pass


def migrate_flat_skills(*, bundled_root: Path | None = None, agent_root: Path | None = None) -> list[str]:
    """Migrate legacy flat ``{root}/{name}.md`` into ``{root}/{name}/SKILL.md``.

    Genesis used to approve into ``skills/{name}.md`` which ``list_all`` never
    discovers. Returns names migrated. No-op when none found.
    """
    migrated: list[str] = []
    roots = [agent_root or _agentSkillsDir(), bundled_root if bundled_root is not None else SKILLS_DIR]
    for root in roots:
        if not root.is_dir():
            continue
        for md in sorted(root.glob('*.md')):
            if md.name.upper() == 'README.MD' or md.name.lower() == 'readme.md':
                continue
            name = md.stem
            try:
                _validateName(name)
            except SkillValidationError:
                # Try kebab-case sanitize for camelCase genesis names
                name = _kebab_name(md.stem)
                try:
                    _validateName(name)
                except SkillValidationError:
                    continue
            dest_dir = root / name
            dest = dest_dir / 'SKILL.md'
            if dest.exists():
                continue
            dest_dir.mkdir(parents=True, exist_ok=True)
            text = md.read_text('utf-8')
            # Ensure frontmatter has created_by for evolving provenance when missing
            parts = text.split('---', 2)
            if len(parts) >= 3 and 'created_by:' not in parts[1]:
                text = text.replace('---\n', '---\ncreated_by: agent\n', 1)
            elif not text.lstrip().startswith('---'):
                text = (
                    f'---\nname: {name}\ndescription: Migrated skill\n'
                    f'created_by: agent\ncategory: uncategorized\n---\n\n{text}'
                )
            dest.write_text(text, 'utf-8')
            try:
                md.unlink()
            except Exception:
                pass
            migrated.append(name)
    if migrated:
        _bust_prompt_skills_cache()
    return migrated


def _kebab_name(name: str) -> str:
    """Normalize camelCase / spaced names to kebab-case for skill_service rules."""
    import re

    s = name.strip()
    if not s:
        return ''
    # Insert hyphen before capitals in camelCase
    s = re.sub('([a-z0-9])([A-Z])', r'\1-\2', s)
    s = re.sub('[^a-zA-Z0-9]+', '-', s)
    s = s.lower().strip('-')
    return s[:64]


# ── Authoring (create / patch / delete) — restored 0.17.0 ─────────────────


def _renderSkillMd(frontmatter: dict[str, str], body: str) -> str:
    lines = ['---']
    for key in ('name', 'description', 'trigger', 'category', 'created_by', 'disabled'):
        val = frontmatter.get(key)
        if val:
            lines.append(f'{key}: {val}')
    lines.append('---')
    lines.append('')
    lines.append(body.strip())
    return '\n'.join(lines) + '\n'


def _agentSkillDir(name: str) -> Path:
    return _agentSkillsDir() / name


def _ensureAgentRoot() -> Path:
    root = _agentSkillsDir()
    root.mkdir(parents=True, exist_ok=True)
    return root


def _copyOnWrite(name: str) -> Path:
    """If a skill only exists in the bundled root, copy it to the agent root
    so it can be patched/extended without mutating built-ins. Returns the
    agent-root skill directory."""
    import shutil

    agent_dir = _agentSkillDir(name)
    if agent_dir.exists():
        return agent_dir
    bundled_md = SKILLS_DIR / name / 'SKILL.md'
    if not bundled_md.exists():
        raise SkillValidationError(f"Skill '{name}' not found; cannot patch a non-existent skill.")
    _ensureAgentRoot()
    shutil.copytree(bundled_md.parent, agent_dir)
    return agent_dir


def createSkill(
    name: str,
    description: str,
    body: str,
    *,
    trigger: str = '',
    category: str = 'uncategorized',
    created_by: str = 'agent',
) -> dict[str, object]:
    """Create a new agent-authored skill."""
    _validateName(name)
    _validateDescription(description)
    if not body.strip():
        raise SkillValidationError('Skill body is required.')
    if get(name):
        raise SkillValidationError(f"Skill '{name}' already exists.")
    agent_dir = _ensureAgentRoot() / name
    agent_dir.mkdir(parents=True, exist_ok=False)
    frontmatter = {
        'name': name,
        'description': description.strip(),
        'trigger': trigger.strip(),
        'category': category.strip() or 'uncategorized',
        'created_by': created_by,
    }
    md = agent_dir / 'SKILL.md'
    md.write_text(_renderSkillMd(frontmatter, body), 'utf-8')
    parsed = _parseSkill(md)
    _bust_prompt_skills_cache()
    return parsed or {'name': name, 'description': description}


def patchSkill(
    name: str,
    *,
    body: Optional[str] = None,
    description: Optional[str] = None,
    trigger: Optional[str] = None,
    category: Optional[str] = None,
) -> dict[str, object]:
    """Patch an existing skill (copy-on-write for bundled skills)."""
    existing = get(name)
    if not existing:
        raise SkillValidationError(f"Skill '{name}' not found.")
    if description is not None:
        _validateDescription(description)
    agent_dir = _copyOnWrite(name)
    md = agent_dir / 'SKILL.md'
    text = md.read_text('utf-8')
    m = re.match('^---\\s*\\n(.*?)\\n---\\s*\\n(.*)', text, re.DOTALL)
    if not m:
        raise SkillValidationError(f"Skill '{name}' has malformed frontmatter.")
    frontmatter: dict[str, str] = {}
    for line in m.group(1).split('\n'):
        if ':' in line:
            key, __, val = line.partition(':')
            frontmatter[key.strip()] = val.strip()
    current_body = m.group(2).strip()
    if description is not None:
        frontmatter['description'] = description.strip()
    if trigger is not None:
        frontmatter['trigger'] = trigger.strip()
    if category is not None:
        frontmatter['category'] = category.strip() or 'uncategorized'
    frontmatter.setdefault('created_by', 'agent')
    new_body = current_body if body is None else body.strip()
    md.write_text(_renderSkillMd(frontmatter, new_body), 'utf-8')
    parsed = _parseSkill(md)
    _bust_prompt_skills_cache()
    return parsed or {'name': name, 'description': frontmatter.get('description', '')}


def deleteSkill(name: str) -> dict[str, object]:
    """Delete an agent-authored skill. Refuses bundled skills."""
    import shutil as _shutil

    agent_dir = _agentSkillDir(name)
    if not agent_dir.exists():
        bundled = SKILLS_DIR / name
        if bundled.exists():
            raise SkillValidationError(
                f"Refusing to delete bundled skill '{name}'."
            )
        raise SkillValidationError(f"Skill '{name}' not found.")
    _shutil.rmtree(agent_dir)
    _bust_prompt_skills_cache()
    return {'deleted': name}


def setEnabled(name: str, *, enabled: bool) -> dict[str, object]:
    """Enable/disable a skill by flipping frontmatter ``disabled``.

    Disabled skills stay discoverable in the catalogue (with
    ``enabled: false``) so the settings UI can show them, but are excluded
    from prompt injection. Copy-on-write for bundled skills.
    """
    agent_dir = _copyOnWrite(name)
    md = agent_dir / 'SKILL.md'
    text = md.read_text('utf-8')
    m = re.match('^---\\s*\\n(.*?)\\n---\\s*\\n(.*)', text, re.DOTALL)
    if not m:
        raise SkillValidationError(f"Skill '{name}' has malformed frontmatter.")
    frontmatter: dict[str, str] = {}
    for line in m.group(1).split('\n'):
        if ':' in line:
            key, __, val = line.partition(':')
            frontmatter[key.strip()] = val.strip()
    if enabled:
        frontmatter.pop('disabled', None)
    else:
        frontmatter['disabled'] = 'true'
    md.write_text(_renderSkillMd(frontmatter, m.group(2).strip()), 'utf-8')
    parsed = _parseSkill(md)
    _bust_prompt_skills_cache()
    return parsed or {'name': name, 'enabled': enabled}

