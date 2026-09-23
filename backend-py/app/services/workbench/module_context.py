"""
Module context — a bounded reading package for one file or directory.

The workbench already puts a whole-workspace map in the prompt
(``code_map.build_code_map``), which answers "what exists" but not "what is
this". Navigating that gap costs the model reads: to learn a module's surface
it opens the file, and the file's body enters context along with its
implementation. This module returns the parts that actually change how you
use a file — its exported names and signatures, what it imports, and what
imports it — in a fixed budget, so an agent can decide *which* file to read
without reading any of them.

Three rules it exists to enforce:

* **Bounded.** Every section has a cap and the whole block has one. The budget
  is what makes this cheaper than `read_file`.
* **Never silently short.** When something is dropped — a section over budget,
  a dependency scan that hit its ceiling — the output says so and says how
  much. A truncated roster that reads like a complete one is worse than no
  roster (ZCode's `GetWorkflowRunRoster` makes the same call with
  ``truncated: true``).
* **Contained.** Paths resolve through the same ``bind_path`` the file tools
  use, so this can no more leave the workspace than ``read_file`` can.
"""

from __future__ import annotations

import ast
import os
import re
import time
from pathlib import Path

__all__ = ['build_module_context', 'MAX_CONTEXT_CHARS']

MAX_CONTEXT_CHARS = 6000
_MAX_SIGNATURES = 40        # top-level names listed per file
_MAX_METHODS_PER_CLASS = 12
_MAX_IMPORTS = 25
_MAX_DEPENDENTS = 15
_MAX_DIR_ENTRIES = 60
_HEADER_CHARS = 500         # leading docstring / comment block
_SIG_LINE_CHARS = 150
_SCAN_FILE_BYTES = 200_000  # skip giant files during the reverse-dependency scan
_TARGET_FILE_BYTES = 8_000_000  # the file you actually asked about is read whole
_SCAN_BUDGET_S = 3.0
_SCAN_MAX_FILES = 4000

# Which extensions can import a file of a given language. A `.tsx` has no
# Python importers, and scanning 4,000 files to prove that is the difference
# between a useful answer and a three-second one.
_LANGUAGE_GROUPS: dict[frozenset[str], frozenset[str]] = {
    frozenset({'.py', '.pyi'}): frozenset({'.py', '.pyi'}),
    frozenset({'.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte'}):
        frozenset({'.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte'}),
    frozenset({'.rs'}): frozenset({'.rs'}),
    frozenset({'.go'}): frozenset({'.go'}),
    frozenset({'.java', '.kt', '.scala'}): frozenset({'.java', '.kt', '.scala'}),
    frozenset({'.c', '.h', '.cpp', '.hpp'}): frozenset({'.c', '.h', '.cpp', '.hpp'}),
}


def _language_group(ext: str) -> frozenset[str]:
    for group in _LANGUAGE_GROUPS.values():
        if ext in group:
            return group
    return _CODE_EXTS

_SKIP_DIRS = frozenset({
    '.git', 'node_modules', 'dist', 'build', '.venv', 'venv', '__pycache__',
    '.next', '.turbo', '.mypy_cache', '.pytest_cache', '.ruff_cache', '.tox',
    '.eggs', 'htmlcov', 'out', 'target', 'web-dist', 'releases', 'coverage',
    '.aug', '.idea', '.vscode',
})
_CODE_EXTS = frozenset({
    '.py', '.pyi', '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.vue',
    '.svelte', '.rs', '.go', '.java', '.kt', '.c', '.h', '.cpp', '.hpp',
    '.cs', '.rb', '.php', '.swift', '.scala',
})
_ENTRY_NAMES = (
    'index.ts', 'index.tsx', 'index.js', 'index.jsx', '__init__.py',
    'main.py', 'mod.rs', 'lib.rs', 'main.go', 'mod.ts',
)

_TS_SIG = re.compile(
    r'^\s*(?:export\s+)?(?:default\s+)?'
    r'(?:async\s+)?(?:function|class|interface|type|enum|const|let|var)\s+'
    r'([A-Za-z_$][\w$]*)'
)
_RS_SIG = re.compile(r'^\s*(?:pub(?:\([^)]*\))?\s+)?(?:default\s+)?'
                     r'(?:async\s+)?(fn|struct|enum|trait|type|impl)\s+([A-Za-z_]\w*)')
_GOLANG_SIG = re.compile(r'^\s*func\s+(?:\([^)]*\)\s*)?([A-Z]\w*)')


