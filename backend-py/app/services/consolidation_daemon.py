"""
Sleep Cycle — consolidation daemon (Phase 9a + 10.4).

v2: Background daemon triggered during idle or every 24 hours. Uses the
Hippocampus model to review recent auto_memories and learned_heuristics,
then merges duplicates, promotes recurring patterns to facts, and deletes
stale entries. Also drafts new SKILL.md files from successful complex
sessions (Phase 10.4) using the Prefrontal model.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from typing import Any

logger = logging.getLogger(__name__)


_CONSOLIDATION_INTERVAL = 86400  # 24 hours
_RECENT_PROTECTION_COUNT = 20  # never delete the 20 most recent rules
_SKILL_DRAFT_RATE_LIMIT = 1  # max 1 auto-gen skill per day

_staging_dir = os.path.join("data", "skills", "staging")
_active_skills_dir = os.path.join("skills")  # adjust to your tree

# v3: Track last run for the brain dashboard
_last_run: dict | None = None


def _sanitize_skill_name(name: str) -> str:
    """v2 hardening: Convert any name to a valid camelCase identifier.

    LLMs may produce names with spaces, hyphens, underscores, or starting
    with uppercase. This function normalizes the name to camelCase so it's
    a valid filename-safe identifier. Examples:
      "Debug Python Script" -> "debugPythonScript"
      "user_preferences"    -> "userPreferences"
      "JWT-Auth-Flow"       -> "jwtAuthFlow"
      "  Hello World  "      -> "helloWorld"
    """
    if not name:
        return ""
    import re
    # Strip whitespace
    s = name.strip()
    # Split on any non-alphanumeric char (space, hyphen, underscore, dot, etc.)
    parts = re.split(r"[^A-Za-z0-9]+", s)
    # Drop empty parts
    parts = [p for p in parts if p]
    if not parts:
        return ""
    # First word lowercase; subsequent words capitalized (camelCase)
    result = parts[0].lower()
    for p in parts[1:]:
        result += p[0].upper() + p[1:].lower() if len(p) > 0 else ""
    # Truncate to 50 chars (sanity)
    return result[:50]


async def _call_hippocampus(prompt: str) -> str:
    """v2: Call the Hippocampus model. Returns raw text response.

    Uses the provider client if available; falls back to a heuristic
    no-op for environments without a configured LLM.
    """
    try:
        from app.services.workbench import model_fleet
        from app.providers.clients import get_client
        model = model_fleet.get_model_for_role("hippocampus")
        client = get_client({"model": model})
        if client and hasattr(client, "generate"):
            response = await client.generate(prompt)
            return response or ""
    except Exception:
        pass
    return ""


async def _call_prefrontal(prompt: str) -> str:
    """v2: Call the Prefrontal model. Returns raw text response."""
    try:
        from app.services.workbench import model_fleet
        from app.providers.clients import get_client
        model = model_fleet.get_model_for_role("prefrontal")
        client = get_client({"model": model})
        if client and hasattr(client, "generate"):
            response = await client.generate(prompt)
            return response or ""
    except Exception:
        pass
    return ""


def _get_session_summary(session_id: str) -> str:
    """v2: Get a brief summary of a session's activity. Default impl returns empty."""
    return ""


