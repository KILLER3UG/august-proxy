"""Model listing API routes.

Port of model-list.js aggregation + Express routes.

Response models inherit from :class:`CamelModel` so internal attributes
stay snake_case while the JSON sent to the frontend remains camelCase
(see ``app/models/camel_base.py``). The aggregation logic in
``model_service`` is untouched; only the return shape is wrapped.
"""

from __future__ import annotations

from fastapi import APIRouter, Query
from pydantic import ConfigDict
from pydantic.alias_generators import to_camel

from app.json_narrowing import as_list
from app.models.camel_base import CamelModel
from app.services import model_service

router = APIRouter()


class ModelInfo(CamelModel):
    """A single provider model, exposed with camelCase JSON keys.

    ``extra='allow'`` preserves any provider-specific fields returned by
    ``model_service.aggregate`` that are not modelled explicitly, so the
    serialized output matches the previous dict-based response exactly.
    """

    id: str
    provider: str = ""
    context_window: int | None = None
    display_name: str | None = None

    model_config = ConfigDict(
        extra="allow",
        alias_generator=to_camel,
        populate_by_name=True,
        # /api/models emits contextWindow (camelCase) via by_alias at the
        # dump boundary — `ser_json_by_alias` was never a valid pydantic 2.x
        # config key (silent no-op), so it was removed.
    )


class ModelList(CamelModel):
    """Aggregated model listing response."""

    models: list[ModelInfo]
    has_more: bool
    total: int


@router.get('/api/models', response_model=ModelList)
async def listModels(
    refresh: bool = Query(False),
    limit: int = Query(0),
    offset: int = Query(0),
):
    """Aggregated model list from all providers.

    Fetches from each provider's /models endpoint with fallback
    to static lists. Results are cached for 5 minutes.
    """
    models = await model_service.aggregate(refresh=refresh)
    total = len(models)
    if limit > 0:
        models = models[offset : offset + limit]
    return ModelList(
        models=[ModelInfo.model_validate(m) for m in models],
        has_more=offset + limit < total,
        total=total,
    )


@router.get('/v1/models')
async def openaiModels():
    """OpenAI-compatible model list (no pagination)."""
    models = await model_service.aggregate()
    return {
        'object': 'list',
        'data': [
            {
                'id': m['id'],
                'object': 'model',
                'created': 0,
                'owned_by': m.get('provider', 'unknown'),
            }
            for m in models
        ],
    }


@router.get('/api/models/catalog')
async def model_catalog(
    provider: str = Query(''),
    capability: str = Query(''),
    q: str = Query(''),
):
    models = await model_service.aggregate()
    out = []
    ql = q.lower().strip()
    pl = provider.lower().strip()
    for m in models:
        mid = str(m.get('id', ''))
        prov = str(m.get('provider', ''))
        caps = as_list(m.get('capabilities'), [])
        if pl and pl not in prov.lower():
            continue
        if capability and capability not in caps:
            continue
        if ql and ql not in mid.lower() and ql not in prov.lower():
            continue
        out.append(
            {
                'id': mid,
                'provider': prov,
                'aliases': m.get('aliases') if isinstance(m.get('aliases'), list) else [],
                'capabilities': caps,
            }
        )
    return {'models': out, 'count': len(out)}


@router.get('/api/models/capabilities')
async def model_capabilities():
    models = await model_service.aggregate()
    caps: set[str] = set()
    for m in models:
        raw = m.get('capabilities')
        if isinstance(raw, list):
            for c in raw:
                caps.add(str(c))
    # Always advertise a baseline set so filters render.
    for base in ('chat', 'tools', 'vision', 'reasoning'):
        caps.add(base)
    return {'capabilities': sorted(caps)}


@router.get('/api/models/aliases')
async def model_aliases():
    from app.services import alias_service

    aliases = []
    try:
        for a in alias_service.listAliasesWire():
            aliases.append(
                {
                    'alias': a.get('alias') or a.get('displayAlias') or '',
                    'resolvesTo': a.get('targetModel') or a.get('target_model') or '',
                    'provider': a.get('targetProvider') or a.get('target_provider') or '',
                }
            )
    except Exception:
        from app.json_narrowing import as_dict, as_list
        from app.services.config_service import getConfig

        for raw in as_list(getConfig().get('modelAliases')):
            a = as_dict(raw)
            aliases.append(
                {
                    'alias': str(a.get('alias') or ''),
                    'resolvesTo': str(a.get('targetModel') or ''),
                    'provider': str(a.get('targetProvider') or ''),
                }
            )
    return {'aliases': aliases}


class CostEstimateBody(CamelModel):
    model_id: str = ''
    input_tokens: int = 0
    output_tokens: int = 0


@router.post('/api/models/estimate-cost')
async def estimate_cost(body: CostEstimateBody):
    # Placeholder pricing — honest zero when unknown rather than fake numbers.
    model = body.model_id or 'unknown'
    return {
        'model': model,
        'cost': 0.0,
        'inputTokens': body.input_tokens,
        'outputTokens': body.output_tokens,
        'currency': 'USD',
        'estimated': False,
    }
