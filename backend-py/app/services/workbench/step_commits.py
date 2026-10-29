"""Per-step commits and reviews for a chat's todo plan.

The todo list is the agent's plan, but on its own it is only a checklist: a
completed step has no durable link to the files it changed or to a review.
This module adds that link without taking over the user's branch:

* stable step ids are assigned on every submit/update (matched by content, so
  an id survives the wholesale replacement the todo tools perform);
* marking a step `in_progress` records a baseline (HEAD + dirty paths) before
  the work starts;
* `commit_step` commits only the step's delta, refuses when the workspace was
  already dirty at the baseline, adopts commits that landed during the step,
  and records the commit(s) on the step;
* `review_step` sends the step's commit range and the worker's claims to the
  clean-context reviewer, then records the verdict.

No commit happens automatically. The model (or a future host policy) chooses
the step and the subject; the host owns the proof and the record.
"""

from __future__ import annotations

import json
import re
import subprocess
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING

from app.json_narrowing import as_dict, as_list, as_str

if TYPE_CHECKING:
    from app.services.workbench.sessions import WorkbenchSession

STEP_ID_RE = re.compile(r'^step_[a-f0-9]{8}$')
_APP_DIRS = ('.aug', '.git')
_MAX_SUBJECT = 160
_MAX_DIFF_CHARS = 60_000
_MAX_PATHS = 200
_GIT_TIMEOUT_S = 30.0


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')


def _workspace(session: 'WorkbenchSession') -> Path | None:
    raw = as_str(getattr(session, 'workspacePath', '') or '').strip()
    if not raw:
        return None
    path = Path(raw)
    try:
        path = path.resolve()
    except OSError:
        return None
    return path if path.is_dir() else None


def _git(workspace: Path, *args: str, timeout: float = _GIT_TIMEOUT_S) -> subprocess.CompletedProcess[str]:
    from app.lib.async_subprocess import noninteractive_env

    return subprocess.run(
        ['git', '-c', 'core.quotePath=false', *args],
        cwd=str(workspace),
        capture_output=True,
        text=True,
        timeout=timeout,
        env=noninteractive_env(),
        errors='replace',
    )


def _is_git_repo(workspace: Path) -> bool:
    try:
        r = _git(workspace, 'rev-parse', '--is-inside-work-tree')
    except (OSError, subprocess.SubprocessError):
        return False
    return r.returncode == 0 and (r.stdout or '').strip().lower() == 'true'


def _head(workspace: Path) -> str:
    r = _git(workspace, 'rev-parse', 'HEAD')
    return (r.stdout or '').strip() if r.returncode == 0 else ''


def _dirty_paths(workspace: Path) -> list[str]:
    r = _git(workspace, 'status', '--porcelain', '--untracked-files=all')
    if r.returncode != 0:
        return []
    out: list[str] = []
    for line in (r.stdout or '').splitlines():
        if len(line) < 4:
            continue
        path = line[3:].strip()
        if ' -> ' in path:
            path = path.split(' -> ', 1)[1]
        path = path.strip().strip('"')
        rel = _relative_posix(workspace, path)
        if rel and rel not in out:
            out.append(rel)
    return sorted(out)


def _relative_posix(workspace: Path, raw: str) -> str:
    if not raw:
        return ''
    p = Path(raw)
    try:
        p = (p if p.is_absolute() else workspace / p).resolve()
    except OSError:
        return ''
    try:
        rel = p.relative_to(workspace)
    except ValueError:
        return ''
    return rel.as_posix()


def _is_done(status: object) -> bool:
    return as_str(status).strip().lower() in ('completed', 'complete', 'done')


def _step_id(previous: dict[str, object] | None, content: str) -> str:
    existing = as_str((previous or {}).get('id')).strip()
    if STEP_ID_RE.match(existing):
        return existing
    return f'step_{uuid.uuid4().hex[:8]}'


def _find_step(session: 'WorkbenchSession', ref: str) -> dict[str, object] | None:
    needle = as_str(ref).strip()
    if not needle:
        return None
    todos = [t for t in as_list(getattr(session, 'todos', None)) if isinstance(t, dict)]
    for item in todos:
        if as_str(item.get('id')).strip() == needle:
            return item
    exact = [t for t in todos if as_str(t.get('content')).strip().lower() == needle.lower()]
    if len(exact) == 1:
        return exact[0]
    return None


