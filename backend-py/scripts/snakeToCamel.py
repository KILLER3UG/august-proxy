"""
AST-based snake_case → camelCase converter for Python source files.

Usage:
    python scripts/snake_to_camel.py file.py              # single file
    python scripts/snake_to_camel.py lib/                  # directory
    python scripts/snake_to_camel.py --dry-run file.py     # preview only
    python scripts/snake_to_camel.py --diff file.py        # show unified diff
    python scripts/snake_to_camel.py --report file.py      # audit log

In-place modification with .bak backup.
"""
import ast
import difflib
import json
import os
import re
import sys
from pathlib import Path
from typing import Any
_DENYList: set[str] = {'__init__', '__str__', '__repr__', '__enter__', '__exit__', '__aenter__', '__aexit__', '__call__', '__getattr__', '__setattr__', '__del__', '__add__', '__eq__', '__hash__', '__len__', '__getitem__', '__setitem__', '__iter__', '__next__', '__contains__', '__bool__', '__anext__', '__aiter__', '__delattr__', '__delitem__', '__format__', '__ge__', '__gt__', '__le__', '__lt__', '__ne__', '__new__', '__reduce__', '__reduce_ex__', '__sizeof__', '__sub__', '__mul__', '__truediv__', '__floordiv__', '__mod__', '__pow__', '__neg__', '__pos__', '__abs__', '__invert__', '__and__', '__or__', '__xor__', '__iadd__', '__isub__', '__imul__', '__itruediv__', '__ifloordiv__', '__imod__', '__ipow__', '__iand__', '__ior__', '__ixor__', 'tmp_path', 'monkeypatch', 'capsys', 'caplog', 'request', 'ConfigDict', 'model_validator', 'field_validator', 'model_dump', 'model_validate', 'field_serializer', 'model_config', 'logger'}

def _loadDenyList(path: str) -> set[str]:
    """Extend deny-list from a file (one identifier per line, # comments ignored)."""
    result = set(_DENYList)
    try:
        with open(path) as f:
            for line in f:
                stripped = line.split('#')[0].strip()
                if stripped:
                    result.add(stripped)
    except FileNotFoundError:
        print(f'Warning: deny-list file not found: {path} — using built-in list', file=sys.stderr)
    return result

def _isUpperSnake(name: str) -> bool:
    """Return True if name looks like an UPPER_SNAKE constant."""
    return re.fullmatch('[A-Z][A-Z0-9]*(_[A-Z0-9]+)*', name) is not None

def _snakeToCamel(name: str) -> str:
    """Convert snake_case to camelCase. Preserves leading underscores."""
    if _isUpperSnake(name):
        return name
    if '__' in name:
        return name
    parts = name.split('_')
    leading = ''
    while parts and parts[0] == '':
        leading += '_'
        parts.pop(0)
    if not parts:
        return leading
    result = leading + parts[0] + ''.join((p.capitalize() for p in parts[1:]))
    return result

class SnakeToCamelTransformer(ast.NodeTransformer):
    """Rename snake_case identifiers to camelCase."""

    def __init__(self, deny: set[str]):
        self.deny = deny
        self.renames: list[dict[str, Any]] = []

    def _rename(self, name: str, nodeType: str, location: tuple[int, int]) -> str:
        """Rename if snake_case, log the change."""
        if name in self.deny:
            return name
        if '_' not in name:
            return name
        if name.startswith('__') and name.endswith('__'):
            return name
        if _isUpperSnake(name):
            return name
        camel = _snakeToCamel(name)
        if camel != name:
            self.renames.append({'old': name, 'new': camel, 'type': nodeType, 'line': location[0], 'col': location[1]})
        return camel

    def _renameFunctionParams(self, node: ast.FunctionDef | ast.AsyncFunctionDef) -> None:
        """Rename all parameters of a function definition (shared by sync and async)."""
        for arg in node.args.args:
            arg.arg = self._rename(arg.arg, 'parameter', (arg.lineno or node.lineno, arg.col_offset or 0))
        for arg in node.args.kwonlyargs:
            arg.arg = self._rename(arg.arg, 'parameter', (arg.lineno or node.lineno, arg.col_offset or 0))
        if node.args.vararg:
            node.args.vararg.arg = self._rename(node.args.vararg.arg, 'parameter', (node.args.vararg.lineno or node.lineno, 0))
        if node.args.kwarg:
            node.args.kwarg.arg = self._rename(node.args.kwarg.arg, 'parameter', (node.args.kwarg.lineno or node.lineno, 0))

    def visit_FunctionDef(self, node: ast.FunctionDef) -> Any:
        node.name = self._rename(node.name, 'function', (node.lineno, node.col_offset))
        self._renameFunctionParams(node)
        self.generic_visit(node)
        return node

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> Any:
        node.name = self._rename(node.name, 'function', (node.lineno, node.col_offset))
        self._renameFunctionParams(node)
        self.generic_visit(node)
        return node

    def visit_Name(self, node: ast.Name) -> Any:
        """Rename ALL variable references — both assignments (Store) and usages (Load)."""
        if isinstance(node.ctx, (ast.Store, ast.Load)):
            newId = self._rename(node.id, 'variable', (node.lineno, node.col_offset))
            node.id = newId
        return node

    def visit_Attribute(self, node: ast.Attribute) -> Any:
        """Rename attribute access on 'self' (method calls within class definitions).
        This is safe because 'self.method_name' always refers to our own methods.
        Does NOT rename attributes on other objects (library objects, etc.)."""
        if isinstance(node.value, ast.Name) and node.value.id == 'self':
            newAttr = self._rename(node.attr, 'attribute', (node.lineno, node.col_offset))
            node.attr = newAttr
        self.generic_visit(node)
        return node

    def visit_ImportFrom(self, node: ast.ImportFrom) -> Any:
        """Rename imported names in 'from X import Y' statements."""
        for alias in node.names:
            if alias.asname:
                alias.asname = self._rename(alias.asname, 'import_as', (node.lineno, 0))
            else:
                alias.name = self._rename(alias.name, 'import', (node.lineno, 0))
        return node

    def visit_Import(self, node: ast.Import) -> Any:
        for alias in node.names:
            if alias.asname:
                alias.asname = self._rename(alias.asname, 'import_as', (node.lineno, 0))
        return node

    def visit_ClassDef(self, node: ast.ClassDef) -> Any:
        """Rename class def only if snake_case (rare for classes)."""
        if '_' in node.name and (not node.name[0].isupper()):
            newName = self._rename(node.name, 'class', (node.lineno, node.col_offset))
            node.name = newName
        self.generic_visit(node)
        return node

