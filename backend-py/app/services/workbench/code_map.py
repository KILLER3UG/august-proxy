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
_CACHE_TTL_S = 120.0  # RAM/CPU pass: was 30s — a bounded walk + stat() of the
                      # workspace ran every prompt build; 2 min is still fresh
_SKIP_DIRS = frozenset({'.git', 'node_modules', 'dist', 'build', '.venv', 'venv', '__pycache__', '.next', '.turbo'})
_SKIP_EXTS = frozenset({'.png', '.jpg', '.jpeg', '.gif', '.ico', '.lock', '.map', '.min.js', '.woff', '.woff2', '.ttf'})

_cache: dict[str, tuple[float, str]] = {}


def _signature_lines(path: Path) -> list[str]:
    """First non-blank lines (comment/signature) of a source file."""
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
    try:
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames if d not in _SKIP_DIRS]
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
                files.append((size, p))
                bucket = tree.setdefault(rel_dir, [])
                if name not in bucket:
                    bucket.append(name)
    except OSError:
        return ''

    # Deterministic tree: dirs sorted, files sorted. Cap 90 entries (was 120
    # — latency fix 2026-09-02: the tree is navigational, not exhaustive;
    # list_directory covers the rest, and every prompt char is per-request
    # cost).
    tree_lines: list[str] = []
    for rel_dir in sorted(tree):
        prefix = '' if not rel_dir else f'{rel_dir}/'
        for name in sorted(tree[rel_dir]):
            tree_lines.append(f'{prefix}{name}')
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
