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


def _skillRoots(
    workspace: str | Path | None = None, agent_id: str = ''
) -> list[tuple[str, Path]]:
    """Search roots in precedence order — earlier roots win on name clash.

    Part 17 Phase B: with a non-home ``workspace`` the project root
    ``<workspace>/.aug/skills/`` is prepended — project skills shadow
    same-named global/bundled ones (the workspace's own way of working
    overrides August's defaults). Home is deliberately NOT a project root:
    the Tasks home anchors folderless chats, not authored skills.

    M-2 (Part 21, ruling OQ5): with a bot ``agent_id`` the Bot's private
    root ``<dataDir>/bots/<agentId>/skills`` is FIRST — a Bot's own skills
    shadow project/agent/bundled ones for that Bot's sessions only. The
    scope rule is shared with the facts store via ``session_scope`` so the
    two doors can't drift.

    Returns (scope, path) PAIRS so the label can never drift from the root
    list (a bare list made home/no-workspace lists mislabel the agent root
    as 'project' once the optional root is absent).
    """
    roots: list[tuple[str, Path]] = []
    if agent_id:
        try:
            from app.services.session_scope import bot_skills_root

            roots.append(('bot', bot_skills_root(agent_id)))
        except Exception:
            pass
    ws = str(workspace or '').strip()
    if ws:
        try:
            wsPath = Path(ws).resolve()
            if wsPath != Path.home().resolve():
                # Part 17 §2 projectSkills toggle: off = the workspace root
                # drops out of the search order entirely (catalogue falls
                # back to agent+bundled). Default on.
                from app.services.brain_config_service import getRuntimeConfig

                if bool(getRuntimeConfig().get('projectSkills', True)):
                    roots.append(('project', wsPath / '.aug' / 'skills'))
        except Exception:
            pass
    roots.append(('agent', _agentSkillsDir()))
    roots.append(('bundled', SKILLS_DIR))
    return roots


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


def _skillMdMarks(pairs: list[tuple[str, Path]]) -> tuple:
    """Per-skill SKILL.md mtimes for the catalogue memo key (Part 16 Phase D
    step 1). Root-dir mtime misses IN-PLACE SKILL.md edits — a hand edit or
    external writer never bumped the memo until an unrelated mutation.
    Stats are cheap (~84 per rebuild window) next to the parse they gate."""
    marks: list[tuple[str, float]] = []
    for _scope, root in pairs:
        try:
            if not root.is_dir():
                continue
            for md in root.glob('*/SKILL.md'):
                try:
                    marks.append((str(md), md.stat().st_mtime))
                except OSError:
                    continue
        except OSError:
            continue
    return tuple(marks)


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
# Public alias for tests.
_BODY_SECTION_KEYS = _BODYSectionOrder
# Sections that MUST be present (in this order) for agent-authored / learned
# skills. Bundled (hand-written) skills keep their existing prose — only
# `created_by: agent` / `created_by: harness-proposal` skills are normalized.
_REQUIRED_BODY_SECTIONS = ('When to Use', 'How to Run', 'Pitfalls', 'Verification')
# Explicit markdown heading only (must start with `#`). The body may also
# use a "Section:" line at column 0; the parser checks that variant in a
# second pass so we don't accidentally over-match prose.
_BODY_HEADING_RE = re.compile(r'^(#{1,6})\s+(.+?)\s*$', re.MULTILINE)
_SECTION_TO_LEVEL: dict[str, int] = {
    'Title': 1,
    'When to Use': 2,
    'Prerequisites': 2,
    'How to Run': 2,
    'Quick Reference': 2,
    'Procedure': 2,
    'Pitfalls': 2,
    'Verification': 2,
}
_SECTION_ALIASES: dict[str, str] = {
    # Common casual headings the harness / agent might use → canonical name.
    'what this skill is': 'Title',
    'overview': 'Title',
    'purpose': 'Title',
    'when to use this': 'When to Use',
    'when to use': 'When to Use',
    'usage': 'When to Use',
    'prereqs': 'Prerequisites',
    'requirements': 'Prerequisites',
    'how to run this': 'How to Run',
    'how to do it': 'How to Run',
    'instructions': 'Procedure',
    'steps': 'Procedure',
    'process': 'Procedure',
    'common mistakes': 'Pitfalls',
    'gotchas': 'Pitfalls',
    'caveats': 'Pitfalls',
    'verify': 'Verification',
    'how to verify': 'Verification',
    'check': 'Verification',
}


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
    frontmatter = _parse_frontmatter_block(m.group(1))
    body = m.group(2).strip()
    if not body:
        return None
    stat = path.stat()
    known = ('name', 'description', 'trigger', 'category', 'disabled', 'created_by')
    meta = {k: v for k, v in frontmatter.items() if k not in known}
    return {
        'name': frontmatter.get('name', path.parent.name),
        'description': frontmatter.get('description', ''),
        'trigger': frontmatter.get('trigger', ''),
        'category': frontmatter.get('category', 'uncategorized'),
        'enabled': frontmatter.get('disabled', 'false').lower() != 'true',
        'created_by': frontmatter.get('created_by', ''),
        # M6 item 3: unrecognized frontmatter keys round-trip instead of
        # being silently dropped on the next patch/setEnabled write.
        'meta': meta,
        'instructions': body,
        'path': str(path),
        'updatedAt': stat.st_mtime,
    }