def _baselines(session: 'WorkbenchSession') -> dict[str, object]:
    meta = dict(as_dict(getattr(session, 'metadata', None) or {}))
    return dict(as_dict(meta.get('stepBaselines') or {}))


def _set_baselines(session: 'WorkbenchSession', baselines: dict[str, object]) -> None:
    meta = dict(as_dict(getattr(session, 'metadata', None) or {}))
    if baselines:
        meta['stepBaselines'] = baselines
    else:
        meta.pop('stepBaselines', None)
    session.metadata = meta


def _record_baseline(session: 'WorkbenchSession', step_id: str) -> None:
    baselines = _baselines(session)
    if step_id in baselines:
        return
    workspace = _workspace(session)
    if workspace is None or not _is_git_repo(workspace):
        return
    baselines[step_id] = {
        'head': _head(workspace),
        'dirty': _dirty_paths(workspace),
        'startedAt': _now(),
    }
    _set_baselines(session, baselines)


def enrich_todos(
    session: 'WorkbenchSession', incoming: list[dict[str, object]]
) -> list[dict[str, object]]:
    """Assign stable ids, carry host fields, and capture an `in_progress` baseline."""
    previous = [t for t in as_list(getattr(session, 'todos', None)) if isinstance(t, dict)]
    by_content = {
        as_str(t.get('content')).strip().lower(): t
        for t in previous
        if as_str(t.get('content')).strip()
    }
    by_id = {as_str(t.get('id')).strip(): t for t in previous if as_str(t.get('id')).strip()}
    out: list[dict[str, object]] = []
    seen: set[str] = set()
    for raw in incoming:
        if not isinstance(raw, dict):
            continue
        content = as_str(raw.get('content')).strip()
        if not content:
            continue
        prior = by_id.get(as_str(raw.get('id')).strip()) or by_content.get(content.lower())
        step_id = _step_id(prior, content)
        if step_id in seen:
            continue
        seen.add(step_id)
        merged: dict[str, object] = dict(raw)
        merged['id'] = step_id
        merged['content'] = content
        merged['status'] = as_str(raw.get('status')) or 'pending'
        for key in ('commit', 'review', 'summary', 'verification', 'commitSubject'):
            if key not in merged and prior is not None and key in prior:
                merged[key] = prior[key]
        out.append(merged)
        # A new in-progress transition opens the step's work window. A repeat
        # submit of the same in-progress step does not re-baseline.
        if as_str(merged.get('status')).strip().lower() == 'in_progress':
            if prior is None or as_str(prior.get('status')).strip().lower() != 'in_progress':
                _record_baseline(session, step_id)

    live_ids = {as_str(t.get('id')) for t in out}
    baselines = {k: v for k, v in _baselines(session).items() if k in live_ids}
    _set_baselines(session, baselines)
    return out


def ensure_todo_ids(todos: list[dict[str, object]]) -> list[dict[str, object]]:
    """Id assignment without git, for a worker's own list."""
    out: list[dict[str, object]] = []
    by_content: dict[str, dict[str, object]] = {}
    for raw in todos:
        if not isinstance(raw, dict):
            continue
        content = as_str(raw.get('content')).strip()
        if not content:
            continue
        prior = by_content.get(content.lower())
        merged = dict(raw)
        merged['id'] = _step_id(prior, content)
        merged['content'] = content
        out.append(merged)
        by_content[content.lower()] = merged
    return out


def _normalize_paths(workspace: Path, raw: object) -> tuple[list[str], str]:
    values = [as_str(v).strip() for v in as_list(raw) if as_str(v).strip()]
    if not values:
        return [], ''
    if len(values) > _MAX_PATHS:
        return [], f'Too many paths ({len(values)} > {_MAX_PATHS}).'
    out: list[str] = []
    for value in values:
        rel = _relative_posix(workspace, value)
        if not rel:
            return [], f'Path is outside the workspace: {value}'
        first = rel.split('/', 1)[0]
        if first in _APP_DIRS:
            return [], f'Refusing to commit app state: {rel}'
        if rel not in out:
            out.append(rel)
    return sorted(out), ''


