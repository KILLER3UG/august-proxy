"""Tests for markdown_export — mirrors, traversal guards, scrubbing.

The export routes are GET endpoints that build filesystem paths from query
params; the traversal guards here are security regression tests.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from app.services.memory import markdown_export as mx


@pytest.fixture()
def _export_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Point the exporter at a temp data dir and force-enable the flag."""
    monkeypatch.setattr(mx, "_data_dir", lambda: tmp_path)
    monkeypatch.setenv("AUGUST_MEMORY_MD_EXPORT", "1")
    # Feature-flag lookup may still consult cognitive_config; force-enable.
    monkeypatch.setattr(mx, "_enabled", lambda: True)
    return tmp_path


def test_disabled_flag_short_circuits(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AUGUST_MEMORY_MD_EXPORT", "0")
    monkeypatch.setattr(
        "app.services.cognitive_config.get_features",
        lambda: {"memory_md_export": False},
        raising=False,
    )
    assert mx.export_memory_markdown() is None
    assert not (tmp_path / "memory.md").exists()


def test_traversal_folder_id_rejected(_export_env: Path) -> None:
    """folder_id with separators/dot-segments must not write outside memory/."""
    for evil in ("../../etc/passwd", "..\\..\\win", "a/b", "a\\b", "..", "."):
        out = mx.export_memory_markdown(folder_id=evil)
        assert out is None, f"traversal id accepted: {evil!r}"
    # Nothing escaped the sandbox dir
    assert list(_export_env.rglob("passwd")) == []


def test_clean_folder_id_writes_inside_memory_dir(_export_env: Path) -> None:
    out = mx.export_memory_markdown(folder_id="folder_abc123")
    if out is not None:  # no memories in DB is fine — route falls back to empty view
        resolved = Path(out).resolve()
        allowed = {_export_env.resolve(), (_export_env / "memory").resolve()}
        assert any(resolved.is_relative_to(a) for a in allowed)


def test_prompt_mirror_with_prebuilt_tiers(_export_env: Path) -> None:
    """Prebuilt tiers are written verbatim; per-session mirror lands in .aug."""
    sess = {"id": "wb_test1", "folderId": "folder_x", "workspacePath": ""}
    out = mx.export_system_prompt_markdown(sess, tiers=("T1-BODY", "T2-BODY", "T3-BODY"))
    assert out is not None
    text = Path(out).read_text(encoding="utf-8")
    assert "T1-BODY" in text and "T2-BODY" in text and "T3-BODY" in text
    assert "wb_test1" in text


def test_prompt_mirror_session_path_scoped_to_aug(_export_env: Path) -> None:
    sess = {"id": "wb_test2"}
    out = mx.export_system_prompt_markdown(sess, tiers=("a", "b", "c"))
    assert out is not None
    resolved = Path(out).resolve()
    aug = (_export_env / ".aug").resolve()
    assert resolved.is_relative_to(aug), f"mirror escaped .aug: {resolved}"
    assert (aug / "system-prompt" / "wb_test2.md").exists()


def test_scrub_redacts_secret_like_content() -> None:
    assert mx._scrub('api_key = "super-secret-value-123"') == "[redacted: potential secret]"
    assert mx._scrub("harmless note") == "harmless note"


def test_debounce_collapses_bursts(monkeypatch: pytest.MonkeyPatch) -> None:
    mx._last_export.clear()
    calls: list[tuple[str, str]] = []
    monkeypatch.setattr(
        mx, "export_memory_markdown", lambda folder_id="", origin="all": calls.append((folder_id, origin)) or None
    )
    mx.debounced_export_memory(folder_id="f1", delay_s=60)
    mx.debounced_export_memory(folder_id="f1", delay_s=60)
    mx.debounced_export_memory(folder_id="f1", delay_s=60)
    # Worker thread is async; give it a beat
    import time

    for _ in range(50):
        if calls:
            break
        time.sleep(0.02)
    assert len(calls) == 1
