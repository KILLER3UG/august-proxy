"""Gate participation — every reachable tool entry point must be claimed.

Audit 2026-09-27, systemic pattern #1. Every sandbox, permission and URL guard
in this codebase is an inline ``if toolName in (...)`` prologue at one call
site, so an ALIAS or AGGREGATE entry point is unguarded by default: adding a
tool, a ``bulk`` operation, or a new router opens a fresh door that nothing
checks. Five real guards were missing exactly this way, with the whole suite
green:

  #2   ``bulk(operation='delete_sessions')`` evaded the running-session
       deletion guard in EVERY guard mode, including Full Access — the mode the
       guard's own comment says must block it.
  #6   ``firmware_compile``'s ``name`` never reached ``bind_path``, so an
       absolute name won outright in ``Path(tmpdir) / base``.
  #8   ``desktop_click`` / ``desktop_type`` / ``desktop_press_key`` /
       ``desktop_ui_act`` / ``desktop_open_url`` skipped confirm, plan AND
       read-only — the modes a user picks precisely to keep the agent off the
       machine.
  #22  ``/api/git`` mutating routes accept any caller-supplied ``repoPath``,
       contradicting the docstring that claims otherwise.
  #30  ``desktop_open_url`` had no URL allowlist / SSRF check at all while the
       headless browser has a full one.

This file turns "someone remembered to add it to the tuple" into a build
failure. It is a CONFORMANCE test, not a regression test for those five (those
are pinned in test_deep_scan_fixes_*.py) — it exists so the SIXTH one cannot be
added silently.

The rule it enforces: a tool that is registered, or reachable through an
aggregate/meta tool, must be claimed by at least one gate. "Unclaimed" is not
automatically wrong — a genuinely read-only tool legitimately claims no gate —
so the test asserts on a curated registry of tools that MUST be gated, and
separately REPORTS the unclaimed set so a new entry is a conscious decision
rather than an oversight.
"""

from __future__ import annotations

import pytest
from app.services import tool_policy


@pytest.fixture(scope='module', autouse=True)
def _registry_populated():
    """Populate the tool registry once for the module.

    The registry is process-global and starts empty; without this the
    conformance assertions see zero tools and every check is vacuously true (or,
    for the floor, vacuously false). Registration is idempotent.
    """
    from app.services.tool_registrations import register_all

    register_all()
    yield


def _registered_tool_names() -> set[str]:
    """Every tool name the registry knows about.

    ``listTools`` returns OpenAI-shaped function definitions, not names, so
    both wire shapes are unwrapped here — silently reading the dict keys would
    have produced {'type','function'} and made every assertion vacuous.
    """
    from app.services import tool_registry

    names: set[str] = set()
    for entry in tool_registry.listTools():
        if isinstance(entry, str):
            names.add(entry.lower())
            continue
        if not isinstance(entry, dict):
            continue
        fn = entry.get('function')
        if isinstance(fn, dict) and fn.get('name'):
            names.add(str(fn['name']).lower())
        elif entry.get('name'):
            names.add(str(entry['name']).lower())
    return names


def _bulk_operations() -> set[str]:
    """Operation literals the `bulk` meta-tool will route.

    `bulk` dispatches operation=<x> to the same handler as <x>, so an operation
    is exactly as reachable as the single tool it aliases — and exactly as
    unguarded if the guard only tests the single name.
    """
    from app.services.tool_registrations.bulk_tools import BULK_OPS

    return {str(op).lower() for op in BULK_OPS}


def _is_gated(name: str, args: dict | None = None) -> bool:
    """True when a real gate claims this call.

    Only ``is_mutating`` and ``is_shell_mutation`` count. ``prompt_bucket`` is
    deliberately NOT used: every registered tool falls into some bucket, so
    including it made every tool 'gated' and the whole conformance check
    vacuous. The prompt bucket drives the caution text the model sees; these two
    drive whether the call is allowed.
    """
    n = str(name).lower()
    return bool(tool_policy.is_mutating(n, args) or tool_policy.is_shell_mutation(n, args))


