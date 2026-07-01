"""v3 — End-to-end test: Brain dashboard aggregation + /Exam full lifecycle."""
import json
from unittest.mock import patch
import pytest
VALID_EXAM = [{'stem': 'What is 2+2?', 'options': ['3', '4', '5', '6'], 'correct_index': 1, 'rationale': '2+2=4.'}, {'stem': 'Capital of France?', 'options': ['Berlin', 'Madrid', 'Paris', 'Rome'], 'correct_index': 2, 'rationale': 'Paris.'}]

@pytest.fixture(autouse=True)
def _initDb():
    from app.services.memoryStore import init
    init()
    yield

def testBrainDashboardAggregatesRealData():
    """Learning + health endpoints surface real data; mutation flow works end-to-end."""
    from fastapi.testclient import TestClient
    from app.main import app
    from app.services.heuristicsService import addHeuristic
    client = TestClient(app)
    learning = client.get('/api/brain/learning').json()
    assert 'heuristics' in learning
    assert 'auto_memories' in learning
    assert 'sleep_cycle' in learning
    assert 'delta_engine' in learning
    assert 'pending_skills' in learning
    health = client.get('/api/brain/health').json()
    flags = {p['flag'] for p in health['phases']}
    for f in ('heuristics', 'daemons', 'blackboard', 'verifier_reflex', 'skill_genesis'):
        assert f in flags, f'missing layer: {f}'
    h = addHeuristic('v3 e2e rule', source='v3-e2e')
    assert h is not None
    resp = client.patch(f'/api/brain/heuristics/{h}', json={'rule': 'v3 e2e updated'})
    assert resp.status_code == 200
    assert resp.json().get('updated') is True
    resp = client.delete(f'/api/brain/heuristics/{h}')
    assert resp.status_code == 200
    assert resp.json().get('deleted') is True

def testExamFullLifecycle():
    """Generate → fetch → answer → help — full /Exam flow with Prefrontal mocked."""
    from fastapi.testclient import TestClient
    from app.main import app
    from app.services.memoryStore import _conn
    client = TestClient(app)
    with patch('app.services.exam_service._call_prefrontal', return_value=json.dumps(VALID_EXAM)):
        gen = client.post('/api/exam/generate', json={'topic': 'math+geography', 'count': 2, 'difficulty': 'easy'})
    assert gen.status_code == 200
    body = gen.json()
    examId = body['exam_id']
    assert body['total_questions'] == 2
    assert 'correct_index' not in body['question']
    fetched = client.get(f'/api/exam/{examId}/question/1').json()
    assert 'correct_index' not in fetched
    assert 'rationale' not in fetched
    q1Id = fetched['id']
    ans = client.post(f'/api/exam/{examId}/answer', json={'question_id': q1Id, 'selected_index': 1})
    assert ans.status_code == 200
    ansBody = ans.json()
    assert ansBody['is_correct'] is True
    assert ansBody['correct_index'] == 1
    assert ansBody['rationale'] == '2+2=4.'
    with patch('app.services.exam_service._call_prefrontal', return_value='The concept is...'):
        helpResp = client.post(f'/api/exam/{examId}/help', json={'question_id': q1Id, 'ask': 'Explain addition'})
    assert helpResp.status_code == 200
    helpBody = helpResp.json()
    assert 'explanation' in helpBody
    assert 'is_correct' not in helpBody
    assert 'correct_index' not in helpBody
    assert helpBody['banner_dismissed'] is False
    attempts = _conn().execute('SELECT COUNT(*) FROM exam_attempts WHERE exam_id = ?', (examId,)).fetchone()[0]
    assert attempts == 1

def testAddQuestionAuthorsAndAppends():
    """User adds a custom question mid-exam; the model authors it."""
    from fastapi.testclient import TestClient
    from app.main import app
    client = TestClient(app)
    with patch('app.services.exam_service._call_prefrontal', return_value=json.dumps(VALID_EXAM)):
        gen = client.post('/api/exam/generate', json={'topic': 'x', 'count': 2, 'difficulty': 'easy'})
    examId = gen.json()['exam_id']
    extra = {'stem': 'Bonus', 'options': ['a', 'b', 'c', 'd'], 'correct_index': 0, 'rationale': 'r'}
    with patch('app.services.exam_service._call_prefrontal', return_value=json.dumps(extra)):
        resp = client.post(f'/api/exam/{examId}/questions', json={'request': 'ask about bonus'})
    assert resp.status_code == 200
    body = resp.json()
    assert body['position'] == 3
    assert body['question']['stem'] == 'Bonus'