def _commits_between(workspace: Path, base: str) -> list[dict[str, str]]:
    if not base:
        return []
    r = _git(workspace, 'log', '-z', '--reverse', '--format=%H%x00%s', f'{base}..HEAD')
    if r.returncode != 0:
        return []
    parts = [p for p in (r.stdout or '').split('\x00') if p.strip()]
    out: list[dict[str, str]] = []
    for i in range(0, len(parts) - 1, 2):
        out.append({'sha': parts[i].strip(), 'subject': parts[i + 1].strip()})
    return out


def _latest_base(step: dict[str, object]) -> str:
    commits = [c for c in as_list(step.get('commit')) if isinstance(c, dict)]
    if not commits:
        return ''
    return as_str(commits[0].get('base')).strip()


def commit_step(
    session: 'WorkbenchSession',
    step_ref: str,
    subject: str = '',
    paths: object = None,
) -> str:
    """Commit exactly one completed step's delta and record it on the step."""
    step = _find_step(session, step_ref)
    if step is None:
        return f'Error: no todo step matches {step_ref!r}.'
    if not _is_done(step.get('status')):
        return f'Error: step {step.get("content")!r} is not completed; mark it done first.'
    workspace = _workspace(session)
    if workspace is None:
        return 'Error: this chat has no workspace directory.'
    if not _is_git_repo(workspace):
        return 'Error: the workspace is not a git repository.'
    step_id = as_str(step.get('id'))
    baseline = as_dict(_baselines(session).get(step_id) or {})
    base_head = as_str(baseline.get('head')).strip()
    baseline_dirty = {as_str(p) for p in as_list(baseline.get('dirty')) if as_str(p)}
    current_dirty = set(_dirty_paths(workspace))
    explicit, path_error = _normalize_paths(workspace, paths)
    if path_error:
        return f'Error: {path_error}'
    if explicit:
        overlap = sorted(set(explicit) & baseline_dirty)
        if overlap:
            return (
                'Error: these paths were already dirty when the step started, so a '
                f'step commit would include someone else\'s work: {", ".join(overlap[:10])}. '
                'Commit them manually or start a new step from a clean tree.'
            )
        candidates = explicit
    else:
        if not baseline:
            return (
                'Error: no baseline was recorded for this step. Mark it in_progress before '
                'working, or pass paths explicitly.'
            )
        if baseline_dirty:
            return (
                'Error: the workspace was already dirty when this step started '
                f'({len(baseline_dirty)} path(s)); a step commit cannot prove the delta is '
                'the step\'s own. Commit the pre-existing work first, or pass paths explicitly.'
            )
        candidates = sorted(current_dirty)
    if not candidates:
        adopted = _commits_between(workspace, base_head)
        if adopted:
            _attach_commits(step, adopted, base_head, [], '')
            _persist(session)
            shas = ', '.join(c['sha'][:8] for c in adopted)
            return f'Step already committed during its window; recorded {shas} as its commits.'
        return 'Error: no changed paths to commit for this step.'

    subject_line = ' '.join((subject or as_str(step.get('commitSubject')) or as_str(step.get('content'))).split())[: _MAX_SUBJECT]
    if not subject_line:
        return 'Error: a commit subject is required.'
    pre_head = _head(workspace)
    adopted = _commits_between(workspace, base_head) if pre_head != base_head else []
    add = _git(workspace, 'add', '-A', '--', *candidates)
    if add.returncode != 0:
        return f'Error staging step paths: {(add.stderr or add.stdout).strip()[:500]}'
    commit = _git(workspace, 'commit', '-m', subject_line, '--', *candidates)
    if commit.returncode != 0:
        return (
            'Error committing the step (nothing was recorded): '
            f'{(commit.stderr or commit.stdout).strip()[:500]}'
        )
    sha = _head(workspace)
    _attach_commits(step, adopted, base_head, candidates, sha, subject_line)
    _persist(session)
    parts = [f'Committed step {step.get("content")!r} as {sha[:8]}: {subject_line}']
    if adopted:
        parts.append('adopted ' + ', '.join(c['sha'][:8] for c in adopted))
    parts.append('review: unreviewed')
    return '; '.join(parts)


