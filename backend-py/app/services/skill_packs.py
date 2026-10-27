"""Skill packs — install-from-remote for skill folders.

Closes the last gap versus the ZCode plugin cache: August's skills were
local-roots only (project → agent → bundled). A *pack* is a zip archive
(any https URL) or a GitHub repo/ subdir that contains skill folders —
directories with a ``SKILL.md`` — installed into the agent skills root
``<dataDir>/skills`` where the catalogue already discovers them.

Sources:
  * ``owner/repo`` / ``owner/repo/subdir`` — fetched as a GitHub zipball
    (``@ref`` suffix pins a branch/tag, e.g. ``acme/skills@v2``);
  * any ``https`` URL ending in ``.zip``.

Guards (the archive is third-party content): https only, 20 MB cap, path
traversal rejected, every member SKILL.md validated through the same
name/body rules as the authoring door before anything is copied, and a
colliding directory that does not belong to the pack is refused, never
overwritten — user and learned skills can't be clobbered by an install.

An install records a manifest (``<dataDir>/skills/.packs.json``) mapping
pack → skill dirs + revision (sha256 of the archive), which is exactly
what ``uninstall_pack`` removes — it never guesses by folder contents.
"""

from __future__ import annotations

import hashlib
import io
import json
import logging
import re
import shutil
import time
import zipfile
from pathlib import Path
from typing import Any

import httpx

log = logging.getLogger(__name__)

_MAX_BYTES = 20 * 1024 * 1024
_MANIFEST = '.packs.json'
_GITHUB_RE = re.compile(r'^([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)(?:/([^@]*))?(?:@([^/@]+))?$')
_SAFE_NAME = re.compile(r'^[A-Za-z0-9._ -]{1,64}$')


def _agentRoot() -> Path:
    from app.services.skill_service import _agentSkillsDir  # noqa: SLF001 — canonical door

    root = _agentSkillsDir()
    root.mkdir(parents=True, exist_ok=True)
    return root


def _loadManifest(root: Path) -> dict[str, Any]:
    try:
        raw = json.loads((root / _MANIFEST).read_text('utf-8'))
        return raw if isinstance(raw, dict) else {}
    except Exception:
        return {}


def _saveManifest(root: Path, manifest: dict[str, Any]) -> None:
    (root / _MANIFEST).write_text(json.dumps(manifest, indent=2), 'utf-8')


def _fetch(url: str) -> bytes:
    """Download the archive (https only, size-capped). Seam for tests."""
    with httpx.Client(follow_redirects=True, timeout=30.0) as client:
        with client.stream('GET', url) as resp:
            if resp.status_code != 200:
                raise ValueError(f'fetch failed: HTTP {resp.status_code} for {url}')
            chunks: list[bytes] = []
            total = 0
            for chunk in resp.iter_bytes():
                total += len(chunk)
                if total > _MAX_BYTES:
                    raise ValueError(f'archive exceeds the {_MAX_BYTES} byte limit')
                chunks.append(chunk)
    return b''.join(chunks)


def _archive_url(source: str) -> tuple[str, str]:
    """(url, subdir-or-'' ) from a pack source string."""
    s = (source or '').strip()
    m = _GITHUB_RE.match(s)
    if m and not s.startswith('http'):
        owner, repo, subdir, ref = m.groups()
        url = f'https://codeload.github.com/{owner}/{repo}/zip/{ref or "HEAD"}'
        return url, (subdir or '')
    if s.startswith('https://') and s.split('?')[0].endswith('.zip'):
        return s, ''
    raise ValueError(
        'source must be a GitHub repo (owner/repo[/subdir][@ref]) or an https .zip URL'
    )


def _skillDirsInArchive(zf: zipfile.ZipFile, subdir: str) -> dict[str, tuple[str, list[str]]]:
    """Map skill-name → (member-path prefix, all member paths under it).
    GitHub zipballs wrap everything in a ``repo-ref/`` root which is
    stripped; a skill dir is any directory that directly contains a
    SKILL.md, at any depth (repos organize ``skills/<name>/SKILL.md``)."""
    members = [n for n in zf.namelist() if not n.endswith('/')]
    prefix = ''
    if members:
        first = members[0].split('/')[0]
        if all(n.startswith(first + '/') for n in members):
            prefix = first + '/'
    want = f'{prefix}{subdir}/' if subdir else prefix
    scoped = [n for n in members if not want or n.startswith(want)]
    dirPrefixes: dict[str, str] = {}
    for n in scoped:
        rel = n[len(want):]
        parts = rel.split('/')
        if len(parts) >= 2 and parts[-1] == 'SKILL.md':
            dirPrefixes[parts[-2]] = want + '/'.join(parts[:-1]) + '/'
        elif len(parts) == 1 and parts[0] == 'SKILL.md':
            # Single-skill archive: the effective root itself is the skill.
            dirPrefixes['single'] = want
    return {
        name: (dp, [n for n in scoped if n.startswith(dp)])
        for name, dp in dirPrefixes.items()
    }