def _parse_frontmatter_block(block: str) -> dict[str, str]:
    """Parse ``key: value`` frontmatter lines, preserving insertion order.

    Part 16 Phase C quote-strip: ``_skill_frontmatter`` and the bundled
    august-harness/august-tools SKILL.md files write quoted values — a
    matching surrounding quote pair is stripped so literal quotes never
    ride into the skills index / prompts."""
    frontmatter: dict[str, str] = {}
    for line in block.split('\n'):
        if ':' in line:
            key, __, val = line.partition(':')
            val = val.strip()
            if len(val) >= 2 and val[0] == val[-1] and val[0] in ('"', "'"):
                val = val[1:-1]
            frontmatter[key.strip()] = val
    return frontmatter


def isEnabled(name: str, workspace: str | Path | None = None) -> bool:
    """The single enabled-check predicate (M6 item 1). Unknown skills are
    treated as not-loadable (False)."""
    skill = get(name, workspace)
    return bool(skill and skill.get('enabled'))



def list_all(
    workspace: str | Path | None = None, agent_id: str = ''
) -> list[dict[str, object]]:
    """Discover all skills from the bot (optional), project (optional), agent,
    and bundled roots — earlier roots shadow same-named later ones.

    M6 item 5: entries whose names fail the authoring-name rule are skipped
    and logged at discovery — invalid folders (e.g. leftover ``pending-*``
    approval staging dirs) never reach any catalogue, prompt, or UI list.

    Part 17 Phase B: each entry carries ``scope`` (project | agent | bundled)
    and ``overrides`` = the shadowed root's name when this entry shadows one.
    """
    global _flat_migrate_done
    if not _flat_migrate_done:
        _flat_migrate_done = True
        try:
            migrate_flat_skills()
        except Exception:
            pass
    skills: list[dict[str, object]] = []
    seen: set[str] = set()
    # name → every root scope that contains it, in precedence order —
    # used after the loop to badge which root each kept entry shadows (C-2).
    scopesByName: dict[str, list[str]] = {}
    for scope, root in _skillRoots(workspace, agent_id):
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
            name = as_str(parsed['name'], '')
            try:
                _validateName(name)
            except SkillValidationError as exc:
                import logging

                logging.getLogger('august.skills').warning(
                    'skipping skill with invalid name %r (%s): %s', name, md, exc
                )
                continue
            scopesByName.setdefault(name, []).append(scope)
            if name in seen:
                continue
            parsed['scope'] = scope
            seen.add(name)
            skills.append(parsed)
    for s in skills:
        name = as_str(s['name'], '')
        scopes = scopesByName.get(name, [])
        idx = scopes.index(as_str(s.get('scope'), '')) if scopes else -1
        if idx >= 0 and idx + 1 < len(scopes):
            s['overrides'] = scopes[idx + 1]
    return skills


