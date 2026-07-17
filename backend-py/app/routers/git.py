"""Git operation API routes.

Resolves a session's workspacePath (or an explicit repoPath) and returns
structured JSON matching the desktop gitApi client:
  status / branch / branches / diff / checkout / commit.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

from fastapi import APIRouter, HTTPException

from app.models.camel_base import CamelModel

router = APIRouter(prefix='/api/git')


class GitCommand(CamelModel):
    """Git CLI body. Internals are snake_case; JSON stays camelCase."""

    session_id: str = ''
    repo_path: str = ''
    args: list[str] = []


class CheckoutBody(CamelModel):
    session_id: str = ''
    repo_path: str = ''
    branch: str = ''


class CommitBody(CamelModel):
    session_id: str = ''
    repo_path: str = ''
    message: str = ''
    all: bool = False


def _resolve_workspace(session_id: str = '', repo_path: str = '') -> tuple[str | None, str | None]:
    """Return (workspace_path, error). Prefers session workspace over repo_path."""
    path = (repo_path or '').strip()
    if session_id.strip():
        from app.services.workbench.sessions import get_workbench_session

        session = get_workbench_session(session_id.strip())
        if not session:
            return None, 'Session not found'
        path = str(getattr(session, 'workspacePath', '') or '').strip()
        if not path:
            return None, 'No workspace folder for this session'
    if not path:
        return None, 'No repository path'
    cwd = Path(path).expanduser()
    if not cwd.is_dir():
        return None, f'Not a directory: {path}'
    return str(cwd.resolve()), None


async def _run_git(repo_path: str, *args: str, check: bool = True) -> tuple[int, str, str]:
    """Run git; return (code, stdout, stderr). Raises only on missing git / timeout."""
    cwd = Path(repo_path).resolve()
    try:
        proc = await asyncio.create_subprocess_exec(
            'git',
            *args,
            cwd=str(cwd),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout_b, stderr_b = await asyncio.wait_for(proc.communicate(), timeout=30)
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail='Git command timed out') from None
    except FileNotFoundError:
        raise HTTPException(status_code=500, detail='Git not found on system PATH') from None

    code = proc.returncode or 0
    stdout = stdout_b.decode('utf-8', errors='replace')
    stderr = stderr_b.decode('utf-8', errors='replace')
    if check and code != 0:
        raise HTTPException(status_code=400, detail=stderr.strip() or f'git {" ".join(args)} failed')
    return code, stdout, stderr


async def _ensure_repo(repo_path: str) -> str | None:
    """Return error string if path is not a git work tree."""
    code, _, stderr = await _run_git(repo_path, 'rev-parse', '--is-inside-work-tree', check=False)
    if code != 0:
        return stderr.strip() or 'Not a git repository'
    return None


def _parse_porcelain(output: str) -> list[dict[str, object]]:
    files: list[dict[str, object]] = []
    for line in output.splitlines():
        if not line.strip():
            continue
        # porcelain v1: XY PATH or XY ORIG -> PATH
        status = line[:2].strip() if len(line) >= 2 else '?'
        rest = line[3:] if len(line) > 3 else line
        if ' -> ' in rest:
            rest = rest.split(' -> ', 1)[1]
        files.append({'path': rest.strip(), 'status': status or '?', 'added': 0, 'removed': 0})
    return files


def _apply_numstat(files: list[dict[str, object]], numstat: str) -> tuple[int, int]:
    by_path = {str(f['path']): f for f in files}
    total_added = 0
    total_removed = 0
    for line in numstat.splitlines():
        parts = line.split('\t')
        if len(parts) < 3:
            continue
        a_raw, d_raw, path = parts[0], parts[1], parts[2]
        try:
            added = 0 if a_raw == '-' else int(a_raw)
            removed = 0 if d_raw == '-' else int(d_raw)
        except ValueError:
            continue
        total_added += added
        total_removed += removed
        if path in by_path:
            by_path[path]['added'] = added
            by_path[path]['removed'] = removed
        else:
            files.append({'path': path, 'status': 'M', 'added': added, 'removed': removed})
    # If porcelain was empty but numstat had rows, totals still count.
    if total_added == 0 and total_removed == 0:
        for f in files:
            total_added += int(f.get('added') or 0)
            total_removed += int(f.get('removed') or 0)
    return total_added, total_removed


@router.get('/status')
async def git_status(sessionId: str = '', repoPath: str = ''):
    path, err = _resolve_workspace(sessionId, repoPath)
    if err or not path:
        return {'workspace': None, 'added': 0, 'removed': 0, 'files': [], 'error': err or 'No path'}
    repo_err = await _ensure_repo(path)
    if repo_err:
        return {'workspace': path, 'added': 0, 'removed': 0, 'files': [], 'error': repo_err}

    _, porcelain, _ = await _run_git(path, 'status', '--porcelain', check=False)
    files = _parse_porcelain(porcelain)
    _, unstaged, _ = await _run_git(path, 'diff', '--numstat', check=False)
    _, staged, _ = await _run_git(path, 'diff', '--cached', '--numstat', check=False)
    added, removed = _apply_numstat(files, unstaged + staged)
    return {
        'workspace': path,
        'added': added,
        'removed': removed,
        'files': files,
    }


@router.get('/log')
async def git_log(sessionId: str = '', repoPath: str = '', count: int = 10):
    path, err = _resolve_workspace(sessionId, repoPath)
    if err or not path:
        raise HTTPException(status_code=400, detail=err or 'No path')
    output = (await _run_git(path, 'log', f'--max-count={count}', '--oneline'))[1]
    return {'log': output, 'workspace': path}


@router.get('/branch')
async def git_branch(sessionId: str = '', repoPath: str = ''):
    """Current branch for the session workspace."""
    path, err = _resolve_workspace(sessionId, repoPath)
    if err or not path:
        return {'workspace': None, 'current': None, 'error': err or 'No path'}
    repo_err = await _ensure_repo(path)
    if repo_err:
        return {'workspace': path, 'current': None, 'error': repo_err}
    _, current, _ = await _run_git(path, 'branch', '--show-current', check=False)
    name = current.strip() or None
    return {'workspace': path, 'current': name}


@router.get('/branches')
async def git_branches(sessionId: str = '', repoPath: str = ''):
    """Local branch list with current flag — used by the branch switcher."""
    path, err = _resolve_workspace(sessionId, repoPath)
    if err or not path:
        return {'workspace': None, 'branches': [], 'error': err or 'No path'}
    repo_err = await _ensure_repo(path)
    if repo_err:
        return {'workspace': path, 'branches': [], 'error': repo_err}

    _, current_raw, _ = await _run_git(path, 'branch', '--show-current', check=False)
    current = current_raw.strip()
    _, listed, _ = await _run_git(path, 'branch', '--format=%(refname:short)', check=False)
    branches = [
        {'name': name, 'current': name == current}
        for name in (line.strip() for line in listed.splitlines())
        if name
    ]
    return {'workspace': path, 'branches': branches}


@router.get('/diff')
async def git_diff(sessionId: str = '', repoPath: str = '', target: str = 'HEAD'):
    path, err = _resolve_workspace(sessionId, repoPath)
    if err or not path:
        return {'workspace': None, 'added': 0, 'removed': 0, 'files': [], 'error': err or 'No path'}
    repo_err = await _ensure_repo(path)
    if repo_err:
        return {'workspace': path, 'added': 0, 'removed': 0, 'files': [], 'error': repo_err}

    _, porcelain, _ = await _run_git(path, 'status', '--porcelain', check=False)
    files = _parse_porcelain(porcelain)
    _, unstaged_ns, _ = await _run_git(path, 'diff', '--numstat', check=False)
    _, staged_ns, _ = await _run_git(path, 'diff', '--cached', '--numstat', check=False)
    added, removed = _apply_numstat(files, unstaged_ns + staged_ns)

    # Attach per-file patch when cheap; full tree diff as fallback text per file.
    _, full_diff, _ = await _run_git(path, 'diff', target, check=False)
    _, staged_diff, _ = await _run_git(path, 'diff', '--cached', check=False)
    combined = (full_diff or '') + (staged_diff or '')
    for f in files:
        f['diff'] = ''
    # Simple split by diff --git headers
    if combined.strip():
        chunks = combined.split('diff --git ')
        for chunk in chunks[1:]:
            header_end = chunk.find('\n')
            header = chunk[:header_end] if header_end >= 0 else chunk
            # b/path
            path_token = ''
            if ' b/' in header:
                path_token = header.split(' b/', 1)[1].strip()
            elif header.startswith('b/'):
                path_token = header[2:].strip()
            body = 'diff --git ' + chunk
            for f in files:
                if f['path'] == path_token or str(f['path']).endswith(path_token):
                    f['diff'] = body
                    break

    return {
        'workspace': path,
        'added': added,
        'removed': removed,
        'files': files,
    }


@router.post('/checkout')
async def git_checkout(body: CheckoutBody):
    if not body.branch.strip():
        raise HTTPException(status_code=400, detail='branch is required')
    path, err = _resolve_workspace(body.session_id, body.repo_path)
    if err or not path:
        raise HTTPException(status_code=400, detail=err or 'No path')
    repo_err = await _ensure_repo(path)
    if repo_err:
        raise HTTPException(status_code=400, detail=repo_err)
    _, output, _ = await _run_git(path, 'checkout', body.branch.strip())
    return {
        'workspace': path,
        'sha': '',
        'output': output,
        'branch': body.branch.strip(),
    }


@router.post('/commit')
async def git_commit(body: CommitBody):
    if not body.message.strip():
        raise HTTPException(status_code=400, detail='message is required')
    path, err = _resolve_workspace(body.session_id, body.repo_path)
    if err or not path:
        raise HTTPException(status_code=400, detail=err or 'No path')
    repo_err = await _ensure_repo(path)
    if repo_err:
        raise HTTPException(status_code=400, detail=repo_err)
    if body.all:
        await _run_git(path, 'add', '-A')
    _, output, _ = await _run_git(path, 'commit', '-m', body.message.strip())
    _, sha, _ = await _run_git(path, 'rev-parse', 'HEAD', check=False)
    return {'workspace': path, 'sha': sha.strip(), 'output': output}


@router.post('/command')
async def git_command(body: GitCommand):
    """Execute an arbitrary git command."""
    if not body.args:
        raise HTTPException(status_code=400, detail='No git args provided')
    path, err = _resolve_workspace(body.session_id, body.repo_path)
    if err or not path:
        raise HTTPException(status_code=400, detail=err or 'No path')
    _, output, _ = await _run_git(path, *body.args)
    return {'output': output, 'workspace': path}
