"""Git operation API routes.

Port of backend/services/git/git-service.js + git-routes.js.
Provides git status, log, and basic operations via the git CLI.
"""

from __future__ import annotations

import asyncio
import os
from pathlib import Path

from fastapi import APIRouter, HTTPException
from app.lib.camel_model import CamelModel

router = APIRouter(prefix="/api/git")


class GitCommand(CamelModel):
    repo_path: str = ""
    args: list[str] = []


async def _run_git(repo_path: str, *args: str) -> str:
    """Run a git command and return stdout."""
    cwd = Path(repo_path).resolve() if repo_path else Path.cwd()
    if not cwd.is_dir():
        raise HTTPException(status_code=400, detail=f"Not a directory: {repo_path}")

    try:
        proc = await asyncio.create_subprocess_exec(
            "git", *args,
            cwd=str(cwd),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=30)
        if proc.returncode != 0:
            raise HTTPException(status_code=400, detail=stderr.decode("utf-8", errors="replace"))
        return stdout.decode("utf-8", errors="replace")
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail="Git command timed out")
    except FileNotFoundError:
        raise HTTPException(status_code=500, detail="Git not found on system PATH")


@router.get("/status")
async def git_status(repo_path: str = ""):
    """Get git status for a repository."""
    output = await _run_git(repo_path, "status", "--porcelain")
    return {"status": output}


@router.get("/log")
async def git_log(repo_path: str = "", count: int = 10):
    """Get recent git log."""
    output = await _run_git(repo_path, "log", f"--max-count={count}", "--oneline")
    return {"log": output}


@router.get("/branch")
async def git_branch(repo_path: str = ""):
    """List git branches."""
    output = await _run_git(repo_path, "branch", "-a")
    return {"branches": output}


@router.get("/diff")
async def git_diff(repo_path: str = "", target: str = "HEAD"):
    """Show git diff for unstaged changes."""
    output = await _run_git(repo_path, "diff", target)
    return {"diff": output}


@router.post("/command")
async def git_command(body: GitCommand):
    """Execute an arbitrary git command."""
    if not body.args:
        raise HTTPException(status_code=400, detail="No git args provided")
    output = await _run_git(body.repo_path, *body.args)
    return {"output": output}
