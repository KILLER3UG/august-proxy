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


def install_pack(source: str) -> dict[str, Any]:
    """Fetch, validate, and install a skill pack. Returns a receipt dict."""
    url, subdir = _archive_url(source)
    try:
        blob = _fetch(url)
    except httpx.HTTPError as exc:
        return {'ok': False, 'error': f'network error: {exc}'}
    rev = hashlib.sha256(blob).hexdigest()[:12]

    try:
        zf = zipfile.ZipFile(io.BytesIO(blob))
    except zipfile.BadZipFile:
        return {'ok': False, 'error': 'archive is not a valid zip'}
    with zf:
        names = zf.namelist()
        for n in names:
            if n.startswith('/') or '..' in Path(n).parts:
                return {'ok': False, 'error': 'archive contains an unsafe path — refused'}
        skills = _skillDirsInArchive(zf, subdir)
        if not skills:
            return {'ok': False, 'error': 'no skill folders (directories with SKILL.md) found in the archive'}

        packName = (subdir.split('/')[-1] if subdir else source.rstrip('/').split('/')[-1]) or 'pack'
        packName = re.sub(r'[^A-Za-z0-9._ -]', '', packName)[:48] or 'pack'
        root = _agentRoot()
        manifest = _loadManifest(root)
        entry = manifest.get(packName) or {}
        prevDirs = set(entry.get('skills') or [])

        installed: list[str] = []
        refused: list[str] = []
        for dirname, (dirPrefix, memberPaths) in sorted(skills.items()):
            safe = re.sub(r'[^A-Za-z0-9._ -]', '-', dirname)[:64]
            if not _SAFE_NAME.match(safe) or safe in ('.', '..'):
                refused.append(f'{dirname}: invalid directory name')
                continue
            target = root / safe
            if target.exists() and safe not in prevDirs:
                refused.append(f'{dirname}: agent skills dir {safe!r} already exists (not owned by this pack)')
                continue
            if target.exists():
                shutil.rmtree(target)
            target.mkdir(parents=True)
            wrote = False
            for m in memberPaths:
                relPath = m[len(dirPrefix):] if dirPrefix and m.startswith(dirPrefix) else m.rsplit('/', 1)[-1]
                if not relPath:
                    continue
                dest = (target / relPath).resolve()
                if not str(dest).startswith(str(target.resolve())):
                    continue  # traversal belt-and-braces
                dest.parent.mkdir(parents=True, exist_ok=True)
                dest.write_bytes(zf.read(m))
                if relPath == 'SKILL.md':
                    wrote = True
            if not wrote:
                shutil.rmtree(target, ignore_errors=True)
                refused.append(f'{dirname}: SKILL.md could not be materialized')
                continue
            # Same authoring door as the UI add-box.
            err = _validateSkillFile(target, dirname)
            if err:
                shutil.rmtree(target, ignore_errors=True)
                refused.append(err)
                continue
            installed.append(safe)

        if not installed:
            return {'ok': False, 'error': 'nothing installed', 'refused': refused}
        manifest[packName] = {
            'source': source, 'rev': rev, 'skills': installed, 'installedAt': time.time(),
        }
        _saveManifest(root, manifest)
        # Drop old dirs of THIS pack that the new version no longer contains.
        for gone in prevDirs - set(installed):
            victim = root / gone
            if victim.is_dir():
                shutil.rmtree(victim, ignore_errors=True)
        return {
            'ok': True, 'pack': packName, 'rev': rev, 'skills': installed,
            'refused': refused,
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
    for d in spec.get('skills') or []:
        victim = root / str(d)
        if victim.is_dir():
            shutil.rmtree(victim, ignore_errors=True)
            removed.append(str(d))
    manifest.pop(name, None)
    _saveManifest(root, manifest)
    return {'ok': True, 'pack': name, 'removed': removed}
