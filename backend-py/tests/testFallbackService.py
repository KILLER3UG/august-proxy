"""Fallback service tests (isolated data dir)."""
import pytest
from app.services import fallbackService

def testGetDefaultShape(isolatedData):
    fb = fallbackService.getFallback()
    assert 'enabled' in fb and 'mode' in fb and ('provider' in fb) and ('model' in fb)

def testConfigurePartial(isolatedData):
    fb = fallbackService.configureFallback(mode='session_only', actor='test')
    assert fb['mode'] == 'session_only'
    assert 'enabled' in fb

def testInvalidModeRejected(isolatedData):
    with pytest.raises(ValueError):
        fallbackService.configureFallback(mode='bogus', actor='test')

def testActiveFallbackValidatesProvider(isolatedData):
    with pytest.raises(ValueError):
        fallbackService.configureFallback(enabled=True, mode='always', provider='ZZZ_NoProvider', model='m', actor='test')

def testTestFallbackResolves(isolatedData):
    result = fallbackService.test_fallback('claude-sonnet-4-7')
    assert 'ok' in result