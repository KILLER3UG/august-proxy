"""
Brain router — mutation endpoints + System Health (v3, §12).

The /api/brain/learning endpoint is served by ui_memory.py (v3 enhanced
that to return the rich aggregation including auto-memories, sleep
cycle, delta engine, and pending skills). This router adds the
mutation endpoints (delete/edit heuristic, approve/reject skill,
run consolidation) and the System Health fan-out.
"""

from __future__ import annotations

from fastapi import APIRouter

router = APIRouter(prefix="/api/brain")


# ── v3: Mutation endpoints (delete/edit heuristic, approve/reject skill, run consolidation) ──


@router.delete("/heuristics/{heuristic_id}")
async def delete_heuristic(heuristic_id: int):
    """v3: Delete a learned heuristic."""
    from app.services.heuristics_service import remove_heuristic_by_id
    ok = remove_heuristic_by_id(heuristic_id)
    return {"deleted": ok}


@router.patch("/heuristics/{heuristic_id}")
async def edit_heuristic(heuristic_id: int, body: dict):
    """v3: Edit a learned heuristic's rule text."""
    from app.services.heuristics_service import update_heuristic
    new_rule = (body.get("rule") or "").strip()
    if not new_rule:
        return {"updated": False, "error": "rule cannot be empty"}
    ok = update_heuristic(heuristic_id, new_rule)
    return {"updated": ok}


@router.post("/skills/{name}/approve")
async def approve_skill(name: str):
    """v3: Approve a pending skill — move staging to active."""
    from app.services.consolidation_daemon import approve_pending_skill
    ok = approve_pending_skill(name)
    return {"approved": ok}


@router.post("/skills/{name}/reject")
async def reject_skill(name: str):
    """v3: Reject a pending skill — delete staging file."""
    from app.services.consolidation_daemon import reject_pending_skill
    ok = reject_pending_skill(name)
    return {"rejected": ok}


@router.post("/run-consolidation")
async def run_consolidation_endpoint():
    """v3: Trigger a consolidation cycle now."""
    from app.services.consolidation_daemon import run_consolidation
    stats = await run_consolidation()
    return stats


@router.get("/health")
async def get_health():
    """Per-phase status: flags + selfcheck() with detail + last_check_at."""
    from app.config import settings
    import time

    try:
        cfg = settings.config
        layers_cfg = cfg.get("auxiliary", {}).get("cognitive_layers", {})
    except Exception:
        layers_cfg = {}

    phases = [
        ("heuristics", "Phase 4 — Learned Heuristics"),
        ("execution_state", "Phase 5 — Execution State"),
        ("scratchpad", "Phase 6 — Working Memory"),
        ("tool_guardrails", "Phase 6 — Loop Guardrails"),
        ("progressive_disclosure", "Phase 3 — BM25"),
        ("prompt_caching", "Phase 7 — Prompt Caching"),
        ("cognitive_budget", "Phase 2 — Cognitive Budgeting"),
        ("daemons", "Phase 8 — Subconscious Daemons"),
        ("blackboard", "Phase 10 — Blackboard"),
        ("env_watcher", "Phase 10 — Env Watcher"),
        ("verifier_reflex", "Phase 10 — Verifier Reflex"),
        ("skill_genesis", "Phase 10 — Skill Genesis"),
    ]

    now_iso = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    results = []
    for flag_key, label in phases:
        flag_val = bool(layers_cfg.get(flag_key, False))
        if not flag_val:
            results.append({
                "layer": label,
                "flag": flag_key,
                "flag_value": False,
                "status": "off",
                "detail": "feature flag disabled",
                "last_check_at": now_iso,
            })
            continue

        check = _run_selfcheck(flag_key)
        results.append({
            "layer": label,
            "flag": flag_key,
            "flag_value": True,
            "status": check["status"],
            "detail": check["detail"],
            "last_check_at": now_iso,
        })

    return {"phases": results}


