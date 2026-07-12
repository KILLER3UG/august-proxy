"""
Exam router — generate, fetch, answer, and help preparation exams (v3, §13).

The defining rule: the model authors every question. No endpoint accepts a
client-supplied correct_index. Questions are served one at a time as banners.
"""

from __future__ import annotations
import json
from fastapi import APIRouter, HTTPException
from app.jsonUtils import as_str, as_int, as_list
from app.services.memory_store import _conn
from app.services import exam_service

router = APIRouter(prefix='/api/exam')


def _db():
    return _conn()


@router.post('/generate')
async def generateExam(body: dict[str, object]):
    """Generate a new exam via Prefrontal. Topic can be a string or derived from uploaded files."""
    topic = as_str(body.get('topic')).strip()
    count = min(as_int(body.get('count'), 5), 50)
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
        import os

        chunks = []
        for fp in files:
            path = as_str(fp)
            if os.path.exists(path):
                try:
                    with open(path, 'r', encoding='utf-8', errors='ignore') as f:
                        chunks.append(f.read()[:5000])
                except Exception:
                    continue
        context = '\n\n'.join(chunks)[:10000]
        sourceFiles = json.dumps(files)
    if not topic:
        topic = f'the content of {len(files)} uploaded file(s)'
    try:
        questions = await exam_service.generateQuestions(
            topic=topic, count=count, difficulty=difficulty, context=context, model=model, provider=provider
        )
    except ValueError as exc:
        raise HTTPException(status_code=500, detail=str(exc))
    conn = _db()
    source = 'files' if files else 'topic' if as_str(body.get('topic')) else 'model'
    cur = conn.execute(
        'INSERT INTO exams (title, topic, source, sourceFiles) VALUES (?, ?, ?, ?)',
        (f'Exam: {topic[:80]}', topic, source, sourceFiles),
    )
    examId = cur.lastrowid
    for i, q in enumerate(questions):
        conn.execute(
            'INSERT INTO examQuestions (examId, position, stem, options, correctIndex, rationale, origin) VALUES (?, ?, ?, ?, ?, ?, ?)',
            (examId, i + 1, q['stem'], json.dumps(q['options']), q['correct_index'], q['rationale'], 'generated'),
        )
    conn.commit()
    first = conn.execute(
        'SELECT id, position, stem, options FROM examQuestions WHERE examId = ? ORDER BY position LIMIT 1', (examId,)
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
        'SELECT stem, options FROM examQuestions WHERE examId = ? ORDER BY position LIMIT 3', (examId,)
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
        raise HTTPException(status_code=500, detail=str(exc))
    if afterPosition is not None:
        afterPos = as_int(afterPosition)
        conn.execute(
            'UPDATE examQuestions SET position = position + 1 WHERE examId = ? AND position > ?', (examId, afterPos)
        )
        nextPos = afterPos + 1
    else:
        row = conn.execute(
            'SELECT COALESCE(MAX(position), 0) + 1 FROM examQuestions WHERE examId = ?', (examId,)
        ).fetchone()
        nextPos = row[0]
    cur = conn.execute(
        'INSERT INTO examQuestions (examId, position, stem, options, correctIndex, rationale, origin) VALUES (?, ?, ?, ?, ?, ?, ?)',
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
    conn.commit()
    newQ = exam_service.stripAnswer(
        {'id': questionId, 'examId': examId, 'position': nextPos, 'stem': q['stem'], 'options': q['options']}
    )
    return {'position': nextPos, 'questionId': questionId, 'question': newQ}


@router.get('/{examId}/question/{position}')
async def getQuestion(examId: int, position: int):
    """Fetch one question. NEVER leaks correct_index or rationale (the authoring invariant)."""
    conn = _db()
    q = conn.execute(
        'SELECT id, stem, options FROM examQuestions WHERE examId = ? AND position = ?', (examId, position)
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
        'SELECT correctIndex, rationale FROM examQuestions WHERE id = ? AND examId = ?', (questionId, examId)
    ).fetchone()
    if not q:
        raise HTTPException(status_code=404, detail='Question not found')
    isCorrect = 1 if selectedIndex == q['correctIndex'] else 0
    conn.execute(
        "INSERT INTO examAttempts (examId, questionId, selectedIndex, isCorrect, answeredAt) VALUES (?, ?, ?, ?, datetime('now'))",
        (examId, questionId, selectedIndex, isCorrect),
    )
    conn.commit()
    return {'isCorrect': bool(isCorrect), 'correctIndex': q['correctIndex'], 'rationale': q['rationale']}


@router.post('/{examId}/help')
async def helpQuestion(examId: int, body: dict[str, object]):
    """Explain a question via Prefrontal without revealing the answer in the banner state."""
    questionId = body.get('questionId')
    ask = as_str(body.get('ask'), '')
    conn = _db()
    q = conn.execute(
        'SELECT stem, options FROM examQuestions WHERE id = ? AND examId = ?', (questionId, examId)
    ).fetchone()
    if not q:
        raise HTTPException(status_code=404, detail='Question not found')
    options = json.loads(q['options'])
    explanation = await exam_service.helpExplanation(
        stem=q['stem'], options=options, userQuestion=ask or 'Explain this question.'
    )
    try:
        conn.execute('UPDATE examAttempts SET askedForHelp = 1 WHERE questionId = ?', (questionId,))
        conn.commit()
    except Exception:
        pass
    return {'explanation': explanation, 'bannerDismissed': False}
