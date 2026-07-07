"""
Multi-language regex-based snake_case → camelCase converter.

Used for **TypeScript / TSX / JavaScript** and **Rust** files. (Python has its
own AST tool at `scripts/snakeToCamel.py`.)

Why regex? TS/TSX parsing requires the TypeScript compiler API which is heavy
to bootstrap from a Python harness; with a deny-list of wire-protocol identifiers
and a careful token-aware scanner, regex is sufficient for the surface area
covered here.

The scanner splits each file into three streams:
  • STRING_LITERAL  — anything inside ' " ` ; skipped
  • COMMENT         — // or /* ... */ ; passed through unchanged
  • CODE            — the remainder; renamed

Inside CODE, we look for whole-word matches of an identifier that:
  • contains at least one underscore (i.e. is genuinely snake_case)
  • is not in the deny-list
  • is not all-uppercase (UPPER_SNAKE_CASE constant)
  • has no leading underscore (private names are kept)

Usage:
    python scripts/snakeToCamelMulti.py --lang ts src/             # directory
    python scripts/snakeToCamelMulti.py --lang ts --dry-run file.tsx
    python scripts/snakeToCamelMulti.py --lang rust src-tauri/src/

In-place modification with .bak backup.
"""
from __future__ import annotations
import argparse
import difflib
import json
import re
import sys
from pathlib import Path
from typing import Iterable
sys.path.insert(0, str(Path(__file__).resolve().parent))
from snakeToCamel import _DENYList, _isUpperSnake, _loadDenyList, _snakeToCamel

def _iterStringSpans(text: str, lang: str) -> Iterable[tuple[int, int]]:
    """Yield (start, end) char spans of source text that are string literals.

    For both TS and Rust we recognise:
      • single-quoted  'foo'
      • double-quoted  "foo"
      • backtick       `foo`   (TS template literal; Rust raw string `r#"..."#`
        is also handled with a more permissive rule)
      • Rust raw strings: r"foo", r#"foo"#, br"foo"
    Backslash escapes are honoured.
    """
    i = 0
    n = len(text)
    while i < n:
        c = text[i]
        if c == '/' and i + 1 < n and (text[i + 1] == '/'):
            j = text.find('\n', i)
            if j == -1:
                j = n
            yield (i, j)
            i = j
            continue
        if c == '/' and i + 1 < n and (text[i + 1] == '*'):
            j = text.find('*/', i + 2)
            if j == -1:
                j = n
            else:
                j += 2
            yield (i, j)
            i = j
            continue
        if lang == 'rust' and c in ('r', 'R') and (i + 1 < n) and (text[i + 1] == '"'):
            k = i + 2
            hashes = 0
            while k < n and text[k] == '#':
                hashes += 1
                k += 1
            close = '"' + '#' * hashes
            j = text.find(close, k)
            if j == -1:
                j = n
            else:
                j += len(close)
            yield (i, j)
            i = j
            continue
        if lang == 'rust' and c == 'b' and (i + 1 < n) and (text[i + 1] in ('r', 'R')) and (i + 2 < n) and (text[i + 2] == '"'):
            k = i + 3
            hashes = 0
            while k < n and text[k] == '#':
                hashes += 1
                k += 1
            close = '"' + '#' * hashes
            j = text.find(close, k)
            if j == -1:
                j = n
            else:
                j += len(close)
            yield (i, j)
            i = j
            continue
        if c in ('"', "'"):
            quote = c
            j = i + 1
            while j < n:
                if text[j] == '\\' and j + 1 < n:
                    j += 2
                    continue
                if text[j] == quote:
                    j += 1
                    break
                j += 1
            yield (i, j)
            i = j
            continue
        if lang != 'rust' and c == '`':
            j = i + 1
            while j < n:
                if text[j] == '\\' and j + 1 < n:
                    j += 2
                    continue
                if text[j] == '`':
                    j += 1
                    break
                j += 1
            yield (i, j)
            i = j
            continue
        i += 1

def _isStringPosition(text: str, pos: int, lang: str) -> bool:
    """Return True if pos is inside a string literal or comment."""
    for start, end in _iterStringSpans(text, lang):
        if start <= pos < end:
            return True
    return False
_IDENTRe = re.compile('\\b([a-z][a-zA-Z0-9_]*)\\b')

def _isCamel(s: str) -> bool:
    """Conservative: a name is already camelCase if it has no underscores and
    contains no consecutive uppercase letters preceded by lowercase."""
    if '_' in s:
        return False
    return True