def _validateSkillFile(target: Path, dirname: str) -> str | None:
    """Run the installed SKILL.md through the SAME authoring door the UI
    add-box uses (frontmatter parse + name rule). Returns an error or None."""
    try:
        from app.services import skill_service

        parsed = skill_service._parseSkill(target / 'SKILL.md')  # noqa: SLF001
        if not parsed:
            return f'{dirname}: SKILL.md failed to parse (frontmatter with a name is required)'
        skill_service._validateName(str(parsed.get('name') or ''))  # noqa: SLF001
    except Exception as exc:
        return f'{dirname}: SKILL.md rejected: {exc}'
    return None


def _validatePlanSkill(files: dict[str, bytes], dirname: str) -> str | None:
    """Validate one planned SKILL.md through the authoring door, before writing."""
    import tempfile

    text = files.get('SKILL.md')
    if not text:
        return f'{dirname}: SKILL.md is missing'
    with tempfile.TemporaryDirectory(prefix='aug-skill-preview-') as td:
        target = Path(td) / 'SKILL.md'
        target.write_bytes(text)
        from app.services import skill_service

        parsed = skill_service._parseSkill(target)  # noqa: SLF001
        if not parsed:
            return f'{dirname}: SKILL.md failed to parse (frontmatter with a name is required)'
    return None


_MEMORY_INSTRUCTION_RE = re.compile(
    r'\b(remember (?:that|this)|always agree with|ignore (?:all )?(?:previous|prior) '
    r'instructions|you are (?:the )?(?:system )?admin)\b',
    re.IGNORECASE,
)


def _scanSkillText(text: str) -> list[dict[str, str]]:
    """Findings for one skill body: unsafe (shell/URL/secret) and memory-instruction."""
    findings: list[dict[str, str]] = []
    try:
        from app.services.harness_rails import _content_check

        refused = _content_check({'body': text})
        if refused:
            findings.append(
                {
                    'severity': 'unsafe',
                    'reason': str(refused.get('reason') or refused.get('rule') or 'unsafe content'),
                }
            )
    except Exception:
        log.debug('skill content scan unavailable', exc_info=True)
    match = _MEMORY_INSTRUCTION_RE.search(text)
    if match:
        findings.append(
            {
                'severity': 'warn',
                'reason': f'skill text instructs memory: {match.group(0)!r}',
            }
        )
    return findings


def _safeDirName(name: str, fallback: str) -> str:
    safe = re.sub(r'[^A-Za-z0-9._ -]', '-', name)[:64]
    return safe if _SAFE_NAME.match(safe) and safe not in ('.', '..') else fallback


def _planFromZip(blob: bytes, subdir: str, source: str) -> dict[str, Any]:
    try:
        zf = zipfile.ZipFile(io.BytesIO(blob))
    except zipfile.BadZipFile:
        raise ValueError('archive is not a valid zip') from None
    names = zf.namelist()
    for n in names:
        if n.startswith('/') or '..' in Path(n).parts:
            raise ValueError('archive contains an unsafe path — refused')
    skills = _skillDirsInArchive(zf, subdir)
    if not skills:
        raise ValueError('no skill folders (directories with SKILL.md) found in the archive')
    packName = (subdir.split('/')[-1] if subdir else source.rstrip('/').split('/')[-1]) or 'pack'
    packName = _safeDirName(packName, 'pack')
    plan: list[dict[str, Any]] = []
    for dirname, (dirPrefix, memberPaths) in sorted(skills.items()):
        files: dict[str, bytes] = {}
        for member in memberPaths:
            rel = (
                member[len(dirPrefix):]
                if dirPrefix and member.startswith(dirPrefix)
                else member.rsplit('/', 1)[-1]
            )
            if not rel or rel.startswith('/') or '..' in Path(rel).parts:
                continue
            files[rel] = zf.read(member)
        plan.append({'dir': dirname, 'files': files})
    return {
        'pack': packName,
        'source': source,
        'rev': hashlib.sha256(blob).hexdigest()[:12],
        'skills': plan,
    }


