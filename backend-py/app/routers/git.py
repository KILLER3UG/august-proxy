"""Git operation API routes.

Port of backend/services/git/git-service.js + git-routes.js.
Provides git status, log, and basic operations via the git CLI.

Request body ``GitCommand`` inherits :class:`CamelModel` so internals are
snake_case while JSON from the frontend stays camelCase.
"""

from __future__ import annotations
import asyncio
from pathlib import Path
from fastapi import APIRouter, HTTPException
from app.models.camel_base import CamelModel

router = APIRouter(prefix='/api/git')


class GitCommand(CamelModel):
    """Git CLI body. Internals are snake_case; JSON stays camelCase."""

    repo_path: str = ''
    args: list[str] = []


async def _runGit(repoPath: str, *args: str) -> str:
    """Run a git command and return stdout."""
    cwd = Path(repoPath).resolve() if repoPath else Path.cwd()
    if not cwd.is_dir():
        raise HTTPException(status_code=400, detail=f'Not a directory: {repoPath}')
    try:
        proc = await asyncio.create_subprocess_exec(
            'git', *args, cwd=str(cwd), stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=30)
        if proc.returncode != 0:
            raise HTTPException(status_code=400, detail=stderr.decode('utf-8', errors='replace'))
        return stdout.decode('utf-8', errors='replace')
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail='Git command timed out')
    except FileNotFoundError:
        raise HTTPException(status_code=500, detail='Git not found on system PATH')


@router.get('/status')
async def gitStatus(repoPath: str = ''):
    """Get git status for a repository."""
    output = await _runGit(repoPath, 'status', '--porcelain')
    return {'status': output}


@router.get('/log')
async def gitLog(repoPath: str = '', count: int = 10):
    """Get recent git log."""
    output = await _runGit(repoPath, 'log', f'--max-count={count}', '--oneline')
    return {'log': output}


@router.get('/branch')
async def gitBranch(repoPath: str = ''):
    """List git branches."""
    output = await _runGit(repoPath, 'branch', '-a')
    return {'branches': output}


@router.get('/diff')
async def gitDiff(repoPath: str = '', target: str = 'HEAD'):
    """Show git diff for unstaged changes."""
    output = await _runGit(repoPath, 'diff', target)
    return {'diff': output}


@router.post('/command')
async def gitCommand(body: GitCommand):
    """Execute an arbitrary git command."""
    if not body.args:
        raise HTTPException(status_code=400, detail='No git args provided')
    output = await _runGit(body.repo_path, *body.args)
    return {'output': output}
