# How August really flows (code map)

Six diagrams: five runtime flows plus the current app surface. **Every box
names a real file and symbol** — nothing here is a sketch of an intended
architecture. The chains were read out of the tree (path and function
confirmed), and the SVG snapshot is committed beside this file as
[`architecture-flow.html`](architecture-flow.html) for offline viewing.

The right way to use this page: when a bug report says "the turn just stopped",
find which diagram owns that step and read the named function. The
"not what it looks like" lists under each diagram are the parts that mislead on
a first read.

Diagrams:

1. Install / update → Tauri shell → React boot
2. One chat turn end to end
3. Tool calls and the gates that stand in front of them
4. Memory: what the model sees, writes, and what survives
5. Provider routing and wire formats
6. App surfaces and navigation (the current shell)

---

## 1. Install, update, shell, boot

```mermaid
flowchart LR
  subgraph install["Install · update"]
    direction TB
    MSI["Installer<br/>MSI / NSIS"] --> RT[("backend-runtime/<br/>re-extractable payload")]
    MSI --> DA[("data/<br/>brain DB · providers.json<br/>skills · sessions · backups")]
    RT --> WIPE["wipeStaleTree<br/>refuses targets outside backend-runtime/"]
    DA --> KEEP["update keeps data/<br/>fresh install starts empty"]
  end

  subgraph shell["Tauri shell"]
    direction TB
    MAIN["main.rs → lib.rs run()"] --> SUP["backend supervisor thread"]
    SUP --> PORT{"port<br/>8085 → 8095"}
    PORT --> SPAWN["spawn<br/>python -m uvicorn app.main:app"]
    SPAWN --> HEALTH{"health probe<br/>45 s · status ok<br/>and python true"}
    HEALTH -->|"ok"| MARK["publish ACTIVE_PROXY_PORT"]
    HEALTH -->|"no"| NODE["Node fallback + watchdog"]
  end

  subgraph ui["React UI in WebView2"]
    direction TB
    HTML["index.html → main.tsx<br/>theme · preferences<br/>realtime bridge"] --> DISC["invoke('proxy_status')"]
    DISC --> FETCH["window.fetch patch<br/>/api + /v1 → live origin"]
    FETCH --> ROUTES["routes.ts<br/>/ · /c/:id · /automations · /runs<br/>/board · /artifacts · /live · /history · /learning<br/>/settings · /_design"]
    ROUTES --> LAYOUT["ChatLayout<br/>sidebar + transcript"]
  end

  MARK -->|"invoke reply ok:port"| DISC
  FETCH -->|"HTTP + SSE"| SPAWN
  LAYOUT -.-> CLOSE["CloseRequested → quit-requested<br/>Exit → stopBackendOnQuit"]
```

- `{appData}/data` and `{appData}/backend-runtime` are **siblings, never
  nested** — `scripts/desktop-backend-payload.mjs` refuses to stage user state
  into the payload, and `wipeStaleTree` (`src-tauri/src/backend.rs`) refuses any
  recursive delete outside `backend-runtime/`.
- The WebView renders the same Vite bundle that FastAPI can serve from
  `web-dist/`; the desktop app is the product, the served copy is packaging.
- The `/_design` route is compiled **only in dev** (`routes.ts` keeps the
  `lazy()` import inside the `import.meta.env.DEV` branch, so production ships no
  DesignRoute chunk).

---

## 2. One chat turn, end to end