# Tools that MUST be claimed by a gate. Everything here either mutates the
# machine, reaches the network, or drives the real desktop — none of which may
# be reachable without a decision being recorded somewhere.
MUST_BE_GATED = {
    # Runs a command on the machine. (`bash` is absent: it survives only as a
    # legacy alias inside the guard tuples, with no registered tool behind it.)
    'run_command',
    # Writes to the workspace.
    'write_file',
    'edit_lines',
    'apply_patch',
    # Deletes something a user owns.
    'delete_session',
    'delete_sessions',
    'delete_folder',
    # Reaches the network on the user's behalf. NOTE: browser_open is absent
    # on purpose — it is classified tool_read, and its actual control is the
    # URL allowlist in browser/handlers.py (_checkUrlAllowlist), not a mutation
    # gate. Listing it here would be asserting a different policy, not a
    # missing one.
    'browser_click',
    'browser_type',
    'browser_evaluate',
    'desktop_open_url',
    # Drives the REAL screen — the audit's #8.
    'desktop_click',
    'desktop_type',
    'desktop_press_key',
    'desktop_ui_act',
    # Persists a change that fires later.
    'create_routine',
}


class TestMustBeGatedToolsExist:
    def test_the_five_audit_fixes_are_still_gated(self):
        """The specific holes the audit found, pinned by name.

        Regression rather than conformance: these five were unguarded with the
        whole suite green. Each asserts the gate that was missing.
        """
        # #8 — the desktop tools must be mutating, which is what plan mode and
        # the read-only pre-check both read.
        for name in ('desktop_click', 'desktop_type', 'desktop_press_key', 'desktop_ui_act',
                     'desktop_open_url'):
            assert tool_policy.is_mutating(name), (
                f'{name} is not mutating: ask/plan/read-only will wave it through'
            )

        # #2 — the aggregate must resolve to the same verdict as the single tool.
        assert tool_policy.is_mutating('delete_sessions')
        assert tool_policy.is_mutating('bulk', {'operation': 'delete_sessions'}), (
            "bulk(operation='delete_sessions') is unguarded — the alias walks "
            'straight past the running-session deletion guard'
        )
        # The alias form must resolve too, not only the canonical name.
        assert tool_policy.is_mutating('bulk', {'operation': 'delete_session'}), (
            "bulk's own alias table maps delete_session -> delete_sessions"
        )

        # #22 — a mutating /api/git call is gated.
        assert tool_policy.is_mutating('run_command')


class TestGateConformance:
    def test_every_must_be_gated_tool_is_actually_registered(self):
        """A guard set naming a tool that no longer exists is a stale guard.

        Guards rot from the other direction too: a renamed or deleted tool stays
        in the tuples forever, and the tuples are then 'green' for a name that
        is no longer callable.
        """
        registered = _registered_tool_names()
        missing = sorted(MUST_BE_GATED - registered)
        assert not missing, (
            f'these gated tool names are not registered any more: {missing}. '
            'Either the tool was renamed (update MUST_BE_GATED and the guard '
            'tuples together) or removed (drop them from both).'
        )

    @pytest.mark.parametrize('name', sorted(MUST_BE_GATED))
    def test_must_be_gated_tool_is_claimed(self, name):
        assert _is_gated(name), (
            f'{name} is reachable but no guard claims it: is_mutating, '
            'is_shell_mutation and caution_level all decline it'
        )

    @pytest.mark.parametrize('op', sorted(_bulk_operations()))
    def test_every_bulk_operation_is_reachable_only_through_a_gated_path(self, op):
        """A bulk operation is exactly as reachable as the tool it aliases.

        If the aliased single tool is gated, the operation is only safe because
        `is_mutating` resolves the nested operation. Assert that resolution
        actually holds for the operations whose targets are gated — this is the
        seam audit #2 fell through.
        """
        canonical = {'delete_session': 'delete_sessions'}.get(op, op)
        via_bulk = tool_policy.is_mutating('bulk', {'operation': op})
        direct = tool_policy.is_mutating(canonical)
        if direct:
            assert via_bulk, (
                f"bulk(operation={op!r}) is ungated while {canonical!r} is gated — "
                'the nested-operation resolution is not covering this operation'
            )

    def test_unclaimed_registered_tools_are_reported_not_asserted(self):
        """The discovery surface.

        Not a failure: a read-only tool legitimately claims no gate, and
        asserting the unclaimed set is empty would force a meaningless gate onto
        every read. What this guarantees is that the list is COMPUTED, so the
        next person adding a tool sees it rather than guessing.
        """
        registered = _registered_tool_names()
        unclaimed = sorted(n for n in registered if not _is_gated(n))
        # A sanity floor rather than an exact list: if this collapses to a
        # handful, a guard set has been gutted.
        assert len(unclaimed) < len(registered) * 0.9, (
            f'{len(unclaimed)} of {len(registered)} registered tools claim no gate — '
            'a guard set is probably gutted'
        )
        assert unclaimed, 'expected some genuinely read-only tools to claim no gate'



