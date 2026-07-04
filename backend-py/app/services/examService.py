"""
v3 — Exam service: Prefrontal-driven exam authoring, validation, and persistence.

The defining rule: the model authors every question. No endpoint accepts a
client-supplied correct_index. Questions are validated (4 options, valid
correct_index, non-empty rationale) before being persisted.
"""
from __future__ import annotations
import json
import logging
logger = logging.getLogger(__name__)

async def _callPrefrontal(prompt: str, model: str='', provider: str='') -> str:
    """v3: Call the Prefrontal model. Returns raw text response (may include code fences)."""
    try:
        from app.services.workbench import modelFleet
        from app.providers import resolver as providerResolver
        from app.providers.clients import getClient
        if not model:
            model = modelFleet.getModelForRole('prefrontal')
        if not model:
            logger.warning('_call_prefrontal: no prefrontal model configured. Set one in Settings > Model Fleet.')
            return ''
        # If the caller provided a provider name, resolve by provider first
        if provider:
            provider_config = providerResolver.resolve(provider)
            if provider_config:
                client = getClient(provider_config)
                if client and hasattr(client, 'generate'):
                    response = await client.generate(prompt)
                    return response or ''
        # Otherwise try to resolve by model ID
        provider_config = providerResolver.resolve(model)
        if not provider_config:
            logger.warning('_call_prefrontal: no provider found for model %s, trying first available', model)
            available = [p for p in providerResolver.listAvailable() if p.get('api_key')]
            provider_config = available[0] if available else None
        if not provider_config:
            logger.warning('_call_prefrontal: no provider configured. Set one in Settings > Model Fleet.')
            return ''
        client = getClient(provider_config)
        if client and hasattr(client, 'generate'):
            response = await client.generate(prompt)
            return response or ''
    except Exception as exc:
        logger.warning('_call_prefrontal failed: %s', exc)
    return ''

def _validateQuestion(q: object) -> bool:
    """A valid question has stem, 4 options, valid correct_index, non-empty rationale."""
    if not isinstance(q, dict):
        return False
    if not isinstance(q.get('stem'), str) or not q['stem'].strip():
        return False
    opts = q.get('options')
    if not isinstance(opts, list) or len(opts) != 4:
        return False
    if not all((isinstance(o, str) and o.strip() for o in opts)):
        return False
    ci = q.get('correct_index')
    if not isinstance(ci, int) or ci < 0 or ci > 3:
        return False
    if not isinstance(q.get('rationale'), str) or not q['rationale'].strip():
        return False
    return True

def _stripCodeFences(raw: str) -> str:
    """Remove ```json ... ``` wrappers that models commonly emit."""
    cleaned = (raw or '').strip()
    if cleaned.startswith('```'):
        lines = cleaned.split('\n')
        if lines and lines[0].startswith('```'):
            lines = lines[1:]
        if lines and lines[-1].startswith('```'):
            lines = lines[:-1]
        cleaned = '\n'.join(lines).strip()
    return cleaned

def _parseQuestions(raw: str) -> list[dict]:
    """Parse the Prefrontal response into a list of validated questions."""
    cleaned = _stripCodeFences(raw)
    try:
        data = json.loads(cleaned)
    except json.JSONDecodeError as exc:
        raise ValueError(f'Prefrontal returned invalid JSON: {exc}') from exc
    if not isinstance(data, list):
        raise ValueError('Prefrontal output is not a JSON array')
    valid = [q for q in data if _validateQuestion(q)]
    return valid

def _buildPrompt(topic: str, count: int, difficulty: str, context: str='', similarTo: list[dict] | None=None) -> str:
    """Build the Prefrontal prompt for exam authoring."""
    parts = [f'Generate {count} multiple-choice question(s) on the topic: {topic}.', f'Difficulty: {difficulty}.', '', 'Each question must have:', "  - 'stem': a clear question string", "  - 'options': exactly 4 distinct non-empty strings", "  - 'correct_index': integer 0-3 pointing to the correct option", "  - 'rationale': a 1-sentence explanation of the correct answer", '', 'Return ONLY a JSON array (no other text, no markdown fences): [{"stem": str, "options": [str, str, str, str], "correct_index": 0-3, "rationale": str}]']
    if context:
        parts.insert(1, f'\nGrounded in the following source material:\n{context}\n')
    if similarTo:
        example = similarTo[0]
        parts.insert(1, f'''\nSimilar in style to: stem="{example.get('stem', '')}" options={example.get('options', [])}''')
    return '\n'.join(parts)

async def generateQuestions(topic: str, count: int, difficulty: str, context: str='', model: str='', provider: str='') -> list[dict]:
    """Call Prefrontal, validate, and return up to `count` valid question dicts.

    Raises ValueError if the model output can't be made valid.
    """
    prompt = _buildPrompt(topic=topic, count=count, difficulty=difficulty, context=context)
    raw = await _callPrefrontal(prompt, model=model, provider=provider)
    if not raw:
        raise ValueError('Prefrontal returned empty response')
    valid = _parseQuestions(raw)
    if len(valid) < count:
        raise ValueError(f'Prefrontal produced {len(valid)} valid question(s); need {count}')
    return valid[:count]

async def generateOneQuestion(topic: str, requestText: str, similarTo: list[dict] | None=None) -> dict:
    """Generate a single question based on a user request (for /api/exam/{id}/questions).

    Accepts either a JSON object (preferred — matches the "one question" intent)
    or a JSON array with one element.
    """
    prompt = _buildPrompt(topic=f'{topic} (specific ask: {requestText})', count=1, difficulty='medium', similar_to=similarTo)
    raw = await _callPrefrontal(prompt)
    if not raw:
        raise ValueError('Prefrontal returned empty response')
    cleaned = _stripCodeFences(raw)
    try:
        data = json.loads(cleaned)
    except json.JSONDecodeError as exc:
        raise ValueError(f'Prefrontal returned invalid JSON: {exc}') from exc
    if isinstance(data, dict):
        data = [data]
    if not isinstance(data, list) or not data:
        raise ValueError('Prefrontal output is not a valid question (or list)')
    valid = [q for q in data if _validateQuestion(q)]
    if not valid:
        raise ValueError('Prefrontal produced no valid question')
    return valid[0]

async def helpExplanation(stem: str, options: list[str], userQuestion: str) -> str:
    """Get a model-generated explanation that does NOT reveal the correct answer."""
    prompt = f"Question: {stem}\nOptions: {' / '.join(options)}\nUser asks: {userQuestion}\n\nExplain the underlying concept so the user can answer the question themselves. Do NOT reveal which option is correct."
    explanation = await _callPrefrontal(prompt)
    return explanation or '(no explanation available)'

def stripAnswer(question: dict) -> dict:
    """Strip correctIndex and rationale before sending to the client."""
    return {'id': question.get('id'), 'examId': question.get('examId'), 'position': question.get('position'), 'stem': question.get('stem'), 'options': question.get('options')}