def _read_text(path: Path, max_bytes: int = _SCAN_FILE_BYTES) -> str:
    """Read a source file, refusing binaries.

    Two size regimes on purpose. The dependency scan has to stay fast across
    thousands of files, so it skips anything over `_SCAN_FILE_BYTES`. The
    *target* the model just asked about gets the whole file: the biggest modules
    are exactly where a bounded reading package pays for itself, and skipping
    them would make the tool useless on precisely the files it exists for.
    """
    try:
        if path.stat().st_size > max_bytes:
            return ''
        raw = path.read_bytes()
    except OSError:
        return ''
    # Same discriminator code_map uses: decoding with errors='replace' never
    # proves text, so a SQLite blob or a vendored binary would otherwise be
    # summarized as if it were source.
    if b'\x00' in raw[:1024]:
        return ''
    return raw.decode('utf-8', errors='replace')


def _header(text: str) -> str:
    """The leading docstring or comment block — intent, before surface."""
    stripped = text.lstrip()
    if stripped.startswith(('"""', "'''")):
        quote = stripped[:3]
        end = stripped.find(quote, 3)
        if end != -1:
            return stripped[3:end].strip()[:_HEADER_CHARS]
    lines: list[str] = []
    collected = 0
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            if lines:
                break
            continue
        if line.startswith(('#', '//', '/*', '*', '*/')):
            body = line.lstrip('/*').lstrip('*').lstrip('/').strip()
            if body:
                lines.append(body)
                collected += len(body)
            if collected >= _HEADER_CHARS:
                break
            continue
        break
    return '\n'.join(lines)[:_HEADER_CHARS]


def _signature_from_lines(lines: list[str], start: int) -> str:
    """Join a definition's header, which may wrap, into one readable line."""
    parts: list[str] = []
    for offset in range(start - 1, min(start + 6, len(lines))):
        piece = lines[offset].strip()
        if not piece:
            continue
        parts.append(re.sub(r'\s+', ' ', piece))
        if piece.endswith(':') or piece.endswith('{') or piece.endswith(';'):
            break
        if len(' '.join(parts)) > _SIG_LINE_CHARS:
            break
    joined = ' '.join(parts)[:_SIG_LINE_CHARS]
    # Joined from wrapped source, so a parameter list picks up stray spaces at
    # each break: `f( a, b )` -> `f(a, b)`.
    joined = re.sub(r'\(\s+', '(', joined)
    joined = re.sub(r'\s+\)', ')', joined)
    return re.sub(r',\s*', ', ', joined)


def _strip_leading_keyword(head: str) -> str:
    """Drop the `def`/`class` a source line already carries.

    The caller re-adds it, because a wrapped signature and an `async` modifier
    both have to survive the join — without this, decorated or wrapped
    definitions came out as `def def foo(...)`.
    """
    for prefix in ('async def ', 'async ', 'def ', 'class ', 'function '):
        if head.startswith(prefix):
            return head[len(prefix):]
    return head


def _python_surface(text: str, lines: list[str]) -> list[str]:
    """Top-level def/class signatures, in source order, via the AST."""
    try:
        tree = ast.parse(text)
    except SyntaxError:
        return _regex_surface(lines, (_TS_SIG, 1), (_RS_SIG, 2), (_GOLANG_SIG, 1))
    out: list[str] = []
    for node in tree.body:
        if len(out) >= _MAX_SIGNATURES:
            out.append(f'… more top-level names not listed (cap {_MAX_SIGNATURES})')
            break
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            kind = 'async def' if isinstance(node, ast.AsyncFunctionDef) else 'def'
            name_part = _strip_leading_keyword(_signature_from_lines(lines, node.lineno))
            out.append(f'{kind} {name_part}')
        elif isinstance(node, ast.ClassDef):
            head = f'class {_strip_leading_keyword(_signature_from_lines(lines, node.lineno))}'
            methods: list[str] = []
            for member in node.body:
                if isinstance(member, (ast.FunctionDef, ast.AsyncFunctionDef)) and not member.name.startswith('_'):
                    methods.append(member.name)
            if methods:
                shown = methods[:_MAX_METHODS_PER_CLASS]
                head += f'  · {", ".join(shown)}'
                if len(methods) > len(shown):
                    head += f' (+{len(methods) - len(shown)} private/other)'
            out.append(head)
        elif isinstance(node, (ast.Import, ast.ImportFrom)):
            continue
    return out


def _regex_surface(
    lines: list[str],
    ts: tuple[re.Pattern[str], int] | None = None,
    rs: tuple[re.Pattern[str], int] | None = None,
    go: tuple[re.Pattern[str], int] | None = None,
) -> list[str]:
    """Signature extraction for non-Python files (and Python files that fail to parse)."""
    out: list[str] = []
    for number, raw in enumerate(lines, start=1):
        if len(out) >= _MAX_SIGNATURES:
            out.append(f'… more top-level names not listed (cap {_MAX_SIGNATURES})')
            break
        stripped = raw.strip()
        if not stripped or stripped.startswith(('#', '//', '/*', '*')):
            continue
        matched = False
        if ts is not None:
            hit = ts[0].match(raw)
            if hit:
                out.append(f'{hit.group(1)}  · L{number}')
                matched = True
        if not matched and rs is not None:
            hit = rs[0].match(raw)
            if hit:
                out.append(f'{hit.group(1)} {hit.group(2)}  · L{number}')
                matched = True
        if not matched and go is not None:
            hit = go[0].match(raw)
            if hit:
                out.append(f'func {hit.group(1)}  · L{number}')
                matched = True
    return out


