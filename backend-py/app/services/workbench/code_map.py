"""
Code map — lightweight repo skeleton for the prompt (Aider repo-map lite).

Builds a cheap, deterministic block: a 2-level directory tree plus the first
comment/signature lines of the top-N files by size. The model navigates with
a map instead of guessing paths, which materially improves first-hop accuracy
for weak models. No tree-sitter, no indexing — a bounded os.walk with a short
mtime-based cache so prompt builds stay fast.
"""

from __future__ import annotations

import logging
import os
import time
from pathlib import Path

logger = logging.getLogger(__name__)

MAX_FILES = 20          # files whose signature lines we include
MAX_SIG_LINES = 3       # signature lines per file
MAX_LINE_LEN = 120
_MAX_TREE_PER_DIR = 8   # entries per directory before "… N more"
_CACHE_TTL_S = 120.0  # RAM/CPU pass: was 30s — a bounded walk + stat() of the
                      # workspace ran every prompt build; 2 min is still fresh
_SKIP_DIRS = frozenset(
    {
        '.git',
        'node_modules',
        'dist',
        'build',
        '.venv',
        'venv',
        '__pycache__',
        '.next',
        '.turbo',
        # Audit finding 2026-09-15 #5: tool caches and build output ate the
        # whole 90-line tree budget, so the real source dirs never appeared.
        '.mypy_cache',
        '.pytest_cache',
        '.ruff_cache',
        '.tox',
        '.eggs',
        'htmlcov',
        '.out',
        'out',
        'target',
        'web-dist',
        'releases',
        'coverage',
    }
)
# Extensions worth showing a signature for. The map exists so the model can
# navigate CODE; the old "largest files" ranking made lockfiles and plan
# markdown the headline entries (audit finding 2026-09-15 #5).
_SOURCE_EXTS = frozenset(
    {
        '.py',
        '.pyi',
        '.js',
        '.jsx',
        '.mjs',
        '.cjs',
        '.ts',
        '.tsx',
        '.vue',
        '.svelte',
        '.rs',
        '.go',
        '.java',
        '.kt',
        '.c',
        '.h',
        '.cpp',
        '.hpp',
        '.cs',
        '.rb',
        '.php',
        '.swift',
        '.scala',
        '.sh',
        '.ps1',
        '.sql',
        '.vhd',
        '.vhdl',
        '.sv',
        '.proto',
    }
)
_SKIP_EXTS = frozenset(
    {
        '.png',
        '.jpg',
        '.jpeg',
        '.gif',
        '.ico',
        '.lock',
        '.map',
        '.min.js',
        '.woff',
        '.woff2',
        '.ttf',
        # Same finding: these were reaching the signature reader, which opens
        # with errors='replace' — a SQLite brain DB became the *largest* file
        # and its binary content was pasted into the system prompt.
        '.db',
        '.sqlite',
        '.sqlite3',
        '.db-wal',
        '.db-shm',
        '.jsonl',
        '.key',
        '.pem',
        '.p12',
        '.pkl',
        '.pyd',
        '.so',
        '.dll',
        '.exe',
        '.zip',
        '.gz',
        '.whl',
        '.pdf',
        '.mp4',
        '.wasm',
        '.coverage',
    }
)
# Dot-directories are tool state (.aug, .zcode, .claude, .opencode, .idea…),
# not project source. `.github` is the exception: workflows are real,
# navigable project content.
_KEEP_DOT_DIRS = frozenset({'.github'})
_BINARY_SNIFF_BYTES = 1024

_cache: dict[str, tuple[float, str]] = {}
_gitDirsCache: dict[str, tuple[float, frozenset[str]]] = {}


def _is_binary(path: Path) -> bool:
    """True when the file's head contains a NUL byte (or cannot be read).

    The signature reader decodes with ``errors='replace'``, so "opens without
    raising" never proved text — the extension list alone also misses SQLite
    sidecars and vendored blobs. A NUL in the first KiB is the cheap, standard
    discriminator.
    """
    try:
        with open(path, 'rb') as fh:
            return b'\x00' in fh.read(_BINARY_SNIFF_BYTES)
    except OSError:
        return True


def _git_tracked_dirs(root: Path) -> frozenset[str]:
    """Posix dirs holding at least one git-tracked file ('' = root).

    One ``git ls-files`` probe, cached on the same TTL as the map itself, used
    only to ORDER the tree so real source comes first when the 90-line budget
    still runs out. Any failure (no git, not a repo, timeout) yields an empty
    set and the ordering falls back to plain alphabetical.
    """
    key = str(root)
    now = time.monotonic()
    cached = _gitDirsCache.get(key)
    if cached is not None and now - cached[0] < _CACHE_TTL_S:
        return cached[1]
    dirs: set[str] = set()
    try:
        import subprocess

        proc = subprocess.run(
            ['git', 'ls-files', '--', '.'],
            cwd=str(root),
            capture_output=True,
            timeout=3,
            check=False,
        )
        if proc.returncode == 0:
            out = proc.stdout.decode('utf-8', errors='replace')
            dirs = set()
            for line in out.splitlines():
                rel = os.path.dirname(line.replace('\\', '/'))
                if rel:
                    dirs.add(rel)
                else:
                    dirs.add('')
    except Exception:
        logger.debug('code_map: git ls-files probe failed', exc_info=True)
    result = frozenset(dirs)
    if len(_gitDirsCache) > 32:
        _gitDirsCache.clear()
    _gitDirsCache[key] = (now, result)
    return result