def search(
    query: str = '',
    category: str = '',
    enabledOnly: bool = True,
    workspace: str | Path | None = None,
    agent_id: str = '',
) -> list[dict[str, object]]:
    """Search skills by name, description, trigger, or category."""
    allSkills = list_all(workspace, agent_id)
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


def get(
    name: str, workspace: str | Path | None = None, agent_id: str = ''
) -> Optional[dict[str, object]]:
    """Get a single skill by name (bot > project > agent > bundled precedence)."""
    for s in list_all(workspace, agent_id):
        if s['name'] == name:
            return s
    return None


def load_bodies(
    names: list[str], *, max_chars: int = 24000, workspace: str | Path | None = None
) -> str:
    """Concatenate SKILL.md bodies for worker preload (progressive disclosure skip).

    Disabled skills are never inlined (M6 item 1 — ``<harness_guide>`` skips
    disabled harness skills); a marker keeps the omission visible.
    """
    parts: list[str] = []
    used = 0
    for raw in names:
        name = str(raw or '').strip()
        if not name:
            continue
        skill = get(name, workspace)
        if not skill:
            parts.append(f'## skill:{name}\n(not found)')
            continue
        if not skill.get('enabled'):
            parts.append(f'## skill:{name}\n(disabled — enable it in Settings → Skills)')
            continue
        body = str(skill.get('instructions') or skill.get('body') or skill.get('content') or '')
        chunk = f'## skill:{name}\n{body}'.strip()
        if used + len(chunk) > max_chars:
            parts.append(f'## skill:{name}\n(truncated — remaining budget {max(0, max_chars - used)})')
            break
        parts.append(chunk)
        used += len(chunk)
    return '\n\n'.join(parts)


def catalogue(
    workspace: str | Path | None = None, agent_id: str = ''
) -> list[dict[str, object]]:
    """Compact metadata for every usable skill — the skill catalogue.

    Following the Claude-Code progressive-disclosure pattern: only this
    lightweight metadata (name + description + optional trigger) is placed
    in the system prompt so the model knows what skills exist. The full
    SKILL.md body is loaded on demand via the ``load_skill`` tool when the
    model decides a skill is relevant.

    M6 item 1: disabled skills are filtered OUT — the catalogue feeds the
    prompt surfaces (``<capabilities>``, ``<intake>``, harness guide), and a
    disabled skill must not be offered there. The Settings UI lists disabled
    skills via ``/api/skills`` (``search(enabledOnly=False)``) instead.
    Entries carry ``enabled`` (always True post-filter) so consumers never
    need a second predicate. Sorted by name for stable prompt output;
    ``created_by`` labels evolving/agent-authored skills.

    Latency pass 0.16.8: results are memoized against the skill roots'
    mtimes (a cold build parses ~84 SKILL.md files ≈ 0.5s and this used to
    run on MANY turns via the Tier-3 relevance pass). Any create/patch/
    delete bumps the roots' mtime → next call rebuilds automatically.

    Part 17 Phase B: the memo is keyed by (workspace, roots, mtimes) so
    per-workspace catalogues never cross-contaminate sessions; project
    entries carry ``scope: 'project'`` and an ``overrides`` label when they
    shadow a global/bundled name.
    """
    global _cat_cache, _cat_cache_key
    wsKey = str(workspace or '')
    try:
        pairs = _skillRoots(workspace, agent_id)
        roots = tuple(f'{scope}:{r}' for scope, r in pairs)
        marks = tuple(_root_mtime(r) for _scope, r in pairs) + _skillMdMarks(pairs)
        key: tuple | None = (wsKey, agent_id, roots, marks)
    except Exception:
        key = None
    if key is not None and _cat_cache is not None and _cat_cache_key == key:
        return _cat_cache
    byName = {as_str(s['name'], ''): s for s in list_all(workspace, agent_id)}
    entries: list[dict[str, object]] = []
    for s in list_all(workspace, agent_id):
        if not s.get('enabled'):
            continue
        name = as_str(s['name'], '')
        scope = as_str(s.get('scope'), '')
        shadowed = ''
        if scope == 'project':
            g = byName.get(name)
            if g is not None and g is not s:
                shadowed = as_str(g.get('scope'), 'global')
        entry: dict[str, object] = {
            'name': s['name'],
            'description': s.get('description', ''),
            'trigger': s.get('trigger', ''),
            'category': s.get('category', 'uncategorized'),
            'created_by': s.get('created_by', ''),
            'enabled': True,
            'scope': scope or 'global',
        }
        if shadowed:
            entry['overrides'] = shadowed
        entries.append(entry)
    out = sorted(entries, key=lambda e: as_str(e.get('name'), ''))
    if key is not None:
        _cat_cache = out
        _cat_cache_key = key
    return out


