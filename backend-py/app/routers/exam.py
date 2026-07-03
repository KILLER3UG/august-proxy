"""
Exam router — generate, fetch, answer, and help preparation exams (v3, §13).

The defining rule: the model authors every question. No endpoint accepts a
client-supplied correct_index. Questions are served one at a time as banners.
"""
from __future__ import annotations
import json
import time
from fastapi import APIRouter, HTTPException
from app.services.memoryStore import _conn
from app.services import examService
router = APIRouter(prefix='/api/exam')

def _db():
    return _conn()

@router.post('/generate')
async def generateExam(body: dict[str, object]):
    """Generate a new exam via Prefrontal. Topic can be a string or derived from uploaded files."""
    topic = (body.get('topic') or '').strip()
    count = min(int(body.get('count', 5)), 50)
    difficulty = body.get('difficulty', 'medium')
    files = body.get('files') or []
    if not topic and (not files):
        raise HTTPException(status_code=400, detail='topic or files required')
    context = ''
    sourceFiles = ''
    if files:
        import os
        chunks = []
        for fp in files:
            if os.path.exists(fp):
                try:
                    with open(fp, 'r', encoding='utf-8', errors='ignore') as f:
                        chunks.append(f.read()[:5000])
                except Exception:
                    continue
        context = '\n\n'.join(chunks)[:10000]
        sourceFiles = json.dumps(files)
    if not topic:
        topic = f'the content of {len(files)} uploaded file(s)'
    try:
        questions = await examService.generate_questions(topic=topic, count=count, difficulty=difficulty, context=context)
    except ValueError as exc:
        raise HTTPException(status_code=500, detail=str(exc))
    conn = _db()
    source = 'files' if files else 'topic' if body.get('topic') else 'model'
    cur = conn.execute('INSERT INTO exams (title, topic, source, sourceFiles) VALUES (?, ?, ?, ?)', (f'Exam: {topic[:80]}', topic, source, sourceFiles))
    examId = cur.lastrowid
    for i, q in enumerate(questions):
        conn.execute('INSERT INTO examQuestions (examId, position, stem, options, correctIndex, rationale, origin) VALUES (?, ?, ?, ?, ?, ?, ?)', (examId, i + 1, q['stem'], json.dumps(q['options']), q['correct_index'], q['rationale'], 'generated'))
    conn.commit()
    first = conn.execute('SELECT id, position, stem, options FROM examQuestions WHERE examId = ? ORDER BY position LIMIT 1', (examId,)).fetchone()
    firstQ = examService.strip_answer({'id': first['id'], 'examId': examId, 'position': first['position'], 'stem': first['stem'], 'options': json.loads(first['options'])})
    return {'exam_id': examId, 'question': firstQ, 'total_questions': len(questions)}

@router.post('/{exam_id}/questions')
async def addQuestion(examId: int, body: dict[str, object]):
    """Add a user-requested question. The model authors it (origin='user-requested')."""
    requestText = (body.get('request') or '').strip()
    afterPosition = body.get('after_position')
    conn = _db()
    exam = conn.execute('SELECT topic FROM exams WHERE id = ?', (examId,)).fetchone()
    if not exam:
        raise HTTPException(status_code=404, detail='Exam not found')
    topic = exam['topic'] or 'general'
    existing = conn.execute('SELECT stem, options FROM examQuestions WHERE examId = ? ORDER BY position LIMIT 3', (examId,)).fetchall()
    similar = []
    for row in existing:
        try:
            similar.append({'stem': row['stem'], 'options': json.loads(row['options'])})
        except Exception:
            continue
    try:
        q = await examService.generate_one_question(topic=topic, request_text=requestText, similar_to=similar)
    except ValueError as exc:
        raise HTTPException(status_code=500, detail=str(exc))
    if afterPosition is not None:
        conn.execute('UPDATE examQuestions SET position = position + 1 WHERE examId = ? AND position > ?', (examId, afterPosition))
        nextPos = afterPosition + 1
    else:
        row = conn.execute('SELECT COALESCE(MAX(position), 0) + 1 FROM examQuestions WHERE examId = ?', (examId,)).fetchone()
        nextPos = row[0]
    cur = conn.execute('INSERT INTO examQuestions (examId, position, stem, options, correctIndex, rationale, origin) VALUES (?, ?, ?, ?, ?, ?, ?)', (examId, nextPos, q['stem'], json.dumps(q['options']), q['correct_index'], q['rationale'], f'user-requested: {requestText}' if requestText else 'user-requested'))
    questionId = cur.lastrowid
    conn.commit()
    newQ = examService.strip_answer({'id': questionId, 'exam_id': examId, 'position': nextPos, 'stem': q['stem'], 'options': q['options']})
    return {'position': nextPos, 'question_id': questionId, 'question': newQ}

@router.get('/{exam_id}/question/{position}')
async def getQuestion(examId: int, position: int):
    """Fetch one question. NEVER leaks correct_index or rationale (the authoring invariant)."""
    conn = _db()
    q = conn.execute('SELECT id, stem, options FROM examQuestions WHERE examId = ? AND position = ?', (examId, position)).fetchone()
    if not q:
        raise HTTPException(status_code=404, detail='Question not found')
    return examService.strip_answer({'id': q['id'], 'examId': examId, 'position': position, 'stem': q['stem'], 'options': json.loads(q['options'])})

@router.post('/{exam_id}/answer')
async def answerQuestion(examId: int, body: dict[str, object]):
    """Record an answer for a question. Returns correctness + rationale."""
    questionId = body.get('question_id')
    selectedIndex = body.get('selected_index')
    conn = _db()
    q = conn.execute('SELECT correctIndex, rationale FROM examQuestions WHERE id = ? AND examId = ?', (questionId, examId)).fetchone()
    if not q:
        raise HTTPException(status_code=404, detail='Question not found')
    isCorrect = 1 if selectedIndex == q['correctIndex'] else 0
    conn.execute("INSERT INTO examAttempts (examId, questionId, selectedIndex, isCorrect, answeredAt) VALUES (?, ?, ?, ?, datetime('now'))", (examId, questionId, selectedIndex, isCorrect))
    conn.commit()
    return {'is_correct': bool(isCorrect), 'correct_index': q['correct_index'], 'rationale': q['rationale']}

@router.post('/{exam_id}/help')
async def helpQuestion(examId: int, body: dict[str, object]):
    """Explain a question via Prefrontal without revealing the answer in the banner state."""
    questionId = body.get('question_id')
    ask = body.get('ask', '')
    conn = _db()
    q = conn.execute('SELECT stem, options FROM examQuestions WHERE id = ? AND examId = ?', (questionId, examId)).fetchone()
    if not q:
        raise HTTPException(status_code=404, detail='Question not found')
    options = json.loads(q['options'])
    explanation = await examService.help_explanation(stem=q['stem'], options=options, user_question=ask or 'Explain this question.')
    try:
        conn.execute('UPDATE examAttempts SET askedForHelp = 1 WHERE questionId = ?', (questionId,))
        conn.commit()
    except Exception:
        pass
    return {'explanation': explanation, 'banner_dismissed': False}