def _run_selfcheck(flag_key: str) -> dict:
    """Run a lightweight self-check for a cognitive layer.

    Returns {"status": str, "detail": str}. Never raises — failures
    become "on & failing" with the exception message as detail.
    """
    try:
        if flag_key == "heuristics":
            from app.services.heuristics_service import count_heuristics
            count = count_heuristics()
            return {
                "status": "on & healthy",
                "detail": f"{count} active heuristic{'s' if count != 1 else ''}",
            }

        elif flag_key == "execution_state":
            # Verify the execution_state table is queryable
            from app.services.memory_store import _conn
            row = _conn().execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='execution_state'"
            ).fetchone()
            return {
                "status": "on & healthy" if row else "on & failing",
                "detail": "execution_state table reachable" if row else "execution_state table missing",
            }

        elif flag_key == "scratchpad":
            from app.services.memory_store import _conn
            row = _conn().execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='scratchpad'"
            ).fetchone()
            return {
                "status": "on & healthy" if row else "on & failing",
                "detail": "scratchpad table reachable" if row else "scratchpad table missing",
            }

        elif flag_key == "tool_guardrails":
            from app.services.memory_store import _conn
            try:
                row = _conn().execute(
                    "SELECT COUNT(*) FROM tool_guardrail_log"
                ).fetchone()
                hits = int(row[0]) if row else 0
            except Exception:
                hits = 0
            return {
                "status": "on & healthy",
                "detail": f"{hits} guardrail event{'s' if hits != 1 else ''} logged",
            }

        elif flag_key == "progressive_disclosure":
            from app.services.tools.model_tools import AUGUST_CORE_TOOLS
            count = len(AUGUST_CORE_TOOLS)
            return {
                "status": "on & healthy" if count > 5 else "on & failing",
                "detail": f"{count} tools in BM25 catalog",
            }

        elif flag_key == "prompt_caching":
            from app.services import prompt_cache
            try:
                stats = prompt_cache.get_stats() if hasattr(prompt_cache, "get_stats") else {}
                hits = int(stats.get("hits", 0)) if isinstance(stats, dict) else 0
            except Exception:
                hits = 0
            return {
                "status": "on & healthy",
                "detail": f"{hits} cache hit{'s' if hits != 1 else ''} recorded",
            }

        elif flag_key == "cognitive_budget":
            from app.services.workbench.token_budget import estimate_tokens
            t = estimate_tokens("selfcheck probe text")
            return {
                "status": "on & healthy" if t > 0 else "on & failing",
                "detail": f"token estimator returns {t}",
            }

        elif flag_key == "daemons":
            from app.services.daemon_manager import get_manager
            mgr = get_manager()
            d = mgr.list_daemons() or []
            running = sum(1 for x in d if x.get("status") in ("running", "idle"))
            return {
                "status": "on & healthy" if d is not None else "on & failing",
                "detail": f"{len(d)} daemon{'s' if len(d) != 1 else ''} registered, {running} active",
            }

        elif flag_key == "blackboard":
            from app.services.memory_store import _conn
            row = _conn().execute("SELECT COUNT(*) FROM blackboard").fetchone()
            n = int(row[0]) if row else 0
            return {
                "status": "on & healthy",
                "detail": f"{n} note{'s' if n != 1 else ''} on blackboard",
            }

        elif flag_key == "env_watcher":
            from app.services.memory_store import _conn
            try:
                row = _conn().execute(
                    "SELECT MAX(timestamp) FROM env_change_log"
                ).fetchone()
                last = row[0] if row else None
            except Exception:
                last = None
            return {
                "status": "on & healthy",
                "detail": f"last event: {last or 'none yet'}",
            }

        elif flag_key == "verifier_reflex":
            from app.services.memory_store import _conn
            try:
                row = _conn().execute(
                    "SELECT COUNT(*) FROM verifier_gate_log"
                ).fetchone()
                gates = int(row[0]) if row else 0
            except Exception:
                gates = 0
            return {
                "status": "on & healthy",
                "detail": f"{gates} verifier gate{'s' if gates != 1 else ''} injected",
            }

        elif flag_key == "skill_genesis":
            from app.services.memory_store import _conn
            row = _conn().execute(
                "SELECT COUNT(*) FROM pending_skills WHERE status = 'pending'"
            ).fetchone()
            n = int(row[0]) if row else 0
            return {
                "status": "on & healthy",
                "detail": f"{n} pending skill{'s' if n != 1 else ''}",
            }

        else:
            return {"status": "on & healthy", "detail": "no probe defined"}
    except Exception as exc:
        return {"status": "on & failing", "detail": f"{type(exc).__name__}: {exc}"}