def convertFile(path: Path, deny: set[str], *, dryRun: bool=False, showDiff: bool=False) -> dict[str, Any]:
    """Process a single Python file. Returns audit info."""
    original = path.read_text(encoding='utf-8')
    try:
        tree = ast.parse(original, filename=str(path))
    except SyntaxError as e:
        return {'file': str(path), 'status': 'error', 'error': f'SyntaxError: {e}', 'renames': []}
    transformer = SnakeToCamelTransformer(deny)
    modifiedTree = transformer.visit(tree)
    ast.fix_missing_locations(modifiedTree)
    try:
        newSource = ast.unparse(modifiedTree)
    except Exception as e:
        return {'file': str(path), 'status': 'error', 'error': str(e), 'renames': []}
    result = {'file': str(path), 'status': 'unchanged' if original == newSource else 'modified', 'renames': transformer.renames}
    if original == newSource:
        return result
    if dryRun:
        print(f'[DRY-RUN] Would modify: {path}')
        for r in transformer.renames:
            print(f"  L{r['line']}: {r['old']} → {r['new']}  ({r['type']})")
        return result
    if showDiff:
        linesOrig = original.splitlines(keepends=True)
        linesNew = newSource.splitlines(keepends=True)
        diff = difflib.unified_diff(linesOrig, linesNew, fromfile=str(path), tofile=str(path), lineterm='')
        sys.stdout.writelines(diff)
    backup = path.with_suffix(path.suffix + '.bak')
    backup.write_text(original, encoding='utf-8')
    path.write_text(newSource, encoding='utf-8')
    result['backup'] = str(backup)
    return result

def convertDirectory(dirPath: Path, deny: set[str], **kwargs) -> list[dict[str, Any]]:
    """Process all .py files in a directory recursively."""
    results = []
    for pyFile in sorted(dirPath.rglob('*.py')):
        if '__pycache__' in pyFile.parts:
            continue
        result = convertFile(pyFile, deny, **kwargs)
        results.append(result)
    return results

def main():
    import argparse
    parser = argparse.ArgumentParser(description='Convert snake_case to camelCase in Python files')
    parser.add_argument('targets', nargs='+', help='Files or directories to convert')
    parser.add_argument('--dry-run', action='store_true', help='Preview changes without modifying')
    parser.add_argument('--diff', action='store_true', help='Show unified diff')
    parser.add_argument('--report', action='store_true', help='Output JSON audit report')
    parser.add_argument('--deny-list', help='Additional deny-list file')
    args = parser.parse_args()
    deny = set(_DENYList)
    if args.deny_list:
        deny = _loadDenyList(args.deny_list)
    allResults = []
    for target in args.targets:
        path = Path(target)
        if path.is_file():
            r = convertFile(path, deny, dryRun=args.dry_run, showDiff=args.diff)
            allResults.append(r)
        elif path.is_dir():
            r = convertDirectory(path, deny, dryRun=args.dry_run, showDiff=args.diff)
            allResults.extend(r)
        else:
            print(f'Warning: {target} not found', file=sys.stderr)
    if args.report:
        print(json.dumps(allResults, indent=2))
    modified = sum((1 for r in allResults if r['status'] == 'modified'))
    unchanged = sum((1 for r in allResults if r['status'] == 'unchanged'))
    errors = sum((1 for r in allResults if r['status'] == 'error'))
    totalRenames = sum((len(r.get('renames', [])) for r in allResults))
    print(f'\nSummary: {modified} modified, {unchanged} unchanged, {errors} errors, {totalRenames} renames')
if __name__ == '__main__':
    main()