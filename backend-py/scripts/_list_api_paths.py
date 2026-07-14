"""List frontend /api path prefixes vs backend OpenAPI paths."""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FRONT = ROOT / 'frontend' / 'desktop' / 'src'
BACKEND = ROOT / 'backend-py'


def frontend_paths() -> set[str]:
    paths: set[str] = set()
    for p in FRONT.rglob('*'):
        if p.suffix not in {'.ts', '.tsx'}:
            continue
        # Skip tests — they often hardcode fake paths
        if 'test' in p.parts or p.name.endswith('.test.tsx') or p.name.endswith('.test.ts'):
            continue
        text = p.read_text(encoding='utf-8', errors='ignore')
        for m in re.finditer(r'''['"`](/api/[a-zA-Z0-9_./${}-]+)''', text):
            path = m.group(1).split('?')[0]
            # Drop broken captures from template literals mid-expression
            if '${' in path and not path.endswith('}'):
                path = path.split('${')[0].rstrip('/')
            path = re.sub(r'\$\{[^}]+\}', '{param}', path)
            path = path.rstrip('.')
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
        paths.add(norm)
    return paths


def covered(front: str, back: set[str]) -> bool:
    f_parts = front.split('/')
    for b in back:
        b_parts = b.split('/')
        if len(f_parts) != len(b_parts):
            continue
        ok = True
        for fp, bp in zip(f_parts, b_parts):
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
