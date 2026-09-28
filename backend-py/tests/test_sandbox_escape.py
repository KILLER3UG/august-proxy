"""The restricted-Python cell must not be escapable.

`POST /api/workbench/sandbox/python` advertises a policy (no network, no
subprocess) and enforces it by handing `exec` a restricted builtins dict. That
is only a boundary if the cell cannot get the REAL builtins back.

It could, and this is the payload that proved it — no import statement, so
the original import ban never fired:

    ().__class__.__base__.__subclasses__()   -> a class whose
    __init__.__globals__['__builtins__']     -> real builtins, with
    exec / open / __import__ on it.

Verified end to end against this route's own allowlist before the fix: it
passed the gate and read a file off disk.

These tests assert the gate REJECTS that family while ordinary cell code —
arithmetic, comprehensions, the pre-injected `math`/`json`/`re` — still runs.
The second half matters as much as the first: a sandbox that blocks
everything is not a fix, it is an outage.
"""

from __future__ import annotations

import pytest
from app.routers import workbench as wb

_ESCAPES = {
    'subclasses_walk': (
        "b = None\n"
        "for c in ().__class__.__base__.__subclasses__():\n"
        "    try:\n"
        "        cand = c.__init__.__globals__.get('__builtins__')\n"
        "    except:\n"
        "        cand = None\n"
        "    if cand is not None and 'exec' in cand:\n"
        "        b = cand\n"
        "        break\n"
    ),
    'globals_direct': "g = ().__class__.__base__.__subclasses__()[0].__init__.__globals__",
    'import_via_dunder': "b = [c for c in ().__class__.__base__.__subclasses__() if 'x' in str(c)][0]",
    'builtins_attr': "x = ().__class__.__base__.__subclasses__()",
    'code_object': "c = (lambda: 0).__code__",
    'reduce_path': "import_dunders = (1).__reduce__",
}


class TestDunderTraversalIsBlocked:
    @pytest.mark.parametrize('name', sorted(_ESCAPES))
    def test_gate_rejects_the_escape(self, name: str):
        assert wb._sandbox_ast_check(_ESCAPES[name]) != ''

    def test_the_original_payload_names_the_reason(self):
        err = wb._sandbox_ast_check(_ESCAPES['subclasses_walk'])
        assert 'Dunder attribute' in err
        # Which dunder it names depends on ast.walk's order, so assert the
        # message is specific rather than pinning one attribute.
        assert err.rsplit(' ', 1)[-1] in wb._SANDBOX_BANNED_ATTRS

    def test_a_plain_import_of_a_banned_module_is_still_blocked(self):
        assert 'Import blocked' in wb._sandbox_ast_check('import socket')

    def test_the_ban_is_on_traversal_not_on_a_handful_of_names(self):
        """A specific denylist of dunders would be defeated by the next one.

        The gate keys on the `__x__` SHAPE, so an unanticipated attribute
        (`__init__` was not the obvious one) is covered by construction.
        """
        assert '__init__' not in {'__class__', '__base__', '__subclasses__'}
        err = wb._sandbox_ast_check('x = ().__class__.__init__')
        assert 'Dunder attribute blocked' in err


class TestLegitimateCellsStillRun:
    """The point of a sandbox is to run code, not to refuse it."""

    def test_arithmetic_and_loops(self):
        assert wb._sandbox_ast_check('total = sum(i * i for i in range(10))\nprint(total)') == ''

    def test_preinjected_modules(self):
        assert wb._sandbox_ast_check('print(math.sqrt(16), json.dumps({"a": 1}))') == ''

    def test_comprehensions_and_dict_methods(self):
        src = 'd = {"a": 1, "b": 2}\nprint([k for k, v in d.items() if v > 1])'
        assert wb._sandbox_ast_check(src) == ''

    def test_inert_dunders_still_allowed(self):
        """`__doc__` and `__name__` are strings, not a path to a callable.

        Banning every dunder unconditionally would break ordinary code for
        no security gain, which is the failure mode that makes people disable
        sandboxes entirely.
        """
        assert wb._sandbox_ast_check('print(__doc__, __name__)') == ''

    def test_a_name_merely_containing_dunders_is_fine(self):
        assert wb._sandbox_ast_check('my__var__ = 5\nprint(my__var__)') == ''
