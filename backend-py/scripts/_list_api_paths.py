"""List frontend /api path prefixes vs backend OpenAPI paths.

Treats a frontend path as covered when it equals a backend route or is a
**prefix** of one (so `/api/curator/pin` matches `/api/curator/pin/{name}`).
Also normalizes template literals and encodeURIComponent wrappers.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FRONT = ROOT / 'frontend' / 'desktop' / 'src'
BACKEND = ROOT / 'backend-py'


def _normalize_front_path(raw: str) -> str:
    path = raw.split('?')[0]
    # ${encodeURIComponent(x)} / ${id} → {param}
    path = re.sub(r'\$\{[^}]*\}', '{param}', path)
    # Truncated template mid-expression (regex cut at '('): drop trailing junk
    path = re.sub(r'\$\{.*$', '', path)
    path = path.rstrip('/')
    # Collapse accidental double slashes
    path = re.sub(r'/+', '/', path)
    return path


def frontend_paths() -> set[str]:
    paths: set[str] = set()
    for p in FRONT.rglob('*'):
        if p.suffix not in {'.ts', '.tsx'}:
            continue
        if 'test' in p.parts or p.name.endswith('.test.tsx') or p.name.endswith('.test.ts'):
            continue
        text = p.read_text(encoding='utf-8', errors='ignore')
        # Allow parentheses inside ${...} by matching until next quote
        for m in re.finditer(r'''['"`](/api/[^'"`]+)['"`]''', text):
            path = _normalize_front_path(m.group(1))
            if path.count('/') >= 2:
                paths.add(path)
    return paths


def backend_paths() -> set[str]:
    sys.path.insert(0, str(BACKEND))
    from app.main import app  # noqa: WPS433

    schema = app.openapi()
    paths: set[str] = set()
    for path in schema.get('paths', {}):
        norm = re.sub(r'\{[^}]+\}', '{param}', path)
        paths.add(norm.rstrip('/'))
    return paths


def covered(front: str, back: set[str]) -> bool:
    """True if front equals a backend path or is a segment-wise prefix of one.

    Also treats a trailing frontend ``{param}`` as optional query-style noise
    when the backend route is the same without that segment
    (e.g. ``/api/august/ui-events{param}`` vs ``/api/august/ui-events``).
    """
    candidates = [front]
    # Paths like /api/foo{param} (malformed capture of ?query) → /api/foo
    if front.endswith('{param}'):
        candidates.append(front[: -len('{param}')].rstrip('/'))
    # /api/foo/{param} → try without last segment
    if front.endswith('/{param}'):
        candidates.append(front[: -len('/{param}')])

    for cand in candidates:
        f_parts = [p for p in cand.split('/') if p]
        for b in back:
            b_parts = [p for p in b.split('/') if p]
            if len(f_parts) > len(b_parts):
                continue
            ok = True
            for i, fp in enumerate(f_parts):
                bp = b_parts[i]
                if fp == '{param}' or bp == '{param}':
                    continue
                if fp != bp:
                    ok = False
                    break
            if ok:
                return True
    return False


def main() -> None:
    front = frontend_paths()
    back = backend_paths()
    print(f'frontend unique paths: {len(front)}')
    print(f'backend OpenAPI paths: {len(back)}')
    missing = sorted(p for p in front if not covered(p, back))
    print(f'\n=== Frontend paths with no backend match ({len(missing)}) ===')
    for p in missing:
        print(p)
    print('\n=== Backend sample (first 40) ===')
    for p in sorted(back)[:40]:
        print(p)


if __name__ == '__main__':
    main()
