"""
Provider resolution and LLM call helpers for workbench chat.

Owns workbench provider/model resolution, content-block extraction, and the
Anthropic / OpenAI streaming call paths used by the chat loop and subagents.

Extracted from workbench.py for Phase 3 modularization.
"""

from __future__ import annotations

import json
import re
import uuid
from typing import Callable

from app.json_narrowing import as_bool, as_dict, as_int, as_list, as_str
from app.models import AnthropicRequest, ChatCompletionRequest
from app.services.workbench.effort import (
    cap_reasoning_effort,
    effort_to_openai_reasoning_effort,
    model_max_output_tokens,
    provider_accepts_reasoning_effort,
    resolve_completion_limits,
)


def background_task_model(task_key: str, chat_model: str) -> str:
    """Resolve the model to use for a background task.

    Uses the per-task model from the background-review config when background
    tasks are enabled and a model is configured; otherwise falls back to the
    chat session's model.
    """
    return chat_model


def make_review_llm_client(
    main_provider: dict[str, object] | None, review_model_hint: str = ''
) -> Callable | None:
    """Create an LLM client for background review calls.

    Resolves the provider from the ``reviewModel`` config (or the provided
    ``review_model_hint``, which is already the per-task resolved model),
    falling back to the main session provider. Returns None if no provider
    is available (review will be a no-op).
    """
    try:
        from app.providers import resolver as providerResolver

        provider = None
        review_model = review_model_hint
        if review_model:
            provider = providerResolver.resolve(review_model)
        if not provider:
            provider = main_provider
        if not provider:
            provider = providerResolver.resolve('')
        if not provider:
            return None
        from app.providers.clients import getClient

        client = getClient(provider)
        if not client:
            return None
        apiKey = client.resolveApiKey()
        if not apiKey:
            return None
        _client = client
        # Model precedence: explicit config > the chat session's own model.
        # The old fallback hardcoded a specific Anthropic model name that fired
        # whenever the hint was empty — memory/reflection calls would silently
        # target a model the user never selected (and likely one with no API
        # access on this install). resolve_model falls back to the provider's
        # defaultModel, which is what the user actually configured.
        if not as_str(review_model, ''):
            review_model = resolve_model(provider)
        _reviewModel = as_str(review_model, '') or as_str(provider.get('defaultModel', ''))

        async def reviewLlm(prompt: list[dict[str, object]]) -> str:
            """Call a cheap/fast model for background review."""
            try:
                from app.services.model_service import get_max_output_tokens

                # Short background review: use a small slice of the model's ceiling.
                model_out = get_max_output_tokens(_reviewModel, provider)
                body = {
                    'model': _reviewModel,
                    'messages': prompt,
                    'max_tokens': max(256, model_out // 32),
                }
                resp = await _client.chat_completions(body)
                bodyJson = resp.body_json or {}
                if resp.is_error or 'error' in bodyJson:
                    return ''
                choices = as_list(bodyJson.get('choices', []), [])
                if not choices:
                    return ''
                return as_str(as_dict(as_dict(choices[0]).get('message', {})).get('content', ''))
            except Exception:
                return ''

        return reviewLlm
    except Exception:
        return None


def make_compactor_llm_client(
    main_provider: dict[str, object] | None, compactor_model_hint: str = ''
) -> Callable | None:
    """Create an LLM client for mid-context compaction summaries.

    Reuses the review client's provider/model resolution; the returned
    callable takes the middle messages and returns a concise summary string
    (``''`` on failure, so the caller can fall back to the local summarizer).
    """
    base = make_review_llm_client(main_provider, compactor_model_hint)
    if base is None:
        return None

    async def compactorLlm(middle: list[dict[str, object]]) -> str:
        prompt: list[dict[str, object]] = [
            {
                'role': 'system',
                'content': (
                    'Summarize the conversation fragment into a concise plain-text summary '
                    'preserving: decisions made, requirements and corrections, tool results '
                    'that changed state, and open questions. No headers, no markdown.'
                ),
            },
            {
                'role': 'user',
                'content': json.dumps(middle, default=str)[:12000],
            },
        ]
        try:
            return await base(prompt)
        except Exception:
            return ''

    return compactorLlm


def _extract_upstream_error_message(event: dict[str, object]) -> str:
    """Pull a human-readable message from a provider stream/error event."""
    errObj = event.get('error')
    if isinstance(errObj, dict):
        msg = as_str(errObj.get('message') or errObj.get('type') or errObj)
        if msg:
            status = event.get('status')
            return f'[{status}] {msg}' if status else msg
    if errObj and not isinstance(errObj, dict):
        msg = as_str(errObj)
        if msg:
            status = event.get('status')
            return f'[{status}] {msg}' if status else msg

    raw_body = as_str(event.get('body') or event.get('message'))
    if raw_body:
        try:
            parsed = json.loads(raw_body)
            if isinstance(parsed, dict):
                inner = as_dict(parsed.get('error'))
                nested = as_str(inner.get('message') or inner.get('type'))
                if nested:
                    status = event.get('status') or parsed.get('status')
                    return f'[{status}] {nested}' if status else nested
                # OpenCode / Anthropic-style envelope
                if as_str(parsed.get('type')) == 'error':
                    nested = as_str(as_dict(parsed.get('error')).get('message'))
                    if nested:
                        status = event.get('status')
                        return f'[{status}] {nested}' if status else nested
        except Exception:
            pass
        status = event.get('status')
        return f'[{status}] {raw_body}' if status else raw_body

    status = event.get('status')
    return f'Upstream error (status {status})' if status else 'Upstream provider error'


def resolve_workbench_provider(provider_name: str, model_hint: str = '') -> dict[str, object] | None:
    """Resolve a provider from name or model hint.

    Prefer user-configured ``providers.json`` entries that have an API key and
    actually list the requested model — never silently fall back to a built-in
    template (e.g. Anthropic) that has no credentials.
    """
    from app.providers import resolver as providerResolver
    from app.services import config_service, provider_credentials

    if provider_name:
        provider = providerResolver.resolve(provider_name)
        if provider:
            return provider
        # Case-insensitive custom store by name/id
        creds = provider_credentials.resolve(provider_name)
        if creds and creds.get('provider'):
            return as_dict(creds.get('provider'))

    if model_hint:
        # 1) Custom providers that list this model id and have a key
        try:
            store = config_service.getProvidersStore() or {}
            target = model_hint.lower()
            for entry in as_list(store.get('providers'), []):
                if not isinstance(entry, dict):
                    continue
                if entry.get('enabled') is False:
                    continue
                if not as_str(entry.get('apiKey')):
                    continue
                models = as_list(entry.get('models'), [])
                for m in models:
                    mid = as_str(m.get('id') if isinstance(m, dict) else m).lower()
                    if mid == target:
                        built = providerResolver.resolve(as_str(entry.get('id') or entry.get('name')))
                        if built:
                            return built
                        creds = provider_credentials.resolve(as_str(entry.get('id') or entry.get('name')))
                        if creds and creds.get('provider'):
                            return as_dict(creds.get('provider'))
        except Exception:
            pass
        # 2) Generic resolver — but only accept if it has credentials
        provider = providerResolver.resolve(model_hint)
        if provider and _provider_has_key(provider):
            return provider

    # Prefer first available provider that actually has a key
    for p in providerResolver.list_available():
        if _provider_has_key(p):
            return p
    providers = providerResolver.list_available()
    return providers[0] if providers else None


def _provider_has_key(provider: dict[str, object] | None) -> bool:
    if not provider:
        return False
    if provider.get('api_key') or provider.get('apiKey'):
        return True
    try:
        from app.services import provider_credentials

        creds = provider_credentials.resolve(
            as_str(provider.get('id') or provider.get('name'))
        )
        return bool(creds and creds.get('api_key'))
    except Exception:
        return False


def resolve_model(provider: dict[str, object] | None, model_hint: str = '') -> str:
    """Resolve the model name from hint or provider default."""
    if model_hint:
        return model_hint
    if provider:
        return as_str(provider.get('defaultModel', ''))
    return ''


def _provider_lists_model(provider: dict[str, object], model_hint: str) -> bool | None:
    """Whether the provider's own model list contains ``model_hint``.

    Returns True/False when the provider carries an authoritative ``models``
    list; None when it has none (cannot verify — the hint is kept).
    """
    models = as_list(provider.get('models'), [])
    if not models:
        return None
    target = (model_hint or '').strip().lower()
    for m in models:
        mid = as_str(m.get('id') if isinstance(m, dict) else m).lower()
        if mid == target:
            return True
    return False


def resolve_chat_llm(
    *,
    model: str = '',
    model_provider: str = '',
    session_provider: str = '',
    session_model: str = '',
) -> tuple[dict[str, object] | None, str]:
    """Same resolution order as workbench chat turns.

    The explicitly picked model always wins — no fleet/role override.

    Order:
      1. explicit modelProvider
      2. model id hint
      3. session.provider + model/session.model
      4. first available provider
    Then model = explicit model → session.model → provider default.
    """
    resolved_provider: dict[str, object] | None = None
    resolved_model = ''
    if model_provider:
        resolved_provider = resolve_workbench_provider(model_provider, '')
    if not resolved_provider and model:
        resolved_provider = resolve_workbench_provider('', model)
    if not resolved_provider:
        resolved_provider = resolve_workbench_provider(session_provider, model or session_model)
    last_resort_fallback = False
    if not resolved_provider:
        resolved_provider = resolve_workbench_provider('', '')
        last_resort_fallback = True
    resolved_model = resolve_model(resolved_provider, model or session_model or '')
    # Last-resort fallback: the session's provider failed to resolve and we
    # landed on an unrelated "first provider with a key". The old session
    # model often 404s there (and the sidebar shows the wrong provider) —
    # re-resolve the model against the winning provider when its model list
    # proves the hint does not belong to it.
    if last_resort_fallback and resolved_provider and resolved_model:
        if _provider_lists_model(resolved_provider, resolved_model) is False:
            provider_default = as_str(resolved_provider.get('defaultModel'))
            if provider_default:
                resolved_model = provider_default
    # Per-model format override (multi-format gateways like OpenCode Zen):
    # the model's own apiFormat wins over the provider-level format.
    if resolved_provider:
        from app.providers.resolver import apply_model_format_override

        resolved_provider = apply_model_format_override(resolved_provider, resolved_model)
    return resolved_provider, resolved_model


def is_anthropic_provider(provider: dict[str, object] | None) -> bool:
    if provider is None:
        return False
    from app.providers.api_format import is_anthropic_api_format

    return is_anthropic_api_format(provider.get('apiMode') or provider.get('apiFormat'))


def is_openai_provider(provider: dict[str, object] | None) -> bool:
    if provider is None:
        return False
    from app.providers.api_format import is_openai_api_format

    return is_openai_api_format(provider.get('apiMode') or provider.get('apiFormat'))


def extract_text(content_blocks: list[dict[str, object]]) -> str:
    """Extract text from Anthropic content blocks."""
    parts: list[str] = []
    for block in content_blocks:
        if block.get('type') == 'text':
            parts.append(as_str(block.get('text', '')))
    return '\n'.join(parts)


def extract_thinking(content_blocks: list[dict[str, object]]) -> str:
    """Extract thinking/reasoning from Anthropic content blocks."""
    parts: list[str] = []
    for block in content_blocks:
        if block.get('type') == 'thinking':
            parts.append(as_str(block.get('thinking'), '') or as_str(block.get('text', '')))
    return '\n'.join(parts)


def supports_thinking(provider: dict[str, object], model: str) -> bool:
    """Check if a provider/model supports Anthropic-style extended thinking.

    Exact and non-wildcard prefix profiles win. A wildcard ``*`` claim alone
    only enables thinking for **Claude** model ids.

    Without profiles, modern Claude 4+ ids default to True so effort can set
    ``thinking.budget_tokens``. Legacy Claude 3.5 / Haiku stay False unless a
    profile explicitly opts them in (API rejects extended thinking on those).
    """
    profiles = as_dict(provider.get('modelProfiles', {}) or provider.get('model_profiles', {}))
    model_l = (model or '').lower()

    if model in profiles:
        profile = as_dict(profiles.get(model) or {})
        return as_bool(profile.get('supportsThinking')) or as_bool(profile.get('supportsReasoning'))

    best_key = ''
    best_profile: dict[str, object] = {}
    for key, val in profiles.items():
        if key == '*' or not isinstance(key, str):
            continue
        if model_l.startswith(str(key).lower()) and len(str(key)) > len(best_key):
            best_key = str(key)
            best_profile = as_dict(val)
    if best_key:
        return as_bool(best_profile.get('supportsThinking')) or as_bool(
            best_profile.get('supportsReasoning')
        )

    star = as_dict(profiles.get('*') or {})
    if as_bool(star.get('supportsThinking')) or as_bool(star.get('supportsReasoning')):
        return 'claude' in model_l

    return _claude_supports_extended_thinking_by_id(model_l)


def _claude_supports_extended_thinking_by_id(model_l: str) -> bool:
    """Heuristic for Anthropic extended thinking when modelProfiles are empty."""
    if 'claude' not in model_l:
        return False
    # Known generations that reject thinking / budget_tokens.
    legacy = (
        'claude-3-5',
        'claude-3.5',
        'claude-3-haiku',
        'claude-3-opus',
        'claude-3-sonnet',
        'claude-instant',
        'claude-2',
    )
    if any(token in model_l for token in legacy):
        return False
    return True


async def call_anthropic_workbench(
    messages: list[dict[str, object]],
    system_text: str,
    model: str,
    tools: list[dict[str, object]],
    effort: str,
    provider: dict[str, object] | None = None,
    emit: Callable[[dict[str, object]], None] | None = None,
    thinking_enabled: bool = True,
) -> dict[str, object]:
    """Call an Anthropic-format model with progressive streaming.

    Emits ``thinking`` / ``finalOutput`` as tokens arrive. Returns the full
    aggregated response dict with ``content``, ``text``, ``thinking``, and
    ``tool_uses`` keys.
    """
    from app.adapters.anthropic import buildAnthropicUpstreamRequest
    from app.providers.clients import getClient
    from app.services.workbench.stream_translate import AnthropicWorkbenchStreamAggregator

    if not provider:
        provider = resolve_workbench_provider('', model)
    if not provider:
        return {'error': 'No provider available'}
    client = getClient(provider)
    if not client:
        return {'error': f'No client for {provider.get("name")}'}
    apiKey = client.resolveApiKey()
    if not apiKey:
        return {'error': 'API key not configured'}
    from app.adapters.anthropic import translateMessagesToAnthropic

    anthropicMessages = translateMessagesToAnthropic(messages)
    # max_tokens is the model's output ceiling; effort only sizes thinking within it.
    model_out = model_max_output_tokens(provider, model)
    if thinking_enabled and supports_thinking(provider, model):
        thinking_budget, max_tokens = resolve_completion_limits(
            effort, max_output_tokens=model_out
        )
    else:
        thinking_budget, max_tokens = 0, model_out
    req = AnthropicRequest(model=model, max_tokens=max_tokens)
    body = buildAnthropicUpstreamRequest(req, model, [{'type': 'text', 'text': system_text}])
    body['messages'] = anthropicMessages
    body['max_tokens'] = max_tokens
    if tools:
        body['tools'] = tools
    # Prompt-cache breakpoints (system/tools/last user message) — re-applied
    # now that messages/tools are final (the builder ran before them).
    from app.adapters.anthropic import apply_prompt_caching

    apply_prompt_caching(body)
    if thinking_budget > 0:
        body['thinking'] = {'type': 'enabled', 'budget_tokens': thinking_budget}
    agg = AnthropicWorkbenchStreamAggregator(emit=emit)
    # Poll the workbench cancel signal during chunk iteration so Stop terminates promptly.
    from app.lib.async_subprocess import current_subprocess_cancel

    _cancel_event = current_subprocess_cancel.get()
    _stream_rule_hit: str | None = None
    try:
        async for event in client.messages_stream(body):
            if _cancel_event is not None and _cancel_event.is_set():
                break
            agg.on_event(event)
            # Stream rules: detect narration, but do NOT abort mid-stream —
            # the hit is cancelled if a real tool_use arrives later in this
            # turn (a strong model narrates AND then emits the call); only a
            # narration with no tool call triggers the reminder + retry.
            if tools and agg.accumulated_text and _stream_rule_hit is None:
                _stream_rule_hit = _match_stream_rule(agg.accumulated_text)
            if _stream_rule_hit and agg.tool_uses:
                _stream_rule_hit = None
            if agg.error:
                errResp: dict[str, object] = {'error': agg.error}
                if agg.error_status is not None:
                    errResp['errorStatus'] = agg.error_status
                if agg.error_retry_after_ms is not None:
                    errResp['retryAfterMs'] = agg.error_retry_after_ms
                return errResp
    except Exception as exc:
        return {'error': str(exc)}
    if _stream_rule_hit and not agg.tool_uses:
        return {
            'stream_rule': _stream_rule_hit,
            'text': agg.accumulated_text,
            'usage': dict(agg.usage),
            'finish_reason': agg.stop_reason or 'end_turn',
        }
    return agg.result()


# ── Stream rules (Oh My Pi lesson) ───────────────────────────────────────
# Mid-stream self-correction: when the model NARRATES a tool call in prose
# instead of emitting it (a code-fenced JSON tool call, "I'll use the X tool"),
# abort the generation and let the turn loop inject a reminder + retry from
# the same point — far cheaper than letting a wasted round complete.
#
# Detection is DEFERRED to end-of-turn (not a mid-stream abort): a strong
# model routinely writes "I'll use the web_search tool to…" and THEN emits
# the real tool call in the same turn — aborting on the narration discarded
# the genuine call (audit A8). The hit is cancelled the moment a real tool
# call arrives, and only a narration with NO tool call triggers the retry.
_STREAM_RULE_PATTERNS: tuple[tuple[str, re.Pattern], ...] = (
    (
        'code_fence_tool_call',
        # Shape-anchored: `name`/`tool`/`function` AND `arguments`/`input`
        # must both be present — a fenced config payload {"name": …} without
        # arguments must not abort the turn.
        re.compile(
            r'```(?:json)?\s*\{\s*["\']?(?:name|tool|function)["\']?\s*:\s*["\'][^"\']+["\']\s*,?\s*'
            r'["\']?(?:arguments|input)["\']?\s*:'
        ),
    ),
    (
        'narrated_tool_call',
        # English + common French/Spanish/German narrations. Non-English
        # coverage is best-effort — the shape-anchored fence rule above is
        # the primary detector; narration is the fallback.
        re.compile(
            r'\b(?:'
            r"I['\u2019]?ll (?:now )?(?:use|call|invoke) (?:the )?[\w:]+ (?:tool|function)|"
            r'I will (?:now )?(?:use|call|invoke) (?:the )?[\w:]+ (?:tool|function)|'
            r'(?:let me|I am going to) (?:use|call) (?:the )?[\w:]+ (?:tool|function)|'
            r'calling (?:the )?[\w:]+ (?:tool|function)(?: now)?|'
            r"je vais utiliser l['\u2019]outil [\w:]+|"
            r'j[\'\u2019]utilise l[\'\u2019]outil [\w:]+|'
            r'voy a usar (?:la )?herramienta [\w:]+|'
            r'usar(?:é|e) (?:la )?herramienta [\w:]+|'
            r'ich (?:werde|nutze|verwende) (?:das )?(?:tool|werkzeug) [\w:]+'
            r')\b',
            re.IGNORECASE,
        ),
    ),
)


def _match_stream_rule(text: str) -> str | None:
    """Return the first stream-rule name matching the accumulated text."""
    for name, pattern in _STREAM_RULE_PATTERNS:
        if pattern.search(text):
            return name
    return None


def _reasoning_effort_rejected(status: object, msg: str | None) -> bool:
    """Whether an upstream error is specifically rejecting ``reasoning_effort``.

    Gateways that configure a per-model pattern for the field return a 400 whose
    message names ``reasoning_effort`` (e.g. ``value "high" does not match pattern
    configured for reasoning_effort``). We treat that as "drop the optional hint
    and retry" rather than a fatal error. ``status`` may be ``None`` on the
    exception path, where we rely on the message text alone.
    """
    text = (msg or '').lower()
    if 'reasoning_effort' not in text:
        return False
    if status is None:
        return True
    # Narrow to int|str so int() resolves a concrete overload (status is `object`).
    sval = status if isinstance(status, (int, str)) else str(status)
    try:
        return int(sval) == 400
    except (TypeError, ValueError):
        return False


async def call_openai_workbench(
    messages: list[dict[str, object]],
    system_text: str,
    model: str,
    tools: list[dict[str, object]],
    effort: str,
    provider: dict[str, object] | None = None,
    emit: Callable[[dict[str, object]], None] | None = None,
    thinking_enabled: bool = True,
) -> dict[str, object]:
    """Call an OpenAI-format model with progressive streaming.

    Emits ``thinking`` / ``reasoning`` and ``final_output`` events as
    tokens arrive. Returns the full aggregated response dict with
    ``choices`` (OpenAI format), ``text``, ``thinking``, and ``tool_uses``.
    """
    from app.providers.clients import getClient

    if not provider:
        provider = resolve_workbench_provider('', model)
    if not provider:
        return {'error': 'No provider available'}
    client = getClient(provider)
    if not client:
        return {'error': f'No client for {provider.get("name")}'}
    apiKey = client.resolveApiKey()
    if not apiKey:
        return {'error': 'API key not configured'}
    from app.adapters.anthropic import translateMessages

    openaiMessages = translateMessages(messages)
    openaiMessages.insert(0, {'role': 'system', 'content': system_text})
    from app.models.openai import dump_openai_upstream_body

    # Clean dump: OpenCode Console (and similar) Zod-reject nulls like session_id: null.
    body: dict[str, object] = dump_openai_upstream_body(ChatCompletionRequest(model=model))
    body['messages'] = openaiMessages
    # Completion ceiling from the model profile — not a workbench constant.
    model_out = model_max_output_tokens(provider, model)
    if thinking_enabled:
        _budget, max_tokens = resolve_completion_limits(effort, max_output_tokens=model_out)
    else:
        max_tokens = model_out
    body['max_tokens'] = max_tokens
    if tools:
        body['tools'] = tools
    # Attach OpenAI-style reasoning_effort when the provider/model is likely to
    # understand it (OpenAI/Codex/DeepSeek/reasoner ids). Unknown gateways often
    # reject unknown fields — skip those. Prompt-level effort is applied upstream.
    if thinking_enabled:
        # Look up the per-model config entry for overrides.
        _model_entry: dict[str, object] | None = None
        for _m in as_list(provider.get('models', [])):
            if isinstance(_m, dict) and as_str(_m.get('id')) == model:
                _model_entry = _m
                break
        reasoning = effort_to_openai_reasoning_effort(effort)
        if _model_entry:
            reasoning = cap_reasoning_effort(reasoning, as_str(_model_entry.get('maxReasoningEffort')) or None)
        if reasoning and provider_accepts_reasoning_effort(provider, model, model_entry=_model_entry):
            body['reasoning_effort'] = reasoning

    # Poll the workbench cancel signal during chunk iteration so Stop terminates promptly.
    from app.lib.async_subprocess import current_subprocess_cancel

    _cancel_event = current_subprocess_cancel.get()
    # ``reasoning_effort`` is an optional hint. Some OpenAI-compatible gateways
    # configure a per-model pattern for the field that rejects the value we map
    # (e.g. "high"), hard-failing the request with a 400 — see the
    # ``_reasoning_effort_rejected`` helper. Because it is only a hint, when the
    # upstream rejects it (and we have emitted nothing yet) we drop it and retry
    # once instead of surfacing the error: chat must not break over an effort
    # hint a particular route won't accept. The heuristic gate above stays as the
    # fast path so compatible providers keep the hint on the first try.
    _retried_reasoning = False
    for _stream_attempt in range(2):
        contentText = ''
        thinkingText = ''
        # Always accumulate reasoning for tool-loop re-sends (DeepSeek/Kimi require it).
        # UI emit / returned ``thinking`` still respect thinking_enabled.
        preservedReasoning = ''
        toolCallsAccum: dict[int, dict[str, object]] = {}
        finishReason: str | None = None
        usage: dict[str, int] = {}
        _retry_stream = False
        _stream_rule_hit: str | None = None
        try:
            async for event in client.chat_completions_stream(body):
                if _cancel_event is not None and _cancel_event.is_set():
                    break
                # Surface HTTP/provider errors instead of returning an empty "success".
                if as_str(event.get('type')) == 'error' or event.get('error') is not None:
                    msg = _extract_upstream_error_message(event)
                    status = event.get('status')
                    # Upstream rejected our reasoning_effort hint before emitting any
                    # content — drop the hint and retry once (see note above).
                    if (
                        not _retried_reasoning
                        and 'reasoning_effort' in body
                        and not contentText
                        and not thinkingText
                        and _reasoning_effort_rejected(status, msg)
                    ):
                        body.pop('reasoning_effort', None)
                        _retried_reasoning = True
                        _retry_stream = True
                        break
                    errResp: dict[str, object] = {'error': msg or 'Upstream provider error'}
                    if isinstance(status, int):
                        errResp['errorStatus'] = status
                    retryAfter = event.get('retryAfterMs')
                    if isinstance(retryAfter, int) and retryAfter > 0:
                        errResp['retryAfterMs'] = retryAfter
                    return errResp

                eventType = event.get('_event_type', '')
                if eventType not in ('chat.completion.chunk', ''):
                    pass
                eventUsage = as_dict(event.get('usage'))
                if eventUsage:
                    usage['input_tokens'] = as_int(eventUsage.get('prompt_tokens', 0))
                    usage['output_tokens'] = as_int(eventUsage.get('completion_tokens', 0))
                    # Preserve the provider's prompt-cache split (DeepSeek,
                    # Moonshot, OpenRouter… stream prompt_cache_hit/miss_tokens
                    # in the final usage chunk) — the context ring reads it.
                    if eventUsage.get('prompt_cache_hit_tokens') is not None:
                        usage['prompt_cache_hit_tokens'] = as_int(
                            eventUsage.get('prompt_cache_hit_tokens'), 0
                        )
                    if eventUsage.get('prompt_cache_miss_tokens') is not None:
                        usage['prompt_cache_miss_tokens'] = as_int(
                            eventUsage.get('prompt_cache_miss_tokens'), 0
                        )
                    # OpenAI-standard shape (OpenAI, OpenRouter, most gateways):
                    # the cache split rides in usage.prompt_tokens_details.
                    # cached_tokens — without this the turn loop sees no cache
                    # fields and books every input token as a cache miss,
                    # pinning the context ring's avg hit rate at a false 0%.
                    promptDetails = as_dict(eventUsage.get('prompt_tokens_details'), {})
                    if promptDetails.get('cached_tokens') is not None:
                        usage['cached_tokens'] = as_int(promptDetails.get('cached_tokens'), 0)
                choices = as_list(event.get('choices', []), [])
                if not choices:
                    continue
                choice = as_dict(choices[0])
                delta = as_dict(choice.get('delta', {}))
                # Some OpenAI-compatible providers (DeepSeek-R1-style "always
                # reasoning" models via OpenCode Zen, etc.) stream reasoning
                # tokens unconditionally — `reasoning_effort` is a hint they
                # often ignore entirely. Always keep the text for the next
                # request (tool-loop continuity); only surface it in the UI
                # when Thinking is enabled.
                reasoner = as_str(delta.get('reasoning_content')) or as_str(delta.get('reasoning'))
                if reasoner:
                    preservedReasoning += reasoner
                    if thinking_enabled:
                        thinkingText += reasoner
                        if emit:
                            emit({'type': 'thinking', 'content': reasoner})
                textDelta = as_str(delta.get('content', ''))
                if textDelta:
                    contentText += textDelta
                    if emit:
                        emit({'type': 'finalOutput', 'content': textDelta})
                    # Stream rules: detect narration but do NOT abort here —
                    # the hit is cancelled if a real tool_call arrives later in
                    # this turn (strong models narrate AND then emit the call);
                    # only a narration with no tool call triggers the retry.
                    if tools and _stream_rule_hit is None:
                        _stream_rule_hit = _match_stream_rule(contentText)
                for rawTc in as_list(delta.get('tool_calls', []), []):
                    tc = as_dict(rawTc)
                    if _stream_rule_hit is not None:
                        # A genuine tool call followed the narration — the
                        # narration was preamble, not a substitution.
                        _stream_rule_hit = None
                    idx = as_int(tc.get('index', 0))
                    if idx not in toolCallsAccum:
                        fn = as_dict(tc.get('function', {}))
                        toolCallsAccum[idx] = {
                            'id': tc.get('id', f'call_{uuid.uuid4().hex[:12]}'),
                            'type': 'function',
                            'function': {'name': fn.get('name', ''), 'arguments': fn.get('arguments', '')},
                        }
                    else:
                        fn = as_dict(tc.get('function', {}))
                        existing = as_dict(toolCallsAccum[idx]['function'])
                        if fn.get('arguments'):
                            existing['arguments'] = as_str(existing.get('arguments')) + as_str(fn.get('arguments'))
                        if fn.get('name'):
                            existing['name'] = as_str(existing.get('name')) + as_str(fn.get('name'))
                if choice.get('finish_reason'):
                    finishReason = as_str(choice.get('finish_reason'))
        except Exception as exc:
            # Same safety net for clients that raise on a 4xx instead of yielding
            # an in-stream error event.
            if (
                not _retried_reasoning
                and 'reasoning_effort' in body
                and not contentText
                and not thinkingText
                and _reasoning_effort_rejected(None, str(exc))
            ):
                body.pop('reasoning_effort', None)
                _retried_reasoning = True
                _retry_stream = True
            else:
                return {'error': str(exc)}
        if _retry_stream:
            continue
        if _stream_rule_hit and not toolCallsAccum:
            # Stream rule fired (narration with no real tool call) — hand
            # control back to the turn loop so it can inject the reminder
            # and retry from this point.
            return {
                'stream_rule': _stream_rule_hit,
                'text': contentText,
                'usage': usage,
                'finish_reason': finishReason or 'stop',
            }
        break

    if not contentText and not toolCallsAccum and not thinkingText and not preservedReasoning:
        # Defensive: empty success with no tools is almost always an upstream
        # failure that the stream layer failed to classify.
        return {
            'error': (
                f'Provider returned an empty response for model "{model}". '
                'Check API key, billing/credits, and that the model id is valid on this provider.'
            )
        }

    assistantMessage: dict[str, object] = {'role': 'assistant', 'content': contentText}
    from app.adapters.reasoning_policy import attach_openai_reasoning

    attach_openai_reasoning(assistantMessage, preservedReasoning or thinkingText)
    toolUses: list[dict[str, object]] = []
    if toolCallsAccum:
        tcList = []
        for idx in sorted(toolCallsAccum):
            tc = toolCallsAccum[idx]
            fn = as_dict(tc['function'])
            argsRaw = as_str(fn.get('arguments'))
            try:
                parsedArgs = json.loads(argsRaw) if argsRaw else {}
                if not isinstance(parsedArgs, dict):
                    raise ValueError('arguments must be an object')
            except (json.JSONDecodeError, TypeError, ValueError):
                # One tolerant salvage pass before marking the call invalid —
                # models wrap arguments in fences or prefix prose, and
                # recovering avoids a full validation-error round.
                from app.services.workbench.json_salvage import salvage_json_object

                saved = salvage_json_object(argsRaw) if argsRaw else None
                if saved is not None:
                    parsedArgs = saved
                else:
                    # Malformed tool arguments must NEVER execute as {} — the model
                    # would silently do the wrong thing. Mark the call so the
                    # workbench loop surfaces a validation-error tool result and
                    # the model self-heals (see `_invalid_json` handling in the
                    # turn loop).
                    parsedArgs = {'_invalid_json': argsRaw[:2000]}
            tcList.append(
                {
                    'id': tc['id'],
                    'type': 'function',
                    'function': {'name': fn['name'], 'arguments': json.dumps(parsedArgs)},
                }
            )
            toolUses.append({'type': 'tool_use', 'id': tc['id'], 'name': fn['name'], 'input': parsedArgs})
            assistantMessage['tool_calls'] = tcList
    return {
        'choices': [{'index': 0, 'message': assistantMessage, 'finish_reason': finishReason or 'stop'}],
        'text': contentText,
        'thinking': thinkingText,
        'tool_uses': toolUses,
        'usage': usage,
        'finish_reason': finishReason or 'stop',
        'stop_reason': finishReason or 'stop',
    }


# Private camelCase aliases for back-compat (tests / workbench / subagent)
_backgroundTaskModel = background_task_model
_makeReviewLlmClient = make_review_llm_client
_resolveWorkbenchProvider = resolve_workbench_provider
_resolveModel = resolve_model
_isAnthropicProvider = is_anthropic_provider
_isOpenaiProvider = is_openai_provider
_extractText = extract_text
_extractThinking = extract_thinking
_supportsThinking = supports_thinking
_callAnthropicWorkbench = call_anthropic_workbench
_callOpenaiWorkbench = call_openai_workbench