```mermaid
flowchart TB
  subgraph fe["Frontend — from Send to painted tokens"]
    direction TB
    SEND["useChatSend.send<br/>sections/chat/hooks/useChatSend.ts"]
    START["startChatStream<br/>sections/chat/stream/start-stop-stream.ts"]
    POSTF["streamWorkbenchChat<br/>api/workbench/stream.ts<br/>POST /api/workbench/chat"]
    PATCH["installFetchPatch<br/>api/client.ts — window.fetch globally patched<br/>every /api and /v1 call goes through it"]
    OPEN["streamWorkbenchReconnect<br/>api/workbench/stream.ts<br/>GET /api/workbench/chat/stream"]
    DISP["dispatchWorkbenchEvent<br/>api/workbench/streamEvents.ts — frame switch"]
    TEND["onTurnEnd<br/>sections/chat/makeStreamHandlers.ts<br/>stamps turnEnd for the stop badge"]
  end

  subgraph be["Backend — one turn is a background task plus an event log"]
    direction TB
    ROUTE["routers/workbench.py:startChat<br/>POST /chat — returns sinceSeq only, no tokens"]
    TASK["routers/workbench.py:_startTurnTask<br/>background turn task"]
    ENG["services/workbench/workbench.py<br/>sendWorkbenchMessageStream"]
    LOOP["_sendWorkbenchMessageStreamImpl<br/>the model-round loop"]
    SURF["workbench.py:toolDefinitions :1431<br/>assembleToolDefs + tool_defs_cache<br/>keyed by the session SET/model/gates"]
  CALL["services/workbench/providers.py<br/>call_openai_workbench"]
    TR["services/workbench/stream_translate.py<br/>AnthropicWorkbenchStreamAggregator.on_event<br/>upstream SSE chunks to August frames"]
    ROOM["routers/workbench.py:streamChat<br/>GET /chat/stream replays the event log<br/>from sinceSeq"]
  end

  subgraph up["Upstream provider"]
    direction TB
    BASE["providers/clients/base.py:wireBody<br/>the transport seam both legs share<br/>scrubs this install's credentials"]
    HOST[("pasted baseUrl<br/>+ apiFormat leaf")]
  end

  SEND --> START --> POSTF --> PATCH --> ROUTE
  ROUTE -->|"sinceSeq"| TASK
  TASK --> ENG --> LOOP --> SURF --> CALL --> BASE --> HOST
  HOST -.->|"SSE chunks"| TR
  TR -->|"frames appended"| ROOM
  START -->|"then opens"| OPEN --> ROOM
  ROOM -.->|"SSE frames"| DISP --> TEND
  LOOP -->|"turn_end reason rounds error"| ROOM
  TEND -.->|"turn_close"| OUT[("turn_outcomes row<br/>services/turn_outcomes.py:record_turn_outcome<br/>migration 046 end_reason")]
```

**Not what it looks like**

- The `POST /api/workbench/chat` response body carries **no tokens** — only
  `sinceSeq`. The turn runs as a background task
  (`routers/workbench.py:_startTurnTask`) and the frontend immediately opens
  `GET /api/workbench/chat/stream`, which replays the session's event log from
  that sequence. "Streaming" here is a replayed log, not a held HTTP response.
- `window.fetch` is globally patched by `api/client.ts:installFetchPatch`; the
  chat stream is one of the calls that arrives at the patch, not through an
  `api` helper.
- The frontend's stream-apply module is `api/workbench/streamEvents.ts`
  (`dispatchWorkbenchEvent`), while the per-frame React handlers live in
  `sections/chat/makeStreamHandlers.ts`. Two files, one frame vocabulary.
- `stream_translate.py` lives under `services/workbench/`, **not** under
  `adapters/`.
- Every turn ends with a `turn_end {reason, rounds, error}` frame; the same
  reason + counters are persisted by `record_turn_outcome` into `turn_outcomes`
  (migration 046), where NULL means unrecorded, not zero. `stall-stop` is the
  runaway backstop's reason, reused deliberately so the badge, the ledger and
  the docs read one vocabulary.
- The provider tool array is a **session** value, not a per-turn one:
  `_sessionToolDefsCacheKey` (`workbench.py:1392`) keys the final disclosed and
  filtered array on the base set, model profile, context window and session
  gates. The BM25 query chooses membership on the first build and is
  deliberately not part of the key; `_applySessionStableOrder`
  (`loop/surface.py:224`) keeps a name's slot when the set changes. A changed
  set or gate still misses and rebuilds.

---

## 3. Tool calls and the gates in front of them

