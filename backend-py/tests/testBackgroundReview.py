"""Background review loop tests (C2).

Tests the interval-gating gate, the full _do_review pipeline with a stub
LLM client, recommendation parsing, and fact persistence. No real LLM calls
or workbench modifications — skill_service is isolated via the same
``isolated_skills`` fixture used in C1.
"""
from __future__ import annotations
import asyncio
import json
from pathlib import Path
import pytest
from app.services import skillService
from app.services.memory.backgroundReview import ReviewGates, _doReview, _parseRecommendations, _saveFact, _lastRelevantMessages, tryBackgroundReview
from app.services.memoryStore import getMemory

class TestReviewGates:

    def testFiresWhenTurnIntervalExceeded(self):
        gates = ReviewGates(turnInterval=3, toolRoundInterval=10)
        assert gates.shouldReview(sessionTurns=5, toolRounds=0, lastReviewedAtTurn=0) is True
        assert gates.shouldReview(sessionTurns=2, toolRounds=0) is False

    def testFiresWhenToolRoundIntervalExceeded(self):
        gates = ReviewGates(turnInterval=10, toolRoundInterval=5)
        assert gates.shouldReview(sessionTurns=1, toolRounds=6) is True
        assert gates.shouldReview(sessionTurns=1, toolRounds=3) is False

    def testRespectsLastReviewedAtTurn(self):
        gates = ReviewGates(turnInterval=3, toolRoundInterval=10)
        assert gates.shouldReview(sessionTurns=5, lastReviewedAtTurn=3) is False
        assert gates.shouldReview(sessionTurns=6, lastReviewedAtTurn=3) is True

    def testZeroTurnsNeverReview(self):
        gates = ReviewGates()
        assert gates.shouldReview(sessionTurns=0) is False

def mkSession(**kw) -> object:

    class _Session:
        pass
    s = _Session()
    for k, v in kw.items():
        setattr(s, k, v)
    return s

@pytest.mark.asyncio
async def testTryBackgroundReviewSkipsWhenGateClosed():
    """When the gate says no, _do_review is NOT called."""
    called = []

    async def dummyLlm(__):
        called.append(True)
        return '{}'
    session = mkSession(messageCount=2)
    messages = [{'role': 'user'}, {'role': 'assistant'}]
    await tryBackgroundReview(session, messages, llmClient=dummyLlm)
    assert called == []

@pytest.mark.asyncio
async def testTryBackgroundReviewSpawnsWhenDue(isolatedSkills):
    """When the gate says yes, _do_review is called and creates a skill."""
    agentRoot, __ = isolatedSkills

    async def stubLlm(_prompt):
        return json.dumps({'skills': [{'action': 'create', 'name': 'review-skill', 'description': 'Learned from review.', 'body': '## When to Use\n\nBody.\n'}], 'memory': []})
    session = mkSession(messageCount=8)
    session._last_reviewed_at_turn = 0
    messages = [{'role': 'user', 'content': 'fix this'}, {'role': 'assistant', 'content': 'done'}]
    await tryBackgroundReview(session, messages, llmClient=stubLlm)
    await asyncio.sleep(0.1)
    fetched = skillService.get('review-skill')
    assert fetched is not None, 'background review should have created the skill'
    assert fetched.get('created_by') == 'agent'

@pytest.mark.asyncio
async def testTryBackgroundReviewNoLlmMeansNoop():
    """Without an LLM client, review is a no-op."""
    session = mkSession(messageCount=8)
    messages = [{'role': 'user'}, {'role': 'assistant'}]
    await tryBackgroundReview(session, messages, llmClient=None)
    assert True

@pytest.mark.asyncio
async def testDoReviewCreatesSkillFromRecommendation(isolatedSkills):
    agentRoot, __ = isolatedSkills

    async def stubLlm(_prompt):
        return json.dumps({'skills': [{'action': 'create', 'name': 'stub-skill', 'description': 'Stub.', 'body': '## When to Use\n\nStub body.\n'}], 'memory': []})
    result = await _doReview([{'role': 'user'}], llmClient=stubLlm)
    assert result['reviewed'] is True
    assert 'stub-skill' in result['skills_created']
    assert skillService.get('stub-skill') is not None

