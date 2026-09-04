"""Project memory — per-workspace markdown files as the source of truth.

Part 17 Phase A (2026-08-29). The global ``facts`` store mixes every
project's constraints into one pool injected into every chat. Project
memory scopes memory to a workspace via hand-editable markdown files at
``<workspace>/.aug/memory/`` (``memory.md`` created on first use; more md
files allowed), fulfilling the 2026-08-26 readability ruling: entries are
titled ``## <title>`` sections a human can open, edit, and trust.

Format contract (tests/test_project_memory.py pins it):
  * Entry  = ``## <title>`` heading; entry key = the heading text.
  * Optional ``* updated: <iso>`` line inside the entry body.
  * Content before the first ``##`` (preamble / template header) is
    preserved VERBATIM on every rewrite.
  * Everything the parser understands round-trips byte-exactly apart from
    the entries a caller deliberately changed.

Write doors: ``remember(scope='project')`` / ``forget`` (session_tools),
and the UI write endpoints — all through ``upsert_entry``/``delete_entry``
here. Hand edits re-parse on the next read (no cache across turns for the
tail block; the system-prompt block is frozen per session like the global
index). August's own shadow-git excludes ``.aug`` (shadow_git.py) so
project memory never lands in the shadow repo; the user's .gitignore
decides whether it lands in theirs.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

log = logging.getLogger(__name__)

_HEADING_RE = re.compile(r'^##\s+(.+?)\s*$', re.MULTILINE)
_UPDATED_RE = re.compile(r'^\*updated:\s*([^*\s]+)\*\s*$|^\*\s*updated:\s*([^*\s]+)\*\s*$', re.MULTILINE)
_ENTRY_BODY_CAP = 400  # per-entry read-back cap for prompt blocks


@dataclass
class ProjectEntry:
    """One `## <title>` section."""

    title: str
    body: str = ''
    updated: str = ''  # ISO date, optional
    file: str = 'memory.md'  # source file name (relative to the root)


@dataclass
class ProjectFile:
    """Parsed md file: preamble preserved verbatim, then entries in order."""

    preamble: str = ''
    entries: list[ProjectEntry] = field(default_factory=list)


def memory_root(workspace: str | Path) -> Path:
    """`<workspace>/.aug/memory` — the project memory root."""
    return Path(workspace) / '.aug' / 'memory'


def parse_memory_md(text: str) -> ProjectFile:
    """Parse one md file into preamble + ordered entries.

    Tolerant by design (files are hand-edited): a `##` heading with no body
    is a valid entry; anything before the first heading is the preamble
    and is preserved verbatim on rewrite.
    """
    matches = list(_HEADING_RE.finditer(text))
    if not matches:
        return ProjectFile(preamble=text, entries=[])
    preamble = text[: matches[0].start()]
    entries: list[ProjectEntry] = []
    for i, m in enumerate(matches):
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        body = text[m.end() : end].strip('\n')
        entry = ProjectEntry(title=m.group(1).strip())
        # Peel an optional `*updated: …*` line off the top of the body.
        lines = body.splitlines()
        while lines and not lines[0].strip():
            lines.pop(0)
        if lines:
            um = _UPDATED_RE.match(lines[0].strip())
            if um:
                entry.updated = (um.group(1) or um.group(2) or '').strip()
                lines = lines[1:]
        entry.body = re.sub(r'^\\##(\s)', r'##\1', '\n'.join(lines), flags=re.MULTILINE).strip('\n')
        entries.append(entry)
    return ProjectFile(preamble=preamble, entries=entries)


def _render_updated(entry: ProjectEntry) -> str:
    if not entry.updated:
        return ''
    return f'*updated: {entry.updated}*'


def render_memory_md(pf: ProjectFile) -> str:
    """Render a parsed file back to markdown (round-trip stable)."""
    parts: list[str] = []
    preamble = pf.preamble
    if preamble.strip('\n'):
        parts.append(preamble.rstrip('\n'))
    for e in pf.entries:
        seg = f'## {e.title}\n'
        upd = _render_updated(e)
        if upd:
            seg += f'{upd}\n'
        if e.body:
            seg += f'{e.body}\n'
        parts.append(seg.rstrip('\n'))
    out = '\n\n'.join(p for p in parts if p)
    return out + ('\n' if out else '')


_TEMPLATE_HEADER = (
    '# Project Memory\n\n'
    'Durable notes for this workspace — constraints, decisions, feedback, and\n'
    'lessons learned while working here. Each entry is a `## <title>` section;\n'
    'edit freely by hand (August re-reads on the next session).\n'
)


def ensure_root(workspace: str | Path) -> Path:
    """Create `<workspace>/.aug/memory/memory.md` from the template on first
    use. Returns the root dir."""
    root = memory_root(workspace)
    if not root.is_dir():
        root.mkdir(parents=True, exist_ok=True)
    main = root / 'memory.md'
    if not main.exists():
        main.write_text(_TEMPLATE_HEADER, 'utf-8')
    return root


def _list_files(workspace: str | Path) -> list[Path]:
    root = memory_root(workspace)
    if not root.is_dir():
        return []
    return sorted(p for p in root.glob('*.md') if p.is_file())


def list_files(workspace: str | Path) -> list[dict[str, object]]:
    """Files + entry counts for the UI's project scope view."""
    out: list[dict[str, object]] = []
    for p in _list_files(workspace):
        pf = parse_memory_md(p.read_text('utf-8'))
        out.append({'file': p.name, 'entries': len(pf.entries)})
    return out


