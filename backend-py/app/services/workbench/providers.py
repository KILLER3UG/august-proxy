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
    effort_to_thinking_budget,
    effort_to_openai_reasoning_effort,
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
                body = {'model': _reviewModel, 'messages': prompt, 'max_tokens': 1024}
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


def resolve_workbench_provider(provider_name: str, model_hint: str = '') -> dict[str, object] | None:
    """Resolve a provider from name or model hint."""
    from app.providers import resolver as providerResolver

    if provider_name:
        provider = providerResolver.resolve(provider_name)
        if provider:
            return provider
    if model_hint:
        provider = providerResolver.resolve(model_hint)
        if provider:
            return provider
    providers = providerResolver.list_available()
    return providers[0] if providers else None


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
    return provider is not None and as_str(provider.get('apiMode')) == 'anthropicMessages'


def is_openai_provider(provider: dict[str, object] | None) -> bool:
    return provider is not None and as_str(provider.get('apiMode')) in ('openaiChat', 'openaiChat', 'codexResponses')


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
            parts.append(as_str(block.get('text', '')))
    return '\n'.join(parts)


def supports_thinking(provider: dict[str, object], model: str) -> bool:
    """Check if a provider/model supports Anthropic-style thinking."""
    profiles = as_dict(provider.get('modelProfiles', {}))
    profile = as_dict(profiles.get(model) or profiles.get('*') or {})
    return as_bool(profile.get('supportsThinking')) or as_bool(profile.get('supportsReasoning'))


async def call_anthropic_workbench(
    messages: list[dict[str, object]],
    system_text: str,
    model: str,
    tools: list[dict[str, object]],
    effort: str,
    provider: dict[str, object] | None = None,
    emit: Callable[[dict[str, object]], None] | None = None,
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
    req = AnthropicRequest(model=model, max_tokens=8192)
    body = buildAnthropicUpstreamRequest(req, model, [{'type': 'text', 'text': system_text}])
    body['messages'] = anthropicMessages
    if tools:
        body['tools'] = tools
    thinkingBudget = effort_to_thinking_budget(effort)
    if thinkingBudget > 0 and supports_thinking(provider, model):
        body['thinking'] = {'type': 'enabled', 'budget_tokens': thinkingBudget}
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
    req = ChatCompletionRequest(model=model)
    body: dict[str, object] = req.model_dump()  # type: ignore[assignment]
    body['messages'] = openaiMessages
    body['max_tokens'] = 8192
    if tools:
        body['tools'] = tools
    reasoning = effort_to_openai_reasoning_effort(effort)
    if reasoning:
        body['reasoning_effort'] = reasoning
        contentText = ''
        thinkingText = ''
        toolCallsAccum: dict[int, dict[str, object]] = {}
        finishReason: str | None = None
        usage: dict[str, int] = {}
        try:
            async for event in client.chat_completions_stream(body):
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
                reasoner = as_str(delta.get('reasoning_content')) or as_str(delta.get('reasoning'))
                if reasoner:
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
    assistantMessage: dict[str, object] = {'role': 'assistant', 'content': contentText}
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
