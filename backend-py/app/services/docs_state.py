"""docs_state — read and validate a Nessa Docs `docs/state/` catalog.

August ships the authoring contract (``skills/nessa-docs``); this is the reading
half, so the app can show a project's system map instead of telling the user to
install a separate Node renderer.

The rules implemented here are the ones the contract states, taken from
``skills/nessa-docs/references/format.md`` at the upstream commit named in that
skill. They are enforced rather than described because the whole value of the
format is that a broken map is CAUGHT: a `diagramLinks` entry pointing at a
document that does not exist renders a `+` that navigates nowhere, and a parent
cycle makes a subtree unreachable.

No YAML dependency is used. `pyproject.toml` carries no PyYAML and adding one to
read a narrow, specified subset would be a lockfile change for a parser smaller
than the dependency's footprint. `_parse_frontmatter` handles exactly the forms
the contract allows — a scalar, `{}`, `[]`, an indented `- item` list, and an
indented `key: value` map — and reports anything else as an issue rather than
guessing. The skill's own frontmatter reader is deliberately flat and cannot
carry a nested map, so extending it would break the simpler contract it serves.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

STATE_DIR = 'docs/state'
ROOT_FILE = 'README.md'

KINDS = (
    'system', 'service', 'feature', 'flow',
    'statechart', 'operation', 'contract', 'guide',
)
STATUSES = ('implemented', 'mixed', 'fixture', 'proposed', 'reference')
REQUIRED = ('id', 'title', 'kind', 'status', 'summary', 'parent')

_ID_RE = re.compile(r'^[a-z0-9]+(?:-[a-z0-9]+)*$')
_REVISION_RE = re.compile(r'^(?:[0-9a-f]{40}|[0-9a-f]{64})$')
# A fenced ```mermaid block, captured with its body so the size ceiling can be
# measured on what the browser would actually render.
_MERMAID_BLOCK_RE = re.compile(
    r'^[ \t]*```[ \t]*mermaid[ \t]*\r?\n(.*?)\r?\n[ \t]*```',
    re.MULTILINE | re.DOTALL,
)
# The contract's ceiling, in UTF-16 code units — the unit the upstream browser
# counts, because that is what a JavaScript string length measures.
DIAGRAM_MAX_UNITS = 100_000
_HEADING_RE = re.compile(r'^(#{1,6})[ \t]+(.+?)[ \t]*#*\s*$', re.MULTILINE)


def _utf16_units(text: str) -> int:
    """UTF-16 code units, not characters: an emoji is 2 here and 2 upstream."""
    return len(text.encode('utf-16-le')) // 2


@dataclass
class Issue:
    severity: str  # 'error' | 'warning'
    code: str
    message: str
    path: str = ''


@dataclass
class Page:
    page_id: str
    title: str
    kind: str
    status: str
    summary: str
    parent: str | None
    rel_path: str
    sources: list[str] = field(default_factory=list)
    diagram_links: dict[str, str] = field(default_factory=dict)
    diagram_details: dict[str, str] = field(default_factory=dict)
    source_revision: str | None = None
    headings: list[str] = field(default_factory=list)
    diagram_count: int = 0

    def as_node(self) -> dict[str, Any]:
        return {
            'id': self.page_id,
            'title': self.title,
            'kind': self.kind,
            'status': self.status,
            'summary': self.summary,
            'parent': self.parent,
            'path': self.rel_path,
            'sources': self.sources,
            'diagramLinks': self.diagram_links,
            'diagramDetails': self.diagram_details,
            'sourceRevision': self.source_revision,
            'diagrams': self.diagram_count,
        }


def _strip_quotes(value: str) -> str:
    v = value.strip()
    if len(v) >= 2 and v[0] == v[-1] and v[0] in ('"', "'"):
        return v[1:-1]
    return v


def _parse_frontmatter(text: str) -> tuple[dict[str, Any] | None, list[str]]:
    """Read the YAML subset the contract allows.

    Returns ``(meta, problems)``. ``meta`` is None when there is no frontmatter
    block at all — a page without it cannot be placed in the tree, so the caller
    reports that rather than inventing an id from the filename.
    """
    problems: list[str] = []
    normalized = text.replace('\r\n', '\n').replace('\r', '\n')
    if not normalized.startswith('---\n'):
        return None, []
    end = normalized.find('\n---', 4)
    if end == -1:
        return None, ['frontmatter block is never closed']
    lines = normalized[4:end].split('\n')

    meta: dict[str, Any] = {}
    i = 0
    while i < len(lines):
        raw = lines[i]
        i += 1
        if not raw.strip() or raw.lstrip().startswith('#'):
            continue
        if raw.startswith((' ', '\t')):
            problems.append(f'ignoring indented line outside a key: {raw.strip()!r}')
            continue
        if ':' not in raw:
            problems.append(f'ignoring line that is not `key: value`: {raw.strip()!r}')
            continue
        key, _, rest = raw.partition(':')
        key = key.strip()
        rest = rest.strip()
        if rest:
            if rest in ('{}', '[]'):
                meta[key] = {} if rest == '{}' else []
            else:
                meta[key] = _strip_quotes(rest)
            continue
        # A bare `key:` owns the indented block under it.
        block: list[str] = []
        while i < len(lines) and (lines[i].startswith((' ', '\t')) or not lines[i].strip()):
            block.append(lines[i])
            i += 1
        content = [ln for ln in block if ln.strip()]
        if not content:
            meta[key] = {}
            continue
        if all(ln.lstrip().startswith('- ') for ln in content):
            meta[key] = [_strip_quotes(ln.lstrip()[2:]) for ln in content]
        elif all(':' in ln for ln in content):
            sub: dict[str, str] = {}
            for ln in content:
                sk, _, sv = ln.strip().partition(':')
                sub[sk.strip()] = _strip_quotes(sv)
            meta[key] = sub
        else:
            problems.append(f'unsupported block under {key!r}; treated as empty')
            meta[key] = [] if content[0].lstrip().startswith('-') else {}
    return meta, problems


def _headings(body: str) -> list[str]:
    return [m.group(2).strip() for m in _HEADING_RE.finditer(body)]


def _as_list(value: Any) -> list[str]:
    if isinstance(value, list):
        return [str(v) for v in value]
    if value is None or value == '':
        return []
    return [str(value)]


def _as_map(value: Any) -> dict[str, str]:
    if isinstance(value, dict):
        return {str(k): str(v) for k, v in value.items()}
    return {}


def load_catalog(project_root: Path) -> dict[str, Any]:
    """Read `<project>/docs/state/**.md` and validate it.

    Always returns a catalog: the browser needs the pages it CAN place even when
    others are broken, and Health is a list of problems rather than an exception.
    """
    issues: list[Issue] = []
    pages: dict[str, Page] = {}
    state_dir = project_root / STATE_DIR

    if not state_dir.is_dir():
        return {
            'projectRoot': str(project_root),
            'stateDir': f'{STATE_DIR}/',
            'found': False,
            'pages': [],
            'roots': [],
            'health': {
                'errors': 1,
                'warnings': 0,
                'issues': [{
                    'severity': 'error',
                    'code': 'no-state-dir',
                    'message': f'No {STATE_DIR}/ directory in this project.',
                    'path': STATE_DIR,
                }],
            },
        }

    md_files = sorted(
        p for p in state_dir.rglob('*.md') if p.is_file()
    )
    bodies: dict[str, str] = {}

    for path in md_files:
        rel = path.relative_to(project_root).as_posix()
        try:
            text = path.read_text(encoding='utf-8')
        except OSError as exc:
            issues.append(Issue('error', 'unreadable', f'{exc}', rel))
            continue
        meta, problems = _parse_frontmatter(text)
        for problem in problems:
            issues.append(Issue('warning', 'frontmatter', problem, rel))
        if meta is None:
            issues.append(Issue(
                'error', 'no-frontmatter',
                'Page has no YAML frontmatter, so it cannot be placed in the tree.',
                rel,
            ))
            continue

        body = text.split('\n---', 2)[-1] if text.startswith('---') else text
        page = Page(
            page_id=str(meta.get('id', '') or ''),
            title=str(meta.get('title', '') or ''),
            kind=str(meta.get('kind', '') or ''),
            status=str(meta.get('status', '') or ''),
            summary=str(meta.get('summary', '') or ''),
            parent=None,
            rel_path=rel,
            sources=_as_list(meta.get('sources')),
            diagram_links=_as_map(meta.get('diagramLinks')),
            diagram_details=_as_map(meta.get('diagramDetails')),
            headings=_headings(body),
            diagram_count=len(_MERMAID_BLOCK_RE.findall(body)),
        )
        bodies[rel] = body

        raw_parent = meta.get('parent', None)
        if raw_parent is None or str(raw_parent).strip().lower() in ('', 'null', '~'):
            page.parent = None
        else:
            page.parent = str(raw_parent).strip()

        for fname in REQUIRED:
            present = fname == 'parent' or meta.get(fname) not in (None, '')
            if not present:
                issues.append(Issue('error', 'missing-field', f'`{fname}` is required.', rel))
        if not page.page_id:
            issues.append(Issue('error', 'missing-id', 'Page has no `id`.', rel))
            continue
        if not _ID_RE.match(page.page_id):
            issues.append(Issue(
                'error', 'bad-id',
                f'`{page.page_id}` is not lowercase kebab-case.',
                rel,
            ))
        if not page.title.strip():
            issues.append(Issue('error', 'empty-title', '`title` must be nonempty.', rel))
        if not page.summary.strip():
            issues.append(Issue('error', 'empty-summary', '`summary` must be nonempty.', rel))
        if page.kind not in KINDS:
            issues.append(Issue(
                'error', 'bad-kind',
                f'`kind: {page.kind}` is not one of {", ".join(KINDS)}.',
                rel,
            ))
        if page.status not in STATUSES:
            issues.append(Issue(
                'error', 'bad-status',
                f'`status: {page.status}` is not one of {", ".join(STATUSES)}.',
                rel,
            ))

        revision = meta.get('sourceRevision')
        if revision not in (None, ''):
            rev = str(revision).strip()
            if not _REVISION_RE.match(rev):
                page.source_revision = None
                issues.append(Issue(
                    'error', 'bad-source-revision',
                    f'`sourceRevision: {rev}` is not a full lowercase commit id '
                    '(40 or 64 hex characters). Branch names, tags and short ids '
                    'are refused.',
                    rel,
                ))
            else:
                page.source_revision = rev

        for source in page.sources:
            if Path(source).is_absolute() or source.startswith('..'):
                issues.append(Issue(
                    'warning', 'source-not-relative',
                    f'`sources: {source}` is not a project-relative path.',
                    rel,
                ))
            elif not (project_root / source).exists():
                issues.append(Issue(
                    'warning', 'source-missing',
                    f'Referenced source does not exist: {source}',
                    rel,
                ))

        for block in _MERMAID_BLOCK_RE.findall(body):
            units = _utf16_units(block)
            if units > DIAGRAM_MAX_UNITS:
                issues.append(Issue(
                    'error', 'diagram-too-large',
                    f'A mermaid block here is {units} UTF-16 units, over the '
                    f'{DIAGRAM_MAX_UNITS} ceiling. Split the model at its actual owners.',
                    rel,
                ))
                break

        if page.page_id in pages:
            issues.append(Issue(
                'error', 'duplicate-id',
                f'`{page.page_id}` is also used by {pages[page.page_id].rel_path}.',
                rel,
            ))
            continue
        pages[page.page_id] = page

    # Navigation and structure checks that need the whole catalog.
    for page in pages.values():
        if page.parent is None:
            continue
        parent = pages.get(page.parent)
        if parent is None:
            issues.append(Issue(
                'error', 'missing-parent',
                f'`parent: {page.parent}` names no accepted document.',
                page.rel_path,
            ))
            continue
        # Folder/parent disagreement is a warning: metadata owns navigation, so
        # the page still renders — but the tree and the disk no longer agree.
        #
        # The rule is the same folder, not "anywhere below". A README owns the
        # folder it sits in, so `services/payments/README.md` parents pages in
        # `services/payments/` — which is its OWN dirname. Accepting every
        # descendant made this check vacuous: the first fixture for it passed
        # silently, because `docs/state/services/payments` does start with
        # `docs/state/`.
        expected = parent.rel_path.rsplit('/', 1)[0]
        own = page.rel_path.rsplit('/', 1)[0]
        if own != expected:
            issues.append(Issue(
                'warning', 'folder-parent-mismatch',
                f'Parent lives in `{expected}` but this page is in `{own}`.',
                page.rel_path,
            ))

        for node, target in page.diagram_links.items():
            if target not in pages:
                issues.append(Issue(
                    'error', 'unresolved-diagram-link',
                    f'diagramLinks.{node} -> `{target}` names no accepted document. '
                    'The + would navigate nowhere.',
                    page.rel_path,
                ))
        for node, heading in page.diagram_details.items():
            if heading not in page.headings:
                issues.append(Issue(
                    'error', 'unresolved-diagram-detail',
                    f'diagramDetails.{node} -> heading `{heading}` does not exist '
                    'in this document.',
                    page.rel_path,
                ))

    # A cycle makes a subtree unreachable from the root, so it is an error even
    # though every page in it parses. Walked per page with a visited set rather
    # than by recursion: a cycle is exactly the input that would blow a
    # recursive walk's stack.
    for page in pages.values():
        seen: set[str] = set()
        cursor: Page | None = page
        while cursor is not None:
            if cursor.page_id in seen:
                issues.append(Issue(
                    'error', 'parent-cycle',
                    'Following `parent` from this page returns to it, so the '
                    'subtree is unreachable from the root.',
                    page.rel_path,
                ))
                break
            seen.add(cursor.page_id)
            cursor = pages.get(cursor.parent) if cursor.parent else None

    roots = [p for p in pages.values() if p.parent is None]
    if not roots:
        issues.append(Issue(
            'error', 'no-root',
            'No page declares `parent: null`, so nothing is the system entry.',
            STATE_DIR,
        ))
    root_readme = (project_root / STATE_DIR / ROOT_FILE).as_posix().replace(
        str(project_root).replace('\\', '/') + '/', ''
    )
    if roots and not any(r.rel_path == root_readme for r in roots):
        issues.append(Issue(
            'warning', 'root-not-readme',
            f'The system entry should be {STATE_DIR}/{ROOT_FILE}.',
            STATE_DIR,
        ))

    ordered = sorted(pages.values(), key=lambda p: p.rel_path)
    return {
        'projectRoot': str(project_root),
        'stateDir': f'{STATE_DIR}/',
        'found': bool(pages),
        'pages': [p.as_node() for p in ordered],
        'bodies': {p.rel_path: bodies.get(p.rel_path, '') for p in ordered},
        'roots': [r.page_id for r in roots],
        'health': {
            'errors': sum(1 for i in issues if i.severity == 'error'),
            'warnings': sum(1 for i in issues if i.severity == 'warning'),
            'issues': [
                {
                    'severity': i.severity,
                    'code': i.code,
                    'message': i.message,
                    'path': i.path,
                }
                for i in issues
            ],
        },
    }