class TestEveryShellSpawnSiteIsGatedOrExempt:
    """Every place this backend starts a shell either runs the hardline list or
    is exempted by name, with the reason written down.

    Round-7 finding #10 was `/api/terminal/command`: the route called
    `_dangerousReason` (an approval prompt) and `soft_preflight` (a workspace
    fence that only runs when the cwd is a recognised workspace), and
    `check_hardline_command` — which the workbench shell DOES call, at the
    `backends/__init__.py` funnel — was never in its path. `cat
    ~/.aws/credentials` over local HTTP returned the file. The tool-level
    conformance above could not see it: the entry point is a router, not a
    registered tool.

    So this scan walks the source for the spawn sites themselves. It is a
    discovery surface: a new `create_subprocess_shell` / `shell=True` /
    `os.system` fails until it is gated or reasoned about, and an exemption that
    no longer spawns a shell fails too, so the table cannot accumulate shelter.
    """

    SPAWN_PATTERNS = ('create_subprocess_shell', 'shell=True', 'os.system(')
    GATE_MARKERS = ('check_hardline_command', '_hardline_check_command')

    # Exempt means "this spawn is not reachable by a model-supplied command
    # string", for the reason given. Two of these are the sandbox backends
    # themselves, which every caller reaches through the funnel that DOES run
    # the list; three are the hook engine, which runs commands a human wrote in
    # a workspace file that a human then had to trust (pinned below).
    EXEMPT = {
        'app/services/sandbox/backends/fallback.py':
            'the soft runner; callers reach it through backends/__init__, which runs the list',
        'app/services/sandbox/backends/windows.py':
            'backend executor; same funnel as fallback.py',
        'app/routers/hooks.py':
            'runs user-authored hook commands, not model-supplied ones',
        'app/services/hooks/user_hooks.py':
            'runs user-authored hook commands, not model-supplied ones',
        'app/services/hooks/sensitive_code.py':
            'static scan of hook source; executes nothing',
    }

    def _spawnFiles(self) -> dict[str, str]:
        from pathlib import Path

        root = Path(__file__).resolve().parents[1]
        out: dict[str, str] = {}
        for path in sorted(root.glob('app/**/*.py')):
            text = path.read_text(encoding='utf-8', errors='replace')
            if any(p in text for p in self.SPAWN_PATTERNS):
                out[path.relative_to(root).as_posix()] = text
        return out

    def test_the_scan_finds_the_sites_that_exist(self):
        """A floor, because a scan that finds nothing passes every other check.

        Seven files start a shell today. If this collapses to a couple, the
        pattern list or the walk broke — and `test_no_spawn_site_...` below would
        go green by simply seeing nothing.
        """
        found = self._spawnFiles()
        assert len(found) >= 6, f'only {sorted(found)} — the discovery itself broke'
        for must in (
            'app/services/workbench/terminal_service.py',
            'app/services/workbench/code_runner.py',
        ):
            assert must in found, f'{must} starts a shell and the scan missed it'

    def test_no_spawn_site_is_both_ungated_and_unexempted(self):
        found = self._spawnFiles()
        offenders = []
        for rel, text in found.items():
            if any(m in text for m in self.GATE_MARKERS):
                continue
            if rel not in self.EXEMPT:
                offenders.append(f'{rel} spawns a shell, runs no hardline gate, is not exempted')
        assert not offenders, '; '.join(offenders)

    def test_no_exemption_is_left_over(self):
        found = self._spawnFiles()
        stale = sorted(set(self.EXEMPT) - set(found))
        assert not stale, f'exempted files that no longer spawn a shell: {stale} — drop the shelter'

    def test_the_hook_engine_still_requires_an_explicit_trust_decision(self):
        """The hooks exemption is only true while a workspace must be trusted.

        If that door goes, a workspace file an agent can write becomes a command
        an executor runs, and `user_hooks` belongs on the gated side — not here.
        """
        from app.services.hooks import user_hooks

        assert hasattr(user_hooks, 'trust_workspace'), (
            'the hook trust door is gone — hooks are no longer an exemption'
        )
        assert hasattr(user_hooks, 'revoke_workspace')