def _ignored_dirs(root: Path) -> frozenset[str]:
    """Plain directory names the repo's own ``.gitignore`` excludes.

    The project already names most of the map noise itself (``web-dist/``,
    ``data/``, ``node_modules/``, ``.mypy_cache/``), so honouring it beats a
    hardcoded list that is wrong for every other workspace. Only bare
    ``name`` / ``/name`` / ``name/`` entries count — anything with a wildcard,
    a path separator or a negation is skipped rather than guessed at, so a
    mis-parse can never hide real source.
    """
    names: set[str] = set()
    try:
        text = (root / '.gitignore').read_text(encoding='utf-8', errors='replace')
    except OSError:
        return frozenset()
    for line in text.splitlines():
        entry = line.strip()
        if not entry or entry.startswith(('#', '!')):
            continue
        entry = entry.strip('/')
        if entry and '/' not in entry and '*' not in entry:
            names.add(entry)
    return frozenset(names)


_TEST_DIR_NAMES = frozenset({'tests', 'test', '__tests__', 'spec', 'specs'})


def _is_test_path(rel_dir: str) -> bool:
    """True for anything under a test/spec directory.

    Size-ranked signatures otherwise fill the block with test docstrings: in
    most repos the largest source files ARE tests, and their module headers
    say nothing about the API surface the map exists to convey.
    """
    return bool(_TEST_DIR_NAMES.intersection(rel_dir.replace(os.sep, '/').split('/')))


def _signature_lines(path: Path) -> list[str]:
    """First non-blank lines (comment/signature) of a source file."""
    if _is_binary(path):
        return []
    lines: list[str] = []
    try:
        with open(path, 'r', encoding='utf-8', errors='replace') as f:
            for raw in f:
                line = raw.rstrip('\n').rstrip('\r')
                stripped = line.strip()
                if not stripped:
                    continue
                if stripped.startswith('#') or stripped.startswith('//') or stripped.startswith('/*'):
                    lines.append(stripped[:MAX_LINE_LEN])
                elif len(lines) < 1:
                    # First code line doubles as a signature (e.g. `def foo(`,
                    # `export function bar`).
                    lines.append(stripped[:MAX_LINE_LEN])
                if len(lines) >= MAX_SIG_LINES:
                    break
    except OSError:
        pass
    return lines


def build_code_map(workspace_path: str | None) -> str:
    """Return the code-map block (or '' when there is no workspace)."""
    if not workspace_path:
        return ''
    root = Path(workspace_path).expanduser()
    if not root.is_dir():
        return ''
    try:
        key = str(root.resolve())
        now = time.monotonic()
        cached = _cache.get(key)
        if cached is not None and now - cached[0] < _CACHE_TTL_S:
            return cached[1]
    except OSError:
        return ''

    tree: dict[str, list[str]] = {}
    files: list[tuple[int, Path]] = []
    skipDirs = _SKIP_DIRS | _ignored_dirs(root)
    try:
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [
                d
                for d in dirnames
                if d not in skipDirs and (d in _KEEP_DOT_DIRS or not d.startswith('.'))
            ]
            rel_dir = os.path.relpath(dirpath, root)
            if rel_dir == '.':
                rel_dir = ''
            depth = 0 if not rel_dir else rel_dir.count(os.sep) + 1
            if depth > 2:
                dirnames[:] = []
                continue
            for name in filenames:
                ext = os.path.splitext(name)[1].lower()
                if ext in _SKIP_EXTS or name.startswith('.'):
                    continue
                p = Path(dirpath) / name
                try:
                    size = p.stat().st_size
                except OSError:
                    continue
                if size > 1_500_000 or size == 0:
                    continue
                if _is_binary(p):
                    continue
                if ext in _SOURCE_EXTS and not _is_test_path(rel_dir):
                    files.append((size, p))
                bucket = tree.setdefault(rel_dir, [])
                if name not in bucket:
                    bucket.append(name)
    except OSError:
        return ''

    # Deterministic tree: git-tracked directories first (real source beats
    # whatever survived the skip lists), dirs sorted, files sorted. Cap 90
    # entries (was 120 — latency fix 2026-09-02: the tree is navigational, not
    # exhaustive; list_directory covers the rest, and every prompt char is
    # per-request cost).
    trackedDirs = _git_tracked_dirs(root)
    tree_lines: list[str] = []
    for rel_dir in sorted(
        tree, key=lambda d: (0 if d.replace(os.sep, '/') in trackedDirs else 1, d)
    ):
        prefix = '' if not rel_dir else rel_dir.replace(os.sep, '/') + '/'
        names = sorted(tree[rel_dir])
        # Per-directory cap: without it, one big folder (this repo's tests/)
        # fills the whole 90-line budget alphabetically and the map stops being
        # a picture of the repo's SHAPE — which is the only reason it exists.
        shown = names[:_MAX_TREE_PER_DIR]
        for name in shown:
            tree_lines.append(f'{prefix}{name}')
        if len(names) > len(shown):
            tree_lines.append(f'{prefix}… {len(names) - len(shown)} more')
    tree_block = '\n'.join(tree_lines[:90])

    # Signatures for the largest files (code density > size).
    files.sort(key=lambda kv: (-kv[0], kv[1].name))
    sig_lines: list[str] = []
    for _size, p in files[:MAX_FILES]:
        sigs = _signature_lines(p)
        if not sigs:
            continue
        rel = os.path.relpath(p, root).replace('\\', '/')
        sig_lines.append(f'{rel}: {sigs[0]}')
        for extra in sigs[1:]:
            sig_lines.append(f'    {extra}')

    parts: list[str] = []
    if tree_lines:
        parts.append('Files:\n' + tree_block)
    if sig_lines:
        parts.append('Signatures:\n' + '\n'.join(sig_lines))
    block = '\n\n'.join(parts)
    try:
        _cache[key] = (time.monotonic(), block)
    except Exception:
        pass
    return block
