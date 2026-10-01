# Review of `AUDIT-REPORT.md` — triage

**Date:** 2026-10-01
**Subject:** `AUDIT-REPORT.md` (root, untracked, 24 KB, self-dated 2026-10-01)
**Method:** every `file:line` citation resolved against the working tree, then the
cited code read and judged. Findings marked **real** were re-checked a second time
against a different question before being accepted.

**Provenance:** this file appeared in the working tree during a session that did
not create it, claiming six subagents I did not launch. That is unresolved and
matters more than any individual claim — see "What this means" below.

---

## Verdict

**Do not work this list as written.** Of the claims read against the code,
roughly a third hold, and the ones that do are mostly minor or already mitigated.

| | Count |
|---|---|
| Real, worth fixing | **8** |
| Real but trivial / severity inflated | **10** |
| False positive | **16** |
| Mixed — needs context the report omits | **7** |
| Deep-verified total | **~45 of 120** |
| Style opinions, no code check changes them | **18** (`#78`–`#95`) |
| Not yet verified | **~57** |

## The report's own numbers are unreliable

- `#80` claims `workbench.py` is **2,615** lines. It is **6,300**. Understated 2.4×.
- `#1` calls "no authentication" the most urgent finding. A `TrustedOriginGuard`
  is wired at `main.py:390`; measured: `Origin: https://evil.example → 403`,
  `tauri://localhost → 200`, 25 tests passing.
- Its headline recommends adding auth middleware to *all routers* — a product
  decision about the local-app trust model, filed as a Critical vulnerability.

## False positives — verified wrong

| # | Claim | Why it is wrong |
|---|---|---|
| 1 | No auth on `/api/*` | Origin guard live and enforced (measured above) |
| 2, 3 | Sandbox escape via env expansion | Expansion is deliberately *before* containment; `is_within_root()` resolves then `relative_to`s |
| 9 | XSS via `escapeAttr` | Missing `>` and `'` — but used inside a **double-quoted** attribute, where `"`, `<`, `&` are exactly the three that are escaped. Not exploitable as used |
| 12 | Pairing-code brute force | The per-platform lockout **is** the rate limit; `_MAX_FAILED` bounds attempts. Also `hmac.compare_digest` on salted hashes |
| 14 | Non-boolean stream flag | The Pydantic path is coerced by validation; the dict path is a defensive nit |
| 15 | Module-level `asyncio.Lock()` | Loop-binding at construction was **removed in Python 3.10**. This repo requires `>=3.12`, runs 3.14.6 |
| 16 | 300 s timeout kills the whole SSE stream | httpx `read` timeout is **per chunk**, not total stream duration |
| 17 | `finish_job` clears `dirty` | SQL is `CASE WHEN ? THEN 1 ELSE dirty END`. Also **already fixed** — the docstring records the original bug and its fix |
| 20 | `id(conn)` reuse | `_pending[id(conn)]` stores `conn` in the value tuple, so it stays alive while its id is a live key |
| 27 | `quota_endpoint` `TypeError` | The ternary short-circuits, **and** line 235 already early-returns the exact case cited |
| 33 | Lookbehind needs Safari 16.4 | `(?<![(\]])` is a **single-character** lookbehind. Only *variable-length* lookbehind needs 16.4 |
| 35 | `_begin_txn` check-then-act | `sessions.py` imports `threading` and carries `_state_lock` |
| 46 | `_mcpCleanupTasks` unbounded | `task.add_done_callback(_mcpCleanupTasks.discard)` removes entries |
| 50 | `_chatTasks`/`_cancelled` unbounded | `_cancelled.pop(sessionId, None)` on the close path |
| 76 | `gateway_auth` swallows exceptions | Returns `False`/`None` — that is **fail-closed**, the safe direction. Listed as if it were fail-open |
| 96 | `_q()` bypassable by Unicode lookalikes | Line 16 is standard single-quote doubling (`'` → `''`). The correct SQL escape |

**Note `#20` vs `#13`.** The audit applied the *same* "cache keyed by `id()`" claim
to two sites. It is wrong about one and right about the other, for a reason that
only shows up when you read the neighbouring line — `deferred_writes` holds the
object, `model_params` does not. Sampling one would have produced the wrong answer.

## Real, worth fixing

