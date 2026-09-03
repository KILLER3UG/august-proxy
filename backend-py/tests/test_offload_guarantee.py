"""P4.1 (Part 18) — background work stays background: the off-load guarantee.

The learning loop's heavy stages (mining, tier-1 scoring, judging,
consolidation) must NEVER run inside a live chat turn. Two structural
guarantees are enforced here as grep/AST gates so a future import or an
inline call fails a test instead of silently blocking the event loop:

1. The workbench turn-loop package (``app/services/workbench/``) never
   imports the learning-loop modules (episode_miner, skill_distiller,
   consolidation). Part 16's engine is post-hoc by design (its §1); the
   only legal entry is the consolidation cadence, which the workbench
   package does not touch.
2. The curator router (the manual "Run now" door) offloads the whole sync
   pass via ``asyncio.to_thread`` — no direct (on-loop) call to
   ``mine_sessions`` / ``run_distiller_pass`` / ``run_resolution_check``
   (the Part 16 §12 F-4 violation class).
"""

from __future__ import annotations

import ast
from pathlib import Path

_WORKBENCH_PACKAGE = Path(__file__).resolve().parent.parent / 'app' / 'services' / 'workbench'
_CURATOR_ROUTER = (
    Path(__file__).resolve().parent.parent / 'app' / 'routers' / 'curator.py'
)

# The learning-loop engine modules the live turn must never touch.
_BANNED_ROOTS = frozenset({'episode_miner', 'skill_distiller'})
_BANNED_MODULES = frozenset({'memory_store.consolidation', 'consolidation'})


def _module_name(node: ast.AST) -> str:
    return str(getattr(node, 'module', '') or '')


def _imported_names(source: str) -> set[str]:
    """Root + full module names pulled in by every import statement."""
    tree = ast.parse(source)
    found: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                found.add(alias.name)
                found.add(alias.name.split('.')[0])
        elif isinstance(node, ast.ImportFrom):
            if node.level:  # relative import — resolve against no package root
                continue
            mod = _module_name(node)
            found.add(mod)
            if mod:
                found.add(mod.split('.')[0])
    return found


def _analyze_offload(source: str) -> tuple[set[str], set[str]]:
    """(direct, offloaded) engine-call names.

    A call counts as OFFLOADED when it happens inside the body of a function
    that is passed to ``asyncio.to_thread`` (including nested defs inside
    that function) — the curator router's sync-pass shape. Anything else is
    a DIRECT on-loop call.
    """
    tree = ast.parse(source)

    def call_name(func: ast.AST) -> str:
        if isinstance(func, ast.Name):
            return func.id
        if isinstance(func, ast.Attribute):
            return func.attr
        return ''

    def is_to_thread(func: ast.AST) -> bool:
        return (
            isinstance(func, ast.Attribute)
            and func.attr == 'to_thread'
            and isinstance(func.value, ast.Name)
            and func.value.id in ('asyncio', 'starlette', 'anyio')
        ) or (isinstance(func, ast.Name) and func.id == 'to_thread')

    # Functions handed to asyncio.to_thread by name.
    offloaded_fns: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and is_to_thread(node.func):
            for arg in node.args:
                if isinstance(arg, ast.Name):
                    offloaded_fns.add(arg.id)

    direct: set[str] = set()
    offloaded: set[str] = set()

    def visit(node: ast.AST, inside_offloaded: bool) -> None:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            child_inside = inside_offloaded or node.name in offloaded_fns
            for child in node.body:
                visit(child, child_inside)
            return
        if isinstance(node, ast.Call):
            name = call_name(node.func)
            if name:
                if inside_offloaded:
                    offloaded.add(name)
                else:
                    direct.add(name)
            # Arguments evaluated at the call site share its context.
            for arg in node.args:
                visit(arg, inside_offloaded)
            return
        for child in ast.iter_child_nodes(node):
            visit(child, inside_offloaded)

    visit(tree, False)
    return direct, offloaded


def test_workbench_package_never_imports_the_learning_engine() -> None:
    """Gate 1: no module under the turn-loop package imports the engine."""
    violations: list[str] = []
    for path in sorted(_WORKBENCH_PACKAGE.glob('*.py')):
        found = _imported_names(path.read_text(encoding='utf-8'))
        for banned in (*_BANNED_ROOTS, *_BANNED_MODULES):
            if banned in found:
                violations.append(f'{path.name} imports {banned}')
    assert not violations, (
        'learning-loop engine imported inside the live turn package '
        '(mining/judging must stay post-hoc): ' + '; '.join(violations)
    )


def test_curator_router_offloads_every_engine_call() -> None:
    """Gate 2: the manual curator run never calls the engine on the loop."""
    source = _CURATOR_ROUTER.read_text(encoding='utf-8')
    direct, offloaded = _analyze_offload(source)
    for engine_call in ('mine_sessions', 'run_distiller_pass', 'run_resolution_check'):
        offenders = direct & {engine_call}
        assert not offenders, (
            f'{_CURATOR_ROUTER.name} calls {engine_call}() directly on the '
            'event loop — wrap the sync pass in asyncio.to_thread '
            '(Part 16 §12 F-4 violation class)'
        )
    # And the doors really are the offloaded ones (the gate is not vacuous).
    assert {'mine_sessions', 'run_distiller_pass', 'run_resolution_check'} <= offloaded, (
        'curator router no longer routes the engine pass through '
        f'asyncio.to_thread (offloaded: {sorted(offloaded)})'
    )
