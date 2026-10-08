"""The SSRF guard must decide the address that gets dialled, not just a verdict.

The guard used to return a bool. It called `getaddrinfo` to decide, and then
httpx called `getaddrinfo` AGAIN to connect — so a hostile authoritative DNS
server could answer public for the check and `169.254.169.254` for the
connect. The address that was vetted was never the address that was dialled.

`_vetted_public_ips` now RETURNS the addresses, and the request is built
against one of them, which is the only way to close that window. These tests
pin the mechanism, including the case that a bool-only guard cannot express.
"""

from __future__ import annotations

import socket

import pytest
from app.services.tool_registrations.web_tools import _is_private_url, _pinned_request, _vetted_public_ips


class TestPrivateAddressesAreRefused:
    @pytest.mark.parametrize(
        'url',
        [
            'http://127.0.0.1:19387/api/providers',
            'http://localhost:8000/',
            'http://169.254.169.254/latest/meta-data/',
            'http://10.0.0.5/internal',
            'http://192.168.1.1/',
            'http://[::1]/',
            'http://0.0.0.0/',
        ],
    )
    def test_refused(self, url: str):
        assert _vetted_public_ips(url) is None
        assert _is_private_url(url) is True

    def test_a_malformed_url_is_refused(self):
        assert _vetted_public_ips('not-a-url') is None
        assert _vetted_public_ips('http://') is None


class TestPublicAddressesAreVetted:
    def test_a_literal_public_ip_is_returned_as_its_own_vetted_address(self):
        assert _vetted_public_ips('http://93.184.216.34/x') == ('93.184.216.34', ['93.184.216.34'])

    def test_a_resolving_host_returns_every_address(self, monkeypatch):
        def fake_gai(host, port, *a, **kw):
            return [
                (socket.AF_INET, socket.SOCK_STREAM, 6, '', ('93.184.216.34', 0)),
                (socket.AF_INET, socket.SOCK_STREAM, 6, '', ('93.184.216.35', 0)),
            ]

        monkeypatch.setattr(socket, 'getaddrinfo', fake_gai)
        assert _vetted_public_ips('https://example.com/') == (
            'example.com',
            ['93.184.216.34', '93.184.216.35'],
        )

    def test_one_private_answer_poisons_the_whole_name(self, monkeypatch):
        """A split-horizon name must not be usable.

        Refusing outright is the point: choosing the public answer and hoping
        is how this bypass comes back, because the resolver is exactly the
        untrusted party in this threat model.
        """
        def fake_gai(host, port, *a, **kw):
            return [
                (socket.AF_INET, socket.SOCK_STREAM, 6, '', ('93.184.216.34', 0)),
                (socket.AF_INET, socket.SOCK_STREAM, 6, '', ('169.254.169.254', 0)),
            ]

        monkeypatch.setattr(socket, 'getaddrinfo', fake_gai)
        assert _vetted_public_ips('https://rebind.example/') is None

    def test_unresolvable_is_refused(self, monkeypatch):
        def boom(*a, **kw):
            raise socket.gaierror('nope')

        monkeypatch.setattr(socket, 'getaddrinfo', boom)
        assert _vetted_public_ips('https://does-not-exist.invalid/') is None


class TestTheRequestIsPinnedToTheVettedAddress:
    """The regression this whole change exists for."""

    def test_the_dialed_host_is_the_vetted_ip_not_the_name(self):
        target, headers, ext = _pinned_request(
            'https://example.com/page', 'example.com', ['93.184.216.34'], {'Accept': 'text/html'}
        )
        # The NAME must not be in the connect target, or httpx re-resolves it
        # and the guard's answer is thrown away.
        assert '93.184.216.34' in target
        assert 'example.com' not in target
        # ...but the identity of the host is restored where the server needs it.
        assert headers['Host'] == 'example.com'
        assert headers['Accept'] == 'text/html'
        # ...and TLS must still verify the certificate for the real name.
        assert ext == {'sni_hostname': 'example.com'}

    def test_http_gets_the_host_header_but_no_sni(self):
        target, headers, ext = _pinned_request('http://example.com/', 'example.com', ['93.184.216.34'], {})
        assert '93.184.216.34' in target
        assert headers['Host'] == 'example.com'
        # SNI is a TLS concept; sending it on a plain request is meaningless.
        assert ext == {}

    def test_a_literal_ip_url_is_left_alone(self):
        target, headers, ext = _pinned_request('http://93.184.216.34/x', '93.184.216.34', ['93.184.216.34'], {})
        assert target == 'http://93.184.216.34/x'
        assert 'Host' not in headers
        assert ext == {}

    def test_the_port_is_preserved(self):
        target, _, _ = _pinned_request('https://example.com:8443/a', 'example.com', ['93.184.216.34'], {})
        assert '8443' in target

    def test_the_path_and_query_are_preserved(self):
        target, _, _ = _pinned_request('https://example.com/a/b?q=1&r=2', 'example.com', ['93.184.216.34'], {})
        assert '/a/b' in target
        assert 'q=1' in target


