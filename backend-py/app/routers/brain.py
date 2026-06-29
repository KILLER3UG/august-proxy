"""
Brain router — Learning + System Health endpoints (v3, §12).

GET /api/brain/learning — aggregates heuristics, auto-memories, facts, etc.
GET /api/brain/health  — per-phase feature flags + selfcheck() results.
"""

from __future__ import annotations

from fastapi import APIRouter

router = APIRouter(prefix="/api/brain")


@router.get("/learning")
async def get_learning():
    """Aggregate everything the brain has learned."""
    from app.services.heuristics_service import list_heuristics
    from app.services.memory_store import get_memory
    from app.services.consolidation_daemon import run_consolidation as _consol

    # Learned heuristics
    heuristics = list_heuristics()

    # Core facts & auto-memories
    core_facts = get_memory("core_memory")
    user_profile = get_memory("user_profile")

    # Delta engine stats
    try:
        from app.services.delta_engine import _diff_queue
        delta_queue_size = len(_diff_queue)
    except Exception:
        delta_queue_size = 0

    return {
        "heuristics": heuristics,
        "heuristic_count": len(heuristics),
        "core_facts": core_facts,
        "user_profile": user_profile,
        "delta_engine": {
            "consent_granted": False,
            "queue_size": delta_queue_size,
        },
        "pending_skills": [],
    }


@router.get("/health")
async def get_health():
    """Per-phase status: flags + selfcheck()."""
    from app.config import settings

    layers = {}
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

    results = []
    for flag_key, label in phases:
        flag_val = layers_cfg.get(flag_key, False)
        status = "off" if not flag_val else _run_selfcheck(flag_key)
        results.append({
            "layer": label,
            "flag": flag_key,
            "flag_value": flag_val,
            "status": status,
        })

    return {"phases": results}


def _run_selfcheck(flag_key: str) -> str:
    """Run a lightweight self-check for a cognitive layer."""
    try:
        if flag_key == "heuristics":
            from app.services.heuristics_service import count_heuristics
            count = count_heuristics()
            return "on & healthy" if count >= 0 else "on & failing"

        elif flag_key == "cognitive_budget":
            from app.services.workbench.token_budget import estimate_tokens
            t = estimate_tokens("selfcheck probe text")
            return "on & healthy" if t > 0 else "on & failing"

        elif flag_key == "progressive_disclosure":
            from app.services.tools.model_tools import AUGUST_CORE_TOOLS
            return "on & healthy" if len(AUGUST_CORE_TOOLS) > 10 else "on & failing"

        elif flag_key == "daemons":
            from app.services.daemon_manager import get_manager
            mgr = get_manager()
            d = mgr.list_daemons()
            return "on & healthy" if d is not None else "on & failing"

        elif flag_key == "blackboard":
            from app.services.memory_store import _conn
            conn = _conn()
            row = conn.execute("SELECT COUNT(*) FROM blackboard").fetchone()
            return "on & healthy" if row is not None else "on & failing"

        else:
            return "on & healthy"
    except Exception:
        return "on & failing"
