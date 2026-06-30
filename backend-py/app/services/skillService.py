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
from typing import Optional
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
_DESCRIPTIONMax = 60
_MARKETINGWords = ['revolutionary', 'cutting-edge', 'state-of-the-art', 'best-in-class', 'game-changing', 'transformative', 'innovative', 'powerful', 'advanced', 'seamless', 'intuitive', 'robust', 'enterprise-grade', 'world-class']
_BODYSectionOrder = ['Title', 'When to Use', 'Prerequisites', 'How to Run', 'Quick Reference', 'Procedure', 'Pitfalls', 'Verification']

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
        raise SkillValidationError(f"Skill description contains marketing words: {', '.join(found)}.")

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
    return {'name': frontmatter.get('name', path.parent.name), 'description': frontmatter.get('description', ''), 'trigger': frontmatter.get('trigger', ''), 'category': frontmatter.get('category', 'uncategorized'), 'enabled': frontmatter.get('disabled', 'false').lower() != 'true', 'created_by': frontmatter.get('created_by', ''), 'instructions': body, 'path': str(path), 'updatedAt': stat.st_mtime}

def _renderSkillMd(frontmatter: dict[str, object], body: str) -> str:
    lines = ['---']
    for key in ('name', 'description', 'trigger', 'category', 'created_by'):
        val = frontmatter.get(key)
        if val:
            lines.append(f'{key}: {val}')
    lines.append('---')
    lines.append('')
    lines.append(body.strip())
    return '\n'.join(lines) + '\n'

def _skillMdPath(name: str, *, createRoots: bool=False) -> Optional[Path]:
    """Resolve the SKILL.md path for an existing skill across roots."""
    for root in _skillRoots():
        md = root / name / 'SKILL.md'
        if md.exists():
            return md
    return None

def _agentSkillDir(name: str) -> Path:
    return _agentSkillsDir() / name

def listAll() -> list[dict[str, object]]:
    """Discover all skills from both the agent and bundled roots."""
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
            if parsed['name'] in seen:
                continue
            seen.add(parsed['name'])
            skills.append(parsed)
    return skills

def search(query: str='', category: str='', enabledOnly: bool=True) -> list[dict[str, object]]:
    """Search skills by name, description, trigger, or category."""
    allSkills = listAll()
    q = query.lower().strip()
    results = []
    for s in allSkills:
        if enabledOnly and (not s['enabled']):
            continue
        if category and s.get('category', '') != category:
            continue
        if q:
            if q in s['name'].lower() or q in s.get('description', '').lower() or q in s.get('trigger', '').lower():
                results.append(s)
        else:
            results.append(s)
    return results

def get(name: str) -> Optional[dict[str, object]]:
    """Get a single skill by name (agent root takes precedence)."""
    for s in listAll():
        if s['name'] == name:
            return s
    return None

def catalogue() -> list[dict[str, object]]:
    """Compact metadata for every discoverable skill — the skill catalogue.

    Following the Claude-Code progressive-disclosure pattern: only this
    lightweight metadata (name + description + optional trigger) is placed
    in the system prompt so the model knows what skills exist. The full
    SKILL.md body is loaded on demand via the ``load_skill`` tool when the
    model decides a skill is relevant.

    All discoverable skills are surfaced (not just ``enabled`` ones) —
    discovery is the standard. Returns entries sorted by name for stable
    prompt output.
    """
    return [{'name': s['name'], 'description': s.get('description', ''), 'trigger': s.get('trigger', ''), 'category': s.get('category', 'uncategorized')} for s in listAll()]

def _ensureAgentRoot() -> Path:
    root = _agentSkillsDir()
    root.mkdir(parents=True, exist_ok=True)
    return root

def _copyOnWrite(name: str) -> Path:
    """If a skill only exists in the bundled root, copy it to the agent root
    so it can be patched/extended without mutating built-ins. Returns the
    agent-root skill directory."""
    agentDir = _agentSkillDir(name)
    if agentDir.exists():
        return agentDir
    bundledMd = SKILLS_DIR / name / 'SKILL.md'
    if not bundledMd.exists():
        raise SkillValidationError(f"Skill '{name}' not found; cannot patch a non-existent skill.")
    _ensureAgentRoot()
    bundledDir = bundledMd.parent
    shutil.copytree(bundledDir, agentDir)
    return agentDir

