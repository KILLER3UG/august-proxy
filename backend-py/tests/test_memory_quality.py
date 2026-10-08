"""The memory write bar, and the distiller door that applies it.

Both reference harnesses refuse the same categories outright — Claude Code
skips "anything it can derive from the codebase" and anything its instruction
files already say; Hermes lists "trivial/obvious info, easily re-discovered
facts, raw data dumps, task progress, completed-work logs, temporary TODO
state" and treats "Nothing to save." as the expected answer. August's distiller
wrote a fact whenever the judge said `action: memory`, gated by nothing but
"not empty" and the sensitive-topic denylist — and wrote it with no human in the
loop at all, which its skill doors require.

The bar is hard-deny only: each branch here is a category a reference names, not
a quality score. A false reject loses one lesson; a false accept is paid back on
every future turn's recall.
"""

from __future__ import annotations

import pytest
from app.services.memory_quality import (
    DEDUPE_SIMILARITY,
    duplicateOf,
    memoryIsJunk,
)


@pytest.fixture
def brain(isolatedData):
    from app.services.memory_store import init

    init()
    return isolatedData


class TestJunkCategories:
    @pytest.mark.parametrize(
        ('text', 'why'),
        [
            ('use pnpm', 'short'),
            ('Should I use pnpm or npm?', 'question'),
            ('On 2026-10-05 the build broke, so pin the resolver', 'incident'),
            ('Fix #1234 needs the flat flag', 'incident'),
            ('QUA-42 is blocked on the flag', 'incident'),
            ('The user said “just restart it” and that worked', 'quoted'),
            ('In this session the port is 8085', 'ephemeral'),
            ('TODO: wire the fleet roles', 'ephemeral'),
            ('I just fixed the composer label bug', 'ephemeral'),
            ('Backend listens on port=8085 for now', 'ephemeral'),
            ('The dev server runs v1.2.3 from /tmp/build', 'runtime'),
            ('package.json defines the build script', 'derivable'),
            ('The repo contains a Makefile for linting', 'derivable'),
        ],
    )
    def test_each_refused_category_is_named(self, text: str, why: str):
        reason = memoryIsJunk(text)
        assert reason, f'{text!r} should be refused'
        assert reason != '', reason

    def test_the_checks_are_not_just_a_length_test(self):
        # Same length, different category — proves each regex fires on its own.
        assert memoryIsJunk('Does the flow need the flat flag?') == 'a question is not a memory'
        assert 'incident' in memoryIsJunk('Pin the resolver as of 2026-10-05 today-ish')
        assert memoryIsJunk('The README lists the supported browsers here') == (
            'restates what the project already documents'
        )

    @pytest.mark.parametrize(
        'text',
        [
            'Run the flow with --flat=on, because the default mode re-resolves every artifact.',
            'Quartus fmax must be read from the .rpt file, not stdout, which truncates it.',
            'Prefer pnpm over npm here: the lockfile is pnpm-format and npm rewrites it.',
            'A sandboxed run_command cannot reach the local API; pass the path instead.',
        ],
    )
    def test_a_durable_lesson_with_a_reason_passes(self, text: str):
        assert memoryIsJunk(text) == '', memoryIsJunk(text)


class TestDedupeAtTheSharedThreshold:
    def test_a_restatement_of_an_existing_fact_is_a_duplicate(self, brain):
        from app.services import memory_store

        memory_store.save_fact(
            'x:flat',
            'Run the flow with --flat=on because the default re-resolves every artifact',
            kind='lesson',
            source='model',
        )
        ratio, key = duplicateOf(
            'Run the flow with --flat=on because the default re-resolves every artifact'
        )
        assert ratio >= DEDUPE_SIMILARITY
        assert key == 'x:flat'

    def test_an_unrelated_lesson_is_not_a_duplicate(self, brain):
        from app.services import memory_store

        memory_store.save_fact('x:flat', 'Use --flat=on for the flow', kind='lesson')
        ratio, _key = duplicateOf('Quartus fmax comes from the .rpt file, never stdout')
        assert ratio < DEDUPE_SIMILARITY

    def test_a_dedupe_that_cannot_run_does_not_eat_the_lesson(self, brain, monkeypatch):
        """The bar is about content. Losing a real memory because the index blew
        up would make the guard worse than the thing it guards."""
        from app.services.memory_store import fact_retrieval

        def boom(*a, **k):
            raise RuntimeError('index unavailable')

        monkeypatch.setattr(fact_retrieval, 'find_similar_facts', boom)
        assert duplicateOf('Anything durable at all, with a reason attached') == (0.0, '')


class TestDistillerMemoryDoor:
    """The door itself: a judge verdict with `action: memory` writes straight
    into the store, so this is where the bar has to live."""

    GOOD = (
        'Read Quartus fmax from the .sdc.rpt file, because stdout truncates the '
        'worst slack path.'
    )

    def _label(self, summary: str) -> str:
        from app.services import skill_distiller as sd

        return sd.apply_verdict(
            {'episode': 3, 'action': 'memory', 'summary': summary},
            'user-correction:bar',
        )

    def test_a_durable_lesson_is_saved(self, brain):
        from app.services.memory_store import get_fact

        assert self._label(self.GOOD) == 'memory-saved'
        # The key is the slugified statement, truncated at 48 chars — pinned
        # exactly, because a drifting key would silently defeat the dedupe.
        assert get_fact('distilled:read-quartus-fmax-from-the-sdc-rpt-file-because-') is not None

    def test_task_state_is_dropped_and_recorded(self, brain):
        from app.services.memory_conn import conn
        from app.services.memory_store import list_facts

        assert self._label('In this session the deploy is still in progress') == (
            'dropped-not-durable'
        )
        assert list_facts() == []
        rows = [
            dict(r)
            for r in conn().execute(
                "SELECT detail FROM lifecycle WHERE event_type = 'distiller_memory_dropped'"
            )
        ]
        assert len(rows) == 1, 'a silent drop is indistinguishable from a loop that never ran'
        assert 'task state' in rows[0]['detail'].lower()

    def test_a_second_hand_of_the_same_lesson_does_not_double_the_store(self, brain):
        from app.services.memory_store import list_facts

        assert self._label(self.GOOD) == 'memory-saved'
        assert self._label(self.GOOD) == 'dropped-duplicate'
        assert len(list_facts()) == 1

    def test_a_downgraded_skill_draft_still_reaches_memory(self, brain):
        """`_asLessonVerdict` re-aims a too-thin skill at this door. The bar must
        not eat the content the skill gate refused, or the downgrade is a delete."""
        from app.services import skill_distiller as sd
        from app.services.memory_store import get_fact

        label = sd.apply_verdict(
            {
                'episode': 9,
                'action': 'create_skill',
                'name': 'flat-flag',
                'description': 'Always pass --flat=on to the flow.',
                'body_markdown': '## How to Run\n\nRe-run with --flat=on.',
            },
            'tool-error:downgrade',
            mode='full',
        )
        assert label == 'memory-saved', label
        assert get_fact('distilled:flat-flag') is not None