| # | Claim | Evidence |
|---|---|---|
| **23** | `exam.py` arbitrary file read | `ws_root = Path(body.get('workspacePath')).resolve()` is user-controlled; the only check is `p.relative_to(ws_root)`. Set the path to `/` and every absolute file passes. The comment on line 53 says *"are rejected (audit finding — arbitrary file disclosure)"* — a prior audit raised this and the fix only covers the **no-workspace** branch. Double review: `generateExam(body: dict[str, object])` takes a raw dict with no Pydantic model and no dependency that could validate upstream, so nothing else constrains it |
| **13** | Stale config cache | `_loaded_config = (stamp, parsed)` stores only the `id()`. `raw = settings.config` goes out of scope, so a new dict can land on the freed address and return stale params indefinitely. Same pattern recurs at line 255 |
| **5** | Egress DNS rebinding | `_is_allowed()` matches the **hostname** string (line 64); line 118 then calls `asyncio.open_connection(host, port)`, which resolves independently. No `getaddrinfo`/resolved-IP check exists anywhere in the file |
| **22** | Security hook fails open | Line 179 is literally `return HookResult(action='allow')  # Fail-open`. The breaker at 176 only opens *after* `_BREAKER_THRESHOLD` consecutive timeouts, so the first timeout still permits the action. **Double review found it is worse than reported:** line 197 is a second `action='allow'` on the generic `except Exception` path, so a *crashing* security guard also fails open. The report only cited the timeout branch |
| **18** | Task reported as fired when the write failed | `try: UPDATE … / except Exception: pass` then `fired.append(...)` **outside** the try (line 230). `last_fired_at` never written → fires again next call |
| **19** | `wait_for_message` re-delivers | Line 104 `return q[-1]` with no pop. Docstring says "Block until a **new** message arrives" — the code contradicts its own contract |
| **8** | OAuth tokens plaintext | Lines 949–950 store `accessToken`/`refreshToken` straight into `config.json`. No encryption at rest. Note its *recommendation* is also wrong: `app.lib.secrets` provides `mask`, which is for display, not encryption — following it verbatim would produce masked-looking-but-plaintext storage |
| **10** | PDF.js worker from CDN | Line 160 loads `unpkg.com` at runtime — remote code in a desktop app |

## Real but trivial — severity inflated

`#28` no-op ternary (`feature if feature in _FEATURE_IDS else feature`) is real but
filed as "P1 Critical Logic Bug". `#116` dead loop is real, and the comment above it
already says "Simpler: clear all for session". `#26` calls `bind_path` twice.
`#67` and `#44` leak a timer/task handle. `#104` uses `!=` for a token compare.
`#40`, `#41`, `#51` are real but small (missing lock; abandoned approvals never pruned).
`#54`, `#114` "grow unbounded" but are a `Set` of session ids and a dict of repo locks.

## Mixed — the report omits the context that decides it

- **#7** — no validation at the call site; `plugin_installer` may validate downstream.
- **#11** — defaults to `'true'` (a no-op). The real point is the absence of an executable
  allowlist for MCP registration, which is the same deliberate-trust decision as #1.
- **#21** — `asyncio.new_event_loop()` is only a bug if called with a loop already running.
- **#37** — there is no cache at all, so "no cache invalidation" cannot be the defect.
- **#42** — `threading.Lock()` is only wrong inside `async def`; not established here.
- **#6** — `follow_redirects=True` on an authenticated request is real, but the exfiltration
  impact depends on the httpx version's cross-host `Authorization` stripping.

## Style opinions, not defects

`#78`–`#95` are file-length, duplication and naming opinions ("god object",
"magic number", "too many lines"). No code review changes these verdicts. `#80`'s
stated measurement is wrong by 2.4×, which is the only checkable content in the group.

## Not yet verified

~57 claims: `#29`–`#34`, `#36`, `#39`, `#43`, `#45`, `#47`–`#49`, `#52`–`#66`,
`#68`–`#75`, `#77`, `#97`–`#103`, `#105`–`#108`, `#110`–`#113`, `#115`,
`#117`–`#120`. These are mostly the P2/P3 tables. Given the measured false-positive
rate I would not expect most to survive, but that is a prediction, not a result.

## What this means

The failure modes are consistent and identifiable:

1. **Reading a line without its neighbours.** `#17`, `#27`, `#20`, `#2`, `#9`, `#76`.
   The cited line is real; the meaning isn't.
2. **Stale platform semantics.** `#15` (pre-3.10 asyncio), `#16` (httpx read timeout).
3. **Deliberate design read as oversight.** `#1`, `#11`, `#14`, `#12`.
4. **Severity inflated to force action.** `#28`, `#54`, `#114` — cosmetic items in a
   Critical/P1 list is what makes the real findings (23, 13, 5, 22) easy to miss.

That last point is the cost. `#23` is a genuine arbitrary-file-read that a prior audit
already flagged, and it is buried at position 23 in a list whose #1 is a non-issue.

**Recommendation:** fix **#23** first, then **#13**, **#5**, **#22**. Discard the rest
until someone verifies each against code, as was done here. Do not schedule the
report's "Recommended First Steps" — step 1 (auth middleware on all routers) would
change the local-app trust model on the authority of a finding that is not true.

## Provenance — unresolved

`AUDIT-REPORT.md` appeared untracked in the working tree mid-session, dated
2026-10-01, describing "6 parallel deep-scan subagents". No such scan was launched
in this session. It is untracked and uncommitted. **Establish where it came from
before changing code on its word.**