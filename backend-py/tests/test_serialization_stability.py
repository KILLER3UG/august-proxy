"""Part 18 P1.3 — serialization stability in the prompt path.

Prefix caching requires byte-identical serialization of every JSON blob
embedded in the prompt: the same logical payload with a different dict
key order must serialize to identical bytes. The audited blobs:

* ``<session_state>`` scratchpad + last_tool_failure (workbench.py)
* subagent ``yieldSchema`` (subagent.py goal text)

These are the prompt-path entries where JSON comes from request data or
model-written state (order varies by writer); tool definitions and the
memory index are constructed in fixed order already.
"""

from __future__ import annotations


def test_session_state_scratchpad_key_order_invariant(isolatedData):
    """Two scratchpad dicts with identical content, different key order,
    must render a byte-identical <session_state> block."""
    from app.services.workbench import workbench as wb

    s1 = wb.createWorkbenchSession()
    s1._working_memory = {'b': 2, 'a': 1, 'c': [{'k': 1, 'j': 2}]}
    s1._failure_feedback = {'detail': 'boom', 'exit': 1}

    s2 = wb.createWorkbenchSession()
    s2._working_memory = {'c': [{'j': 2, 'k': 1}], 'a': 1, 'b': 2}
    s2._failure_feedback = {'exit': 1, 'detail': 'boom'}

    block1 = wb._sessionStateBlock(s1)
    block2 = wb._sessionStateBlock(s2)
    assert block1 == block2, 'scratchpad/failure JSON key order leaks into prompt bytes'


def test_subagent_yield_schema_key_order_invariant(isolatedData):
    """The same yieldSchema with different key orders must render an
    identical schema segment in the subagent goal text."""
    from app.services.workbench import subagent as sa

    a = {'type': 'object', 'properties': {'b': {'type': 'string'}, 'a': {'type': 'integer'}}}
    b = {'properties': {'a': {'type': 'integer'}, 'b': {'type': 'string'}}, 'type': 'object'}
    assert sa._renderYieldSchema(a) == sa._renderYieldSchema(b)
    assert '"type": "string"' in sa._renderYieldSchema(a)
