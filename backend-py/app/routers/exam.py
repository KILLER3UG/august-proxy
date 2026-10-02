"""
Exam router — generate, fetch, answer, and help preparation exams (v3, §13).

The defining rule: the model authors every question. No endpoint accepts a
client-supplied correct_index. Questions are served one at a time as banners.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

from fastapi import APIRouter, HTTPException

from app.json_narrowing import as_int, as_list, as_str
from app.services import exam_service
from app.services.memory_conn import commit as brain_commit
from app.services.memory_store import _conn

logger = logging.getLogger(__name__)

router = APIRouter(prefix='/api/exam')


def _read_attached_files(files: list[object], ws_root: Path | None) -> str:
    """Read the caller's attached files, bounded by a containment root.

    Split out of ``generateExam`` so it can be tested directly: inline, the
    containment logic could only be reached through the full request/DB path,
    which is how triage #23 (a request-supplied root of ``/``) survived.

    Two roots, and neither is asserted by the caller: a session-owned workspace
    when there is one, else the system temp dir. Both are checked by resolving
    the candidate first, so a symlink cannot walk out of the root it passed.
    """
    import tempfile

    tmp_root = Path(tempfile.gettempdir()).resolve()
    chunks: list[str] = []
    for fp in files:
        path = as_str(fp)
        try:
            p = Path(path).resolve()
        except OSError:
            continue
        if not p.is_file():
            continue
        if ws_root is not None:
            try:
                p.relative_to(ws_root)
            except ValueError:
                continue
        elif not p.is_absolute() or (tmp_root not in p.parents and p != tmp_root):
            continue
        try:
            with open(p, 'r', encoding='utf-8', errors='ignore') as f:
                chunks.append(f.read()[:5000])
        except Exception:
            continue
    return '\n\n'.join(chunks)[:10000]


def _trusted_workspace_root(session_id: str, claimed: str) -> Path | None:
    """Resolve the containment root for attached-file reads.

    A caller-supplied ``workspacePath`` cannot DEFINE the root. It may only
    nominate one, and it is honoured only when it matches the workspace a real
    session already owns — server-side truth, not something the request asserts.

    Before this, the root was taken straight from the body and the only check was
    ``p.relative_to(ws_root)``, so ``{"workspacePath": "/"}`` made every absolute
    path on the machine pass containment and the first 10 KB of each was read
    into the exam prompt. The comment above the call already claimed "arbitrary
    absolute paths are rejected"; that was true only for the no-workspace branch.

    The shipped frontend never sends ``workspacePath`` for exam generation, so
    this closes an API-level hole without changing the UI contract: with no
    nominated workspace the temp-dir rule below still applies.
    """
    claim = (claimed or '').strip()
    if not claim:
        return None
    try:
        wanted = str(Path(claim).expanduser().resolve(strict=False)).lower()
    except OSError:
        return None

    # A nominated workspace must belong to a session that exists.
    sid = (session_id or '').strip()
    owned: list[str] = []
    if sid:
        try:
            from app.services.workbench.sessions import get_workbench_session

            wb = get_workbench_session(sid)
            if wb:
                owned.append(str(getattr(wb, 'workspacePath', '') or ''))
        except Exception:
            logger.debug('exam workspace: workbench lookup failed', exc_info=True)
        try:
            from app.services.memory_store import get_session

            rec = get_session(sid)
            if rec:
                owned.append(str(rec.get('workspacePath') or ''))
        except Exception:
            logger.debug('exam workspace: session lookup failed', exc_info=True)

    for path in owned:
        if not path:
            continue
        try:
            if str(Path(path).expanduser().resolve(strict=False)).lower() == wanted:
                return Path(wanted)
        except OSError:
            continue

    logger.warning('exam: rejected unowned workspacePath %r', claim)
    return None


def _db():
    return _conn()


@router.post('/generate')
async def generateExam(body: dict[str, object]):
    """Generate a new exam via Prefrontal. Topic can be a string or derived from uploaded files."""
    topic = as_str(body.get('topic')).strip()
    count = max(1, min(as_int(body.get('count'), 5), 50))
    difficulty = as_str(body.get('difficulty'), 'medium')
    model_raw = body.get('model')
    if isinstance(model_raw, dict):
        model = as_str(model_raw.get('id'), '')
    else:
        model = as_str(model_raw)
    provider = as_str(body.get('provider'))
    files = as_list(body.get('files'), [])
    if not topic and (not files):
        raise HTTPException(status_code=400, detail='topic or files required')
    context = ''
    sourceFiles = ''
    if files:

        # Only read files the user actually owns: inside the session workspace
        # when one is nominated AND that workspace belongs to a real session
        # (see _trusted_workspace_root), else the system temp dir (mirrors the
        # sandbox's no-workspace write gate). A body-supplied path can no longer
        # widen the root to "/" — arbitrary absolute paths are rejected.
        ws = as_str(body.get('workspacePath')) or as_str(body.get('workspace_path'))
        ws_root = _trusted_workspace_root(as_str(body.get('sessionId')), ws)
        context = _read_attached_files(files, ws_root)
        sourceFiles = json.dumps(files)
    if not topic:
        topic = f'the content of {len(files)} uploaded file(s)'
    try:
        questions = await exam_service.generateQuestions(
            topic=topic, count=count, difficulty=difficulty, context=context, model=model, provider=provider
        )
    except ValueError as exc:
        logger.warning('exam generate failed: %s', exc)
        raise HTTPException(status_code=500, detail='Exam generation failed — check the model/provider configuration.')
    conn = _db()
    source = 'files' if files else 'topic' if as_str(body.get('topic')) else 'model'
    cur = conn.execute(
        'INSERT INTO exams (title, topic, source, source_files) VALUES (?, ?, ?, ?)',
        (f'Exam: {topic[:80]}', topic, source, sourceFiles),
    )
    examId = cur.lastrowid
    for i, q in enumerate(questions):
        conn.execute(
            'INSERT INTO exam_questions (exam_id, position, stem, options, correct_index, rationale, origin) VALUES (?, ?, ?, ?, ?, ?, ?)',
            (examId, i + 1, q['stem'], json.dumps(q['options']), q['correct_index'], q['rationale'], 'generated'),
        )
    brain_commit(conn)
    first = conn.execute(
        'SELECT id, position, stem, options FROM exam_questions WHERE exam_id = ? ORDER BY position LIMIT 1', (examId,)
    ).fetchone()
    firstQ = exam_service.stripAnswer(
        {
            'id': first['id'],
            'examId': examId,
            'position': first['position'],
            'stem': first['stem'],
            'options': json.loads(first['options']),
        }
    )
    return {'examId': examId, 'question': firstQ, 'totalQuestions': len(questions)}


@router.post('/{examId}/questions')
async def addQuestion(examId: int, body: dict[str, object]):
    """Add a user-requested question. The model authors it (origin='user-requested')."""
    requestText = as_str(body.get('request')).strip()
    afterPosition = body.get('after_position')
    model_raw = body.get('model')
    if isinstance(model_raw, dict):
        model = as_str(model_raw.get('id'), '')
    else:
        model = as_str(model_raw)
    provider = as_str(body.get('provider'))
    conn = _db()
    exam = conn.execute('SELECT topic FROM exams WHERE id = ?', (examId,)).fetchone()
    if not exam:
        raise HTTPException(status_code=404, detail='Exam not found')
    topic = exam['topic'] or 'general'
    existing = conn.execute(
        'SELECT stem, options FROM exam_questions WHERE exam_id = ? ORDER BY position LIMIT 3', (examId,)
    ).fetchall()
    similar = []
    for row in existing:
        try:
            similar.append({'stem': row['stem'], 'options': json.loads(row['options'])})
        except Exception:
            continue
    try:
        q = await exam_service.generateOneQuestion(
            topic=topic, requestText=requestText, similarTo=similar, model=model, provider=provider
        )
    except ValueError as exc:
        logger.warning('exam generate failed: %s', exc)
        raise HTTPException(status_code=500, detail='Exam generation failed — check the model/provider configuration.')
    if afterPosition is not None:
        afterPos = as_int(afterPosition)
        conn.execute(
            'UPDATE exam_questions SET position = position + 1 WHERE exam_id = ? AND position > ?', (examId, afterPos)
        )
        nextPos = afterPos + 1
    else:
        row = conn.execute(
            'SELECT COALESCE(MAX(position), 0) + 1 FROM exam_questions WHERE exam_id = ?', (examId,)
        ).fetchone()
        nextPos = row[0]
    cur = conn.execute(
        'INSERT INTO exam_questions (exam_id, position, stem, options, correct_index, rationale, origin) VALUES (?, ?, ?, ?, ?, ?, ?)',
        (
            examId,
            nextPos,
            q['stem'],
            json.dumps(q['options']),
            q['correct_index'],
            q['rationale'],
            f'user-requested: {requestText}' if requestText else 'user-requested',
        ),
    )
    questionId = cur.lastrowid
    brain_commit(conn)
    newQ = exam_service.stripAnswer(
        {'id': questionId, 'examId': examId, 'position': nextPos, 'stem': q['stem'], 'options': q['options']}
    )
    return {'position': nextPos, 'questionId': questionId, 'question': newQ}


@router.get('/{examId}/question/{position}')
async def getQuestion(examId: int, position: int):
    """Fetch one question. NEVER leaks correct_index or rationale (the authoring invariant)."""
    conn = _db()
    q = conn.execute(
        'SELECT id, stem, options FROM exam_questions WHERE exam_id = ? AND position = ?', (examId, position)
    ).fetchone()
    if not q:
        raise HTTPException(status_code=404, detail='Question not found')
    return exam_service.stripAnswer(
        {'id': q['id'], 'examId': examId, 'position': position, 'stem': q['stem'], 'options': json.loads(q['options'])}
    )


@router.post('/{examId}/answer')
async def answerQuestion(examId: int, body: dict[str, object]):
    """Record an answer for a question. Returns correctness + rationale."""
    questionId = body.get('questionId')
    selectedIndex = body.get('selectedIndex')
    conn = _db()
    q = conn.execute(
        'SELECT correct_index, rationale FROM exam_questions WHERE id = ? AND exam_id = ?', (questionId, examId)
    ).fetchone()
    if not q:
        raise HTTPException(status_code=404, detail='Question not found')
    isCorrect = 1 if as_int(selectedIndex, -1) == as_int(q['correct_index'], -1) else 0
    conn.execute(
        "INSERT INTO exam_attempts (exam_id, question_id, selected_index, is_correct, answered_at) VALUES (?, ?, ?, ?, datetime('now'))",
        (examId, questionId, selectedIndex, isCorrect),
    )
    brain_commit(conn)
    return {'isCorrect': bool(isCorrect), 'correctIndex': q['correct_index'], 'rationale': q['rationale']}


@router.post('/{examId}/help')
async def helpQuestion(examId: int, body: dict[str, object]):
    """Explain a question via Prefrontal without revealing the answer in the banner state."""
    questionId = body.get('questionId')
    ask = as_str(body.get('ask'), '')
    conn = _db()
    q = conn.execute(
        'SELECT stem, options FROM exam_questions WHERE id = ? AND exam_id = ?', (questionId, examId)
    ).fetchone()
    if not q:
        raise HTTPException(status_code=404, detail='Question not found')
    options = json.loads(q['options'])
    explanation = await exam_service.helpExplanation(
        stem=q['stem'], options=options, userQuestion=ask or 'Explain this question.'
    )
    try:
        conn.execute(
            'UPDATE exam_attempts SET asked_for_help = 1 WHERE question_id = ? AND exam_id = ?',
            (questionId, examId),
        )
        brain_commit(conn)
    except Exception:
        pass
    return {'explanation': explanation, 'bannerDismissed': False}
