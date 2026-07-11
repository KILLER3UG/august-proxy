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
    with pytest.raises(ValueError):
        fallback_service.configureFallback(
            enabled=True, mode='always', provider='ZZZ_NoProvider', model='m', actor='test'
        )


def testTestFallbackResolves(isolatedData):
    result = fallback_service.testFallback('claude-sonnet-4-7')
    assert 'ok' in result