def read_entries(workspace: str | Path, *, title: str = '') -> list[ProjectEntry]:
    """All entries across the workspace's md files (ordered by file then
    position). Optional exact-title filter."""
    wanted = (title or '').strip().lower()
    out: list[ProjectEntry] = []
    for p in _list_files(workspace):
        pf = parse_memory_md(p.read_text('utf-8'))
        for e in pf.entries:
            if wanted and e.title.lower() != wanted:
                continue
            out.append(
                ProjectEntry(
                    title=e.title, body=e.body, updated=e.updated, file=p.name
                )
            )
    return out


def _sanitizeTitle(title: str) -> str:
    """§9 F-4: a newline in the title would render a second `## ` heading
    and re-parse as a separate entry — flatten to one line."""
    return ' '.join((title or '').split())


def _sanitizeBody(body: str) -> str:
    """§9 F-4: escape body lines that look like `## ` headings so a body can
    never inject a new entry on re-parse (writer-side; parser stays simple).

    2.16 (Part 25): the old replacement `r'\\\1'` DELETED the two hashes
    (`## x` → `\\ x`) — silent content loss. Prefix a backslash instead
    (`## x` → `\\## x`); the parser un-escapes on read."""
    if not body or '##' not in body:
        return body
    return '\n'.join(
        re.sub(r'^##(\s)', r'\\##\1', ln, count=1) for ln in body.splitlines()
    )


def upsert_entry(
    workspace: str | Path,
    title: str,
    body: str,
    *,
    file: str = 'memory.md',
    touch_updated: bool = True,
) -> ProjectEntry:
    """Append or update one `## <title>` entry (write door for remember
    scope='project' and the UI). Title is the entry key; body replaces the
    old body. An `*updated: …*` stamp is refreshed when ``touch_updated``.

    §9 F-4 format-contract guards: titles are flattened to one line and
    heading-looking body lines are escaped, so the entries written here
    always re-parse 1:1; a title that already exists in ANOTHER md file is
    updated there (first match in file order) instead of duplicated."""
    root = ensure_root(workspace)
    target = root / file
    pf = parse_memory_md(target.read_text('utf-8')) if target.exists() else ProjectFile()
    title = _sanitizeTitle(title) or 'Untitled'
    body = _sanitizeBody(body)
    now = datetime.now().astimezone().strftime('%Y-%m-%d')
    hit = False
    for e in pf.entries:
        if e.title.strip().lower() == title.lower():
            e.body = body.strip()
            if touch_updated:
                e.updated = now
            hit = True
            break
    if not hit:
        # Title keys are unique per workspace by convention — upsert accepts
        # a file param, so a cross-file duplicate is creatable and one
        # delete would only remove part of it. Update the first match
        # elsewhere instead of creating a duplicate.
        for p in _list_files(workspace):
            if p == target:
                continue
            pf_other = parse_memory_md(p.read_text('utf-8'))
            for e in pf_other.entries:
                if e.title.strip().lower() == title.lower():
                    e.body = body.strip()
                    if touch_updated:
                        e.updated = now
                    p.write_text(render_memory_md(pf_other), 'utf-8')
                    log.info(
                        'project_memory: title %r matched in %s; updated there instead of creating in %s',
                        title, p.name, file,
                    )
                    return ProjectEntry(title=title, body=body, updated=now if touch_updated else '', file=p.name)
        pf.entries.append(
            ProjectEntry(title=title, body=body.strip(), updated=now if touch_updated else '')
        )
    target.write_text(render_memory_md(pf), 'utf-8')
    return ProjectEntry(title=title, body=body, updated=now, file=file)


