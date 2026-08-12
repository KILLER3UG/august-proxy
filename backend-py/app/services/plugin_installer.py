"""Install MCP plugin sources from GitHub without requiring the git binary.

Preferred path: ``git clone --depth 1`` when git is available. Fallback: the
codeload tarball over HTTP, extracted with ``tarfile`` — public GitHub plugin
sources install correctly even without Git (audit feature).

Install layout: ``data/plugins/<name>/`` with the repo contents; the entry
point (``dist/index.js`` → ``index.js`` → …) is detected and the server is
registered as ``node <entry>``. A ``package.json`` without a bundled build
gets a best-effort ``npm install --omit=dev`` when npm is available.
"""

from __future__ import annotations

import io
import logging
import os
import re
import shutil
import subprocess
import tarfile
import tempfile
import urllib.parse
import uuid
from pathlib import Path

logger = logging.getLogger(__name__)

_SOURCE_RE = re.compile(
    r'^(?:https?://github\.com/|git@github\.com:|ssh://git@github\.com/)?'
    r'([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+?)(?:\.git)?(?:#([A-Za-z0-9_.\-/]+))?$'
)

_ENTRY_CANDIDATES = (
    'dist/index.js',
    'index.js',
    'dist/index.mjs',
    'index.mjs',
    'src/index.js',
    'src/index.mjs',
)


class PluginInstallError(RuntimeError):
    """Raised when a plugin source cannot be installed."""


def parse_source(source: str) -> tuple[str, str, str]:
    """Parse ``owner/repo`` or a GitHub URL into (owner, repo, ref)."""
    m = _SOURCE_RE.match((source or '').strip())
    if not m:
        raise PluginInstallError(
            f'Invalid GitHub source {source!r}. Use "owner/repo" or a github.com URL '
            '(optionally with #ref for a branch or tag).'
        )
    return m.group(1), m.group(2), m.group(3) or 'HEAD'


def _git_available() -> bool:
    try:
        r = subprocess.run(
            ['git', '--version'], capture_output=True, text=True, timeout=10,
            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0) if os.name == 'nt' else 0,
        )
        return r.returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def _clone_with_git(owner: str, repo: str, ref: str, dest: Path) -> None:
    url = f'https://github.com/{owner}/{repo}.git'
    args = ['git', 'clone', '--depth', '1']
    if ref != 'HEAD':
        args += ['--branch', ref]
    args += [url, str(dest)]
    r = subprocess.run(
        args,
        capture_output=True,
        text=True,
        timeout=300,
        creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0) if os.name == 'nt' else 0,
    )
    if r.returncode != 0:
        raise PluginInstallError(f'git clone failed: {(r.stderr or r.stdout)[:500]}')


def _download_tarball(owner: str, repo: str, ref: str, dest: Path) -> None:
    """HTTP tarball fallback — no git binary required."""
    import httpx

    url = f'https://codeload.github.com/{owner}/{repo}/tar.gz/{urllib.parse.quote(ref)}'
    try:
        resp = httpx.get(url, follow_redirects=True, timeout=120)
        resp.raise_for_status()
    except (httpx.HTTPError, httpx.RequestError) as exc:
        raise PluginInstallError(f'tarball download failed for {owner}/{repo}: {exc}') from exc
    tmp = Path(tempfile.gettempdir()) / f'august-plugin-{uuid.uuid4().hex[:8]}'
    try:
        tmp.mkdir(parents=True, exist_ok=True)
        # Wrap the response bytes in a BytesIO — tarfile needs a file-like
        # object with .read().
        with tarfile.open(fileobj=io.BytesIO(resp.content), mode='r:gz') as tf:
            tf.extractall(tmp, filter='data')  # path-traversal-safe extraction
        members = [p for p in tmp.iterdir() if p.is_dir()]
        src = members[0] if len(members) == 1 else tmp
        shutil.move(str(src), str(dest))
    except (tarfile.TarError, OSError) as exc:
        raise PluginInstallError(f'tarball extraction failed: {exc}') from exc
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def _detect_entry(root: Path) -> str | None:
    for cand in _ENTRY_CANDIDATES:
        p = root / cand
        if p.is_file():
            return cand
    return None


def _npm_install(root: Path) -> None:
    """Best-effort dependency install for package-based plugins."""
    if not (root / 'package.json').is_file():
        return
    try:
        r = subprocess.run(
            ['npm', 'install', '--omit=dev', '--no-audit', '--no-fund'],
            cwd=str(root),
            capture_output=True,
            text=True,
            timeout=300,
            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0) if os.name == 'nt' else 0,
        )
        if r.returncode != 0:
            logger.warning('plugin npm install failed: %s', (r.stderr or r.stdout)[:400])
    except (OSError, subprocess.SubprocessError):
        logger.warning('plugin npm install unavailable — dependencies may be missing')


def _safe_dir_name(name: str) -> str:
    safe = re.sub(r'[^A-Za-z0-9_.-]', '_', (name or 'plugin').strip())[:80] or 'plugin'
    return safe


async def install_from_github(name: str, source: str) -> dict[str, object]:
    """Install a GitHub plugin source into ``data/plugins/<name>``.

    Returns ``{ok, dir, entry, command, args, method}`` or an error dict.
    """
    try:
        from app.lib.paths import dataPath

        owner, repo, ref = parse_source(source)
        dest = dataPath('plugins', _safe_dir_name(name))
        if dest.exists():
            entry = _detect_entry(dest)
            if entry is None:
                return {
                    'ok': False,
                    'error': (
                        f'Plugin directory {dest} exists but no entry point was found '
                        '(dist/index.js / index.js). Delete it or pick another name.'
                    ),
                }
            return {
                'ok': True,
                'dir': str(dest),
                'entry': entry,
                'command': 'node',
                'args': [str(dest / entry)],
                'method': 'existing',
                'note': 'Already installed — reusing the existing copy.',
            }
        dest.parent.mkdir(parents=True, exist_ok=True)
        method = 'git'
        try:
            if _git_available():
                _clone_with_git(owner, repo, ref, dest)
            else:
                raise PluginInstallError('git binary not available')
        except PluginInstallError:
            method = 'tarball'
            _download_tarball(owner, repo, ref, dest)
        entry = _detect_entry(dest)
        if entry is None:
            shutil.rmtree(dest, ignore_errors=True)
            return {
                'ok': False,
                'error': (
                    f'No runnable entry point found in {owner}/{repo} '
                    '(looked for dist/index.js, index.js, index.mjs, src/index.js).'
                ),
            }
        _npm_install(dest)
        return {
            'ok': True,
            'dir': str(dest),
            'entry': entry,
            'command': 'node',
            'args': [str(dest / entry)],
            'method': method,
        }
    except PluginInstallError as exc:
        return {'ok': False, 'error': f'Plugin install failed: {exc}'}
    except Exception as exc:  # defensive — never crash the tool call
        logger.exception('plugin install failed for %s', name)
        return {'ok': False, 'error': f'Plugin install failed: {exc}'}