def skill_body(name: str, workspace: str | Path | None = None) -> str | None:
    """Full instruction body for a skill, or None when not found."""
    sk = get(name, workspace)
    return as_str(sk.get('instructions'), '') if sk else None


def _bust_prompt_skills_cache() -> None:
    """Global bust of ALL skills-related prompt caches (M6 item 2).

    One call clears every layer: the catalogue memo here, plus the
    workbench-side ``_caps_block_cache``, ``_harness_guide_cache``, the
    prompt-segments cache and the Tier 1/2 prompt cache — collapsed into a
    single entry point so a mutation can never leak a stale ``<capabilities>``
    block (the audit found setEnabled busted only some layers).
    """
    global _cat_cache, _cat_cache_key
    _cat_cache = None
    _cat_cache_key = None
    try:
        from app.services.workbench.workbench import clear_skill_prompt_caches

        clear_skill_prompt_caches()
    except Exception:
        # Workbench not importable (unit-test context) — fall back to the
        # segment/prompt caches directly.
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


# ── Body structure (learned skills look like Claude skills) ──────────────


def _parse_body_sections(body: str) -> list[tuple[str, str]]:
    """Return [(canonical_section, content), …] for a markdown body.

    A heading matches a canonical section by case-insensitive name (with
    aliases — "What this skill is" → "Title", "Steps" → "Procedure", etc).
    Heading styles recognised:
      * Markdown `## Section` (preferred)
      * Plain "Section:" / "Section" at column 0 — only when the name is a
        canonical section or a known alias, so we never over-match prose
        lines that happen to end with a colon.

    Anything before the first recognised heading is attached to the first
    section under the implicit "Title" bucket. Unrecognised headings are
    folded into the preceding section's content so we never drop prose.
    """
    out: list[tuple[str, str]] = []
    if not body.strip():
        return out
    current_section = 'Title'
    buf: list[str] = []
    recognised_names = set(_SECTION_TO_LEVEL) | set(_SECTION_ALIASES)
    for line in body.splitlines():
        stripped = line.strip()
        heading_text: str | None = None
        m = _BODY_HEADING_RE.match(line)
        if m:
            heading_text = m.group(2).strip()
        elif stripped and not line.startswith((' ', '\t')):
            # Column-0 "Section:" or "Section" — strict: name must be a
            # canonical section or a known alias (case-insensitive), and
            # the line must be short (no embedded colons / punctuation).
            candidate = stripped.rstrip(':').strip()
            if (
                len(candidate) <= 40
                and re.match(r'^[A-Za-z][A-Za-z0-9 /-]*$', candidate)
                and candidate.lower() in {n.lower() for n in recognised_names}
            ):
                heading_text = candidate
        if heading_text is not None:
            key = heading_text.lower()
            canonical = _SECTION_ALIASES.get(key, heading_text)
            if canonical not in _SECTION_TO_LEVEL:
                # Heading is an alias-of-alias or external — keep prose.
                buf.append(line)
                continue
            out.append((current_section, '\n'.join(buf).strip()))
            current_section = canonical
            buf = []
        else:
            buf.append(line)
    out.append((current_section, '\n'.join(buf).strip()))
    # Drop empty trailing sections from the leading implicit "Title".
    if out and not out[0][1] and len(out) > 1:
        out = out[1:]
    return [(s, c) for s, c in out if c]


