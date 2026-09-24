"""Progressive disclosure must not mutate the module-global bridge tool defs.

Regression: ``assembleToolDefs`` used to append its per-session short-catalog
hint onto the shared ``_BRIDGEToolDefs['tool_search']`` description in place.
Because the hint is derived from the CURRENT session's tool inventory, that
made the description grow by ~800 chars on every call, leak one session's tool
names into every other session's prompt, and permanently break provider prefix
cache for a core tool. The self-amplifying tail also inflated the token
estimate, which tripped the budget and silently dropped auto-loaded skills.
"""

from __future__ import annotations

from app.services.tools import model_tools


def _bulkToolDefs(count: int) -> list[dict]:
    """Deferrable tools heavy enough to activate progressive disclosure."""
    return [
        {
            'name': f'bulk_tool_{i}',
            'description': 'does a specific thing ' + ('y' * 300),
            'input_schema': {
                'type': 'object',
                'properties': {'a': {'type': 'string'}, 'b': {'type': 'string'}},
            },
        }
        for i in range(count)
    ]


def _toolSearchDescription(toolDefs: list[dict]) -> str:
    for td in toolDefs:
        if td.get('name') == 'tool_search':
            return str(td.get('description', ''))
    raise AssertionError('tool_search missing from assembled surface')


def _baselineBridgeDescription() -> str:
    return _toolSearchDescription(model_tools._BRIDGEToolDefs)


def test_bridge_defs_global_is_not_mutated_across_calls():
    """The module global keeps its pristine description no matter how many
    times assembly runs (and no matter which session's tools it saw)."""
    baseline = _baselineBridgeDescription()
    defs = _bulkToolDefs(400)

    for _ in range(5):
        result = model_tools.assembleToolDefs(
            list(defs),
            context_messages=[{'role': 'user', 'content': 'bulk tool work'}],
            contextLength=200000,
            thresholdPct=10.0,
            preloadK=10,
        )
        assert result.activated is True  # ensure we took the hint-patching path

    assert _baselineBridgeDescription() == baseline


def test_short_catalog_hint_still_reaches_the_model():
    """Dropping the in-place mutation must not silently disable progressive
    disclosure: the hint still ships, on this call's copy of the defs."""
    result = model_tools.assembleToolDefs(
        _bulkToolDefs(400),
        context_messages=[{'role': 'user', 'content': 'bulk tool work'}],
        contextLength=200000,
        thresholdPct=10.0,
        preloadK=10,
    )
    desc = _toolSearchDescription(result.tool_defs)
    assert 'Available (short):' in desc
    # The hint is capped at 800 chars on top of the original description.
    assert len(desc) <= len(_baselineBridgeDescription()) + 800


def test_assembly_is_byte_stable_across_calls():
    """Identical inputs must produce an identical prompt surface — this is
    what keeps the provider prefix cache warm turn over turn."""
    defs = _bulkToolDefs(400)
    kwargs = dict(
        context_messages=[{'role': 'user', 'content': 'bulk tool work'}],
        contextLength=200000,
        thresholdPct=10.0,
        preloadK=10,
    )
    first = model_tools.assembleToolDefs(list(defs), **kwargs)
    second = model_tools.assembleToolDefs(list(defs), **kwargs)

    assert _toolSearchDescription(first.tool_defs) == _toolSearchDescription(second.tool_defs)
    assert [t.get('name') for t in first.tool_defs] == [t.get('name') for t in second.tool_defs]


def test_session_tool_inventory_does_not_leak_across_sessions():
    """A tool that exists only in session A must not appear in session B's
    prompt, even after session A ran a turn."""
    sessionA = _bulkToolDefs(400) + [
        {
            'name': 'secret_session_a_tool',
            'description': 'only session A has this',
            'input_schema': {'type': 'object', 'properties': {}},
        }
    ]
    model_tools.assembleToolDefs(
        sessionA,
        context_messages=[{'role': 'user', 'content': 'bulk tool work'}],
        contextLength=200000,
        thresholdPct=10.0,
        preloadK=10,
    )

    sessionB = model_tools.assembleToolDefs(
        _bulkToolDefs(400),
        context_messages=[{'role': 'user', 'content': 'bulk tool work'}],
        contextLength=200000,
        thresholdPct=10.0,
        preloadK=10,
    )
    assert 'secret_session_a_tool' not in _toolSearchDescription(sessionB.tool_defs)


def test_non_activated_path_is_unchanged():
    """Below the token threshold nothing is deferred and no hint is added.

    The non-activated path returns the full surface verbatim — the bridge
    defs are not spliced in, so ``tool_search`` is absent unless the caller
    supplied it as a core tool.
    """
    result = model_tools.assembleToolDefs(
        _bulkToolDefs(3),
        context_messages=[{'role': 'user', 'content': 'anything'}],
        contextLength=200000,
        thresholdPct=10.0,
    )
    assert result.activated is False
    assert len(result.tool_defs) == 3
    assert 'tool_search' not in {t.get('name') for t in result.tool_defs}
