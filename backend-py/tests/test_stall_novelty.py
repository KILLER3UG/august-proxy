"""Stall-nudge novelty exemption (Part 28 review, item 9).

The phase/step stall signature punished deep investigation exactly as hard
as real spinning: many read_file/search_files calls on *different* files
never advance phase/step. ``_assistant_round_is_novel`` is the fix — new
tool-call signatures or emitted prose reset the counter; only repeated
identical calls keep counting.
"""

from __future__ import annotations

from app.services.workbench.workbench import _assistant_round_is_novel


def test_anthropic_new_tool_call_is_novel():
    seen: set[tuple[str, str]] = set()
    msgs = [{
        'role': 'assistant',
        'content': [{'type': 'tool_use', 'name': 'read_file', 'input': {'path': 'a.py'}}],
    }]
    assert _assistant_round_is_novel(msgs, seen) is True
    # The identical call repeated is no longer novel — genuine spinning.
    assert _assistant_round_is_novel(msgs, seen) is False


def test_anthropic_different_file_is_novel():
    seen: set[tuple[str, str]] = set()
    first = [{'role': 'assistant', 'content': [
        {'type': 'tool_use', 'name': 'read_file', 'input': {'path': 'a.py'}},
    ]}]
    second = [{'role': 'assistant', 'content': [
        {'type': 'tool_use', 'name': 'read_file', 'input': {'path': 'b.py'}},
    ]}]
    assert _assistant_round_is_novel(first, seen) is True
    assert _assistant_round_is_novel(second, seen) is True


def test_anthropic_prose_is_novel():
    seen: set[tuple[str, str]] = set()
    msgs = [{'role': 'assistant', 'content': [{'type': 'text', 'text': 'found the root cause'}]}]
    assert _assistant_round_is_novel(msgs, seen) is True


def test_openai_tool_calls_novelty():
    seen: set[tuple[str, str]] = set()
    msgs = [{'role': 'assistant', 'content': '', 'tool_calls': [
        {'function': {'name': 'search_files', 'arguments': '{"query": "x"}'}},
    ]}]
    assert _assistant_round_is_novel(msgs, seen) is True
    assert _assistant_round_is_novel(msgs, seen) is False


def test_openai_text_content_is_novel():
    seen: set[tuple[str, str]] = set()
    msgs = [{'role': 'assistant', 'content': 'thinking out loud', 'tool_calls': []}]
    assert _assistant_round_is_novel(msgs, seen) is True


def test_no_assistant_message_is_not_novel():
    assert _assistant_round_is_novel([], set()) is False
    assert _assistant_round_is_novel([{'role': 'user', 'content': 'hi'}], set()) is False


def test_malformed_arguments_do_not_crash():
    seen: set[tuple[str, str]] = set()
    msgs = [{'role': 'assistant', 'content': '', 'tool_calls': [
        {'function': {'name': 'run_command', 'arguments': 'not-json{'}},
    ]}]
    assert _assistant_round_is_novel(msgs, seen) is True


def _anthropicCall(name: str, args: dict[str, object]):
    return {
        'role': 'assistant',
        'content': [{'type': 'tool_use', 'id': 't1', 'name': name, 'input': args}],
    }


class TestCanonicalIdentity:
    """Key order is a transport accident, not a new idea."""

    def test_reordered_arguments_are_the_same_action(self):
        seen: set[tuple[str, str]] = set()
        first = _anthropicCall('run_command', {'command': 'pytest -q', 'timeout': 30})
        second = _anthropicCall('run_command', {'timeout': 30, 'command': 'pytest -q'})
        assert _assistant_round_is_novel([first], seen) is True
        assert _assistant_round_is_novel([second], seen) is False

    def test_a_different_secondary_argument_is_new_work(self):
        seen: set[tuple[str, str]] = set()
        a = _anthropicCall('edit_file', {'path': 'a.py', 'start': 1})
        b = _anthropicCall('edit_file', {'path': 'a.py', 'start': 2})
        assert _assistant_round_is_novel([a], seen) is True
        assert _assistant_round_is_novel([b], seen) is True


class TestPollingTargetGuard:
    """Full-argument novelty alone would call shifting offsets on one file
    progress forever; the target tally is what makes a polling loop a stall."""

    def _loop(self, offsets: int):
        seen: set[tuple[str, str]] = set()
        uses: dict[tuple[str, str], int] = {}
        outcomes = []
        for i in range(offsets):
            msg = _anthropicCall('read_file', {'path': 'big.log', 'start': i})
            outcomes.append(_assistant_round_is_novel([msg], seen, uses))
        return outcomes

    def test_same_target_with_changing_args_stops_counting_as_novel(self):
        outcomes = self._loop(9)
        assert outcomes[:6] == [True] * 6
        assert outcomes[6:] == [False] * 3

    def test_without_the_tally_the_loop_looks_productive(self):
        # The guard is opt-in by argument, so the subagent path keeps today's
        # behaviour until it passes a dict too.
        seen: set[tuple[str, str]] = set()
        for i in range(9):
            assert _assistant_round_is_novel(
                [_anthropicCall('read_file', {'path': 'big.log', 'start': i})], seen
            ) is True

    def test_different_targets_are_not_penalised(self):
        seen: set[tuple[str, str]] = set()
        uses: dict[tuple[str, str], int] = {}
        for i in range(9):
            assert _assistant_round_is_novel(
                [_anthropicCall('read_file', {'path': f'file{i}.py'})], seen, uses
            ) is True


class TestErrorFamilies:
    def test_classification_is_first_match_wins_and_case_insensitive(self):
        from app.services.workbench.workbench import _error_family

        assert _error_family('Command timed out after 30s') == 'timeout'
        assert _error_family('HTTP 429 Too Many Requests') == 'rate_limit'
        assert _error_family('Error: permission denied: /etc/x') == 'permission'
        assert _error_family('FileNotFoundError: no such file') == 'not_found'
        assert _error_family('all good, 42 tests passed') == ''

    def test_window_tally_counts_a_family_across_results(self):
        from app.services.workbench.workbench import _recent_error_families

        msgs = [
            {'role': 'tool', 'content': 'connection refused by host'},
            {'role': 'tool', 'content': 'ok'},
            {'role': 'tool', 'content': 'Connection reset by peer'},
            {'role': 'assistant', 'content': 'thinking'},
            {'role': 'tool', 'content': 'getaddrinfo failed'},
        ]
        assert _recent_error_families(msgs) == {'network': 3}

    def test_only_the_recent_window_counts(self):
        from app.services.workbench.workbench import (
            _ERROR_FAMILY_WINDOW,
            _recent_error_families,
        )

        msgs = [{'role': 'tool', 'content': 'timed out'}] + [
            {'role': 'tool', 'content': 'fine'} for _ in range(_ERROR_FAMILY_WINDOW)
        ]
        assert _recent_error_families(msgs) == {}

    def test_content_blocks_are_read_not_just_plain_strings(self):
        from app.services.workbench.workbench import _error_family, _toolResultText

        msg = {'role': 'tool', 'content': [{'type': 'text', 'text': 'invalid argument: path'}]}
        assert _error_family(_toolResultText(msg)) == 'invalid_argument'

    def test_every_advice_key_names_a_real_family(self):
        from app.services.workbench.workbench import (
            _ERROR_FAMILY_ADVICE,
            _ERROR_FAMILY_RULES,
        )

        assert set(_ERROR_FAMILY_ADVICE) == {f for f, _ in _ERROR_FAMILY_RULES}