def _ensure_canonical_body(
    body: str,
    *,
    name: str,
    description: str,
    is_learned: bool,
) -> str:
    """Re-render an agent-authored / learned skill so it always has the
    canonical sections in `_REQUIRED_BODY_SECTIONS` in the order listed in
    `_BODYSectionOrder`. Bundled (hand-written) skills pass through unchanged
    — the body is whatever the human shipped.
    """
    if not is_learned:
        return body
    sections = _parse_body_sections(body)
    # Map existing section content by canonical name; preserve insertion order
    # of any unknown headings inside the section they followed.
    present: dict[str, str] = {}
    for sec, content in sections:
        if sec in present:
            present[sec] = present[sec].rstrip() + '\n\n' + content.strip()
        else:
            present[sec] = content.strip()
    # Pull the first non-empty prose block into Title when the author didn't
    # include a "What this skill is" section. Use the frontmatter description
    # as the fallback prose so even a no-body lesson ships a clear headline.
    title_text = present.get('Title', '').strip()
    if not title_text:
        title_text = description.strip() or f'What `{name}` does.'
    out: list[str] = []
    out.append(f'# What this skill is\n\n{title_text}')
    for sec in _BODYSectionOrder[1:]:
        if sec not in _REQUIRED_BODY_SECTIONS and sec not in present:
            continue
        body_text = present.get(sec, '').strip()
        if not body_text:
            body_text = _placeholder_for(sec, name, description)
        out.append(f'## {sec}\n\n{body_text}')
    # Append any extra sections the author included (recognition they're not
    # required, but we keep them so the skill body stays a superset of intent).
    for sec, content in sections:
        if sec in _SECTION_TO_LEVEL or sec == 'Title':
            continue
        if content.strip():
            out.append(f'## {sec}\n\n{content.strip()}')
    return '\n\n'.join(out).rstrip() + '\n'


def _placeholder_for(section: str, name: str, description: str) -> str:
    """Template placeholder so every learned skill ships with a useful
    starting structure rather than an empty section."""
    desc = (description or '').strip()
    if section == 'When to Use':
        return f'- {desc or f"Trigger `{name}` when the situation calls for it."}'
    if section == 'Prerequisites':
        return '- _None — fill in any tools, files, or state this skill needs._'
    if section == 'How to Run':
        return (
            f'1. `load_skill("{name}")` to read the body.\n'
            '2. Follow the procedure below, batching independent calls.\n'
            '3. Run the verification step before reporting success.'
        )
    if section == 'Pitfalls':
        return '- _None recorded yet — add a row the first time a call misfires._'
    if section == 'Verification':
        return (
            f'- Confirm `{name}` produced the expected artefact or side-effect.\n'
            '- Re-run a single dry call if the user asks for proof.'
        )
    return '_No content yet._'


# ── Authoring (create / patch / delete) — restored 0.17.0 ─────────────────


def _renderSkillMd(frontmatter: dict[str, str], body: str) -> str:
    """Render SKILL.md. Known keys keep a stable canonical order; any other
    keys round-trip after them (M6 item 3 — unknown frontmatter survives)."""
    lines = ['---']
    written: set[str] = set()
    for key in ('name', 'description', 'trigger', 'category', 'created_by', 'disabled'):
        val = frontmatter.get(key)
        if val:
            lines.append(f'{key}: {val}')
            written.add(key)
    for key, val in frontmatter.items():
        if key not in written and val:
            lines.append(f'{key}: {val}')
    lines.append('---')
    lines.append('')
    lines.append(body.strip())
    return '\n'.join(lines) + '\n'


def _agentSkillDir(name: str) -> Path:
    return _agentSkillsDir() / name


def botRootFor(agent_id: str) -> Path:
    """Phase E: the Bot's private skill root (created on demand). The write
    target for a learned skill authored by a bot-scoped session — the mirror
    of the ``('bot', …)`` read root in ``_skillRoots``."""
    from app.services.session_scope import bot_skills_root

    root = bot_skills_root(agent_id)
    root.mkdir(parents=True, exist_ok=True)
    return root


