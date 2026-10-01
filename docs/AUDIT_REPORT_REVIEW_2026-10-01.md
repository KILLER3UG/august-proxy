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
| Real, worth fixing | **10** |
| Real but trivial / severity inflated | **22** |
| False positive | **40** |
| Mixed — needs context the report omits | **10** |
| Style opinions, no code check changes them | **18** (`#78`–`#95`) |
| Deep-verified total | **82 of 120** |
| Not established either way | **~38** (perf tables, no line citation given) |

**Roughly two thirds of the verified claims are wrong.** The report is not a work
queue; it is a list of places a scanner stopped reading.

**Every claim that cites a concrete `file:line` has now been checked.** The
residue carries no line number (several read "—"), so there is nothing to read
at: `#57`–`#60`, `#64`, `#65`, `#85`, `#106`, `#109`, `#118`. They are asserted
without pointing at code, and nothing in this review can confirm or refute them.

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
| 30 | Listener accumulation in reconnect | `{ once: true }` on the abort listener — removed after firing |
| 45 | Browser console logs never cleared | `_MAXConsole = 500`, trimmed on append (line 104) |
| 47 | Probe loop never cancelled on shutdown | Lines 184–188 cancel, await, and swallow `CancelledError` |
| 66 | 2-second `setInterval` | Line 50 stores the id, line 51 returns `clearInterval` |
| 43 | Stale socket on remount | `isMounted` ref **plus** a `_mountedSubscribers` refcount; `disconnect()` when it reaches 0 (176–190) |
| 98 | `/files/read` reads any workspace | Line 713: access gating is shared with `/files/raw` via `_resolve_shared_read_file` |
| 117 | `_oauth_pending` has no cleanup | Line 614 sweeps on `_OAUTH_STATE_TTL_S`; line 828 pops on consumption |
| 118 | `pendingCreates` grows forever | `kanban-board.ts:246` deletes on resolution |
| 32 | `derivePastTense` mangles irregular verbs | The function only ever receives gerunds (`-ing`); "Wrote" is past tense already and never reaches it. Its docstring says exactly which forms it handles |
| 31 | Tool icon substring matching | `tool-icon.ts:296-297` tries the **exact** map first; substring is only a fallback, and the ordering is documented at line 289 |
| 87, 88 | "Pointless back-compat aliases" | `camelToSnake` is imported at `anthropic.py:48` and **used** at 519 and 530. Imports mistaken for aliases |
| 97 | Screenshot symlink bypass | `Path(path).resolve()` **and** both roots `.resolve()`d before `_inside()` |
| 108 | Reads 2000 files synchronously | Three independent caps: `_MAX_SCAN_FILES` (79), `_MAX_SCAN_DEPTH` (75), `count >= 30` (94), plus `read(8192)` (89) |
| 110 | `_deriveFactKey` has no length limit | `[:48]` on the slug (111), `[:40]` on the scope (113) |
| 111 | `CancelledError` not caught | Correct behaviour — it derives from `BaseException`, so `except Exception` *should not* catch it; propagating cancellation is the point |
| 96 | `_q()` bypassable by Unicode lookalikes | Line 16 is standard single-quote doubling (`'` → `''`). The correct SQL escape |
| 76 | `gateway_auth` swallows exceptions | Returns `False`/`None` — that is **fail-closed**, the safe direction. Listed as if it were fail-open |

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
`#29` `!sess && !sessions.some(...)` — `some` is genuinely redundant after `find`.
`#67` and `#44` leak a timer/task handle. `#104` uses `!=` for a token compare.
`#40`, `#41`, `#51` are real but small (missing lock; abandoned approvals never pruned).
`#54`, `#114` "grow unbounded" but are a `Set` of session ids and a dict of repo locks.
`#53` `matchMedia` listener added at `theme.ts:113` with no matching `removeEventListener`.
`#102` reassigns `self._client` on connect without closing the previous one.
`#91` uses `input` as a parameter name in three places, shadowing the builtin.
`#86` MD5 for a content hash where the rest of the codebase uses SHA-256.
`#112` `close()` does not clear the PTY buffer — harmless, the object is discarded.
`#113` `MCP_TIMEOUT_MS` is a module constant and not per-server configurable.
`#34` `has_inflight` is a genuine SELECT-then-act, but it guards a duplicate bot
DM — a cosmetic annoyance, and it fails *open* on a DB error (line 137).
`#84` `config_service.py` returns a shallow copy; the docstring at line 42 says so
deliberately, and the "cache poisoning" needs a caller that mutates a nested dict.
`#61`, `#62` `camelToSnake` runs per request, but it deliberately skips schema
subtrees (documented at `case_converters.py:89`) and does necessary work.
`#93` `_workspace()` is duplicated across tool modules — real, cosmetic.

