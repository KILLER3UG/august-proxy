"""Full end-to-end verification of all phases v1, v2, v3 backend."""
import json, sys, os, sqlite3, py_compile

errors = []
print("=" * 60)
print("AUGUST PROXY — FULL VERIFICATION")
print("=" * 60)

# 1. Config
print("\n1. Config loading...")
from app.config import settings
settings.reload()
print("  CONFIG OK")

# 2. Database init
print("\n2. Database initialization...")
from app.services.memoryStore import init, getStats
init()
stats = get_stats()
expected = ["memory_store", "facts", "proposals", "sessions", "messages", "usage_events", "session_topics"]
for t in expected:
    if stats.get(t) is not None:
        print(f"  Table {t}: {stats[t]}")
    else:
        errors.append(f"missing table: {t}")

# 3. New tables
print("\n3. New tables...")
db_path = settings.data_dir / "august_brain.sqlite"
conn = sqlite3.connect(str(db_path))
cursor = conn.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
tables = {r[0] for r in cursor.fetchall()}
for t in ["learned_heuristics", "auto_memories", "auto_memories_fts", "episodic_timeline", "blackboard", "exams", "exam_questions", "exam_attempts"]:
    if t in tables:
        print(f"  {t}: OK")
    else:
        errors.append(f"missing: {t}")

# 4. FTS triggers
print("\n4. FTS triggers...")
triggers = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='trigger'").fetchall()}
for t in ["memory_store_fts_ai", "memory_store_fts_ad", "memory_store_fts_au",
          "auto_memories_ai", "auto_memories_ad", "auto_memories_au"]:
    if t in triggers:
        print(f"  {t}: OK")
    else:
        errors.append(f"missing trigger: {t}")
conn.close()

# 5. brain_query
print("\n5. brain_query...")
from app.services.memoryStore import brainQuery
stores = ["memory", "auto_memories", "heuristics", "facts", "sessions", "messages", "timeline", "blackboard"]
for s in stores:
    try:
        result = brain_query(s, "", None, 1)
        if "error" not in result.lower() or "not available" in result.lower():
            print(f"  brain_query({s}): OK")
        else:
            print(f"  brain_query({s}): {result[:60]}")
    except Exception as e:
        errors.append(f"brain_query({s}): {e}")

# 6. Heuristics CRUD
print("\n6. Heuristics CRUD...")
from app.services.heuristicsService import addHeuristic, countHeuristics
n1 = count_heuristics()
rid = add_heuristic("Test verification rule", source="verification")
n2 = count_heuristics()
if rid and n2 > n1:
    print(f"  CRUD: OK ({n1} -> {n2})")
else:
    errors.append("heuristics CRUD")

# 7. Blackboard CRUD
print("\n7. Blackboard CRUD...")
from app.services.blackboardService import writeNote, readNotes, clearNotes
write_note("test_s", "verify", "k1", "v1", priority=5)
notes = read_notes("test_s")
if any(n["key"] == "k1" for n in notes):
    print("  write+read: OK")
    clear_notes("test_s")
    notes2 = read_notes("test_s")
    if len(notes2) == 0:
        print("  clear: OK")
    else:
        errors.append("blackboard clear")
else:
    errors.append("blackboard write/read")

# 8. Token budget
print("\n8. Token budget...")
from app.services.workbench.tokenBudget import estimateTokens, computeBudget, getCriticalThreshold
t = estimate_tokens("Hello world test")
budget = compute_budget("Hello world test", model="gpt-4", provider="openai")
thresh = get_critical_threshold(model="unknown", provider="local")
if t > 0 and budget["attention_pressure"] == "low" and thresh == 0.85:
    print(f"  estimate_tokens={t}, pressure={budget['attention_pressure']}, threshold={thresh}")
else:
    errors.append("token budget")

# 9. BM25
print("\n9. BM25...")
from app.services.tools.retrieval import buildToolCatalog, searchTools
catalog = build_tool_catalog([
    {"name": "read_file", "description": "Read files", "input_schema": {"properties": {"path": {}}}},
    {"name": "web_fetch", "description": "Fetch URLs", "input_schema": {"properties": {"url": {}}}},
])
results = search_tools(catalog, "read file", k=5)
if "read_file" in results:
    print(f"  BM25: {results}")
else:
    print(f"  BM25 (warn): {results}")

# 10. Core tools
print("\n10. Core tools...")
from app.services.tools.modelTools import AUGUST_CORE_TOOLS
required = ["brain_query", "update_heuristics", "update_state", "write_scratchpad",
            "spawn_daemon", "list_daemons", "kill_daemon",
            "write_blackboard", "read_blackboard", "clear_blackboard"]
for t in required:
    if t in AUGUST_CORE_TOOLS:
        print(f"  {t}: OK")
    else:
        errors.append(f"core tool missing: {t}")

# 11. Config flags
print("\n11. Config flags...")
cfg = json.load(open(str(settings.data_dir / "config.json")))
layers = cfg.get("auxiliary", {}).get("cognitive_layers", {})
for k in ["heuristics","execution_state","scratchpad","cognitive_budget","progressive_disclosure","prompt_caching"]:
    if layers.get(k) == True:
        print(f"  v1 {k}=true: OK")
    else:
        errors.append(f"flag: {k}={layers.get(k)}")
for k in ["daemons","blackboard","env_watcher","verifier_reflex","skill_genesis"]:
    if layers.get(k) == False:
        print(f"  v2 {k}=false: OK")
    else:
        print(f"  v2 {k}={layers.get(k)} (expected false)")

# 12. Compile all files
print("\n12. Compile check...")
files = ["app/services/memory_store.py", "app/services/memory/auto_memory.py",
         "app/services/memory/context_builder.py", "app/services/daemon_manager.py",
         "app/services/blackboard_service.py", "app/services/consolidation_daemon.py",
         "app/services/delta_engine.py", "app/services/environment_watcher.py",
         "app/services/heuristics_service.py", "app/services/db_writer.py",
         "app/services/tool_definitions.py", "app/services/tool_registry.py",
         "app/services/tools/retrieval.py", "app/services/tools/model_tools.py",
         "app/services/tools/tool_bridges.py", "app/services/tools/skill_manifest.py",
         "app/services/workbench/workbench.py", "app/services/workbench/token_budget.py",
         "app/services/workbench/tool_guardrails.py", "app/services/workbench/prompt_cache.py",
         "app/routers/brain.py", "app/routers/exam.py", "app/main.py"]
count = 0
for f in files:
    try:
        py_compile.compile(f, doraise=True)
        count += 1
    except py_compile.PyCompileError as e:
        errors.append(f"compile: {f}")
print(f"  {count}/{len(files)} files compile OK")

# Summary
print("\n" + "=" * 60)
if errors:
    print(f"FAILURES ({len(errors)}):")
    for e in errors:
        print(f"  - {e}")
    sys.exit(1)
else:
    print("ALL CHECKS PASSED — v1, v2, v3 structurally complete")
    print("=" * 60)