async def run_consolidation() -> dict[str, Any]:
    """Run one Hippocampus-driven consolidation cycle.

    1. Collect recent auto_memories and all learned_heuristics
    2. Call Hippocampus with a structured prompt
    3. Validate the JSON response
    4. Apply merges, promotions, deletes (most-recent 20 protected)
    5. Write through db_writer (Phase 0 single-write-queue)

    Returns stats about what was done.
    """
    stats: dict[str, Any] = {
        "merged": 0,
        "promoted": 0,
        "deleted_stale": 0,
        "errors": [],
    }

    # v4.3 — announce the cycle start so the Brain Activity tab can see it
    from app.services.brain_event_bus import emit_brain_event
    emit_brain_event(
        category="consolidation",
        layer="consolidation_daemon",
        summary=f"Sleep cycle started over {0} heuristics (will update on completion)",
    )

    try:
        from app.services.memory_store import _conn
        from app.services.db_writer import enqueue_write

        conn = _conn()

        # 1. Collect data
        auto_memories = [dict(r) for r in conn.execute(
            "SELECT * FROM auto_memories ORDER BY id DESC LIMIT 100"
        ).fetchall()]
        heuristics = [dict(r) for r in conn.execute(
            "SELECT * FROM learned_heuristics ORDER BY id DESC"
        ).fetchall()]

        if not heuristics:
            return stats  # nothing to consolidate

        # 2. Build prompt
        prompt = (
            "Review these auto_memories and learned_heuristics. Return a JSON plan:\n"
            "{'merge': [{'keep_id': int, 'remove_ids': [int, ...], 'merged_rule': str}],\n"
            " 'promote': [{'pattern': str, 'fact_key': str, 'fact_value': str}],\n"
            " 'delete': [int, ...]}\n"
            f"Auto memories ({len(auto_memories)}):\n{json.dumps(auto_memories, default=str)[:2000]}\n\n"
            f"Heuristics ({len(heuristics)}):\n{json.dumps(heuristics, default=str)[:2000]}\n\n"
            "Preserve the most recent 20 rules (do not delete them).\n"
            "If there's nothing to do, return {\"merge\": [], \"promote\": [], \"delete\": []}.\n"
        )

        # 3. Call Hippocampus
        raw = await _call_hippocampus(prompt)

        # 4. Validate JSON
        if not raw:
            return stats
        try:
            plan = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            return stats  # malformed: no destructive writes
        if not isinstance(plan, dict):
            return stats

        # 5. Apply operations
        # Protect the 20 most recent rules
        recent_ids = {r["id"] for r in conn.execute(
            "SELECT id FROM learned_heuristics ORDER BY id DESC LIMIT ?",
            (_RECENT_PROTECTION_COUNT,),
        ).fetchall()}

        # Merges
        for merge in plan.get("merge", []):
            keep_id = merge.get("keep_id")
            remove_ids = merge.get("remove_ids", [])
            merged_rule = merge.get("merged_rule")
            if keep_id is None or not remove_ids:
                continue
            for rid in remove_ids:
                if rid == keep_id:
                    continue
                await enqueue_write(lambda i=rid: conn.execute(
                    "DELETE FROM learned_heuristics WHERE id = ?", (i,)
                ))
            if merged_rule:
                await enqueue_write(lambda k=keep_id, m=merged_rule: conn.execute(
                    "UPDATE learned_heuristics SET rule = ?, updated_at = datetime('now') WHERE id = ?",
                    (m, k),
                ))
            stats["merged"] += 1

        # Promotions
        for promo in plan.get("promote", []):
            fact_key = promo.get("fact_key")
            fact_value = promo.get("fact_value")
            if not fact_key or not fact_value:
                continue
            await enqueue_write(lambda k=fact_key, v=fact_value: conn.execute(
                "INSERT INTO facts (fact_key, fact_value, category, source, confidence) "
                "VALUES (?, ?, ?, ?, ?)",
                (k, v, "auto-promoted", "consolidation", 0.8),
            ))
            stats["promoted"] += 1

        # Deletes (with recent protection)
        for did in plan.get("delete", []):
            if did in recent_ids:
                continue
            await enqueue_write(lambda i=did: conn.execute(
                "DELETE FROM learned_heuristics WHERE id = ?", (i,)
            ))
            stats["deleted_stale"] += 1

    except Exception as exc:
        stats["errors"].append(str(exc))
        logger.error("Consolidation error: %s", exc)

    # v3: Record last run for the brain dashboard
    global _last_run
    _last_run = {
        "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "merged": stats["merged"],
        "promoted": stats["promoted"],
        "deleted_stale": stats["deleted_stale"],
    }

    # v4.3 — emit a "done" summary so the activity feed shows what changed
    from app.services.brain_event_bus import emit_brain_event
    summary_parts = []
    if stats["merged"]:
        summary_parts.append(f"merged {stats['merged']} duplicate{'s' if stats['merged'] != 1 else ''}")
    if stats["promoted"]:
        summary_parts.append(f"promoted {stats['promoted']} pattern{'s' if stats['promoted'] != 1 else ''} to facts")
    if stats["deleted_stale"]:
        summary_parts.append(f"deleted {stats['deleted_stale']} stale rule{'s' if stats['deleted_stale'] != 1 else ''}")
    if not summary_parts:
        summary_parts.append("no changes — sleep cycle healthy")
    emit_brain_event(
        category="consolidation",
        layer="consolidation_daemon",
        summary=f"Sleep cycle done: {', '.join(summary_parts)}",
        meta={
            "merged": stats["merged"],
            "promoted": stats["promoted"],
            "deleted_stale": stats["deleted_stale"],
        },
    )

    return stats


# ── Phase 10.4: Skill Genesis ───────────────────────────────────────────