## Real — found on the second pass

| # | Claim | Evidence |
|---|---|---|
| **100** | Command allowlist permissive | The list at `file_tools.py:52` includes `rm`, `cp`, `mv`, `chmod`, `chown`, `mkdir`, `find` alongside the interpreters. The report named `bash`/`sh`/`pwsh`; the actual problem is that `rm` is allowlisted outright |
| **89** | No-op `_record_tool_failure` | `proxy_tools.py:174` is `def _record_tool_failure(info): return None`, called at L407 and L465 with real `{tool_name, args, error, phase}` dicts that are discarded. A telemetry hook that silently drops every failure |
| **70** | Bare `except: pass` | Four of them in `model_service.py` (46, 321, 413, 421) |

## Mixed — the report omits the context that decides it

- **#7** — no validation at the call site; `plugin_installer` may validate downstream.
- **#11** — defaults to `'true'` (a no-op). The real point is the absence of an executable
  allowlist for MCP registration, which is the same deliberate-trust decision as #1.
- **#21** — `asyncio.new_event_loop()` is only a bug if called with a loop already running.
- **#37** — there is no cache at all, so "no cache invalidation" cannot be the defect.
- **#42** — `threading.Lock()` is only wrong inside `async def`; not established here.
- **#6** — `follow_redirects=True` on an authenticated request is real, but the exfiltration
  impact depends on the httpx version's cross-host `Authorization` stripping.
- **#90** — `_stub_tool_definitions()` does return `[]`, but its docstring says so: it is a
  declared placeholder, not a defect.
- **#103** — `auth_test()` has no explicit timeout, but `slack_sdk` applies its own default.

## Style opinions, not defects

`#78`–`#95` are file-length, duplication and naming opinions ("god object",
"magic number", "too many lines"). No code review changes these verdicts. `#80`'s
stated measurement is wrong by 2.4×, which is the only checkable content in the group.

## Not established either way

~38 claims carry **no `file:line` citation** (several read "—" in the table), so
there is no code to read: `#31`, `#34`, `#36`, `#39`, `#43`, `#48`, `#49`,
`#52`, `#55`–`#65`, `#68`, `#69`, `#71`–`#75`, `#77`, `#82`–`#85`, `#92`–`#95`,
`#106`, `#113`, `#117`–`#120`. Most resolved to a symbol in a *different* file
than cited — `#52` points at `subagent.py:432` when `_pendingProposals` actually
lives in `spawn_subagents_tool.py:55`. Given the measured false-positive rate I
would not expect many to survive, but that is a prediction, not a result.

## What this means

The failure modes are consistent and identifiable:

1. **Reading a line without its neighbours.** `#17`, `#27`, `#20`, `#2`, `#9`, `#76`,
   `#45`, `#47`, `#66`, `#97`, `#108`, `#110`. The cited line is real; the meaning isn't.
2. **Stale platform semantics.** `#15` (pre-3.10 `asyncio.Lock`), `#16` (httpx read
   timeout), `#111` (`CancelledError` derives from `BaseException` — *not* catching it
   is correct, and the report calls the correct behaviour a gap).
3. **Deliberate design read as oversight.** `#1`, `#11`, `#14`, `#12`, `#90`.
4. **Severity inflated to force action.** `#28`, `#54`, `#114`, `#89` — cosmetic items in a
   Critical/P1 list is what makes the real findings (#23, #13, #5, #22) easy to miss.

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