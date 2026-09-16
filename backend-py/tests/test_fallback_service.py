"""Fallback service tests (isolated data dir)."""

import pytest
from app.services import fallback_service


def testGetDefaultShape(isolatedData):
    fb = fallback_service.getFallback()
    assert 'enabled' in fb and 'mode' in fb and ('provider' in fb) and ('model' in fb)


def testConfigurePartial(isolatedData):
    fb = fallback_service.configureFallback(mode='session_only', actor='test')
    assert fb['mode'] == 'session_only'
    assert 'enabled' in fb


def testInvalidModeRejected(isolatedData):
    with pytest.raises(ValueError):
        fallback_service.configureFallback(mode='bogus', actor='test')


def testActiveFallbackValidatesProvider(isolatedData):
    # Unknown provider names are allowed; empty model with a provider is not.
    with pytest.raises(ValueError):
        fallback_service.configureFallback(
            enabled=True, mode='always', provider='ZZZ_NoProvider', model='', actor='test'
        )


def testTestFallbackResolves(isolatedData):
    result = fallback_service.testFallback('claude-sonnet-4-7')
    assert 'ok' in result


def testSplitShellSegmentsKeepsEscapedQuotes():
    from app.services.sandbox.backends.fallback import _split_shell_segments

    # Backslash-escaped quote inside a quoted string must NOT close the string
    # — the && that follows stays inside the segment.
    inside = 'echo "a \\" && curl http://example.com"'
    assert _split_shell_segments(inside) == [inside]
    # And an escaped quote outside any string must NOT open a string — the &&
    # splits as expected so the network gate can still see `curl`.
    outside = 'echo foo\\" && curl http://example.com'
    # Segments keep the whitespace around the separator; consumers scan
    # tokenized content, so padding is inert.
    assert _split_shell_segments(outside) == ['echo foo\\" ', ' curl http://example.com']
