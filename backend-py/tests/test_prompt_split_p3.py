"""P3 prompt_build.py split — regression guards (2026-09-11).

The split moved the git probe, model display name, harness-guide and
capabilities memos, cache-buster and memory-nudge pair out of workbench.py.
Every old reference site (tests via wb.*, skill_service, prompt internals)
must keep resolving to the SAME objects — a silent copy would leave a second
caps cache that skill mutations never bust.
"""

from __future__ import annotations


def test_workbench_reexports_are_identical_objects() -> None:
    from app.services.workbench import prompt_build as pb
    from app.services.workbench import workbench as wb

    for name in (
        '_probe_workspace_git',
        '_modelDisplayName',
        '_harness_guide_text',
        'clear_skill_prompt_caches',
        'queue_memory_habit_nudge',
        'memory_nudge_block',
    ):
        assert getattr(wb, name) is getattr(pb, name), name
    # Memo dicts are SHARED, not copied: a clear through either path empties
    # the one cache the prompt builder reads and writes.
    assert wb._caps_block_cache is pb._caps_block_cache
    assert wb._harness_guide_cache is pb._harness_guide_cache
    assert wb._git_probe_cache is pb._git_probe_cache


def test_caps_cache_clear_via_workbench_empties_prompt_build() -> None:
    from app.services.workbench import prompt_build as pb
    from app.services.workbench import workbench as wb

    pb._caps_block_cache['probe-key'] = 'x'
    wb.clear_skill_prompt_caches()
    assert 'probe-key' not in pb._caps_block_cache


def test_skill_service_bust_path_targets_prompt_build() -> None:
    """skill_service imports the real module (mypy re-export trap): the call
    site must point at prompt_build, not rely on workbench's alias."""
    import inspect

    from app.services import skill_service

    src = inspect.getsource(skill_service)
    assert 'from app.services.workbench.prompt_build import clear_skill_prompt_caches' in src