```mermaid
flowchart TB
  MODEL["model emits a tool call<br/>within a workbench round"]

  subgraph exec["services/workbench/loop/exec.py — _executeTool (the dispatch door)"]
    direction TB
    MUT{"is_mutating_tool<br/>tool_policy"}
    STALE["join turn-start baseline<br/>sha256 stale-write gate<br/>exec.py:111-152"]
    HOOKS["hook_registry.emit PRE_TOOL_USE<br/>exec.py:173 — deny or modify, fails CLOSED"]
    SECRET["hooks/secret_guard.py:scan_secrets<br/>deny secret-shaped writes"]
    FAM{"run_command family?<br/>run_command bash safe_python terminal_command"}
    GRACE["wider harness timeout<br/>exec.py:194"]
    DISP["tool_registry.dispatch<br/>tool_registry.py:625<br/>isCommandBlocked at :647"]
  end

  subgraph sandbox["Real sandbox — every shell line"]
    direction TB
    RB["sandbox/backends/__init__.py<br/>run_with_best_backend"]
    HL["sandbox/hardline.py:check_hardline_command<br/>_PROTECTED_WRITE_PATTERN :58<br/>_agent_state_reason :243"]
    TERM["workbench/terminal_service.py<br/>:357 launch · :597 every typed line · :736"]
    CODERUN["workbench/code_runner.py:420-746<br/>a PORT of the same hardline<br/>injected into every code cell"]
  end

  subgraph doors["Doors that are not the shell"]
    direction TB
    FILES["file tools + 7 listing doors<br/>sandbox/paths.py:listable_root :203<br/>routers/security.py · workbench.py:693<br/>file_tools :957 :1089 · module_context :429"]
    SUB["workbench/subagent.py<br/>_workerDeniedNames :316<br/>tools/agent_registry.py:evaluateAgentTool :163"]
    SELFCFG["self_config_tools.py<br/>_authority_refusal :135 :170<br/>permissions tools modelAlias refused"]
  end

  RESULT["handler returns a string<br/>back into the round"]

  MODEL --> MUT
  MUT -->|"yes"| STALE --> HOOKS
  MUT -->|"no"| HOOKS
  HOOKS --> SECRET --> FAM
  FAM -->|"yes"| GRACE --> DISP
  FAM -->|"no"| DISP
  DISP --> RB --> HL
  DISP --> TERM --> HL
  DISP --> CODERUN
  DISP --> FILES
  DISP --> SUB
  DISP --> SELFCFG
  RB --> RESULT
  FILES --> RESULT
  SUB --> RESULT
  SELFCFG --> RESULT

  NOWIRE["workbench._checkToolGuard is the live approval authority<br/>plan/ask → is_mutating, edit → is_shell_mutation<br/>(tool_policy.needs_approval_in was dead and was removed)"]
  NOWIRE -.->|"enforced at the call site"| DISP
```

**Not what it looks like**

- `_executeTool` is the one door every chat tool call passes (`loop/exec.py:58`),
  and it ends in `tool_registry.dispatch` (`tool_registry.py:625`, imported at
  `exec.py:73`). There is no second dispatch path for aliases: `bulk` routes
  `operation=<x>` to the same handlers from inside `dispatch`.
- **Approval policy lives in `workbench._checkToolGuard`, not in
  `tool_policy.needs_approval_in`.** That predicate had no call site and was
  removed; `_checkToolGuard` is called by the workbench loop, the subagent
  runner and the kernel, and it uses `is_mutating` for plan/ask and
  `is_shell_mutation` for edit. `ask` and `full` do NOT behave the same:
  `full` returns early, while `ask` queues a pending mutation that the user
  must accept. (The old text here concluded the opposite from the dead
  predicate and was wrong.)
- The hardline rules are not one implementation. `sandbox/hardline.py` is the
  source, `workbench/code_runner.py:420-746` is a **port** rendered into every
  code cell (it cannot import `app`), and `terminal_service.py` calls the
  original on every typed line. A rule added to one and not the others is the
  known drift class here.
- The seven listing doors all call `sandbox/paths.py:listable_root` then
  `listable_entry`/`listable_child`; the write door
  (`_agent_state_reason`, `_PROTECTED_WRITE_PATTERN`) lives in the hardline
  module and protects agent state (skills layers, `hooks.json`,
  `mcp-servers.json`, `automations.json`, kernel `site-packages`, the brain DB).
- Sub-agent capability is a **deny set** (`_workerDeniedNames` +
  `_workerDenied` published on `currentSubagentDenied`), never an allow-list of
  the offered surface — progressive disclosure means a worker may legitimately
  call a tool outside the slice it was shown.

---

## 4. Memory: what the model sees, what it can write, what survives