def _attach_commits(
    step: dict[str, object],
    adopted: list[dict[str, str]],
    base: str,
    paths: list[str],
    sha: str,
    subject: str = '',
) -> None:
    commits = [c for c in as_list(step.get('commit')) if isinstance(c, dict)]
    for item in adopted:
        commits.append(
            {'sha': item['sha'], 'subject': item['subject'], 'base': base, 'adopted': True, 'at': _now()}
        )
    if sha:
        commits.append(
            {
                'sha': sha,
                'subject': subject,
                'base': base,
                'paths': paths,
                'adopted': False,
                'at': _now(),
            }
        )
    step['commit'] = commits
    old_review = as_dict(step.get('review') or {})
    step['review'] = {
        'status': 'unreviewed',
        'reviewedSha': as_str(old_review.get('reviewedSha')),
        'at': _now(),
    }


async def review_step(session: 'WorkbenchSession', step_ref: str, focus: str = '') -> str:
    """Review a step's committed change from a clean context and record the verdict."""
    step = _find_step(session, step_ref)
    if step is None:
        return f'Error: no todo step matches {step_ref!r}.'
    commits = [c for c in as_list(step.get('commit')) if isinstance(c, dict)]
    if not commits:
        return f'Error: step {step.get("content")!r} has no recorded commit to review.'
    workspace = _workspace(session)
    if workspace is None:
        return 'Error: this chat has no workspace directory.'
    first = commits[0]
    last = commits[-1]
    base = as_str(first.get('base')).strip()
    last_sha = as_str(last.get('sha')).strip()
    if not last_sha:
        return 'Error: the step has no commit sha.'
    if base:
        diff_result = _git(workspace, 'diff', '--no-color', f'{base}..{last_sha}')
    else:
        diff_result = _git(workspace, 'show', '--format=', '--no-color', last_sha)
    if diff_result.returncode != 0:
        return f'Error reading the step diff: {(diff_result.stderr or diff_result.stdout).strip()[:500]}'
    diff = diff_result.stdout or ''
    if len(diff) > _MAX_DIFF_CHARS:
        diff = diff[:_MAX_DIFF_CHARS] + '\n[truncated — open the files for the rest]'
    requirement = as_str(step.get('content')).strip()
    verification = as_str(step.get('verification')).strip()
    summary = as_str(step.get('summary')).strip()
    evidence = verification or (
        'No verification output was recorded for this step. Treat any "verified" claim as unproven.'
    )
    if summary:
        evidence += f'\n\nWorker summary (a claim to verify, not evidence):\n{summary}'
    from app.services.workbench.clean_review import run_clean_review

    result = await run_clean_review(
        session,
        requirement=requirement,
        diff=diff,
        test_evidence=evidence,
        focus=focus,
    )
    verdict = as_dict(result.get('verdict') or {})
    status = as_str(verdict.get('verdict')).strip()
    if status not in ('approve', 'request_changes'):
        step['review'] = {
            'status': 'failed',
            'reviewedSha': last_sha,
            'summary': 'The reviewer did not return a valid verdict.',
            'findings': [],
            'at': _now(),
        }
        _persist(session)
        return json.dumps({'status': 'failed', 'raw': result.get('raw')}, default=str)
    review_record: dict[str, object] = {
        'status': 'approved' if status == 'approve' else 'changes_requested',
        'reviewedSha': last_sha,
        'summary': as_str(verdict.get('summary')),
        'findings': as_list(verdict.get('findings')),
        'at': _now(),
    }
    step['review'] = review_record
    _persist(session)
    return json.dumps(
        {'status': review_record['status'], 'reviewedSha': last_sha, 'verdict': verdict},
        default=str,
    )

def _persist(session: 'WorkbenchSession') -> None:
    try:
        from app.services.workbench import sessions as sessions_mod

        sessions_mod.saveSessions()
        sessions_mod._emit_session_status(session.id)
    except Exception:  # noqa: BLE001 -- a failed persistence must not undo the commit receipt
        pass