def _renameInCode(text: str, lang: str, deny: set[str]) -> tuple[str, list[dict]]:
    """Return (new_text, rename_log) where rename_log is a list of changes."""
    log: list[dict] = []
    stringSpans = list(_iterStringSpans(text, lang))

    def inString(pos: int) -> bool:
        for s, e in stringSpans:
            if s <= pos < e:
                return True
        return False
    out: list[str] = []
    i = 0
    n = len(text)
    while i < n:
        m = _IDENTRe.match(text, i)
        if not m:
            out.append(text[i])
            i += 1
            continue
        name = m.group(1)
        start, end = m.span()
        if inString(start):
            out.append(text[start:end])
            i = end
            continue
        if '_' not in name:
            out.append(text[start:end])
            i = end
            continue
        if name.startswith('_'):
            out.append(text[start:end])
            i = end
            continue
        if _isUpperSnake(name):
            out.append(text[start:end])
            i = end
            continue
        if name in deny:
            out.append(text[start:end])
            i = end
            continue
        camel = _snakeToCamel(name)
        if camel == name:
            out.append(text[start:end])
            i = end
            continue
        log.append({'old': name, 'new': camel, 'offset': start})
        out.append(camel)
        i = end
    return (''.join(out), log)

def convertFile(path: Path, lang: str, deny: set[str], *, dryRun: bool=False, showDiff: bool=False) -> dict:
    original = path.read_text(encoding='utf-8')
    newText, log = _renameInCode(original, lang, deny)
    result = {'file': str(path), 'status': 'unchanged' if original == newText else 'modified', 'renames': log}
    if original == newText:
        return result
    if dryRun:
        print(f'[DRY-RUN] {path} — {len(log)} rename(s)')
        for r in log[:10]:
            print(f"  off {r['offset']}: {r['old']} → {r['new']}")
        if len(log) > 10:
            print(f'  … +{len(log) - 10} more')
        return result
    if showDiff:
        diff = difflib.unified_diff(original.splitlines(keepends=True), newText.splitlines(keepends=True), fromfile=str(path), tofile=str(path), lineterm='')
        sys.stdout.writelines(diff)
    backup = path.with_suffix(path.suffix + '.bak')
    backup.write_text(original, encoding='utf-8')
    path.write_text(newText, encoding='utf-8')
    result['backup'] = str(backup)
    return result

def convertDirectory(dirPath: Path, lang: str, deny: set[str], **kw) -> list[dict]:
    if lang == 'ts':
        exts = {'.ts', '.tsx', '.js', '.mjs', '.cjs'}
    elif lang == 'rust':
        exts = {'.rs'}
    else:
        raise ValueError(f'unsupported lang: {lang}')
    results = []
    for f in sorted(dirPath.rglob('*')):
        if not f.is_file() or f.suffix not in exts:
            continue
        if any((part in {'node_modules', 'dist', 'build', 'target', '.git', '__pycache__', 'web-dist', 'tsbuildinfo'} for part in f.parts)):
            continue
        results.append(convertFile(f, lang, deny, **kw))
    return results

def main() -> None:
    parser = argparse.ArgumentParser(description='Multi-language snake_case → camelCase (TS/TSX/JS/Rust)')
    parser.add_argument('targets', nargs='+', help='Files or directories to convert')
    parser.add_argument('--lang', choices=['ts', 'rust'], required=True)
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--diff', action='store_true')
    parser.add_argument('--report', action='store_true')
    parser.add_argument('--deny-list', help='Additional deny-list file')
    args = parser.parse_args()
    deny = set(_DENYList)
    if args.deny_list:
        deny = _loadDenyList(args.deny_list)
    allResults: list[dict] = []
    for target in args.targets:
        p = Path(target)
        if p.is_file():
            allResults.append(convertFile(p, args.lang, deny, dry_run=args.dry_run, show_diff=args.diff))
        elif p.is_dir():
            allResults.extend(convertDirectory(p, args.lang, deny, dry_run=args.dry_run, show_diff=args.diff))
        else:
            print(f'Warning: {target} not found', file=sys.stderr)
    if args.report:
        print(json.dumps(allResults, indent=2))
    modified = sum((1 for r in allResults if r['status'] == 'modified'))
    unchanged = sum((1 for r in allResults if r['status'] == 'unchanged'))
    totalRenames = sum((len(r.get('renames', [])) for r in allResults))
    print(f'\nSummary: {modified} modified, {unchanged} unchanged, {totalRenames} renames')
if __name__ == '__main__':
    main()