```mermaid
flowchart TB
  DB[("august_brain.sqlite<br/>services/memory_conn.py:db_path<br/>under lib/paths.py:dataDir")]

  DB --> FACTS["facts — key/value, value is JSON-encoded<br/>memory_schema.py:32"]
  DB --> KV["memory_store + FTS5 — app KV<br/>memory_schema.py:21 :28"]
  DB --> MSG["messages / sessions<br/>memory_schema.py:82"]
  DB --> ST["internal_state · turn_outcomes<br/>migrations/026 · 046"]

  subgraph tail["The memory tail attached to a turn"]
    direction TB
    GATE{"brain_config memoryAutoInject<br/>app/services/brain_config_service.py:220<br/>DEFAULT OFF"}
    BM["fact_retrieval.py:build_memory_block :667<br/>BM25 over facts — only when invoked"]
    PROF["build_profile_block — ALWAYS-ON lane<br/>rendered even with auto-inject off"]
    DELTA["fact_retrieval.py:build_memory_delta_block :958<br/>facts updated after session.createdAt<br/>fixed-width microseconds, live projection"]
    MERGE["merge: profile lane first, then recalled facts, then delta"]
    PART["_omitted_receipt — names what budget dropped<br/>recall partial"]
    INJ["workbench.py:3062 / 3085<br/>tail patched into the user message<br/>_injected_facts"]
  end

  GATE -->|"on"| BM --> MERGE
  PROF --> MERGE
  DELTA --> MERGE
  MERGE --> PART --> INJ

  subgraph crud["Model-facing memory CRUD — core tools"]
    direction TB
    REM["remember — tool_registrations/session_tools.py:_remember<br/>writes facts via memory_store/rest.py:save_fact<br/>updated_at = timeutil.utc_now_text() microseconds"]
    LST["list_facts — _list_facts<br/>modelMemoryRead-gated read"]
    FGT["forget — _forget<br/>retire by exact key"]
    BQ["brain_query — _brainQuery<br/>memory_store/brain.py:_BRAINStores<br/>reads facts AND memory_store KV<br/>store enum omits memory; dispatch does not enforce it"]
  end

  REM --> FACTS
  LST --> FACTS
  FGT --> FACTS
  BQ --> FACTS
  BQ --> KV

  KV --> GETM["memory_store/kv.py:get_memory<br/>app-internal callers only<br/>no model tool reads it by this door"]

  subgraph learn["Learning loop — opt-in"]
    direction TB
    HK["tool-use hooks<br/>loop/exec.py:173 PRE · :216 POST<br/>hooks/builtin.py:register_builtin_hooks"]
    REV["skill_distiller.py:run_review_pass<br/>apply_verdict · _reviewCursors per session"]
    SCH["learning_scheduler.py:_review_job<br/>must drop results before _finish_run"]
    HK --> REV --> SCH
  end

  subgraph safe["Memory survives independently of recall"]
    direction TB
    BK["brain_backup.py:create_backup<br/>SQLite backup API · integrity_check · rolling prune"]
    RS["apply_pending_restore — STAGED, applied next launch<br/>main.py:184 before memory_store init"]
    BK --> RS
  end

  DB --> BK
  RS -.->|"next boot"| DB
```

**Not what it looks like**

- `memoryAutoInject` is **off by default**, but that gate only governs the
  recalled-facts lane: `build_profile_block` (the `kind='profile'` facts) is
  rendered on every turn regardless. That is what makes August remember *who
  you are* without a keyword coincidence.
- Recalled facts are attached to the **user message** at
  `workbench.py:3188`/`:3283` (`_injected_facts`), not to the system prompt.
- The delta lane (`build_memory_delta_block`, `fact_retrieval.py:958`) is a
  live projection over `facts.updated_at`, not a cursor: an UPDATE is
  delivered like a new write, a retired row is excluded, and keys the recall
  lane already showed are skipped. It used to compare a second-resolution
  `updated_at` against a microsecond session stamp, which hid writes made in
  the session's opening second. Fact writers now stamp
  `timeutil.utc_now_text()` (fixed-width UTC microseconds) and the lane
  compares those strings directly, so same-second writes are visible.
- A fact value is **stored JSON-encoded**; every read door decodes it. Write one
  and read it back through a different door and a raw JSON blob is a
  serialization bug, not a data bug.
