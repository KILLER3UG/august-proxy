"""v1.1 — Test that brain_query returns correct shape for all 12 stores."""
import pytest
import json
from app.services.memoryStore import brainQuery
ALL_STORES = ['memory', 'auto_memories', 'heuristics', 'facts', 'sessions', 'messages', 'timeline', 'graph', 'blackboard', 'daemons', 'exams', 'exam_attempts']

@pytest.mark.parametrize('store_name', ALL_STORES)
def testStoreReturnsListOrNotAvailable(storeName):
    """Each store returns a list of rows, or a structured 'not available' dict."""
    result = brainQuery(store=storeName, query='', limit=5)
    assert isinstance(result, str)
    parsed = json.loads(result)
    assert isinstance(parsed, (list, dict)), f'{storeName}: unexpected type {type(parsed)}'
    if isinstance(parsed, dict):
        assert 'error' in parsed
        assert 'available' in parsed

def testUnknownStoreReturnsNotAvailable():
    """Unknown stores return a structured not-available response, not an exception."""
    result = brainQuery(store='not_a_real_store', limit=5)
    parsed = json.loads(result)
    assert isinstance(parsed, dict)
    assert 'error' in parsed

def testGraphStoreHandlesMissingFile():
    """graph store returns empty list when JSON file is missing (graceful degrade)."""
    result = brainQuery(store='graph', query='anything', limit=5)
    parsed = json.loads(result)
    assert isinstance(parsed, list)

def testDaemonsStoreHandlesNoDaemons():
    """daemons store returns empty list when no daemons are running."""
    result = brainQuery(store='daemons', query='', limit=5)
    parsed = json.loads(result)
    assert isinstance(parsed, list)

def testExamsStoreResponds():
    """exams store returns a list (possibly empty)."""
    result = brainQuery(store='exams', query='', limit=5)
    parsed = json.loads(result)
    assert isinstance(parsed, list)

def testExamAttemptsStoreResponds():
    """exam_attempts store returns a list (possibly empty)."""
    result = brainQuery(store='exam_attempts', query='', limit=5)
    parsed = json.loads(result)
    assert isinstance(parsed, list)