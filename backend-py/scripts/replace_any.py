"""
Replace `Any` type annotations with proper types across the codebase.

Uses regex on annotation patterns, then cleans up imports.
Safe approach: replaces only well-known annotation patterns.
"""

from __future__ import annotations
import re
import os
import sys

ANNOTATION_REPLACEMENTS = [
    ('\\bdict\\[str,\\s*Any\\]', 'dict[str, object]'),
    ('\\bDict\\[str,\\s*Any\\]', 'Dict[str, object]'),
    ('\\blist\\[dict\\[str,\\s*Any\\]\\]', 'list[dict[str, object]]'),
    ('\\bList\\[Dict\\[str,\\s*Any\\]\\]', 'List[Dict[str, object]]'),
    ('\\bAsyncIterator\\[dict\\[str,\\s*Any\\]\\]', 'AsyncIterator[dict[str, object]]'),
    ('\\blist\\[Any\\]', 'list[object]'),
    ('\\bList\\[Any\\]', 'List[object]'),
]


def replaceAnnotations(content: str) -> tuple[str, int]:
    """Replace known annotation patterns. Returns (new_content, count)."""
    total = 0
    for pattern, replacement in ANNOTATION_REPLACEMENTS:
        newContent, count = re.subn(pattern, replacement, content)
        if count > 0:
            total += count
            content = newContent
    return (content, total)


def replaceAnyInParamRet(content: str) -> tuple[str, int]:
    """
    Replace `Any` in function parameter and return type annotations.
    Only matches `Any` that appears in typing contexts.
    """
    total = 0
    content, c = re.subn(':\\s*Any\\s*=\\s*([^,)]+)', ': object = \\1', content)
    total += c
    content, c = re.subn(':\\s*Any\\s*\\|\\s*None', ': object | None', content)
    total += c
    content, c = re.subn(':\\s*Any\\s*[,)]', ': object,', content)
    total += c
    content, c = re.subn('->\\s*Any\\s*\\|\\s*None', '-> object | None', content)
    total += c
    content, c = re.subn('->\\s*Any\\s*:', '-> object:', content)
    total += c
    content, c = re.subn('\\)\\s*->\\s*Any\\s*:', ') -> object:', content)
    total += c
    content, c = re.subn('->\\s*Any\\s*\\n', '-> object\n', content)
    total += c
    content, c = re.subn('->\\s*Any\\s*,', '-> object,', content)
    total += c
    content, c = re.subn(
        'Callable\\[\\[(?:[^\\[\\]]+|\\[[^\\[\\]]*\\])*\\]\\s*,\\s*Any\\]',
        lambda m: m.group(0).replace(', Any]', ', object]'),
        content,
    )
    total += c
    content, c = re.subn(':\\s*Any\\s*$', ': object', content, flags=re.MULTILINE)
    total += c
    content, c = re.subn('dict\\[str,\\s*str\\s*\\|\\s*Any\\]', 'dict[str, str | object]', content)
    total += c
    content, c = re.subn('\\)\\s*,\\s*Any\\s*[,)]', ') , object)', content)
    total += c
    return (content, total)


def cleanImports(content: str) -> str:
    """Remove `Any` from typing imports if it's no longer used."""
    lines = content.split('\n')
    newLines = []
    for line in lines:
        if 'from typing import' in line or 'import typing' in line:
            newLine = line
            if 'from typing import' in line:
                importsPart = line[line.index('import') + len('import') :].strip()
                parts = [p.strip() for p in importsPart.split(',')]
                parts = [p for p in parts if p != 'Any' and p != "'Any'" and (p != '"Any"')]
                if parts:
                    newLine = 'from typing import ' + ', '.join(parts)
                else:
                    newLine = None
            if newLine:
                newLines.append(newLine)
        else:
            newLines.append(line)
    return '\n'.join(newLines)


def needsAny(content: str) -> bool:
    """Check if `Any` is still used in code (not in imports)."""
    lines = content.split('\n')
    for line in lines:
        stripped = line.strip()
        if stripped.startswith('from typing import') or stripped.startswith('import '):
            continue
        if 'Any' in stripped:
            if re.search('\\bAny\\b', stripped):
                return True
    return False


def processFile(filepath: str) -> int:
    """Process a single file, return number of replacements."""
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()
    original = content
    content, count1 = replaceAnnotations(content)
    content, count2 = replaceAnyInParamRet(content)
    total = count1 + count2
    content = cleanImports(content)
    if content != original:
        with open(filepath, 'w', encoding='utf-8') as f:
            f.write(content)
    return total


def main():
    root = sys.argv[1] if len(sys.argv) > 1 else 'C:/Dev/august-proxy/backend-py'
    filesToProcess = []
    for dirpath, dirnames, filenames in os.walk(os.path.join(root, 'app')):
        dirnames[:] = [d for d in dirnames if not d.startswith('.') and d != '.venv']
        for fn in filenames:
            if fn.endswith('.py'):
                filesToProcess.append(os.path.join(dirpath, fn))
    for dirpath, dirnames, filenames in os.walk(os.path.join(root, 'tests')):
        dirnames[:] = [d for d in dirnames if not d.startswith('.') and d != '.venv']
        for fn in filenames:
            if fn.endswith('.py'):
                filesToProcess.append(os.path.join(dirpath, fn))
    totalReplacements = 0
    changedFiles = 0
    for fp in sorted(filesToProcess):
        if '.venv' in fp:
            continue
        try:
            count = processFile(fp)
            if count > 0:
                print(f'  {os.path.relpath(fp, root)}: {count} replacements')
                totalReplacements += count
                changedFiles += 1
        except Exception as e:
            print(f'  ERROR {os.path.relpath(fp, root)}: {e}')
    print(f'\nTotal: {totalReplacements} replacements across {changedFiles} files')


if __name__ == '__main__':
    main()