- `remember`/`list_facts`/`forget` are core tools (never hidden by progressive
  disclosure) and `list_facts` is gated by `modelMemoryRead`. Since 2026-10-17
  the read is also a **precondition**: `remember` refuses its first write of a
  turn until memory was read that turn, and refuses a sentence already stored
  under another key (naming it in `existingKey`). `list_facts` pages with
  `offset`/`hasMore`/`total` and takes `include_retired`.
- `brain_query` can read the KV table (`store='memory'`, aliases `kv` /
  `memory_store` — `memory_store/brain.py:_BRAINStores`), and as of 2026-10-17
  `memory` is in the advertised store enum: the composer's Notes lane is
  reachable through a **named** door, not an unadvertised alias. Dispatch still
  does not validate the enum, so a stale client using an alias keeps working.
- The learning pass is opt-in and per-session: `run_review_pass` keeps a
  **cursor map** in `internal_state` (`skill_distiller:review:cursors`), not one
  global high-water id, and its job adapter must drop `results` before returning
  (`_finish_run` truncates detail at 2000 chars).
- Backups are online SQLite copies (`create_backup`), verified with
  `PRAGMA integrity_check` before trust; a restore is **staged** and applied at
  the next launch (`apply_pending_restore` runs in `main.py:184` before the
  store initializes) — never in place.

---

## 5. Provider routing and wire formats

```mermaid
flowchart TB
  STORE[("data/providers.json<br/>config_service.py:getProvidersStore / saveProvidersStore")]
  MODELS["config_service.py:getProvidersAsModels<br/>per-model apiFormat + priceInPerM / priceOutPerM"]
  PDICT["routers/providers.py:_provider_to_dict<br/>rebuilds field by field — a new per-model field<br/>must be named here or it is write-only"]
  PICK["routers/models.py:56 + model_service.py:421<br/>what the picker shows"]

  subgraph pick1["Effective wire format, per call"]
    direction TB
    R1["workbench/providers.py:resolve_chat_llm<br/>the workbench chat path"]
    R2["adapters/openai.py:handleChatCompletions<br/>the /v1 proxy path"]
    R3["adapters/anthropic.py:handleMessages<br/>the /v1 proxy path"]
    RES["providers/resolver.py<br/>apply_model_format_override<br/>a per-model override beats the provider apiFormat"]
    R1 --> RES
    R2 --> RES
    R3 --> RES
  end

  URL["providers/api_format.py:provider_endpoint_url<br/>baseUrl used exactly as pasted + the format leaf<br/>chat/completions · v1/messages · responses · models<br/>never invents /v1"]

  subgraph body["The request body"]
    direction TB
    DUMP["models/openai.py:dump_openai_upstream_body<br/>models/anthropic.py:dump_anthropic_upstream_body<br/>exclude_none + strip August-only keys"]
    STRIP["services/message_sources.py<br/>AUGUST_MESSAGE_ONLY_KEYS · strip_august_message_keys<br/>per-message internal keys"]
    WIRE["providers/clients/base.py:BaseProviderClient.wireBody<br/>THE transport seam — wraps requestJson and streamSse<br/>scrubs this install's own credentials BY VALUE"]
  end

  subgraph legs["The three legs"]
    direction TB
    L1["openai client → /chat/completions"]
    L2["anthropic client → /v1/messages"]
    L3["responses client → /responses"]
  end

  subgraph proxy["/v1 proxy — the other door into the same legs"]
    direction TB
    P1["routers/proxy.py:/v1/chat/completions"]
    P2["routers/proxy.py:/v1/messages"]
    P3["routers/proxy.py:/v1/responses"]
    X1["adapters/openai.py:_openaiToAnthropicBody<br/>_streamAnthropicAsOpenai (SSE translation back)"]
    X2["adapters/anthropic.py:translateMessages<br/>_streamOpenaiAsAnthropic"]
  end

  PRICE["services/cost_estimator.py:price_for_model<br/>env override > model price > free > family table > default<br/>estimated=True on the last two"]

  STORE --> MODELS --> PDICT --> PICK
  MODELS --> R1
  R1 --> DUMP
  R2 --> DUMP
  R3 --> DUMP
  DUMP --> STRIP --> WIRE
  RES --> URL
  URL --> L1
  URL --> L2
  URL --> L3
  WIRE --> L1
  WIRE --> L2
  WIRE --> L3
  P1 --> X1 --> L2
  P2 --> X2 --> L1
  P3 --> L3
  MODELS --> PRICE
```