def _planFromFolder(root: Path, source: str) -> dict[str, Any]:
    if not root.is_dir():
        raise ValueError('source folder does not exist')
    skill_dirs: list[Path] = []
    if (root / 'SKILL.md').is_file():
        skill_dirs = [root]
    else:
        skill_dirs = sorted(
            p for p in root.iterdir() if p.is_dir() and (p / 'SKILL.md').is_file()
        )
    if not skill_dirs:
        raise ValueError('no skill folders (directories with SKILL.md) found in the folder')
    plan: list[dict[str, Any]] = []
    total = 0
    for sd in skill_dirs:
        files: dict[str, bytes] = {}
        for f in sorted(sd.rglob('*')):
            if f.is_symlink() or not f.is_file():
                continue
            rel = f.relative_to(sd).as_posix()
            if rel.startswith('/') or '..' in Path(rel).parts:
                continue
            blob = f.read_bytes()
            total += len(blob)
            if total > _MAX_BYTES:
                raise ValueError(f'folder exceeds the {_MAX_BYTES} byte limit')
            files[rel] = blob
        plan.append({'dir': sd.name, 'files': files})
    return {
        'pack': _safeDirName(root.name, 'pack'),
        'source': source,
        'rev': '',
        'skills': plan,
    }


_REF_PATH_RE = re.compile(r'\b(?:references|scripts|templates|assets)/[A-Za-z0-9._/-]+')


def _planFromRawUrl(source: str) -> dict[str, Any]:
    """One raw SKILL.md URL plus the sibling files its body references.

    A raw URL has no archive manifest, so the referenced support paths ARE the
    manifest: only the four standard sibling dirs are fetched, up to 20 files,
    same-origin, and each failure is reported as a warning rather than
    silently installing a skill whose references/ links are broken.
    """
    from urllib.parse import urljoin, urlparse

    blob = _fetch(source)
    name = Path(urlparse(source).path).stem or 'skill'
    text = blob.decode('utf-8', 'replace')
    try:
        import yaml

        _fm = re.match(r'^---\s*\n(.*?)\n---', text, re.DOTALL)
        if _fm:
            _loaded = yaml.safe_load(_fm.group(1))
            if isinstance(_loaded, dict) and _loaded.get('name'):
                name = str(_loaded['name']).strip()
    except Exception:
        pass
    files: dict[str, bytes] = {'SKILL.md': blob}
    warnings: list[str] = []
    refs: list[str] = []
    for match in _REF_PATH_RE.finditer(text):
        rel = match.group(0).rstrip('.,);:')
        if '..' in Path(rel).parts or rel in refs:
            continue
        refs.append(rel)
    total = len(blob)
    for rel in refs[:20]:
        try:
            support = _fetch(urljoin(source, rel))
        except Exception as exc:
            warnings.append(f'{rel}: {str(exc)[:120]}')
            continue
        total += len(support)
        if total > _MAX_BYTES:
            warnings.append(f'{rel}: skipped (pack exceeds the {_MAX_BYTES} byte cap)')
            continue
        files[rel] = support
    return {
        'pack': _safeDirName(name, 'skill'),
        'source': source,
        'rev': hashlib.sha256(blob).hexdigest()[:12],
        'skills': [{'dir': name, 'files': files}],
        'warnings': warnings,
    }


def _buildPlan(source: str) -> dict[str, Any]:
    s = (source or '').strip()
    local = Path(s)
    if s and local.is_dir():
        return _planFromFolder(local, s)
    if s.startswith('https://') and s.split('?')[0].endswith('.md'):
        return _planFromRawUrl(s)
    url, subdir = _archive_url(s)
    return _planFromZip(_fetch(url), subdir, s)


def _preview(plan: dict[str, Any]) -> dict[str, Any]:
    skills: list[dict[str, Any]] = []
    refused: list[str] = []
    for item in plan['skills']:
        dirname = str(item.get('dir') or '')
        files = item.get('files') or {}
        err = _validatePlanSkill(files, dirname)
        if err:
            refused.append(err)
            continue
        text = files.get('SKILL.md', b'').decode('utf-8', 'replace')
        skills.append(
            {
                'name': dirname,
                'files': len(files),
                'bytes': sum(len(v) for v in files.values()),
                'findings': _scanSkillText(text),
            }
        )
    return {
        'pack': plan['pack'],
        'source': plan['source'],
        'rev': plan['rev'],
        'skills': skills,
        'refused': refused,
        'warnings': plan.get('warnings') or [],
    }


def _trashPackDir(source: Path, name: str) -> str:
    """Route a pack-owned replacement or removal through the skill trash.

    Every other skill mutation (patch, delete, restore) snapshots before it
    writes; a pack reinstall or uninstall was the one path that deleted live
    content with no undo. Trashing instead makes the replaced directory
    addressable by ``restoreSkill`` like any delete.
    """
    from app.services.skill_service import _trashDir  # noqa: SLF001 — canonical trash door

    trash_id, _ = _trashDir(source, name, scope='agent', restore_to=_agentRoot())
    return trash_id