def _currentWriteRoot() -> Path:
    """Where an agent-authored/learned skill lands for the CURRENT session:
    the Bot's own folder when the session is bot-scoped (Phase E), else the
    shared agent root. One resolution point so the write door matches the
    read door (``_skillRoots``) and the rule can't drift."""
    try:
        from app.services import session_scope

        scope = session_scope.resolve_scope()
        if session_scope.is_bot_scope(scope):
            return botRootFor(session_scope.bot_agent_id(scope))
    except Exception:
        pass
    return _agentSkillsDir()


def _ensureAgentRoot() -> Path:
    """The writable skill root for the current session (agent root, or the
    Bot's own root when the authoring session is bot-scoped — Phase E)."""
    root = _currentWriteRoot()
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
    workspace: str | Path | None = None,
) -> dict[str, object]:
    """Create a new agent-authored skill.

    Part 17 Phase B: with a non-home ``workspace`` the skill lands in the
    project root ``<ws>/.aug/skills/`` (created on demand) — project scope
    by choice, global otherwise.
    """
    _validateName(name)
    _validateDescription(description)
    if not body.strip():
        raise SkillValidationError('Skill body is required.')
    if get(name, workspace):
        raise SkillValidationError(f"Skill '{name}' already exists.")
    wsStr = str(workspace or '').strip()
    if wsStr and Path(wsStr).resolve() != Path.home().resolve():
        root = Path(wsStr) / '.aug' / 'skills'
        root.mkdir(parents=True, exist_ok=True)
        skill_dir = root / name
    else:
        skill_dir = _ensureAgentRoot() / name
    skill_dir.mkdir(parents=True, exist_ok=False)
    frontmatter = {
        'name': name,
        'description': description.strip(),
        'trigger': trigger.strip(),
        'category': category.strip() or 'uncategorized',
        'created_by': created_by,
    }
    normalized = _ensure_canonical_body(
        body,
        name=name,
        description=description,
        is_learned=created_by in ('agent', 'harness-proposal'),
    )
    md = skill_dir / 'SKILL.md'
    md.write_text(_renderSkillMd(frontmatter, normalized), 'utf-8')
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
    enabled: Optional[bool] = None,
    workspace: str | Path | None = None,
) -> dict[str, object]:
    """Patch an existing skill (copy-on-write for bundled skills).

    M6 item 4: the enabled/disabled flip is handled HERE so a PATCH that
    changes both ``disabled`` and content fields performs exactly one file
    write (the router previously called setEnabled + patchSkill = 2 writes).

    Part 17 Phase B: with a ``workspace``, a project entry patches in
    place (project root); a bundled/global name copy-on-writes INTO the
    project root as a project override — the workspace's customized copy.
    """
    existing = get(name, workspace)
    if not existing:
        raise SkillValidationError(f"Skill '{name}' not found.")
    if description is not None:
        _validateDescription(description)
    wsStr = str(workspace or '').strip()
    inProject = False
    md = None
    if wsStr and Path(wsStr).resolve() != Path.home().resolve():
        projDir = Path(wsStr) / '.aug' / 'skills' / name
        if projDir.exists():
            md = projDir / 'SKILL.md'
            inProject = True
        else:
            # Copy-on-write the resolved skill into the project root —
            # the project's customized shadow of a global/bundled skill.
            projDir.mkdir(parents=True, exist_ok=True)
            src = Path(as_str(existing.get('path'), ''))
            (projDir / 'SKILL.md').write_text(src.read_text('utf-8'), 'utf-8')
            md = projDir / 'SKILL.md'
            inProject = True
    if not inProject:
        agent_dir = _copyOnWrite(name)
        md = agent_dir / 'SKILL.md'
    assert md is not None
    text = md.read_text('utf-8')
    m = re.match('^---\\s*\\n(.*?)\\n---\\s*\\n(.*)', text, re.DOTALL)
    if not m:
        raise SkillValidationError(f"Skill '{name}' has malformed frontmatter.")
    frontmatter = _parse_frontmatter_block(m.group(1))
    current_body = m.group(2).strip()
    if description is not None:
        frontmatter['description'] = description.strip()
    if trigger is not None:
        frontmatter['trigger'] = trigger.strip()
    if category is not None:
        frontmatter['category'] = category.strip() or 'uncategorized'
    if enabled is not None:
        if enabled:
            frontmatter.pop('disabled', None)
        else:
            frontmatter['disabled'] = 'true'
    frontmatter.setdefault('created_by', 'agent')
    is_learned = frontmatter.get('created_by', 'agent') in ('agent', 'harness-proposal')
    if body is None:
        # PATCH didn't change the body — preserve verbatim so a single-field
        # patch (e.g. toggling `disabled`) is a true no-op for prose. This
        # matters for round-trip tests and for humans who only wanted to
        # flip the enable bit without re-rendering the skill.
        new_body = current_body
    else:
        new_body = _ensure_canonical_body(
            body.strip(),
            name=as_str(frontmatter.get('name', name), name),
            description=as_str(frontmatter.get('description', ''), ''),
            is_learned=is_learned,
        )
    md.write_text(_renderSkillMd(frontmatter, new_body), 'utf-8')
    parsed = _parseSkill(md)
    _bust_prompt_skills_cache()
    return parsed or {'name': name, 'description': frontmatter.get('description', '')}


