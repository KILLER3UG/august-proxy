"""Tests for the lifecycle hook system (Phase 2.1–2.6)."""

import asyncio

import pytest
from app.services.hooks import HookContext, HookEvent, HookResult, registry
from app.services.hooks.blast_radius import _is_core_path, compute_blast_radius
from app.services.hooks.registry import _HOOK_TIMEOUT_S, HookRegistry
from app.services.hooks.secret_guard import _redact_secrets, _scan_for_secrets
from app.services.hooks.sensitive_code import _SENSITIVE_PATTERNS
from app.services.hooks.test_mapping import _is_critical


@pytest.fixture(autouse=True)
def _clean_registry():
    """Use a fresh registry per test."""
    reg = HookRegistry()
    yield reg
    reg.clear()


# ─── Registry Core (2.1) ──────────────────────────────────────────────────────


class TestHookRegistry:
    @pytest.mark.asyncio
    async def test_register_and_emit(self, _clean_registry):
        reg = _clean_registry

        async def handler(ctx: HookContext) -> HookResult:
            return HookResult(action='allow', data={'seen': True})

        reg.register('test_hook', HookEvent.PRE_TOOL_USE, handler, matcher='*')
        ctx = HookContext(event=HookEvent.PRE_TOOL_USE, session_id='s1', tool_name='write_file')
        results = await reg.emit(HookEvent.PRE_TOOL_USE, ctx)
        assert len(results) == 1
        assert results[0].data == {'seen': True}

    @pytest.mark.asyncio
    async def test_matcher_filtering(self, _clean_registry):
        reg = _clean_registry
        calls = []

        async def handler(ctx: HookContext) -> HookResult:
            calls.append(ctx.tool_name)
            return HookResult()

        reg.register('specific', HookEvent.PRE_TOOL_USE, handler, matcher='write_file|edit_file')

        # Matching tool
        ctx1 = HookContext(event=HookEvent.PRE_TOOL_USE, session_id='s1', tool_name='write_file')
        await reg.emit(HookEvent.PRE_TOOL_USE, ctx1)
        assert calls == ['write_file']

        # Non-matching tool
        ctx2 = HookContext(event=HookEvent.PRE_TOOL_USE, session_id='s1', tool_name='read_file')
        await reg.emit(HookEvent.PRE_TOOL_USE, ctx2)
        assert calls == ['write_file']  # Not called again

    @pytest.mark.asyncio
    async def test_priority_ordering(self, _clean_registry):
        reg = _clean_registry
        order = []

        async def make_handler(name):
            async def handler(ctx):
                order.append(name)
                return HookResult()
            return handler

        reg.register('second', HookEvent.PRE_TOOL_USE, await make_handler('second'), priority=50)
        reg.register('first', HookEvent.PRE_TOOL_USE, await make_handler('first'), priority=10)
        reg.register('third', HookEvent.PRE_TOOL_USE, await make_handler('third'), priority=100)

        ctx = HookContext(event=HookEvent.PRE_TOOL_USE, session_id='s1', tool_name='x')
        await reg.emit(HookEvent.PRE_TOOL_USE, ctx)
        assert order == ['first', 'second', 'third']

    @pytest.mark.asyncio
    async def test_deny_short_circuits(self, _clean_registry):
        reg = _clean_registry
        calls = []

        async def deny_handler(ctx):
            calls.append('deny')
            return HookResult(action='deny', message='blocked')

        async def allow_handler(ctx):
            calls.append('allow')
            return HookResult()

        reg.register('blocker', HookEvent.PRE_TOOL_USE, deny_handler, priority=10)
        reg.register('after', HookEvent.PRE_TOOL_USE, allow_handler, priority=50)

        ctx = HookContext(event=HookEvent.PRE_TOOL_USE, session_id='s1', tool_name='x')
        results = await reg.emit(HookEvent.PRE_TOOL_USE, ctx)
        assert len(results) == 1
        assert results[0].action == 'deny'
        assert calls == ['deny']  # 'after' never ran

    @pytest.mark.asyncio
    async def test_modify_chaining(self, _clean_registry):
        reg = _clean_registry

        async def modifier(ctx):
            args = dict(ctx.tool_args or {})
            args['injected'] = True
            return HookResult(action='modify', modified_args=args)

        seen_args = {}

        async def observer(ctx):
            seen_args.update(ctx.tool_args or {})
            return HookResult()

        reg.register('mod', HookEvent.PRE_TOOL_USE, modifier, priority=10)
        reg.register('obs', HookEvent.PRE_TOOL_USE, observer, priority=50)

        ctx = HookContext(event=HookEvent.PRE_TOOL_USE, session_id='s1', tool_name='x', tool_args={'original': 1})
        await reg.emit(HookEvent.PRE_TOOL_USE, ctx)
        assert seen_args == {'original': 1, 'injected': True}

    @pytest.mark.asyncio
    async def test_timeout_fail_open(self, _clean_registry):
        reg = _clean_registry

        async def slow_handler(ctx):
            await asyncio.sleep(_HOOK_TIMEOUT_S + 1)
            return HookResult(action='deny')  # Should never reach this

        reg.register('slow', HookEvent.PRE_TOOL_USE, slow_handler, priority=10)
        ctx = HookContext(event=HookEvent.PRE_TOOL_USE, session_id='s1', tool_name='x')
        results = await reg.emit(HookEvent.PRE_TOOL_USE, ctx)
        assert results[0].action == 'allow'  # Fail-open

    @pytest.mark.asyncio
    async def test_exception_fail_closed_pre(self, _clean_registry):
        """A broken PRE hook must NOT silently allow the call (fail-closed)."""
        reg = _clean_registry

        async def bad_handler(ctx):
            raise ValueError('oops')

        reg.register('bad', HookEvent.PRE_TOOL_USE, bad_handler, priority=10)
        ctx = HookContext(event=HookEvent.PRE_TOOL_USE, session_id='s1', tool_name='x')
        results = await reg.emit(HookEvent.PRE_TOOL_USE, ctx)
        assert results[0].action == 'deny'
        assert 'bad' in (results[0].message or '')

    @pytest.mark.asyncio
    async def test_exception_fail_open_post(self, _clean_registry):
        """POST_TOOL_USE exceptions are non-fatal (the tool already ran)."""
        reg = _clean_registry

        async def bad_handler(ctx):
            raise ValueError('oops')

        reg.register('bad_post', HookEvent.POST_TOOL_USE, bad_handler, priority=10)
        ctx = HookContext(event=HookEvent.POST_TOOL_USE, session_id='s1', tool_name='x')
        results = await reg.emit(HookEvent.POST_TOOL_USE, ctx)
        assert results[0].action == 'allow'

    @pytest.mark.asyncio
    async def test_duplicate_register_skipped(self, _clean_registry):
        """Registering the same hook name twice must not stack handlers."""
        reg = _clean_registry
        calls = []

        async def handler(ctx):
            calls.append(ctx.tool_name)
            return HookResult()

        reg.register('dup', HookEvent.PRE_TOOL_USE, handler)
        reg.register('dup', HookEvent.PRE_TOOL_USE, handler)
        ctx = HookContext(event=HookEvent.PRE_TOOL_USE, session_id='s1', tool_name='x')
        await reg.emit(HookEvent.PRE_TOOL_USE, ctx)
        assert len(calls) == 1

    @pytest.mark.asyncio
    async def test_reserved_noop_events(self, _clean_registry):
        """SESSION_START / PRE_MODEL_CALL / STOP have no emission call sites —
        dispatch is a documented no-op, not an error."""
        reg = _clean_registry

        async def handler(ctx):
            return HookResult(action='deny')

        reg.register('reserved', HookEvent.STOP, handler)
        ctx = HookContext(event=HookEvent.STOP, session_id='s1', tool_name='x')
        results = await reg.emit(HookEvent.STOP, ctx)
        assert results == []

    @pytest.mark.asyncio
    async def test_circuit_breaker(self, _clean_registry):
        reg = _clean_registry
        call_count = [0]

        async def timeout_handler(ctx):
            call_count[0] += 1
            await asyncio.sleep(_HOOK_TIMEOUT_S + 1)
            return HookResult()

        reg.register('breaker', HookEvent.PRE_TOOL_USE, timeout_handler, priority=10)
        ctx = HookContext(event=HookEvent.PRE_TOOL_USE, session_id='s1', tool_name='x')

        # Trip the breaker (3 timeouts)
        for _ in range(3):
            await reg.emit(HookEvent.PRE_TOOL_USE, ctx)

        assert call_count[0] == 3
        # Next emit should skip the hook (breaker open)
        results = await reg.emit(HookEvent.PRE_TOOL_USE, ctx)
        assert call_count[0] == 3  # Not called again
        assert len(results) == 0  # No results (hook skipped)

    def test_stats(self, _clean_registry):
        reg = _clean_registry

        async def handler(ctx):
            return HookResult()

        reg.register('stat_hook', HookEvent.POST_TOOL_USE, handler, matcher='write_file', priority=42)
        stats = reg.stats()
        assert len(stats['hooks']) == 1
        assert stats['hooks'][0]['name'] == 'stat_hook'
        assert stats['hooks'][0]['priority'] == 42
        assert stats['hooks'][0]['breaker_state'] == 'closed'

    def test_unregister(self, _clean_registry):
        reg = _clean_registry

        async def handler(ctx):
            return HookResult()

        reg.register('temp', HookEvent.STOP, handler)
        assert reg.unregister('temp') is True
        assert reg.unregister('temp') is False