def install_pack(source: str, *, confirm: bool = False) -> dict[str, Any]:
    """Preview, then (only with ``confirm=True``) install a skill pack.

    Nothing is written until the caller confirms. The preview names every
    skill, its file count/size, and any content scan finding; unsafe shell,
    URL or credential content refuses the install even after confirmation.
    Local folders and raw ``.md`` URLs follow the same path; scripts are
    copied, never executed.
    """
    try:
        plan = _buildPlan(source)
    except (ValueError, httpx.HTTPError) as exc:
        return {'ok': False, 'error': f'network error: {exc}' if isinstance(exc, httpx.HTTPError) else str(exc)}
    preview = _preview(plan)
    unsafe = [
        {'skill': sk['name'], **finding}
        for sk in preview['skills']
        for finding in sk['findings']
        if finding['severity'] == 'unsafe'
    ]
    if not confirm:
        return {
            'ok': False,
            'requiresConfirmation': True,
            'preview': preview,
            'warnings': preview.get('warnings') or [],
            'findings': [f for sk in preview['skills'] for f in sk['findings']],
        }
    if unsafe:
        return {
            'ok': False,
            'error': 'refused: the pack contains unsafe content (shell, URL or credential text)',
            'findings': unsafe,
            'preview': preview,
        }
    if not preview['skills']:
        return {'ok': False, 'error': 'nothing to install', 'refused': preview['refused'], 'preview': preview}

    root = _agentRoot()
    manifest = _loadManifest(root)
    packName = str(plan['pack'])
    entry = manifest.get(packName) or {}
    prevDirs = set(entry.get('skills') or [])
    installed: list[str] = []
    trash_ids: list[str] = []
    refused = list(preview['refused'])
    byName = {str(item['dir']): item for item in plan['skills']}
    for sk in preview['skills']:
        dirname = str(sk['name'])
        safe = _safeDirName(dirname, dirname)
        item = byName.get(dirname) or {}
        files = item.get('files') or {}
        target = root / safe
        if target.exists() and safe not in prevDirs:
            refused.append(f'{dirname}: agent skills dir {safe!r} already exists (not owned by this pack)')
            continue
        if target.exists():
            try:
                trash_ids.append(_trashPackDir(target, dirname))
            except OSError as exc:
                refused.append(f'{dirname}: could not preserve the previous copy: {exc}')
                continue
        target.mkdir(parents=True)
        for rel, blob in files.items():
            dest = (target / rel).resolve()
            if not dest.is_relative_to(target.resolve()):
                continue
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(blob)
        err = _validateSkillFile(target, dirname)
        if err:
            shutil.rmtree(target, ignore_errors=True)
            refused.append(err)
            continue
        installed.append(safe)
    if not installed:
        return {'ok': False, 'error': 'nothing installed', 'refused': refused, 'preview': preview}
    manifest[packName] = {
        'source': source, 'rev': plan['rev'], 'skills': installed, 'installedAt': time.time(),
    }
    _saveManifest(root, manifest)
    for gone in prevDirs - set(installed):
        victim = root / gone
        if victim.is_dir():
            try:
                trash_ids.append(_trashPackDir(victim, gone))
            except OSError as exc:
                log.warning('pack %s: could not trash removed skill %s: %s', packName, gone, exc)
    return {
        'ok': True, 'pack': packName, 'rev': plan['rev'], 'skills': installed,
        'refused': refused, 'warnings': preview.get('warnings') or [],
        'findings': [f for sk in preview['skills'] for f in sk['findings']],
        'trashIds': trash_ids,
        'note': 'skills appear in the catalogue next turn (load_skill by name)',
    }


def list_packs() -> list[dict[str, Any]]:
    root = _agentRoot()
    return [
        {'pack': name, **spec}
        for name, spec in sorted(_loadManifest(root).items())
        if isinstance(spec, dict)
    ]


def uninstall_pack(name: str) -> dict[str, Any]:
    root = _agentRoot()
    manifest = _loadManifest(root)
    spec = manifest.get(name)
    if not isinstance(spec, dict):
        return {'ok': False, 'error': f'no installed pack {name!r}'}
    removed = []
    trash_ids: list[str] = []
    errors: list[str] = []
    for d in spec.get('skills') or []:
        victim = root / str(d)
        if victim.is_dir():
            try:
                trash_ids.append(_trashPackDir(victim, str(d)))
            except OSError as exc:
                # Leave the directory in place and keep it in the manifest —
                # an undoable uninstall either fully protects its content or
                # does not happen.
                errors.append(f'{d}: {exc}')
                continue
            removed.append(str(d))
    if errors:
        return {'ok': False, 'error': 'uninstall failed; nothing further removed', 'errors': errors, 'removed': removed}
    manifest.pop(name, None)
    _saveManifest(root, manifest)
    return {'ok': True, 'pack': name, 'removed': removed, 'trashIds': trash_ids}