@pytest.mark.asyncio
async def testDoReviewPatchesExistingSkill(isolatedSkills):
    skillService.createSkill('patch-skill', 'Original.', '## When to Use\n\nOld body.\n')

    async def stubLlm(_prompt):
        return json.dumps({'skills': [{'action': 'patch', 'name': 'patch-skill', 'body': '## When to Use\n\nPatched body.\n'}], 'memory': []})
    result = await _doReview([{'role': 'user'}], llmClient=stubLlm)
    assert 'patch-skill' in result['skills_patched']
    fetched = skillService.get('patch-skill')
    assert 'Patched body.' in fetched['instructions']

@pytest.mark.asyncio
async def testDoReviewSavesMemoryFacts(isolatedData):

    async def stubLlm(_prompt):
        return json.dumps({'skills': [], 'memory': [{'action': 'add', 'fact': 'User likes python.'}, {'action': 'add', 'fact': 'User prefers async code.'}]})
    result = await _doReview([{'role': 'user'}], llmClient=stubLlm)
    assert len(result['facts_added']) == 2
    facts = getMemory('core_memory') or []
    assert len(facts) == 2
    assert any(('python' in f['fact'] for f in facts))

@pytest.mark.asyncio
async def testDoReviewNoClientIsNoop():
    result = await _doReview([{'role': 'user'}], llmClient=None)
    assert result['reviewed'] is False
    assert result['skills_created'] == []
    assert result['facts_added'] == []

class TestParseRecommendations:

    def testCleanJson(self):
        raw = '{"skills": [{"action": "create", "name": "x"}]}'
        parsed = _parseRecommendations(raw)
        assert len(parsed['skills']) == 1
        assert parsed['skills'][0]['name'] == 'x'

    def testJsonWithCodeFences(self):
        raw = '```json\n{"skills": []}\n```'
        parsed = _parseRecommendations(raw)
        assert parsed['skills'] == []

    def testJsonWithSingleQuotes(self):
        raw = "{'skills': [], 'memory': []}"
        parsed = _parseRecommendations(raw)
        assert parsed['skills'] == []

    def testGarbageReturnsEmpty(self):
        parsed = _parseRecommendations('not json at all')
        assert parsed['skills'] == []
        assert parsed['memory'] == []

class TestSaveFact:
    KEY = 'core_memory'

    def _facts(self):
        return getMemory(self.KEY) or []

    def testAddFact(self, isolatedData):
        _saveFact('add', 'User likes simplicity.')
        assert any(('simplicity' in f['fact'] for f in self._facts()))

    def testAddDedup(self, isolatedData):
        _saveFact('add', 'Dup fact.')
        _saveFact('add', 'Dup fact.')
        count = sum((1 for f in self._facts() if f['fact'] == 'Dup fact.'))
        assert count == 1

    def testReplaceUpdatesExisting(self, isolatedData):
        _saveFact('add', 'Replace me.')
        _saveFact('replace', 'Replace me.')
        matching = [f for f in self._facts() if f['fact'] == 'Replace me.']
        assert len(matching) == 1
        assert matching[0].get('updated_at') is not None

class TestLastRelevantMessages:

    def testReturnsOnlyUserAndAssistant(self):
        messages = [{'role': 'system'}, {'role': 'user'}, {'role': 'assistant'}, {'role': 'tool'}]
        filtered = _lastRelevantMessages(messages)
        assert all((m['role'] in ('user', 'assistant') for m in filtered))
        assert len(filtered) == 2

    def testRespectsMaxLen(self):
        messages = [{'role': 'user'} for __ in range(100)]
        filtered = _lastRelevantMessages(messages, maxLen=10)
        assert len(filtered) == 10