class TestFetchProvenance:
    """SSRF answers "may this address be dialed"; provenance answers "did the
    conversation contain this URL". A page can plant a link to a look-alike host
    and the model will fetch it as research, and a model can guess a plausible
    docs URL and quote the error page back — neither is blocked by the address
    guard, and until now nothing told the model (or a reviewer) which happened.
    """

    @pytest.fixture(autouse=True)
    def _cleanState(self, isolatedData):
        from app.services.memory_store import init
        from app.services.tool_registrations import web_tools
        from app.services.workbench.context import currentSessionId

        init()
        from app.services.memory_conn import conn

        conn().execute(
            "INSERT OR IGNORE INTO sessions (id, title) VALUES ('prov-session', 't')"
        )
        conn().commit()
        web_tools._searchSuppliedUrls.clear()
        currentSessionId.set('prov-session')
        yield
        # A leaked currentSessionId re-keys memory scope resolution for later
        # files — the same trap several prompt tests reset for.
        currentSessionId.set('')
        web_tools._searchSuppliedUrls.clear()

    def test_the_comparison_ignores_fragment_trailing_slash_and_host_case(self):
        from app.services.tool_registrations.web_tools import _normUrl, _urlProvenance

        self._seedUserMessage('read https://Docs.Example.com/Setup#section-2 please')
        assert _normUrl('https://docs.example.com/Setup#section-2') == _normUrl(
            'HTTPS://DOCS.EXAMPLE.COM/Setup/'
        )
        # Same path, different decoration: still the URL the user supplied.
        assert _urlProvenance('https://docs.example.com/Setup#cmp=1') == 'user'
        # Path CASE is deliberately NOT normalized — /setup is a different
        # resource on every host that cares about case, and calling it the
        # user's URL would be a false "seen".
        assert _urlProvenance('https://docs.example.com/setup') == 'unseen'

    def test_a_url_the_user_pasted_is_reported_as_user_supplied(self):
        from app.services.tool_registrations.web_tools import _urlProvenance

        self._seedUserMessage('compare https://example.com/pricing with the other one')
        assert _urlProvenance('https://example.com/pricing') == 'user'

    def test_a_search_result_url_is_reported_once(self):
        from app.services.tool_registrations.web_tools import (
            _noteSearchResults,
            _provenanceHeaderLine,
            _urlProvenance,
        )

        assert _urlProvenance('https://found.test/page') == 'unseen'
        _noteSearchResults([{'title': 'x', 'url': 'https://found.test/page'}])
        assert _urlProvenance('https://found.test/page') == 'search'
        assert 'earlier web_search' in _provenanceHeaderLine('https://found.test/page')

    def test_a_url_inside_a_fetched_page_is_never_trusted(self):
        """The laundering path: page A links look-alike B, the model follows it,
        and B must still be reported as unseen."""
        from app.services.memory_store import save_message
        from app.services.tool_registrations.web_tools import _urlProvenance

        save_message(
            'prov-session', 'tool',
            {'role': 'tool', 'content': 'see also https://examp1e.com/evil for more'},
        )
        assert _urlProvenance('https://examp1e.com/evil') == 'unseen'

    def test_an_assistant_message_naming_a_url_does_not_legitimise_it(self):
        from app.services.memory_store import save_message
        from app.services.tool_registrations.web_tools import _urlProvenance

        save_message(
            'prov-session', 'assistant',
            {'role': 'assistant', 'content': 'I will fetch https://guessed.test/docs now'},
        )
        assert _urlProvenance('https://guessed.test/docs') == 'unseen'

    def test_one_session_search_does_not_whitewash_another(self):
        from app.services.tool_registrations.web_tools import (
            _noteSearchResults,
            _urlProvenance,
        )
        from app.services.workbench.context import currentSessionId

        _noteSearchResults([{'url': 'https://shared.test/a'}])
        currentSessionId.set('other-session')
        assert _urlProvenance('https://shared.test/a') == 'unseen'

    def test_the_unseen_warning_says_what_to_do_instead_of_trusting_it(self):
        from app.services.tool_registrations.web_tools import _provenanceHeaderLine

        line = _provenanceHeaderLine('https://never-mentioned.test/x')
        assert line.startswith('Provenance: NOT seen')
        assert 'planted' in line

    @staticmethod
    def _seedUserMessage(text: str) -> None:
        from app.services.memory_store import save_message

        save_message('prov-session', 'user', {'role': 'user', 'content': text})