async def draft_skill_for_session(session_id: str) -> str | None:
    """v        emit_brain_event(category="skill_genesis", layer="consolidation_daemon.draft_skill_for_session", summary=f"Drafted skill: {(session_id or "unknown")[:60]}"),
2: Draft a SKILL.md from a successful session.

    Returns the skill name or None if skipped.
    Quality guard: skip if we already drafted a skill today.
    """
    try:
        from app.services.memory_store import _conn
        conn = _conn()
        today = time.strftime("%Y-%m-%d")
        recent = conn.execute(
            "SELECT COUNT(*) as c FROM pending_skills "
            "WHERE created_at >= ? AND created_by = 'auto-gen'",
            (today,),
        ).fetchone()
        if recent["c"] >= _SKILL_DRAFT_RATE_LIMIT:
            return None  # rate-limited

        summary = _get_session_summary(session_id)
        if not summary:
            return None

        prompt = (
            "This session completed a complex multi-step workflow. "
            "Is this workflow generic enough to be turned into a reusable skill? "
            "If yes, draft a SKILL.md. "
            "Constraints: the 'name' MUST be a valid camelCase identifier "
            "(e.g., 'debugPythonScript', 'userPreferences', 'jwtAuthFlow') — "
            "lowercase first word, capitalized subsequent words, no separators, no spaces, no special chars, <= 50 chars. "
            "Return JSON: {'name': str, 'description': str, 'trigger': str, 'body': str} "
            "or {'skip': true, 'reason': str}.\n\n"
            f"Session summary:\n{summary}\n"
        )
        raw = await _call_prefrontal(prompt)
        try:
            plan = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            return None
        if plan.get("skip"):
            return None
        # v2 hardening: sanitize the skill name to camelCase (LLMs may
        # produce spaces, hyphens, or uppercase first letters).
        name = _sanitize_skill_name(plan.get("name", ""))
        description = plan.get("description", "")
        trigger = plan.get("trigger", "")
        body = plan.get("body", "")
        if not name or not body:
            return None

        # Write to staging
        os.makedirs(_staging_dir, exist_ok=True)
        draft_path = os.path.join(_staging_dir, f"{name}.md")
        content = f"""---
name: {name}
description: {description}
trigger: {trigger}
created_by: auto-gen
---

{body}
"""
        with open(draft_path, "w", encoding="utf-8") as f:
            f.write(content)

        # Insert into pending_skills
        conn.execute(
            "INSERT INTO pending_skills (name, description, trigger_text, draft_path, "
            "source_session_id, source_workflow) VALUES (?, ?, ?, ?, ?, ?)",
            (name, description, trigger, draft_path, session_id, summary[:500]),
        )
        conn.commit()
        return name
    except Exception as exc:
        logger.error("Skill drafting error: %s", exc)
        return None


def approve_pending_skill(name: str) -> bool:
    
    # v4.3 ensure brain_event_bus is importable without circular deps
    try:
        from app.services.brain_event_bus import emit_brain_event
    except Exception:
        pass
"""v2: Approve a pending skill — move from staging to active."""
    try:
        from app.services.memory_store import _conn
        conn = _conn()
        row = conn.execute(
            "SELECT draft_path FROM pending_skills WHERE name = ?", (name,)
        ).fetchone()
        if not row:
            return False
        draft_path = row["draft_path"]
        if not os.path.exists(draft_path):
            return False
        os.makedirs(_active_skills_dir, exist_ok=True)
        import shutil
        shutil.move(draft_path, os.path.join(_active_skills_dir, f"{name}.md"))
        conn.execute(
            "UPDATE pending_skills SET status = 'approved' WHERE name = ?", (name,)
        )
        conn.commit()

        return Truemit_brain_event(category="skill_genesis", layer="consolidation_daemon.approved_pending_skill", summary=f"Approved skill: {name[:80]}")
        return True
    except Exception as exc:
        logger.error("Skill approval error: %s", exc)
        return False


def reject_pending_skill(name: str) -> bool:
    
    # v4.3 ensure brain_event_bus is importable without circular deps
    try:
        from app.services.brain_event_bus import emit_brain_event
    except Exception:
        pass
"""v2: Reject a pending skill — delete the staging file."""
    try:
        from app.services.memory_store import _conn
        conn = _conn()
        row = conn.execute(
            "SELECT draft_path FROM pending_skills WHERE name = ?", (name,)
        ).fetchone()
        if not row:
            return False
        draft_path = row["draft_path"]
        if os.path.exists(draft_path):
            os.re
        return Truemit_brain_event(category="skill_genesis", layer="consolidation_daemon.rejected_pending_skill", summary=f"Rejected skill: {name[:80]}")
        return True      conn.execute(
            "UPDATE pending_skills SET status = 'rejected' WHERE name = ?", (name,)
        )
        conn.commit()
        return True
    except Exception as exc:
        logger.error("Skill rejection error: %s", exc)
        return False
