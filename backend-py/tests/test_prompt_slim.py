"""Latency fix 3 — system prompt slimming.

Measured (2026-09-02, live buildSystemPrompt on this repo, agent mode):
  system prompt = 29,716 chars ≈ 7,400 tokens, of which
  <harness_guide> = 12,949 chars (43%!) — the FULL bodies of the
  august-harness + august-tools skills inlined, despite the intake line
  already saying "Bodies load on demand via load_skill" and <core> already
  carrying the operating rules.

Every prompt token is TTFT and cost on EVERY request; 3.2k tokens of
duplicated skill prose re-serializes per turn and (for Anthropic-style
caching) sits INSIDE the cached prefix — fine when cached, but it is also
re-READ cost on cold sessions and pure noise for model attention.

Fix: the harness guide rides as a COMPACT digest (the loop contract in ~20
lines), full bodies stay loadable via load_skill. Cache-sentinel suite
must stay green (the digest is byte-stable per session like the old body).
"""

from __future__ import annotations

import os
import re
import sys
from pathlib import Path

import pytest

TMP = os.environ.get("TEMP", "/tmp")
os.environ.setdefault("AUGUST_DATA_DIR", os.path.join(TMP, "august_prompt_slim"))
Path(os.environ["AUGUST_DATA_DIR"]).mkdir(parents=True, exist_ok=True)
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.services.workbench import workbench as wb  # noqa: E402


def _buildPrompt() -> str:
    # Pin the tool surface: buildSystemPrompt's <capabilities> block scales
    # with what's registered, and other test modules register tools into the
    # global registry. Without this the budget assertion measures a different
    # prompt depending on test order (19k solo vs 24k in a full run).
    from app.services.tool_registrations import register_all

    register_all()
    session = wb.createWorkbenchSession(provider='stub-anthropic')
    session.workspacePath = str(Path(__file__).resolve().parent.parent)
    tools = wb.toolDefinitions(session)
    return wb.buildSystemPrompt(session, tools)


class TestPromptSlim:
    def test_harness_guide_is_a_digest_not_full_body(self):
        p = _buildPrompt()
        m = re.search(r"<harness_guide>(.*?)</harness_guide>", p, re.DOTALL)
        assert m, "harness_guide block must exist"
        guide = m.group(1)
        assert len(guide) < 4000, (
            f"harness_guide is {len(guide)} chars — the two full skill bodies "
            "inline ~12.9k; the digest must stay a digest (<4k)"
        )
        # The loop contract essentials stay present…
        for needle in ("update_state", "plan mode", "load_skill"):
            assert needle.lower() in guide.lower(), f"digest lost essential: {needle}"
        # …but not the full skill prose.
        assert "## When to Use" not in guide, "full skill body prose must be gone"
        assert "## skill:august-harness" not in guide, "full skill inlining must be gone"

    def test_total_prompt_budget(self):
        p = _buildPrompt()
        # The budget covers the HARNESS SCAFFOLD — everything the harness
        # authors itself. <workspace> (code map) and <aug_directives>
        # (AGENTS.md) are user content that legitimately varies per repo,
        # so they're excluded; the pre-digest scaffold was ~14k, the digest
        # cut ~11.5k of duplicated skill prose out of it.
        scaffold = re.sub(r'<workspace>.*?</workspace>', '', p, flags=re.DOTALL)
        scaffold = re.sub(r'<aug_directives>.*?</aug_directives>', '', scaffold, flags=re.DOTALL)
        assert len(scaffold) < 12000, (
            f"harness scaffold is {len(scaffold)} chars (~{len(scaffold)//4} tokens) — "
            "target <12k; the biggest chunk was harness_guide"
        )
