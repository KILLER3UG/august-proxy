# v4.3 — Realtime Brain Activity (Design)

**Date:** 2026-06-30
**Status:** Approved (inline brainstorm, 2026-06-30)
**Scope:** Cross-session realtime feed of "what is the brain doing" + a live tab in the Brain dashboard so the user can see the brain actually learning (consolidation merges, delta engine inferences, new heuristics, background review, skill genesis).
**Reference:** `docs/design/cognitive-architecture-v1.md` §5 (metacognitive layers), §10 (background review), §10 (skill genesis); `docs/design/tracker-v4.md` §10/§14.

---

## 1. Background

After v3 + v4.0.0-frontend + v4.1.0-fleet + v4.2.0-live, the Brain dashboard has two tabs:
- **Learning** — static snapshot of heuristics / auto-memories / sleep-cycle / delta-engine / pending-skills (from `/api/brain/learning`)
- **System Health** — 12 selfchecks with status + detail + last_check_at

What's missing is the **realtime** view: when the consolidation daemon merges duplicate heuristics, when the delta engine flushes a learned preference from a user edit, when background review reflects on a session, when the skill genesis drafts a new skill — the user has zero visibility. They want to *watch* the brain learn.

## 2. Goals

- A new **Activity** tab in the Brain dashboard that surfaces brain-internal events as they happen
- SSE-push (not poll): when something fires, the user sees it within ~200 ms
- Category filtering so the user can focus (e.g. only "Heuristics" while watching the delta engine)
- Pause/resume the live feed (so reading isn't scroll-jacked)
- Reduced-motion variant (no slide animation)

## 3. Non-goals

- **File persistence** — in-memory ring buffer only (matches the existing `ActivityLog` pattern)
- **Cross-process events** — single Python process; restarts lose the buffer (acceptable: events are also written to their own tables, this is just the live tail)
- **Modifying existing ActivityLog/proxy traffic** — those serve a different purpose (proxy traffic)
- **Wiring all 12 cognitive layers on day one** — 5 high-signal publishers land now (consolidation, delta engine, heuristic added, background review, skill genesis); blackboard/env-watcher/verifier can be added later as we hit natural publish points
- **Filter chips beyond 5 categories** — UI caps at the 5 we wire

## 4. Backend architecture

### 4.1 `app/services/brain_event_bus.py`

In-process pub/sub, parallel to `services/logger.py:ActivityLog`:

```python
class BrainEventBus:
    """In-memory ring buffer of brain events with SSE fan-out."""

    def __init__(self) -> int = 200: ...
    def emit(self, *, category: str, layer: str, summary: str, meta: dict | None = None): ...
    def recent(self, limit: int = 100, category: str | None = None) -> list[dict]: ...
    async def subscribe(self) -> AsyncIterator[dict]: ...
```

Categories (the chip set): `consolidation`, `delta_engine`, `heuristic`, `review`, `skill_genesis`.

### 4.2 `app/routers/brain_activity.py`

```python
GET /api/brain/events?limit=200&category=consolidation
→ list[Event]   (newest first, capped at 200)

GET /api/brain/events/stream
→ SSE: text/event-stream
   emits one event per `bus.emit()` after the connection opens
   close on client disconnect
```

### 4.3 Publishers (5 touchpoints)

| Sub-system | When to emit | Event summary |
|---|---|---|
| `consolidation_daemon.run_consolidation()` | start + done | "Sleep cycle: merged 2 duplicate Yarn rules into 'Use Yarn not NPM'" |
| `delta_engine.flush_queue()` | per heuristic inferred | "Learned heuristic from your edit: prefer Yarn over npm" |
| `heuristics_service.add_heuristic()` | on insert (covers delta engine fallback too) | "Added heuristic [manual]: $rule" |
| `services/memory/background_review.try_background_review()` | start + done | "Background review: reflected on session $id, $n findings" |
| `consolidation_daemon.{draft_skill_for_session, approve_pending_skill, reject_pending_skill}` | each | "Skill genesis: drafted/approved/rejected $name" |

All publishers use `try/except`: a publisher failure must not break the underlying operation.

## 5. Frontend architecture

### 5.1 New files

```
frontend/desktop/src/sections/brain/BrainActivityTab.tsx
frontend/desktop/src/test/v4_3_brain_activity.test.tsx
frontend/desktop/src/api/brainStream.ts     # SSE client
```

### 5.2 `BrainActivityTab.tsx` shape

```
┌─ Brain ──────────────────────────────────────────────────────┐
│  ● Activity   ● Learning   ● System Health                  │
│                                                              │
│  Live (●) [Pause]       [All] [Consolidation] [Heuristics] │
│  [Delta Engine] [Review] [Skill Genesis]                    │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐    │
│  │ 10:24:15  consolidation   sleep cycle merged 2 dup Yarn  │  │
│  │ 10:23:40  heuristic       added [manual] 'Use tabs'      │  │
│  │ 10:23:01  delta_engine    learned 'User prefers Yarn'    │  │
│  │ 10:22:30  review          reflected on session abc — 3… │  │
│  └──────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────┘
```

- Empty state: "No brain activity yet — start chatting to see the brain learn."
- SSE auto-reconnect on close (3 retries, then polling fallback)
- Pause toggle stops inserting but keeps the existing events visible
- Filter chips (multi-select): "All" clears filters; clicking a chip toggles it
- Reduced-motion: events appear via a fade instead of a slide

### 5.3 Wiring in `BrainDashboard.tsx`

Add a third tab `'activity'` (not 'learning' or 'health'). Tab label = "Activity", icon = `Sparkles` (already imported).

## 6. Testing strategy

### Backend (~6 tests)

| Test | Asserts |
|---|---|
| `test_emit_appends_with_id_and_iso_timestamp` | shape: `{id, category, layer, summary, meta?, at}` |
| `test_recent_respects_limit_and_category` | filter + cap work |
| `test_get_returns_recent_events_newest_first` | ordering |
| `test_sse_stream_emits_subsequent_events` | open stream → emit → receive |
| `test_consolidation_daemon_emits_start_and_done` | publisher fires |
| `test_heuristic_add_emits_heuristic_event` | publisher fires |

### Frontend (~6 tests)

| Test | Asserts |
|---|---|
| `test_activity_tab_renders_with_chip_filters` | chip + empty state |
| `test_chip_click_filters_events` | toggling a chip narrows the feed |
| `test_pause_toggle_prevents_new_events_appearing` | pause stops SSE insert |
| `test_sse_reconnect_on_close` | mock close → reconnect path |
| `test_reduced_motion_disables_slide_animation` | class names |
| `test_new_event_arrives_via_sse_appears_at_top` | mocked stream feeds the list |

## 7. Risks

| Risk | Mitigation |
|---|---|
| SSE behind reverse proxy (Tauri desktop app — single-client so safe) | documented; the only consumer is the desktop app |
| Publisher failures breaking the underlying daemon | `try/except` wraps every publish; logged |
| Event spam from a stuck daemon (e.g. firing 100×/sec) | ring buffer caps; UI also caps the visible window; future per-category rate limiter |
| Race on tab unmount while SSE in flight | cancel subscription in cleanup |

## 8. Out of scope (deferred)

- Blackboard / env watcher / verifier reflex event wiring
- File persistence (events are recoverable from the underlying tables)
- Cross-process event aggregation
- Heart-rate-style time-series chart from the event stream

---

**End of design. Approved 2026-06-30. Ready to implement.**
