"""Part 10 R-A — code review routes (``/api/code-review``).

Advisory review of the session workspace changeset (working tree vs HEAD).
R5: advisory only, NEVER a gate — every degenerate case returns HTTP 200
with ``{skipped: true, notice}`` rather than an error that could block UI.
"""

from __future__ import annotations

from fastapi import APIRouter

from app.models.camel_base import CamelModel

router = APIRouter(prefix='/api/code-review')


class ReviewRunBody(CamelModel):
    """Review request. Internals snake_case; JSON camelCase."""

    session_id: str = ''
    repo_path: str = ''
    workspace: str = ''
    diff_text: str = ''  # optional: the UI already holds the diff
    model_hint: str = ''
    passes: int = 1  # exhaustive-merge: 1..3 reviewer passes (R-B)


@router.get('/rubric')
async def get_rubric():
    """The severity rubric + conventions directive (transparency)."""
    from app.services.code_review import CONVENTIONS_DIRECTIVE, SEVERITY_RUBRIC

    return {'rubric': SEVERITY_RUBRIC, 'conventionsDirective': CONVENTIONS_DIRECTIVE}


@router.post('/run')
async def run_review(body: ReviewRunBody):
    """Run one advisory review pass over the changeset diff."""
    from app.routers.git import _resolve_workspace, git_diff
    from app.services.code_review import run_code_review_async

    workspace = body.workspace.strip()
    diff_text = body.diff_text
    changed_paths: list[str] = []
    file_count = 0

    if not workspace:
        resolved, _err = _resolve_workspace(body.session_id, body.repo_path)
        workspace = resolved or ''

    if not diff_text.strip() and (body.session_id or body.repo_path or workspace):
        # Reuse the git diff endpoint logic (plain function call).
        diff = await git_diff(
            sessionId=body.session_id, repoPath=body.repo_path or workspace
        )
        files = [f for f in diff.get('files', []) if isinstance(f, dict)]
        file_count = len(files)
        changed_paths = [str(f.get('path') or '') for f in files]
        diff_text = '\n'.join(str(f.get('diff') or '') for f in files if f.get('diff'))

    return await run_code_review_async(
        workspace=workspace,
        diff_text=diff_text,
        file_count=file_count,
        changed_paths=changed_paths or None,
        model_hint=body.model_hint,
        max_passes=body.passes,
    )