def _safeJoin(skillDir: Path, relPath: str) -> Path:
    """Join rel_path under skill_dir, refusing traversal escapes."""
    target = (skillDir / relPath).resolve()
    if not target.is_relative_to(skillDir.resolve()):
        raise SkillValidationError(f"file_path '{relPath}' escapes the skill directory.")
    return target

def createSkill(name: str, description: str, body: str, *, trigger: str='', category: str='uncategorized', createdBy: str='agent') -> dict[str, object]:
    """Create a new agent-authored skill."""
    _validateName(name)
    _validateDescription(description)
    if not body.strip():
        raise SkillValidationError('Skill body is required.')
    if get(name):
        raise SkillValidationError(f"Skill '{name}' already exists.")
    agentDir = _ensureAgentRoot() / name
    agentDir.mkdir(parents=True, exist_ok=False)
    frontmatter = {'name': name, 'description': description.strip(), 'trigger': trigger.strip(), 'category': category.strip() or 'uncategorized', 'created_by': createdBy}
    (agentDir / 'SKILL.md').write_text(_renderSkillMd(frontmatter, body), 'utf-8')
    parsed = _parseSkill(agentDir / 'SKILL.md')
    return parsed or {'name': name, 'description': description}

def patchSkill(name: str, *, body: Optional[str]=None, description: Optional[str]=None, trigger: Optional[str]=None, category: Optional[str]=None) -> dict[str, object]:
    """Patch an existing skill (copy-on-write for bundled skills)."""
    existing = get(name)
    if not existing:
        raise SkillValidationError(f"Skill '{name}' not found.")
    if description is not None:
        _validateDescription(description)
    agentDir = _copyOnWrite(name)
    md = agentDir / 'SKILL.md'
    text = md.read_text('utf-8')
    m = re.match('^---\\s*\\n(.*?)\\n---\\s*\\n(.*)', text, re.DOTALL)
    if not m:
        raise SkillValidationError(f"Skill '{name}' has malformed frontmatter.")
    frontmatter: dict[str, object] = {}
    for line in m.group(1).split('\n'):
        if ':' in line:
            key, __, val = line.partition(':')
            frontmatter[key.strip()] = val.strip()
    currentBody = m.group(2).strip()
    if description is not None:
        frontmatter['description'] = description.strip()
    if trigger is not None:
        frontmatter['trigger'] = trigger.strip()
    if category is not None:
        frontmatter['category'] = category.strip() or 'uncategorized'
    frontmatter.setdefault('created_by', 'agent')
    newBody = currentBody if body is None else body.strip()
    md.write_text(_renderSkillMd(frontmatter, newBody), 'utf-8')
    parsed = _parseSkill(md)
    return parsed or {'name': name, 'description': frontmatter.get('description', '')}

def writeSkillFile(name: str, filePath: str, content: str) -> dict[str, object]:
    """Write a support file (scripts/ references/ templates/) into a skill dir."""
    if not get(name):
        raise SkillValidationError(f"Skill '{name}' not found.")
    agentDir = _copyOnWrite(name)
    target = _safeJoin(agentDir, filePath)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, 'utf-8')
    return {'name': name, 'file': filePath, 'bytes': len(content)}

def removeSkillFile(name: str, filePath: str) -> dict[str, object]:
    """Remove a support file from a skill dir (SKILL.md itself is untouched)."""
    if not get(name):
        raise SkillValidationError(f"Skill '{name}' not found.")
    agentDir = _copyOnWrite(name)
    target = _safeJoin(agentDir, filePath)
    if target.name == 'SKILL.md':
        raise SkillValidationError('Use delete_skill to remove a skill, not remove_skill_file.')
    if not target.exists():
        raise SkillValidationError(f"File '{filePath}' not found in skill '{name}'.")
    target.unlink()
    return {'name': name, 'removed': filePath}

def deleteSkill(name: str) -> dict[str, object]:
    """Delete an agent-authored skill. Refuses bundled skills."""
    agentDir = _agentSkillDir(name)
    if not agentDir.exists():
        bundled = SKILLS_DIR / name
        if bundled.exists():
            raise SkillValidationError(f"Refusing to delete bundled skill '{name}'. Archive via the curator instead.")
        raise SkillValidationError(f"Skill '{name}' not found.")
    shutil.rmtree(agentDir)
    return {'name': name, 'deleted': True}