def _surface(path: Path, text: str) -> list[str]:
    lines = text.splitlines()
    ext = path.suffix.lower()
    if ext in ('.py', '.pyi'):
        return _python_surface(text, lines)
    if ext in ('.rs',):
        return _regex_surface(lines, rs=(_RS_SIG, 2))
    if ext == '.go':
        return _regex_surface(lines, go=(_GOLANG_SIG, 1))
    return _regex_surface(lines, ts=(_TS_SIG, 1))


def _imports(text: str) -> list[str]:
    """Import statements, deduped, capped — the file's outward edges."""
    found: list[str] = []
    seen: set[str] = set()
    for raw in text.splitlines():
        line = raw.strip()
        if len(found) >= _MAX_IMPORTS:
            found.append('… imports truncated')
            break
        if line.startswith('import ') or line.startswith('from ') or line.startswith('const {') or line.startswith('import{'):
            cleaned = re.sub(r'\s+', ' ', line)[:120]
            if cleaned in seen:
                continue
            seen.add(cleaned)
            found.append(cleaned)
    return found


def _walk_code_files(root: Path, exts: frozenset[str] = _CODE_EXTS):
    """Yield (path, relative posix path) for code files of the given languages, honoring skip dirs."""
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in _SKIP_DIRS and not d.startswith('.')]
        for name in filenames:
            if os.path.splitext(name)[1].lower() not in exts:
                continue
            full = Path(dirpath) / name
            yield full, os.path.relpath(full, root).replace('\\', '/')


def _import_heads(text: str) -> list[str]:
    """The module expressions a file imports from, one per statement.

    `from a.b import c` yields 'a.b'; `import a.b, d.e` yields both halves.
    Anything that is not an import line is ignored, so a docstring mentioning
    the word "import" cannot register as a dependency.
    """
    heads: list[str] = []
    for raw in text.splitlines():
        line = raw.strip()
        if line.startswith('from '):
            heads.append(line[5:].split(' import ')[0].strip())
        elif line.startswith('import '):
            for piece in line[7:].split(','):
                heads.append(piece.split(' as ')[0].strip())
    return [h for h in heads if h]


def _dependents(root: Path, rel_target: str) -> tuple[list[str], bool]:
    """Files that import `target`, as (matches, hit_a_bound).

    Matching is on dotted path segments, never substrings, so `reporting`
    cannot be matched by `error_reporting`. A package-level import
    (`from app.services.reporting import build_report`) does not name
    `builder.py` — it names the package — so it is reported as a via-package
    edge rather than dropped or silently attributed to the module.
    """
    parts = _module_path(rel_target).split('/')
    stem = parts[-1].rsplit('.', 1)[0]
    pkg_parts = parts[:-1]
    pkg_dotted = '.'.join(pkg_parts)
    pkg_last = pkg_parts[-1] if pkg_parts else ''
    # A package's own file is named by its directory, not by `__init__`.
    direct_names = {stem} if stem != '__init__' else {pkg_last}
    ext = os.path.splitext(rel_target)[1].lower()

    matches: list[str] = []
    seen: set[str] = set()
    scanned = 0
    hit_limit = False
    deadline = time.monotonic() + _SCAN_BUDGET_S
    for full, rel in _walk_code_files(root, _language_group(ext)):
        if rel == rel_target:
            continue
        scanned += 1
        if scanned > _SCAN_MAX_FILES or time.monotonic() > deadline:
            hit_limit = True
            break
        text = _read_text(full)
        if not text:
            continue
        for head in _import_heads(text):
            normalized = head.replace('/', '.').strip('.')
            segments = [s for s in normalized.split('.') if s]
            is_direct = any(name in segments for name in direct_names if name)
            via_package = (
                not is_direct
                and stem != '__init__'
                and bool(pkg_dotted)
                and (normalized == pkg_dotted or normalized.startswith(pkg_dotted + '.'))
            )
            if not is_direct and not via_package:
                continue
            label = rel
            if via_package:
                label = f'{rel} (imports the {pkg_last} package, not this file directly)'
            if label not in seen:
                seen.add(label)
                matches.append(label)
            break
        if len(matches) >= _MAX_DEPENDENTS:
            hit_limit = True
            break
    return matches, hit_limit


def _module_path(rel_path: str) -> str:
    """Normalize a workspace-relative path to forward slashes."""
    return rel_path.replace('\\', '/')


