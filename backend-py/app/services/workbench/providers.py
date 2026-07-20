"""
Provider resolution and LLM call helpers for workbench chat.

Owns workbench provider/model resolution, content-block extraction, and the
Anthropic / OpenAI streaming call paths used by the chat loop and subagents.

Extracted from workbench.py for Phase 3 modularization.
"""

from __future__ import annotations

import json
import uuid
from typing import Callable

from app.json_narrowing import as_str, as_dict, as_list, as_int, as_bool
from app.models import AnthropicRequest, ChatCompletionRequest
from app.services.workbench.effort import (
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
    try:
        from app.services.background_review_service import getConfig

        cfg = getConfig()
        if cfg.get('enabled') and cfg.get(task_key):
            return as_str(cfg[task_key])
    except Exception:
        pass
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
        reviewConfig: dict[str, object] | None = None
        try:
            from app.services.background_review_service import getConfig

            reviewConfig = getConfig()
            review_model = reviewConfig.get('reviewModel', '') or review_model_hint
            if review_model:
                provider = providerResolver.resolve(as_str(review_model))
        except Exception:
            review_model = review_model_hint
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
        _reviewModel = review_model or 'claude-sonnet-4-20250514'

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
    from app.services import provider_credentials
    from app.services import config_service

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


def resolve_chat_llm(
    *,
    model: str = '',
    model_provider: str = '',
    session_provider: str = '',
    session_model: str = '',
) -> tuple[dict[str, object] | None, str]:
    """Same resolution order as workbench chat turns.

    Order:
      1. explicit modelProvider
      2. model id hint
      3. session.provider + model/session.model
      4. first available provider
    Then model = explicit model → session.model → provider default.
    """
    resolved_provider: dict[str, object] | None = None
    if model_provider:
        resolved_provider = resolve_workbench_provider(model_provider, '')
    if not resolved_provider and model:
        resolved_provider = resolve_workbench_provider('', model)
    if not resolved_provider:
        resolved_provider = resolve_workbench_provider(session_provider, model or session_model)
    if not resolved_provider:
        resolved_provider = resolve_workbench_provider('', '')
    resolved_model = resolve_model(resolved_provider, model or session_model or '')
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
    if thinking_budget > 0:
        body['thinking'] = {'type': 'enabled', 'budget_tokens': thinking_budget}
    agg = AnthropicWorkbenchStreamAggregator(emit=emit)
    try:
        async for event in client.messages_stream(body):
            agg.on_event(event)
            if agg.error:
                return {'error': agg.error}
    except Exception as exc:
        return {'error': str(exc)}
    return agg.result()


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
        reasoning = effort_to_openai_reasoning_effort(effort)
        if reasoning and provider_accepts_reasoning_effort(provider, model):
            body['reasoning_effort'] = reasoning

    contentText = ''
    thinkingText = ''
    # Always accumulate reasoning for tool-loop re-sends (DeepSeek/Kimi require it).
    # UI emit / returned ``thinking`` still respect thinking_enabled.
    preservedReasoning = ''
    toolCallsAccum: dict[int, dict[str, object]] = {}
    finishReason: str | None = None
    usage: dict[str, int] = {}
    try:
        async for event in client.chat_completions_stream(body):
            # Surface HTTP/provider errors instead of returning an empty "success".
            if as_str(event.get('type')) == 'error' or event.get('error') is not None:
                msg = _extract_upstream_error_message(event)
                return {'error': msg or 'Upstream provider error'}

            eventType = event.get('_event_type', '')
            if eventType not in ('chat.completion.chunk', ''):
                pass
            eventUsage = as_dict(event.get('usage'))
            if eventUsage:
                usage['input_tokens'] = as_int(eventUsage.get('prompt_tokens', 0))
                usage['output_tokens'] = as_int(eventUsage.get('completion_tokens', 0))
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
            for rawTc in as_list(delta.get('tool_calls', []), []):
                tc = as_dict(rawTc)
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
        return {'error': str(exc)}

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
            try:
                parsedArgs = json.loads(as_str(fn.get('arguments'))) if fn.get('arguments') else {}
            except (json.JSONDecodeError, TypeError):
                parsedArgs = {}
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