# ─── Secret Guard (2.2) ───────────────────────────────────────────────────────


class TestSecretGuard:
    def test_detects_openai_key(self):
        assert _scan_for_secrets('key = "sk-abc123def456ghi789jkl012"') == 'OpenAI API key'

    def test_detects_anthropic_key(self):
        assert _scan_for_secrets('sk-ant-api03-abcdefghijklmnopqrstuvwx') == 'Anthropic API key'

    def test_detects_aws_key(self):
        assert _scan_for_secrets('aws_key = AKIAIOSFODNN7EXAMPLE') == 'AWS access key'

    def test_detects_github_token(self):
        assert _scan_for_secrets('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij') == 'GitHub token'

    def test_detects_private_key(self):
        assert _scan_for_secrets('-----BEGIN RSA PRIVATE KEY-----') == 'Private key'

    def test_allows_clean_content(self):
        assert _scan_for_secrets('def hello(): return "world"') is None

    def test_redact_secrets(self):
        text = 'api_key = "sk-abc123def456ghi789jkl012"'
        redacted = _redact_secrets(text)
        assert 'sk-abc123' not in redacted
        assert '[REDACTED]' in redacted

    @pytest.mark.asyncio
    async def test_pre_tool_denies_secret_write(self, _clean_registry):
        from app.services.hooks.secret_guard import register
        reg = _clean_registry
        register(reg)

        ctx = HookContext(
            event=HookEvent.PRE_TOOL_USE, session_id='s1',
            tool_name='write_file',
            tool_args={'content': 'OPENAI_KEY=sk-abc123def456ghi789jkl012'},
        )
        results = await reg.emit(HookEvent.PRE_TOOL_USE, ctx)
        assert any(r.action == 'deny' for r in results)

    @pytest.mark.asyncio
    async def test_pre_tool_denies_nested_bulk_secret_write(self, _clean_registry):
        from app.services.hooks.secret_guard import register

        reg = _clean_registry
        register(reg)
        ctx = HookContext(
            event=HookEvent.PRE_TOOL_USE, session_id='s1',
            tool_name='bulk',
            tool_args={
                'operation': 'write_files',
                'files': [{'path': '.env', 'content': 'TOKEN=sk-abc123def456ghi789jkl012'}],
            },
        )
        results = await reg.emit(HookEvent.PRE_TOOL_USE, ctx)
        assert any(r.action == 'deny' for r in results)


