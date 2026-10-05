import pytest
from app.services.workbench import providers as wp


class TestReviewClientFailureIsNotSilent:
    """`reviewLlm` returned '' for four different outcomes and logged nothing.

    Measured on a real install: the provider answered with an upstream error
    (credit), and every background review looked exactly like a model that had
    nothing to say. These tests pin that the causes are now distinguishable
    while the '' return contract every caller depends on is unchanged.
    """

    class _Resp:
        def __init__(self, body, is_error=False, status_code=None):
            self.body_json = body
            self.is_error = is_error
            self.status_code = status_code

    def _client(self, monkeypatch, resp=None, raises=None):
        class FakeClient:
            def resolveApiKey(self):
                return 'k'

            async def chat_completions(self, body):
                if raises is not None:
                    raise raises
                return resp

            async def close(self):
                pass

        monkeypatch.setattr('app.providers.resolver.resolve', lambda name='': {'name': 'p'})
        monkeypatch.setattr('app.providers.clients.getClient', lambda p: FakeClient())
        return wp.make_review_llm_client(None, 'reviewer-x')

    async def _call(self, fn):
        return await fn([{'role': 'user', 'content': 'hi'}])

    def test_an_upstream_error_is_logged_with_its_reason(self, monkeypatch):
        cap = []
        monkeypatch.setattr(
            wp.logger, 'warning', lambda msg, *a, **k: cap.append(str(msg % a if a else msg))
        )
        resp = self._Resp(
            {'error': {'type': 'server_error', 'message': 'Insufficient account funds'}},
            is_error=True,
        )
        fn = self._client(monkeypatch, resp=resp)
        assert pytest__run(self._call(fn)) == ''
        assert any('upstream error' in c for c in cap), cap
        assert any('Insufficient account funds' in c for c in cap), cap

    def test_a_body_without_choices_says_so_including_its_keys(self, monkeypatch):
        cap = []
        monkeypatch.setattr(
            wp.logger, 'warning', lambda msg, *a, **k: cap.append(str(msg % a if a else msg))
        )
        resp = self._Resp({'content': [{'type': 'text', 'text': 'hello'}]})
        fn = self._client(monkeypatch, resp=resp)
        assert pytest__run(self._call(fn)) == ''
        assert any('no choices' in c for c in cap), cap
        assert any('content' in c for c in cap), cap

    def test_an_exception_is_no_longer_swallowed_silently(self, monkeypatch):
        cap = []
        monkeypatch.setattr(
            wp.logger, 'warning', lambda msg, *a, **k: cap.append(str(msg % a if a else msg))
        )
        fn = self._client(monkeypatch, raises=RuntimeError('socket closed'))
        assert pytest__run(self._call(fn)) == ''
        assert any('call failed' in c and 'RuntimeError' in c for c in cap), cap

    def test_a_real_answer_still_logs_nothing(self, monkeypatch):
        cap = []
        monkeypatch.setattr(
            wp.logger, 'warning', lambda msg, *a, **k: cap.append(str(msg % a if a else msg))
        )
        resp = self._Resp({'choices': [{'message': {'content': 'KEEP'}}]})
        fn = self._client(monkeypatch, resp=resp)
        assert pytest__run(self._call(fn)) == 'KEEP'
        assert cap == [], cap


def pytest__run(coro):
    import asyncio

    return asyncio.run(coro)
