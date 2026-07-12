"""
AUG.md directive service — discover, load, write, and generate the
project-level AUG.md file (the August Proxy analogue of Claude Code's
CLAUDE.md).

AUG.md is a plain-markdown file stored at the workspace root. Its body is
loaded into Tier 2 of the system prompt as an ``<aug_directives>`` block,
delivered as soft context the model should follow but is not strictly
enforced to honor.

Scope (confirmed): workspace-relative only. Resolution order:
  1. <workspacePath>/AUG.md   (preferred — per-project conventions)
  2. <settings.projectRoot>/AUG.md  (fallback when no workspace is set)

The ``/init`` command generates (or refines) AUG.md by analyzing the
workspace and asking an LLM for a draft; the draft is returned for review
and only persisted when the user confirms via ``PUT /api/aug/content``.

Frontmatter parsing mirrors ``skillService._parseSkill`` (simple
``key: value`` lines inside a leading ``---`` block) so we avoid a hard
PyYAML dependency.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Optional
from app.jsonUtils import as_str, as_dict, as_list

_AUG_FILENAME = 'AUG.md'
_FRONTMATTER_RE = re.compile(r'^---\s*\n(.*?)\n---\s*\n(.*)', re.DOTALL)
_SKIP_DIRS = {
    '.git',
    'node_modules',
    '__pycache__',
    '.venv',
    'venv',
    'dist',
    'build',
    '.aug',
    'data',
    'web-dist',
    '.turbo',
    'target',
}
_MAX_READ_BYTES = 4000


def _resolveAugPath(workspacePath: str | None) -> Path:
    """Resolve the AUG.md path for a workspace.

    Falls back to the project root when no workspace is set.
    """
    if workspacePath:
        ws = Path(workspacePath)
        if ws.is_dir():
            return ws / _AUG_FILENAME
    try:
        from app.config import settings

        return Path(settings.projectRoot) / _AUG_FILENAME
    except Exception:
        return Path.cwd() / _AUG_FILENAME


def _parseAug(text: str) -> dict[str, object]:
    """Parse AUG.md text into frontmatter + body."""
    frontmatter: dict[str, str] = {}
    body = text.strip()
    m = _FRONTMATTER_RE.match(text)
    if m:
        for line in m.group(1).split('\n'):
            if ':' in line:
                key, _, val = line.partition(':')
                frontmatter[key.strip()] = val.strip()
        body = m.group(2).strip()
    return {'frontmatter': frontmatter, 'body': body}


def load(workspacePath: str | None) -> Optional[dict[str, object]]:
    """Load and parse AUG.md for a workspace.

    Returns ``None`` if the file does not exist. Otherwise returns
    ``{path, body, frontmatter, updatedAt, exists: True}``.
    """
    path = _resolveAugPath(workspacePath)
    if not path.exists():
        return None
    try:
        text = path.read_text('utf-8')
    except Exception:
        return None
    parsed = _parseAug(text)
    stat = path.stat()
    return {
        'path': str(path),
        'body': parsed['body'],
        'frontmatter': parsed['frontmatter'],
        'updatedAt': stat.st_mtime,
        'exists': True,
    }


def exists(workspacePath: str | None) -> bool:
    """Whether an AUG.md exists for the workspace."""
    return _resolveAugPath(workspacePath).exists()


def write(
    workspacePath: str | None, content: str, *, frontmatter: Optional[dict[str, str]] = None
) -> dict[str, object]:
    """Write AUG.md for a workspace.

    Refuses to write outside the resolved workspace root. Returns
    ``{path, bytes, frontmatter}``.
    """
    path = _resolveAugPath(workspacePath)
    resolved = path.resolve()
    # Safety: ensure we never escape the workspace root.
    if workspacePath:
        root = Path(workspacePath).resolve()
        if not str(resolved).startswith(str(root)):
            raise ValueError(f'AUG.md path escapes workspace root: {resolved}')
    lines = ['---']
    fm = frontmatter or {}
    if not fm.get('description') and workspacePath:
        fm['description'] = 'Project directives for August Proxy (auto-generated).'
    for key, val in fm.items():
        if val:
            lines.append(f'{key}: {val}')
    lines.append('---')
    lines.append('')
    lines.append(content.strip())
    lines.append('')
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text('\n'.join(lines), 'utf-8')
    return {'path': str(path), 'bytes': path.stat().st_size, 'frontmatter': fm}


def delete(workspacePath: str | None) -> dict[str, object]:
    """Delete AUG.md for a workspace if present."""
    path = _resolveAugPath(workspacePath)
    removed = False
    if path.exists():
        path.unlink()
        removed = True
    return {'path': str(path), 'removed': removed}

    # ── Workspace analysis (for /init) ──────────────────────────────────────────


def _analyzeWorkspace(workspacePath: str) -> dict[str, object]:
    """Collect lightweight signals about a workspace for AUG.md generation."""
    ws = Path(workspacePath)
    if not ws.is_dir():
        return {'error': f'Workspace not found: {workspacePath}'}
    topLevel: list[str] = []
    for entry in sorted(ws.iterdir()):
        if entry.name in _SKIP_DIRS:
            continue
        topLevel.append(entry.name + ('/' if entry.is_dir() else ''))
    signals: dict[str, object] = {'topLevel': topLevel[:60]}
    # Manifest hints
    for manifest in (
        'package.json',
        'pyproject.toml',
        'Cargo.toml',
        'go.mod',
        'pom.xml',
        'requirements.txt',
        'Gemfile',
        'composer.json',
    ):
        mp = ws / manifest
        if mp.exists():
            try:
                manifests = signals.setdefault('manifests', {})
                if isinstance(manifests, dict):
                    manifests[manifest] = mp.read_text('utf-8')[:_MAX_READ_BYTES]
            except Exception:
                pass
                # README
    for readme in ('README.md', 'README.txt', 'README', 'readme.md'):
        rp = ws / readme
        if rp.exists():
            try:
                signals['readme'] = rp.read_text('utf-8')[:_MAX_READ_BYTES]
            except Exception:
                pass
            break
            # Git context
    try:
        import subprocess

        branch = subprocess.run(
            ['git', 'branch', '--show-current'], cwd=workspacePath, capture_output=True, text=True, timeout=5
        ).stdout.strip()
        if branch:
            signals['gitBranch'] = branch
        log = subprocess.run(
            ['git', 'log', '--oneline', '--max-count', '10'],
            cwd=workspacePath,
            capture_output=True,
            text=True,
            timeout=5,
        ).stdout.strip()
        if log:
            signals['gitLog'] = log.split('\n')
    except Exception:
        pass
    return signals


def _renderAnalysis(analysis: dict[str, object]) -> str:
    """Render the workspace analysis into a compact text blob for the prompt."""
    parts: list[str] = []
    topLevel = as_list(analysis.get('topLevel'))
    if topLevel:
        parts.append('Top-level entries:\n' + '\n'.join(f'  - {e}' for e in topLevel))
    manifests = as_dict(analysis.get('manifests'))
    if manifests:
        for name, content in manifests.items():
            parts.append(f'{name}:\n{content}')
    if analysis.get('readme'):
        parts.append(f'README.md:\n{analysis["readme"]}')
    if analysis.get('gitBranch'):
        parts.append(f'Git branch: {analysis["gitBranch"]}')
    gitLog = as_list(analysis.get('gitLog'))
    if gitLog:
        parts.append('Recent git history:\n' + '\n'.join(f'  - {line}' for line in gitLog))
    return '\n\n'.join(parts)

    # ── Generation (LLM-driven) ─────────────────────────────────────────────────


_SYSTEM_PROMPT_CREATE = (
    'You are generating an AUG.md file for a software project. AUG.md is the '
    'project instruction file for the August Proxy AI agent (the equivalent of '
    "Claude Code's CLAUDE.md). It is plain markdown and should be concise "
    "(target under 120 lines). It teaches the agent the project's build "
    'commands, test commands, code conventions, and architecture so future '
    'sessions are productive.\n\n'
    'Write the AUG.md body only (no YAML frontmatter). Use markdown sections: '
    '# Project, ## Build, ## Test, ## Conventions, ## Architecture. Be specific '
    'and concrete; only include commands and facts you can infer from the '
    'workspace. If something is unknown, omit it rather than guessing.'
)

_SYSTEM_PROMPT_REFINE = (
    'You are refining an existing AUG.md file for a software project. AUG.md is '
    'the project instruction file for the August Proxy AI agent. Given the '
    'current AUG.md and fresh workspace signals, produce an improved, complete '
    'AUG.md body (no YAML frontmatter). Keep what is still accurate, fix stale '
    'details, and add genuinely useful conventions the agent can act on. Target '
    'under 120 lines. Plain markdown only.'
)


async def generate(
    workspacePath: str, *, mode: str = 'create', existing: Optional[str] = None, model: str = ''
) -> dict[str, object]:
    """Analyze a workspace and ask an LLM to draft (or refine) AUG.md.

    Returns ``{draft, existing, analysis, mode}``. Does NOT write to disk —
    the caller persists via ``write()`` after user confirmation.
    """
    analysis = _analyzeWorkspace(workspacePath)
    analysisText = _renderAnalysis(analysis)
    # In refine mode, load the current AUG.md from disk if a draft wasn't
    # supplied (keeps generate() self-sufficient for direct callers/tests).
    if mode == 'refine' and not existing:
        try:
            loaded = load(workspacePath)
            if loaded:
                existing = as_str(loaded.get('body'))
        except Exception:
            pass
    isRefine = mode == 'refine' and bool(existing)
    systemPrompt = _SYSTEM_PROMPT_REFINE if isRefine else _SYSTEM_PROMPT_CREATE

    userParts: list[str] = []
    if isRefine:
        userParts.append(f'# Current AUG.md\n{existing}\n')
    userParts.append('# Workspace signals\n' + (analysisText or '(no readable signals)'))
    userParts.append('Now produce the AUG.md body.')

    messages: list[dict[str, object]] = [
        {'role': 'system', 'content': systemPrompt},
        {'role': 'user', 'content': '\n\n'.join(userParts)},
    ]

    draft = await _callLlm(messages, model=model) or ''
    draft = _stripCodeFences(draft).strip()
    if not draft:
        # No provider configured / API key missing / call failed. Surface a
        # clear error rather than returning a blank AUG.md preview.
        raise RuntimeError(
            'No AUG.md draft was produced. Check that a provider/API key is configured and reachable, then retry /init.'
        )
    return {
        'draft': draft,
        'existing': bool(isRefine),
        'analysis': {k: v for k, v in analysis.items() if k != 'error'},
        'mode': 'refine' if isRefine else 'create',
    }


def _stripCodeFences(text: str) -> str:
    """Remove a surrounding ```markdown … ``` fence if present."""
    m = re.match(r'^```[a-zA-Z]*\s*\n(.*?)\n```\s*$', text, re.DOTALL)
    if m:
        return m.group(1)
    return text


async def _callLlm(messages: list[dict[str, object]], *, model: str = '') -> str:
    """One-shot LLM call using the first available provider."""
    try:
        from app.providers import resolver as providerResolver
        from app.providers.clients import getClient

        providers = providerResolver.list_available()
        if not providers:
            return ''
        provider = providerResolver.resolve(model) if model else providers[0]
        if not provider:
            provider = providers[0]
        client = getClient(provider)
        if not client or not hasattr(client, 'chatCompletions'):
            return ''
        apiKey = client.resolveApiKey()
        if not apiKey:
            return ''
        useModel = model or provider.get('defaultModel', '') or 'claude-sonnet-4-20250514'
        req_body = {'model': useModel, 'messages': messages, 'max_tokens': 2000}
        resp = await client.chat_completions(req_body)
        if getattr(resp, 'status', 200) != 200:
            return ''
        resp_body = getattr(resp, 'body', None)
        if not isinstance(resp_body, dict):
            return ''
        raw_choices = resp_body.get('choices', [])
        if not isinstance(raw_choices, list) or not raw_choices:
            return ''
        choice = raw_choices[0]
        if not isinstance(choice, dict):
            return ''
        msg = choice.get('message', {})
        if not isinstance(msg, dict):
            msg = {}
        content = msg.get('content', '')
        if isinstance(content, list):
            return ' '.join(b.get('text', '') for b in content if isinstance(b, dict))
        return content if isinstance(content, str) else ''
    except Exception:
        return ''