def deleteSkill(name: str, workspace: str | Path | None = None) -> dict[str, object]:
    """Delete a skill. Refuses bundled skills.

    Part 17 Phase B override safety: with a ``workspace``, deleting a name
    that exists as a PROJECT entry removes only the project override — the
    shadowed global/bundled skill stays intact. Deleting a name that has
    no project entry but exists globally is refused (the UI should redirect
    to the global scope); bundled skills are never deletable.
    """
    import shutil as _shutil

    _validateName(name)  # §9 F-1: traversal names ('..', separators) must not reach the project-root join
    wsStr = str(workspace or '').strip()
    project_root = (
        Path(wsStr) / '.aug' / 'skills'
        if wsStr and Path(wsStr).resolve() != Path.home().resolve()
        else None
    )
    if project_root is not None:
        projDir = project_root / name
        if projDir.exists():
            _shutil.rmtree(projDir)
            _bust_prompt_skills_cache()
            return {'deleted': name, 'scope': 'project', 'override_removed': True}
        # No project entry: if a global/agent copy exists, deleting here
        # would have to delete the GLOBAL skill — refuse; the caller should
        # delete it from the global scope explicitly.
        if get(name) is not None:
            raise SkillValidationError(
                f"Skill '{name}' has no project override in this workspace; "
                'delete it from the global scope instead.'
            )
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
    return {'deleted': name, 'scope': 'global'}


def record_skill_use(skillPath: str) -> None:
    """Bump the per-skill usage sidecar (``<skillDir>/.usage.json``).

    Part 16 Phase E: without trigger-hit counts, "zero loads and no
    recurrence" is unknowable — which is why honest demotion suggestions
    and the curator report could not exist before. Best-effort: a failed
    sidecar write never blocks the load."""
    try:
        import json as _json
        from datetime import datetime

        d = Path(skillPath).parent
        if not d.is_dir():
            return
        sidecar = d / '.usage.json'
        data: dict[str, object] = {}
        if sidecar.exists():
            try:
                data = _json.loads(sidecar.read_text('utf-8'))
            except Exception:
                data = {}
        data['count'] = int(str(data.get('count') or 0) or 0) + 1
        data['lastUsed'] = datetime.now().astimezone().isoformat()
        sidecar.write_text(_json.dumps(data), 'utf-8')
    except Exception:
        pass


def setEnabled(name: str, *, enabled: bool) -> dict[str, object]:
    """Enable/disable a skill by flipping frontmatter ``disabled``.

    Disabled skills stay discoverable via ``list_all``/``/api/skills`` (with
    ``enabled: false``) so the settings UI can show them, but are excluded
    from the catalogue and every prompt surface (M6 item 1). Thin wrapper
    over ``patchSkill`` so both paths share one single-write implementation.
    """
    return patchSkill(name, enabled=enabled)