# ─── Blast Radius (2.3) ───────────────────────────────────────────────────────


class TestBlastRadius:
    def test_core_path_detection(self):
        assert _is_core_path('app/routers/workbench.py') is True
        assert _is_core_path('app/adapters/proxy_tools.py') is True
        assert _is_core_path('app/services/sandbox/policy.py') is True
        assert _is_core_path('app/services/memory/auto_memory.py') is False

    def test_score_core_higher_than_leaf(self):
        core_score, _ = compute_blast_radius('app/routers/workbench.py', None)
        leaf_score, _ = compute_blast_radius('app/services/memory/topic_index.py', None)
        assert core_score > leaf_score

    def test_score_capped_at_100(self):
        score, _ = compute_blast_radius('app/routers/auth_permission_secret.py', None)
        assert score <= 100

    def test_security_path_bonus(self):
        score, reasons = compute_blast_radius('app/lib/secrets.py', None)
        assert 'security-related' in reasons


# ─── Test Mapping (2.4) ───────────────────────────────────────────────────────


class TestTestMapping:
    def test_critical_path_detection(self):
        assert _is_critical('app/routers/workbench.py') is True
        assert _is_critical('app/adapters/proxy_tools.py') is True
        assert _is_critical('app/services/memory/auto_memory.py') is False

    @pytest.mark.asyncio
    async def test_warns_on_untested_critical(self, _clean_registry):
        from app.services.hooks.test_mapping import register
        reg = _clean_registry
        register(reg)

        ctx = HookContext(
            event=HookEvent.POST_TOOL_USE, session_id='s1',
            tool_name='write_file',
            tool_args={'path': 'app/routers/some_new_router.py'},
            workspace_path='/nonexistent',  # No tests exist here
        )
        results = await reg.emit(HookEvent.POST_TOOL_USE, ctx)
        assert any(r.data and r.data.get('type') == 'testMappingWarning' for r in results)


# ─── Sensitive Code (2.5) ─────────────────────────────────────────────────────


class TestSensitiveCode:
    @pytest.mark.asyncio
    async def test_detects_eval(self):
        from app.services.hooks.sensitive_code import _detect_sensitive
        ctx = HookContext(
            event=HookEvent.PRE_TOOL_USE, session_id='s1',
            tool_name='write_file',
            tool_args={'content': 'result = eval(user_input)'},
        )
        result = await _detect_sensitive(ctx)
        assert result.data is not None
        assert 'execution boundaries' in result.data['categories']

    @pytest.mark.asyncio
    async def test_no_false_positive_benign(self):
        from app.services.hooks.sensitive_code import _detect_sensitive
        ctx = HookContext(
            event=HookEvent.PRE_TOOL_USE, session_id='s1',
            tool_name='write_file',
            tool_args={'content': 'def add(a, b): return a + b'},
        )
        result = await _detect_sensitive(ctx)
        assert result.data is None

    def test_all_categories_have_patterns(self):
        assert len(_SENSITIVE_PATTERNS) == 8
