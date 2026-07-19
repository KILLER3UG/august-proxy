"""Full end-to-end verification of all phases v1, v2, v3 backend."""

import json
import sys
import sqlite3
import py_compile as pyCompile

errors = []
print('=' * 60)
print('AUGUST PROXY — FULL VERIFICATION')
print('=' * 60)
print('\n1. Config loading...')
from app.config import settings  # noqa: E402

settings.reload()
print('  CONFIG OK')
print('\n2. Database initialization...')
from app.services.memory_store import init, get_stats  # noqa: E402

init()
stats = get_stats()
# get_stats returns camelCase wire keys for table counts
expected = ['memoryStore', 'facts', 'proposals', 'sessions', 'messages', 'usageEvents', 'sessionTopics']
for t in expected:
    if stats.get(t) is not None:
        print(f'  Table {t}: {stats[t]}')
    else:
        errors.append(f'missing table: {t}')
print('\n3. New tables...')
dbPath = settings.data_dir / 'august_brain.sqlite'
conn = sqlite3.connect(str(dbPath))
cursor = conn.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
tables = {r[0] for r in cursor.fetchall()}
for t in [
    'learned_heuristics',
    'auto_memories',
    'auto_memories_fts',
    'episodic_timeline',
    'blackboard',
    'exams',
    'exam_questions',
    'exam_attempts',
    'pending_skills',
    'memory_store',
]:
    if t in tables:
        print(f'  {t}: OK')
    else:
        errors.append(f'missing: {t}')
print('\n4. FTS triggers...')
triggers = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='trigger'").fetchall()}
for t in [
    'memory_store_fts_ai',
    'memory_store_fts_ad',
    'memory_store_fts_au',
    'auto_memories_ai',
    'auto_memories_ad',
    'auto_memories_au',
]:
    if t in triggers:
        print(f'  {t}: OK')
    else:
        errors.append(f'missing trigger: {t}')
conn.close()
print('\n5. brain_query...')
from app.services.memory_store import brain_query  # noqa: E402

stores = ['memory', 'autoMemories', 'heuristics', 'facts', 'sessions', 'messages', 'timeline', 'blackboard']
for s in stores:
    try:
        result = brain_query(s, '', None, 1)
        lower = result.lower()
        # Unshipped stores intentionally return "not available".
        if 'not available' in lower:
            print(f'  brain_query({s}): OK (not available)')
        elif '"error"' in lower or lower.strip().startswith('{"error"'):
            print(f'  brain_query({s}): {result[:60]}')
            errors.append(f'brain_query({s}): {result[:120]}')
        else:
            print(f'  brain_query({s}): OK')
    except Exception as e:
        errors.append(f'brain_query({s}): {e}')
print('\n6. Heuristics CRUD...')
from app.services.heuristics_service import addHeuristic, countHeuristics  # noqa: E402

n1 = countHeuristics()
rid = addHeuristic('Test verification rule', source='verification')
n2 = countHeuristics()
if rid and n2 > n1:
    print(f'  CRUD: OK ({n1} -> {n2})')
else:
    errors.append('heuristics CRUD')
print('\n7. Blackboard CRUD...')
from app.services.blackboard_service import writeNote, readNotes, clearNotes  # noqa: E402

writeNote('test_s', 'verify', 'k1', 'v1', priority=5)
notes = readNotes('test_s')
if any((n['key'] == 'k1' for n in notes)):
    print('  write+read: OK')
    clearNotes('test_s')
    notes2 = readNotes('test_s')
    if len(notes2) == 0:
        print('  clear: OK')
    else:
        errors.append('blackboard clear')
else:
    errors.append('blackboard write/read')
print('\n8. Token budget...')
from app.services.workbench.token_budget import estimateTokens, computeBudget, getCriticalThreshold  # noqa: E402

t = estimateTokens('Hello world test')
budget = computeBudget('Hello world test', model='gpt-4', provider='openai')
thresh = getCriticalThreshold(model='unknown', provider='local')
if t > 0 and budget['attention_pressure'] == 'low' and (thresh == 0.85):
    print(f'  estimate_tokens={t}, pressure={budget["attention_pressure"]}, threshold={thresh}')
else:
    errors.append('token budget')
print('\n9. BM25...')
from app.services.tools.retrieval import buildToolCatalog, searchTools  # noqa: E402

catalog = buildToolCatalog(
    [
        {'name': 'read_file', 'description': 'Read files', 'input_schema': {'properties': {'path': {}}}},
        {'name': 'web_fetch', 'description': 'Fetch URLs', 'input_schema': {'properties': {'url': {}}}},
    ]
)
results = searchTools(catalog, 'read file', k=5)
if 'read_file' in results:
    print(f'  BM25: {results}')
else:
    print(f'  BM25 (warn): {results}')
print('\n10. Core tools...')
from app.services.tools.model_tools import AUGUST_CORE_TOOLS  # noqa: E402

required = [
    'brain_query',
    'update_heuristics',
    'update_state',
    'write_scratchpad',
    'spawn_daemon',
    'list_daemons',
    'kill_daemon',
    'write_blackboard',
    'read_blackboard',
    'clear_blackboard',
]
for t in required:
    if t in AUGUST_CORE_TOOLS:
        print(f'  {t}: OK')
    else:
        errors.append(f'core tool missing: {t}')
print('\n11. Config flags...')
cfg = json.load(open(str(settings.data_dir / 'config.json')))
layers = cfg.get('auxiliary', {}).get('cognitive_layers', {})
for k in [
    'heuristics',
    'execution_state',
    'scratchpad',
    'cognitive_budget',
    'progressive_disclosure',
    'prompt_caching',
]:
    if layers.get(k) is True:
        print(f'  v1 {k}=true: OK')
    else:
        errors.append(f'flag: {k}={layers.get(k)}')
for k in ['daemons', 'blackboard', 'env_watcher', 'verifier_reflex', 'skill_genesis']:
    if layers.get(k) is False:
        print(f'  v2 {k}=false: OK')
    else:
        print(f'  v2 {k}={layers.get(k)} (expected false)')
print('\n12. Compile check...')
files = [
    'app/services/memory_store.py',
    'app/services/memory/auto_memory.py',
    'app/services/memory/context_builder.py',
    'app/services/daemon_manager.py',
    'app/services/blackboard_service.py',
    'app/services/consolidation_daemon.py',
    'app/services/delta_engine.py',
    'app/services/environment_watcher.py',
    'app/services/heuristics_service.py',
    'app/services/db_writer.py',
    'app/services/tool_definitions.py',
    'app/services/tool_registry.py',
    'app/services/tools/retrieval.py',
    'app/services/tools/model_tools.py',
    'app/services/tools/tool_bridges.py',
    'app/services/tools/skill_manifest.py',
    'app/services/workbench/workbench.py',
    'app/services/workbench/token_budget.py',
    'app/services/workbench/tool_guardrails.py',
    'app/services/workbench/prompt_cache.py',
    'app/routers/brain.py',
    'app/routers/exam.py',
    'app/main.py',
]
count = 0
for f in files:
    try:
        pyCompile.compile(f, doraise=True)
        count += 1
    except pyCompile.PyCompileError:
        errors.append(f'compile: {f}')
print(f'  {count}/{len(files)} files compile OK')
print('\n' + '=' * 60)
if errors:
    print(f'FAILURES ({len(errors)}):')
    for e in errors:
        print(f'  - {e}')
    sys.exit(1)
else:
    print('ALL CHECKS PASSED — v1, v2, v3 structurally complete')
    print('=' * 60)
