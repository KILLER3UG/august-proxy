"""What's New — recent GitHub activity for the August repo (last N hours)."""

from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
from fastapi import APIRouter, Query

router = APIRouter(prefix='/api/whats-new', tags=['whats-new'])

DEFAULT_REPO = 'KILLER3UG/august-proxy'
GITHUB_API = 'https://api.github.com'


def _repo() -> str:
    return (os.environ.get('AUGUST_GITHUB_REPO') or DEFAULT_REPO).strip()


def _headers() -> dict[str, str]:
    headers = {
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'august-proxy-whats-new',
    }
    token = (
        os.environ.get('GITHUB_TOKEN')
        or os.environ.get('GH_TOKEN')
        or os.environ.get('GITHUB_PERSONAL_ACCESS_TOKEN')
        or ''
    ).strip()
    if token:
        headers['Authorization'] = f'Bearer {token}'
    return headers


def _parse_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError:
        return None


@router.get('')
async def get_whats_new(hours: int = Query(default=48, ge=1, le=168)):
    """Return commits + releases from the last ``hours`` (default 48)."""
    since = datetime.now(timezone.utc) - timedelta(hours=hours)
    since_iso = since.isoformat().replace('+00:00', 'Z')
    repo = _repo()
    headers = _headers()

    commits: list[dict] = []
    releases: list[dict] = []
    errors: list[str] = []


    async with httpx.AsyncClient(timeout=12.0) as client:
        try:
            resp = await client.get(
                f'{GITHUB_API}/repos/{repo}/commits',
                params={'since': since_iso, 'per_page': 30},
                headers=headers,
            )
            if resp.status_code >= 400:
                errors.append(f'commits: HTTP {resp.status_code}')
            else:
                for item in resp.json():
                    commit = item.get('commit') or {}
                    author = commit.get('author') or {}
                    commits.append(
                        {
                            'sha': (item.get('sha') or '')[:7],
                            'fullSha': item.get('sha') or '',
                            'message': (commit.get('message') or '').split('\n', 1)[0].strip(),
                            'author': author.get('name') or item.get('author', {}).get('login') or 'unknown',
                            'date': author.get('date') or '',
                            'url': item.get('html_url') or '',
                        }
                    )
        except Exception as exc:  # noqa: BLE001
            errors.append(f'commits: {exc}')

        try:
            resp = await client.get(
                f'{GITHUB_API}/repos/{repo}/releases',
                params={'per_page': 10},
                headers=headers,
            )
            if resp.status_code >= 400:
                errors.append(f'releases: HTTP {resp.status_code}')
            else:
                for item in resp.json():
                    published = _parse_iso(item.get('published_at'))
                    if published is None or published < since:
                        continue
                    releases.append(
                        {
                            'tag': item.get('tag_name') or '',
                            'name': item.get('name') or item.get('tag_name') or 'Release',
                            'body': (item.get('body') or '')[:600],
                            'date': item.get('published_at') or '',
                            'url': item.get('html_url') or '',
                            'prerelease': bool(item.get('prerelease')),
                        }
                    )
        except Exception as exc:  # noqa: BLE001
            errors.append(f'releases: {exc}')

    return {
        'repo': repo,
        'hours': hours,
        'since': since_iso,
        'commits': commits,
        'releases': releases,
        'repoUrl': f'https://github.com/{repo}',
        'errors': errors,
        'changelog': _changelog_fallback() if not commits and not releases else [],
    }


def _changelog_fallback(limit: int = 6) -> list[dict]:
    """Local CHANGELOG.md digest shown when GitHub yields nothing.

    Without this, What's New / Notifications render a silent blank whenever
    the GitHub API fails (rate limit, private repo, offline). Honest source:
    we say the notes come from the bundled changelog.
    """
    candidates = [
        Path(__file__).resolve().parents[3] / 'CHANGELOG.md',
        Path.cwd().parent / 'CHANGELOG.md',
        Path.cwd() / 'CHANGELOG.md',
    ]
    for p in candidates:
        try:
            if not p.is_file():
                continue
            entries: list[dict] = []
            current: dict | None = None
            for line in p.read_text(encoding='utf-8', errors='replace').splitlines():
                if line.startswith('## '):
                    if current is not None:
                        entries.append(current)
                    current = {'tag': line[3:].strip(), 'name': line[3:].strip(), 'body': '', 'date': '', 'url': '', 'prerelease': False, 'source': 'changelog'}
                    if len(entries) >= limit:
                        break
                elif current is not None and line.strip():
                    body = current['body']
                    current['body'] = (body + '\n' if body else '') + line.strip()
                    if len(current['body']) > 600:
                        current['body'] = current['body'][:600]
            if current is not None and len(entries) < limit:
                entries.append(current)
            if entries:
                return entries
        except Exception:
            continue
    return []


def __getattr__(name: str) -> object:
    """Lazy module attribute — httpx is imported on first use (cold-start win;
    the request path carries its own local import)."""
    if name == 'httpx':
        import httpx

        return httpx
    raise AttributeError(f'module {__name__!r} has no attribute {name!r}')