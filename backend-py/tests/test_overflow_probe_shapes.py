"""The context-overflow probe must recognise the shapes gateways actually send.

Roadmap #5. ``_isContextOverflowError`` reduced the response to
``as_str(response.get('error'))``. Any gateway that nests the message — which
is most of them — collapsed to a string containing no marker, so the predicate
returned False, the reactive reduction never ran, and the turn died on a
context overflow having done nothing about it. The marker table was rich (ten
ways of saying the same thing) and the SHAPE it was matched against was one.

The second half of the item: the three compaction paths were not countable in
the stream. Only the pre-turn auto-compact emitted a `compaction` frame, so a
budget compaction and a reactive overflow reduction were indistinguishable from
each other and from the ladder's non-compaction rungs.
"""

from __future__ import annotations

import pytest
from app.services.workbench.loop.recovery import (
    _CONTEXT_OVERFLOW_MARKERS,
    _isContextOverflowError,
    _overflowProbeText,
)


class TestOverflowProbeShapes:
    @pytest.mark.parametrize(
        'label,envelope',
        [
            # The one shape the old probe handled.
            ('flat string', {'error': 'context length exceeded'}),
            # Nested — the most common, and the one that broke.
            ('nested message', {'error': {'message': 'prompt is too long'}}),
            ('nested code only', {'error': {'code': 'context_length_exceeded'}}),
            (
                'openai-style type+message',
                {'error': {'type': 'invalid_request_error', 'message': 'maximum context length is 8192 tokens'}},
            ),
            # No `error` key at all.
            ('bare code', {'code': 'context_length_exceeded'}),
            ('top-level message', {'message': 'this request exceeds the model context window'}),
            ('detail field', {'detail': 'input is too long'}),
            # Double-wrapped proxies.
            (
                'double wrapped',
                {'error': {'error': {'message': 'token limit reached for this model'}}},
            ),
            # Batch / aggregator shapes.
            ('error is a list', {'error': [{'message': 'context length exceeded'}]}),
        ],
    )
    def test_overflow_shapes_are_recognised(self, label, envelope):
        assert _isContextOverflowError(envelope), (
            f'{label}: the probe missed a real context overflow, so the reactive '
            'rescue would never have run'
        )

    @pytest.mark.parametrize(
        'label,envelope',
        [
            ('empty', {}),
            ('rate limit', {'error': {'message': 'rate limit reached, try again later'}}),
            ('auth', {'error': {'code': 'invalid_api_key'}}),
            ('not found', {'error': {'message': 'model does not exist'}}),
            ('bad request', {'message': 'missing required parameter: messages'}),
        ],
    )
    def test_other_failures_are_not_mistaken_for_overflow(self, label, envelope):
        """Broad matching must not turn every error into a compaction.

        The reduction is destructive — it drops the middle of the conversation —
        so a false positive silently loses context the turn still needed.
        """
        assert not _isContextOverflowError(envelope), (
            f'{label}: a non-overflow error was promoted to a context reduction'
        )

    def test_every_marker_is_reachable_in_a_nested_envelope(self):
        """No marker is dead weight behind a shape the probe cannot see."""
        for marker in _CONTEXT_OVERFLOW_MARKERS:
            assert _isContextOverflowError({'error': {'message': f'something {marker} happened'}}), (
                f'marker {marker!r} does not match a nested envelope'
            )


class TestProbeIsBounded:
    def test_deep_nesting_terminates(self):
        """A predicate must not become an unbounded traversal."""
        deep: object = {'error': {'message': 'context length exceeded'}}
        for _ in range(50):
            deep = {'error': deep}
        # Bounded, so it does not raise or hang; it simply stops early.
        assert isinstance(_overflowProbeText(deep), str)

    def test_wide_payload_is_bounded(self):
        wide = {f'k{i}': 'x' * 10 for i in range(1000)}
        assert isinstance(_overflowProbeText(wide), str)

    def test_matching_is_case_insensitive(self):
        assert _isContextOverflowError({'error': {'message': 'CONTEXT LENGTH EXCEEDED'}})

    def test_non_dict_inputs_do_not_raise(self):
        """The signature widened to `object`; every shape must be safe."""
        for value in (None, '', 0, 1, 1.5, True, [], {}, (), b'bytes'):
            assert _isContextOverflowError(value) in (True, False)


class TestCompactionEventsAreCountable:
    def test_the_helper_tags_the_trigger(self):
        from app.services.workbench.loop.events import _emitCompactionEvent

        out: list[dict] = []
        _emitCompactionEvent(
            out.append,
            trigger='reactive_overflow',
            originalTokens=1000,
            originalMessages=10,
            currentMessages=[{'role': 'user', 'content': 'x'}],
            contextWindow=200_000,
        )
        assert len(out) == 1
        ev = out[0]
        assert ev['type'] == 'compaction'
        assert ev['trigger'] == 'reactive_overflow'
        assert ev['originalTokens'] == 1000
        assert ev['contextWindow'] == 200_000
        # 10 messages in, 1 out.
        assert ev['compressedCount'] == 9

    def test_a_no_op_compaction_is_visible_as_one(self):
        """Ran-and-achieved-nothing is a different fact from never having run.

        The reactive path's own before/after comparison is internal, so without
        this frame the two states were indistinguishable to any stream reader.
        """
        from app.providers.clients.base import estimateTokens
        from app.services.workbench.loop.events import _emitCompactionEvent

        msgs = [{'role': 'user', 'content': 'x'}]
        # A genuine no-op: the same messages before and after, so the "before"
        # count is the real estimate rather than an invented number.
        realTokens = estimateTokens(msgs)
        out: list[dict] = []
        _emitCompactionEvent(
            out.append,
            trigger='reactive_overflow',
            originalTokens=realTokens,
            originalMessages=len(msgs),
            currentMessages=msgs,
            contextWindow=1000,
        )
        ev = out[0]
        assert ev['compressedCount'] == 0
        assert ev['originalTokens'] == ev['compressedTokens'] == realTokens

    def test_a_none_emit_is_a_no_op(self):
        from app.services.workbench.loop.events import _emitCompactionEvent

        _emitCompactionEvent(
            None,
            trigger='budget',
            originalTokens=1,
            originalMessages=2,
            currentMessages=[],
            contextWindow=1,
        )  # must not raise