def delete_entry(workspace: str | Path, title: str, *, file: str = '') -> bool:
    """Delete one entry by exact title (case-insensitive). When ``file`` is
    empty every md file is searched (title keys are unique per workspace by
    convention). Returns True when an entry was removed.

    §9 F-4: with ``file`` empty and the title matching more than one file,
    only the FIRST match (sorted file order) is deleted and the rest are
    logged — pass ``file=`` to target a specific file."""
    removed = False
    rest: list[str] = []
    for p in _list_files(workspace):
        pf = parse_memory_md(p.read_text('utf-8'))
        keep = [e for e in pf.entries if e.title.strip().lower() != (title or '').strip().lower()]
        if len(keep) == len(pf.entries):
            continue
        if file:
            if p.name != file:
                continue
            pf.entries = keep
            p.write_text(render_memory_md(pf), 'utf-8')
            return True
        if not removed:
            pf.entries = keep
            p.write_text(render_memory_md(pf), 'utf-8')
            removed = True
        else:
            rest.append(p.name)
    if rest:
        log.warning(
            'project_memory: title %r also matched %s — deleted only the first match; '
            'pass file= to target a specific file',
            title, ', '.join(rest),
        )
    return removed


def _entry_text(e: ProjectEntry) -> str:
    """Indexing text: title words + body (titles carry the human phrasing)."""
    return f"{e.title} {e.body}"


def search_entries(workspace: str | Path, query: str, k: int = 5) -> list[ProjectEntry]:
    """BM25-ranked project entries for the tail block / brain_query store.
    Shares the retrieval tokenizer with the global facts index."""
    from app.services.tools.retrieval import BM25, _tokenize

    entries = read_entries(workspace)
    if not entries:
        return []
    q = (query or '').strip()
    if len(q) < 4:
        return entries[: max(1, k)]
    queryTokens = _tokenize(q)
    if not queryTokens:
        return []
    corpus = [_tokenize(_entry_text(e)) or ['·'] for e in entries]
    bm25 = BM25(corpus)
    scored: list[tuple[float, int]] = []
    for i in range(len(entries)):
        s = bm25.score(queryTokens, i)
        if s > 0:
            scored.append((s, i))
    if not scored:
        return []
    scored.sort(reverse=True)
    return [entries[i] for _, i in scored[: max(1, k)]]


def project_block(workspace: str | Path, cap: int = 1200) -> str:
    """Frozen per-session boot block: title-only index of the project's
    entries (≤ cap chars). Sits in the system prompt like the global memory
    index — frozen per session so hand edits apply next session, and the
    tail block carries fresh per-turn recall."""
    entries = read_entries(workspace)
    if not entries:
        return ''
    lines: list[str] = ['<project_memory>']
    budget = cap
    listed = 0
    for e in entries:
        line = f'- {e.title}' + (f' ({e.updated})' if e.updated else '')
        if budget - len(line) < 0:
            break
        budget -= len(line)
        lines.append(line)
        listed += 1
    if not listed:
        return ''
    if len(entries) > listed:
        lines.append(f'… +{len(entries) - listed} more')
    lines.append('Project memory entries (titles only — read via brain_query store=project-memory).')
    lines.append('</project_memory>')
    return '\n'.join(lines)


def build_project_memory_tail(
    workspace: str | Path, query: str, k: int = 3, block_cap: int = 800
) -> str:
    """Project entries section for the per-turn `<memory>` tail block:
    BM25-ranked, tagged `project:` so the model can tell scopes apart.
    The caller splices this INSIDE the global `<memory>` block (one tail,
    several tagged sections — not a parallel mechanism); ``block_cap`` is
    the project section's share of the tail budget."""
    entries = search_entries(workspace, query, k=k)
    if not entries:
        return ''
    lines: list[str] = ['project:']
    budget = block_cap
    shown = 0
    for e in entries:
        body = e.body
        if len(body) > _ENTRY_BODY_CAP:
            body = body[:_ENTRY_BODY_CAP].rstrip() + '…'
        line = f'- {e.title}: {body}' if body else f'- {e.title}'
        if budget - len(line) < 0 and shown:
            break
        budget -= len(line)
        lines.append(line)
        shown += 1
    if not shown:
        return ''
    return '\n'.join(lines)
