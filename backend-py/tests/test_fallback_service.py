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
    assert _split_shell_segments(inside, platform='posix') == [inside]
    # And an escaped quote outside any string must NOT open a string — the &&
    # splits as expected so the network gate can still see `curl`.
    outside = 'echo foo\\" && curl http://example.com'
    # Segments keep the whitespace around the separator; consumers scan
    # tokenized content, so padding is inert.
    assert _split_shell_segments(outside, platform='posix') == ['echo foo\\" ', ' curl http://example.com']


class TestSplitShellSegmentsPlatformSemantics:
    """Inert parsing only — these tests never execute anything."""

    def testPosixEscapedDoubleQuoteKeepsSeparatorInside(self) -> None:
        from app.services.sandbox.backends.fallback import _split_shell_segments

        # POSIX: \" inside double quotes does NOT close the quote, so the
        # && stays inside the single segment.
        inside = 'echo "a \\" && curl http://example.com"'
        assert _split_shell_segments(inside, platform='linux') == [inside]

    def testCmdBackslashIsLiteralQuoteClosesSeparatorSplits(self) -> None:
        from app.services.sandbox.backends.fallback import _split_shell_segments

        # cmd.exe: backslash is literal, " closes, so && splits — the network
        # gate must see `curl` as its own segment head.
        outside = 'echo "a\\" && curl http://example.com'
        segs = _split_shell_segments(outside, platform='nt')
        assert len(segs) == 2
        assert segs[1].lstrip().startswith('curl')

    def testPosixSingleQuoteBackslashIsLiteral(self) -> None:
        from app.services.sandbox.backends.fallback import _split_shell_segments

        cmd = "echo 'a\\' && echo marker"
        assert _split_shell_segments(cmd, platform='posix') == ["echo 'a\\' ", ' echo marker']

    def testCaretEscapesOnlyOutsideQuotesOnCmd(self) -> None:
        from app.services.sandbox.backends.fallback import _split_shell_segments

        # ^& outside quotes: the & is escaped, so one segment, head echo.
        assert _split_shell_segments('echo a^&b', platform='nt') == ['echo a^&b']
        # Inside quotes ^ is literal; the quoted ampersand remains protected.
        segs = _split_shell_segments('echo "a^&b" & curl http://example.com', platform='nt')
        assert len(segs) == 2 and segs[1].lstrip().startswith('curl')

    @pytest.mark.parametrize('count', [1, 2, 3, 4])
    def testPosixDoubleQuoteBackslashParity(self, count):
        from app.services.sandbox.backends.fallback import _split_shell_segments

        prefix = 'echo "marker' + '\\' * count + '"'
        command = prefix + ' && echo next'
        expected = [command] if count % 2 else [prefix + ' ', ' echo next']
        assert _split_shell_segments(command, platform='posix') == expected

    def testCmdSingleQuotesDoNotProtectSeparators(self):
        from app.services.sandbox.backends.fallback import _split_shell_segments

        assert _split_shell_segments("echo 'a & b'", platform='nt') == ["echo 'a ", " b'"]
        assert _split_shell_segments('echo a;b', platform='nt') == ['echo a;b']
        assert _split_shell_segments('echo ^"a & echo next', platform='nt') == [
            'echo ^"a ', ' echo next',
        ]
        assert _split_shell_segments('echo "a^" & echo next', platform='nt') == [
            'echo "a^" ', ' echo next',
        ]

    def testNetworkDenialUsesNativeQuoteRules(self, tmp_path):
        import os

        from app.services.sandbox.backends.fallback import soft_preflight
        from app.services.sandbox.policy import SandboxPolicy

        prefix = 'echo "marker' + '\\' * (1 if os.name == 'nt' else 2) + '"'
        policy = SandboxPolicy(workspace_root=str(tmp_path), network=False)
        assert 'network disabled' in soft_preflight(prefix + ' && curl', policy)

    @pytest.mark.parametrize('flag', ['-command', '-c'])
    def testPowerShellCommandAliasDeniesNestedNetwork(self, flag: str, tmp_path):
        from app.services.sandbox.backends.fallback import soft_preflight
        from app.services.sandbox.policy import SandboxPolicy

        policy = SandboxPolicy(workspace_root=str(tmp_path), network=False)
        denial = soft_preflight(
            f'powershell {flag} "curl https://example.com"',
            policy,
            platform='powershell',
        )
        assert denial is not None
        assert 'network disabled' in denial
        assert 'curl' in denial

    @pytest.mark.parametrize('flag', ['-encodedcommand', '-enc', '-ec', '-e'])
    def testPowerShellEncodedAliasesFailClosed(self, flag: str, tmp_path):
        from app.services.sandbox.backends.fallback import _shell_payload, _shell_tokens, soft_preflight
        from app.services.sandbox.policy import SandboxPolicy

        command = f'powershell {flag} "curl https://example.com"'
        payload, payload_platform, encoded = _shell_payload(
            _shell_tokens(command, platform='powershell'), platform='powershell'
        )
        assert payload is None
        assert payload_platform == 'powershell'
        assert encoded is True

        policy = SandboxPolicy(workspace_root=str(tmp_path), network=False)
        assert soft_preflight(command, policy, platform='powershell') is not None

    def testDefaultPlatformMatchesSubprocessShell(self) -> None:
        import os

        from app.services.sandbox.backends.fallback import _split_shell_segments

        # asyncio.create_subprocess_shell uses cmd.exe on Windows, /bin/sh
        # elsewhere — the no-arg default must track os.name exactly.
        assert _split_shell_segments('echo a^&b') == _split_shell_segments(
            'echo a^&b', platform=os.name
        )