**Not what it looks like**

- One provider entry can serve several wire formats: `apiFormat` is per
  provider, and a **model** entry may carry its own override
  (`apply_model_format_override`, consulted by the workbench, the Test button,
  Live/BTW and both `/v1` adapters). OpenCode Zen is the motivating case.
- The base URL is used **exactly as pasted**; `provider_endpoint_url` appends
  only the format leaf. It never invents `/v1` — OpenAI-compatible hosts include
  it in the paste, and Anthropic's format already has `v1` inside its leaf.
- The credential scrub is in `BaseProviderClient.wireBody` — the transport seam
  wrapping `requestJson`/`streamSse` — **not** in the `dump_*` serializers,
  because the workbench assigns `body['messages']` after dumping and the `/v1`
  proxy appends tool results and re-sends. Matched by **value**, so key-shaped
  text a user pasted survives.
- `_provider_to_dict` and `getProvidersAsModels` rebuild model entries field by
  field: a new per-model field must be named in both or it is write-only.
- `0.0` is a price, not an absence (only `None` means unset), and
  `price_for_model` is the **only** pricing source, returning
  `estimated: True` for the family-table and default fallbacks so a readout can
  distinguish a fact from a guess.

---

## 6. App surfaces and navigation (the current shell)

```mermaid
flowchart TB
  SHELL["ChatLayout + SessionListNav<br/>New · Search → command palette<br/>Projects · Artifacts · Customize"]
  SHELL --> ROUTES["routes.ts<br/>/c/:id · /artifacts · /settings<br/>/board · /runs · /live · /learning"]
  ROUTES --> CHAT["ChatThread + ChatThreadComposer<br/>folder chip every turn · model picker<br/>effort/thinking controls"]
  ROUTES --> ART["ArtifactsPage<br/>collectArtifacts over the 40 most recent chats"]
  ROUTES --> SET["Settings overlay (WorkspaceShell)<br/>rail: Setup · Agent · Data · App"]
  CHAT --> DRAWER["RightDrawer<br/>artifacts · circuit · diff · terminal · tasks · notes"]
  DRAWER --> CIRC["Circuit drawer<br/>CircuitSchematicEditor owns the graph<br/>3D stage is a lazy three.js chunk"]
  SET --> APPEAR["Appearance<br/>theme · font size · reduce motion<br/>show raw reasoning switch"]
  ART --> DRAWER
```

**Not what it looks like**

- **Search** is the command palette (`toggleCommandPalette`), not a full-text
  page. The reference's Search row and `Ctrl+K` are the same door.
- The **Projects** row opens the composer's folder picker. The picker is
  mounted on every turn, not only an empty chat, so the row works in an active
  conversation. Clearing a folder is sent to the backend before the local row
  is cleared; a failed POST leaves the old folder visible.
- **Settings is an overlay with a URL**: `/settings` renders the
  `WorkspaceShell` dialog and its rail (`settings-registry.ts`), not a second
  app. The rail is August's own (Model settings, Memory, Plugins, Skills,
  Commands, …), so Claude reference items such as Billing or Claude Code are
  deliberately absent.
- **Thinking** cards render distilled steps by default. The raw branch is
  reachable only through Settings → Appearance → Show raw reasoning, which is a
  live `useSyncExternalStore` preference, and Arena uses the same distilled
  list. The former Vision pill was removed because no server emits `vision`.
- **Artifacts** has two verbs: a card opens that artifact through the drawer's
  file viewer (or an external link), while a chat group's "Open chat" opens the
  chat with the artifact list. The page derives from `collectArtifacts`, the
  same collector as the in-chat drawer.
- **Circuit** is the one drawer section with two renderers over one graph:
  `CircuitSchematicEditor` owns the fetch and reports it through
  `onGraphChange`; the 3D stage consumes that same object. three.js is a
  separate lazy chunk (`CircuitBreadboard3D-*.js`), the stage mounts before the
  graph arrives, parts are placed from their pin centroid, and the camera is
  reachable by pointer, wheel and arrow/+/−/Home keys.

---

## Re-rendering

The mermaid sources above are the source of truth (GitHub renders them). The
snapshot in `architecture-flow.html` was produced offline with `mermaid@11` +
the repo's Playwright chromium; if the diagrams change, rebuild the snapshot
rather than editing the SVG by hand.
