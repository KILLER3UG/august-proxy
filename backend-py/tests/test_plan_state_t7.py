"""T7 (plan §9.4) — plan/todo state re-injection.

State lives on the session, outside the transcript, so compaction cannot
destroy it. Pre-turn it rides the system prompt's <session> block (pre-turn
defer); mid-turn the system text was built at turn start, so state-changing
tool receipts re-inject the compact block, and a compacted transcript gets
it back via ``_injectPlanState`` (mid-turn re-inject above the tail).
Q15 ruling: always inject.
"""

from __future__ import annotations

import pytest
from app.services.workbench import workbench as wb


@pytest.fixture()
def session():
    return wb.createWorkbenchSession(provider='anthropic')


class TestPlanStateBlock:
    def testEmptyWhenNoState(self, session):
        assert wb._planStateBlock(session) == ''

    def testGoalLineIsCollapsedAndCapped(self, session):
        session.goal = '  Ship   the feature  '
        block = wb._planStateBlock(session)
        assert block.startswith('<plan_state>')
        assert block.endswith('</plan_state>')
        assert 'goal: Ship the feature' in block

    def testMarkdownPlanShowsStatusTitleAndPath(self, session):
        session.plan = {'markdown': '# Refactor auth\n\n- step one\n', 'planPath': '.aug/plans/x.md'}
        session.planApproved = True
        block = wb._planStateBlock(session)
        assert 'plan: approved — Refactor auth (.aug/plans/x.md)' in block

    def testStepsPlanCountsDoneAndNamesCurrent(self, session):
        session.plan = {
            'steps': [
                {'text': 'explore', 'done': True},
                {'text': 'implement thing', 'status': 'pending'},
                {'text': 'test'},
            ]
        }
        block = wb._planStateBlock(session)
        assert 'plan: pending — 1/3 steps done, current: implement thing' in block

    def testExecutionStateLine(self, session):
        session._execution_state = {
            'phase': 'implement',
            'step': 3,
            'completed': ['a', 'b'],
            'blockers': [],
        }
        block = wb._planStateBlock(session)
        assert 'execution: phase=implement step=3 completed=2' in block
        assert 'blockers' not in block  # zero blockers is not reported

    def testTodosDoneCountAndNext(self, session):
        session.todos = [
            {'content': 'first', 'status': 'done'},
            {'content': 'second task', 'status': 'pending'},
            {'content': 'third'},
        ]
        block = wb._planStateBlock(session)
        assert 'todos: 1/3 done — next: second task' in block

    def testBlockStaysCompact(self, session):
        session.goal = 'g' * 5000
        session.todos = [{'content': 't' * 500, 'status': 'pending'}]
        session._execution_state = {'phase': 'implement', 'step': 1}
        block = wb._planStateBlock(session)
        # goal capped at 300 chars, todo text at 120 — the block must stay
        # in the ~50–150 token budget, not grow with the payload size.
        assert len(block) < 600


class TestInjectPlanState:
    def testNoStateLeavesMessagesUntouched(self, session):
        msgs = [{'role': 'user', 'content': 'hi'}]
        assert wb._injectPlanState(msgs, session) is msgs

    def testInsertsAfterSummaryMessage(self, session):
        from app.services.workbench.context_compressor import buildSummaryMessage

        session.goal = 'find the bug'
        summary = buildSummaryMessage([{'role': 'user', 'content': 'old'}], 'middle stuff')
        msgs = [
            {'role': 'user', 'content': 'start'},
            summary,
            {'role': 'assistant', 'content': 'working'},
            {'role': 'user', 'content': 'keep going'},
        ]
        out = wb._injectPlanState(msgs, session)
        assert len(out) == 5
        injected = out[2]
        assert injected['role'] == 'user'
        assert '<plan_state>' in str(injected['content'])
        assert 'find the bug' in str(injected['content'])
        # The original list is not mutated in place.
        assert len(msgs) == 4

    def testWithoutSummaryInsertsAboveLastUserMessage(self, session):
        session.todos = [{'content': 'wire tests', 'status': 'pending'}]
        msgs = [
            {'role': 'user', 'content': 'start'},
            {'role': 'assistant', 'content': 'ok'},
            {'role': 'user', 'content': 'latest ask'},
        ]
        out = wb._injectPlanState(msgs, session)
        assert len(out) == 4
        assert '<plan_state>' in str(out[2]['content'])
        assert out[3]['content'] == 'latest ask'

    def testWithoutUserMessageAppendsAtEnd(self, session):
        session.goal = 'orient me'
        msgs = [{'role': 'assistant', 'content': 'hm'}]
        out = wb._injectPlanState(msgs, session)
        assert len(out) == 2
        assert '<plan_state>' in str(out[1]['content'])
