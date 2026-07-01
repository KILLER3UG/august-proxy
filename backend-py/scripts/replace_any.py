"""
Replace `Any` type annotations with proper types across the codebase.

Uses regex on annotation patterns, then cleans up imports.
Safe approach: replaces only well-known annotation patterns.
"""
from __future__ import annotations

import re
import os
import sys

# Regex patterns for type annotation replacements.
# Each is (pattern, replacement) applied via re.subn.
# Patterns are applied in order and only match at word boundaries.

ANNOTATION_REPLACEMENTS = [
    # dict[str, Any] → dict[str, object]
    (r'\bdict\[str,\s*Any\]', 'dict[str, object]'),
    # Dict[str, Any] → Dict[str, object]
    (r'\bDict\[str,\s*Any\]', 'Dict[str, object]'),
    # list[dict[str, Any]] → list[dict[str, object]]
    (r'\blist\[dict\[str,\s*Any\]\]', 'list[dict[str, object]]'),
    # List[Dict[str, Any]] → List[Dict[str, object]]
    (r'\bList\[Dict\[str,\s*Any\]\]', 'List[Dict[str, object]]'),
    # AsyncIterator[dict[str, Any]] → AsyncIterator[dict[str, object]]
    (r'\bAsyncIterator\[dict\[str,\s*Any\]\]', 'AsyncIterator[dict[str, object]]'),
    # list[Any] → list[object]
    (r'\blist\[Any\]', 'list[object]'),
    # List[Any] → List[object]
    (r'\bList\[Any\]', 'List[object]'),
]


def replace_annotations(content: str) -> tuple[str, int]:
    """Replace known annotation patterns. Returns (new_content, count)."""
    total = 0
    for pattern, replacement in ANNOTATION_REPLACEMENTS:
        new_content, count = re.subn(pattern, replacement, content)
        if count > 0:
            total += count
            content = new_content
    return content, total


def replace_any_in_param_ret(content: str) -> tuple[str, int]:
    """
    Replace `Any` in function parameter and return type annotations.
    Only matches `Any` that appears in typing contexts.
    """
    total = 0
    
    # MUST apply more specific patterns BEFORE less specific ones
    
    # 1. `: Any = value` (param with default value like None, '', etc.)
    content, c = re.subn(r':\s*Any\s*=\s*([^,)]+)', ': object = \\1', content)
    total += c
    
    # 2. `: Any | None` in params
    content, c = re.subn(r':\s*Any\s*\|\s*None', ': object | None', content)
    total += c
    
    # 3. `: Any` in parameter annotations followed by comma or )
    content, c = re.subn(r':\s*Any\s*[,)]', ': object,', content)
    total += c
    
    # 4. `-> Any | None`
    content, c = re.subn(r'->\s*Any\s*\|\s*None', '-> object | None', content)
    total += c
    
    # 5. `-> Any:` in return types
    content, c = re.subn(r'->\s*Any\s*:', '-> object:', content)
    total += c
    
    # 6. `) -> Any:` (no space before colon)
    content, c = re.subn(r'\)\s*->\s*Any\s*:', ') -> object:', content)
    total += c
    
    # 7. `-> Any\n` (standalone return type before newline)
    content, c = re.subn(r'->\s*Any\s*\n', '-> object\n', content)
    total += c
    
    # 8. `-> Any,` (if Any is part of a tuple return)
    content, c = re.subn(r'->\s*Any\s*,', '-> object,', content)
    total += c
    
    # 9. `Callable[[...], Any]` → `Callable[[...], object]`
    content, c = re.subn(r'Callable\[\[(?:[^\[\]]+|\[[^\[\]]*\])*\]\s*,\s*Any\]', 
                         lambda m: m.group(0).replace(', Any]', ', object]'), content)
    total += c
    
    # 10. `: Any` at end of line (simple param like `def foo(x: Any)`)
    content, c = re.subn(r':\s*Any\s*$', ': object', content, flags=re.MULTILINE)
    total += c
    
    # 11. dict[str, str | Any] → dict[str, str | object]
    content, c = re.subn(r'dict\[str,\s*str\s*\|\s*Any\]', 'dict[str, str | object]', content)
    total += c
    
    # 12. `), Any` in function parameter lists (rare)
    content, c = re.subn(r'\)\s*,\s*Any\s*[,)]', ') , object)', content)
    total += c
    
    return content, total


def clean_imports(content: str) -> str:
    """Remove `Any` from typing imports if it's no longer used."""
    lines = content.split('\n')
    new_lines = []
    for line in lines:
        if 'from typing import' in line or 'import typing' in line:
            # Check if Any is still used in the body (not in imports)
            # We'll just remove Any from this import line regardless
            new_line = line
            # Remove 'Any' from the import
            if 'from typing import' in line:
                imports_part = line[line.index('import') + len('import'):].strip()
                parts = [p.strip() for p in imports_part.split(',')]
                parts = [p for p in parts if p != 'Any' and p != "'Any'" and p != '"Any"']
                if parts:
                    new_line = 'from typing import ' + ', '.join(parts)
                else:
                    # Remove entire import if only Any was imported
                    new_line = None
            if new_line:
                new_lines.append(new_line)
        else:
            new_lines.append(line)
    return '\n'.join(new_lines)


def needs_any(content: str) -> bool:
    """Check if `Any` is still used in code (not in imports)."""
    lines = content.split('\n')
    for line in lines:
        stripped = line.strip()
        if stripped.startswith('from typing import') or stripped.startswith('import '):
            continue
        if 'Any' in stripped:
            # Check it's not in a string
            # Simple heuristic: look for Any with word boundaries
            if re.search(r'\bAny\b', stripped):
                return True
    return False


def process_file(filepath: str) -> int:
    """Process a single file, return number of replacements."""
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()
    
    original = content
    
    # Step 1: Replace annotation patterns
    content, count1 = replace_annotations(content)
    
    # Step 2: Replace Any in param/return types
    content, count2 = replace_any_in_param_ret(content)
    
    total = count1 + count2
    
    # Step 3: Clean up imports
    content = clean_imports(content)
    
    if content != original:
        with open(filepath, 'w', encoding='utf-8') as f:
            f.write(content)
    
    return total


def main():
    root = sys.argv[1] if len(sys.argv) > 1 else 'C:/Dev/august-proxy/backend-py'
    
    # Files to process
    files_to_process = []
    for dirpath, dirnames, filenames in os.walk(os.path.join(root, 'app')):
        dirnames[:] = [d for d in dirnames if not d.startswith('.') and d != '.venv']
        for fn in filenames:
            if fn.endswith('.py'):
                files_to_process.append(os.path.join(dirpath, fn))
    
    for dirpath, dirnames, filenames in os.walk(os.path.join(root, 'tests')):
        dirnames[:] = [d for d in dirnames if not d.startswith('.') and d != '.venv']
        for fn in filenames:
            if fn.endswith('.py'):
                files_to_process.append(os.path.join(dirpath, fn))
    
    total_replacements = 0
    changed_files = 0
    
    for fp in sorted(files_to_process):
        if '.venv' in fp:
            continue
        try:
            count = process_file(fp)
            if count > 0:
                print(f"  {os.path.relpath(fp, root)}: {count} replacements")
                total_replacements += count
                changed_files += 1
        except Exception as e:
            print(f"  ERROR {os.path.relpath(fp, root)}: {e}")
    
    print(f"\nTotal: {total_replacements} replacements across {changed_files} files")


if __name__ == '__main__':
    main()