def _describe_directory(root: Path, target: Path) -> tuple[str, bool]:
    """A directory's shape: its entries, and what each code file exposes."""
    try:
        entries = sorted(target.iterdir(), key=lambda p: (p.is_file(), p.name.lower()))
    except OSError as exc:
        return f'Cannot read directory: {exc}', False
    lines: list[str] = []
    dirs = [e for e in entries if e.is_dir() and e.name not in _SKIP_DIRS and not e.name.startswith('.')]
    files = [e for e in entries if e.is_file()]
    for d in dirs[:_MAX_DIR_ENTRIES]:
        lines.append(f'{d.name}/')
    truncated = len(dirs) > _MAX_DIR_ENTRIES
    shown_files = files[: max(0, _MAX_DIR_ENTRIES - len(dirs))]
    if len(files) > len(shown_files):
        truncated = True
    for f in shown_files:
        lines.append(f.name)
    body = '\n'.join(lines)
    # Name the entrypoint first: that is the file a caller actually wants.
    entry = next((f for f in files if f.name.lower() in _ENTRY_NAMES), None)
    header = f'Entries ({len(dirs)} dirs, {len(files)} files):\n{body}'
    if entry is not None:
        text = _read_text(entry, _TARGET_FILE_BYTES)
        surface = _surface(entry, text) if text else []
        if surface:
            header += f'\n\nEntrypoint {entry.name}:\n  ' + '\n  '.join(surface[:20])
    return header, truncated


def build_module_context(
    workspace: str | Path | None,
    path: str,
    max_chars: int = MAX_CONTEXT_CHARS,
) -> str:
    """Return the bounded reading package for `path`, or an error string."""
    if not workspace:
        return 'Error: no workspace is bound to this session, so module context has no root.'
    root = Path(workspace).expanduser()
    if not root.is_dir():
        return f'Error: workspace {root} is not a directory.'
    from app.services.execution_world import bind_path

    bound, error = bind_path(path, str(root), for_write=False)
    if error:
        return f'Error: {error}'
    target = Path(str(bound))
    if not target.exists():
        return f'Error: {path} does not exist in this workspace.'

    sections: list[str] = []
    notes: list[str] = []
    rel = os.path.relpath(target, root).replace('\\', '/')

    if target.is_dir():
        listing, truncated = _describe_directory(root, target)
        sections.append(f'# {rel}/\n\n{listing}')
        if truncated:
            notes.append(f'directory listing capped at {_MAX_DIR_ENTRIES} entries — `list_files` for the rest')
        block = '\n\n'.join(sections)
        return _with_notes(block, notes, max_chars)

    text = _read_text(target, _TARGET_FILE_BYTES)
    if not text:
        return (
            f'# {rel}\n\nNo readable source at this path — it is binary, larger than '
            f'{_TARGET_FILE_BYTES} bytes, or not a code file. Use the media/office readers '
            'for documents and images.'
        )

    line_count = text.count('\n') + 1
    facts = [f'{line_count} lines', f'{target.stat().st_size} bytes', f'modified {time.strftime("%Y-%m-%d", time.localtime(target.stat().st_mtime))}']
    sections.append(f'# {rel}\n{" · ".join(facts)}')

    header = _header(text)
    if header:
        sections.append(f'## Purpose\n{header}')

    surface = _surface(target, text)
    if surface:
        sections.append('## Surface\n' + '\n'.join(surface))
    elif target.suffix.lower() in _CODE_EXTS:
        sections.append('## Surface\n(no top-level definitions detected)')

    imports = _imports(text)
    if imports:
        sections.append('## Imports\n' + '\n'.join(imports))

    dependents, dep_truncated = _dependents(root, rel)
    if dependents:
        sections.append('## Imported by\n' + '\n'.join(dependents))
    else:
        sections.append('## Imported by\n(none found)')
    if dep_truncated:
        notes.append(
            f'"Imported by" is incomplete: stopped at {_MAX_DEPENDENTS} matches or the '
            f'{_SCAN_BUDGET_S:0.0f}s scan budget — treat the list as a subset, not the callers'
        )

    return _with_notes('\n\n'.join(sections), notes, max_chars)


def _with_notes(block: str, notes: list[str], max_chars: int) -> str:
    """Assemble the package, then shrink without ever lying about the cut."""
    if notes:
        block += '\n\n## Caveats\n' + '\n'.join(f'- {n}' for n in notes)
    if len(block) <= max_chars:
        return block
    # Keep the head (identity + purpose + surface); drop the tail's tail.
    dropped = block[max_chars:]
    trimmed = block[:max_chars].rstrip()
    lost = dropped.count('\n') + 1
    return (
        trimmed
        + f'\n\n[truncated at {max_chars} chars — {lost} further line(s) omitted; '
        'read_file the path for the whole thing]'
    )
