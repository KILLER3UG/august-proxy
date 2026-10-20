# Opt-in LAN access — the design, and why it is shaped this way

Date: 2026-10-20 · Status: **approved by the owner on 2026-10-20, NOT yet
built** · Companion to `docs/plans/2026-10-20-after-this-round.md` §1

---

## Why this exists

The mobile companion is a **second client of the user's own backend**. The
mobile app is already that: `frontend/mobile/App.tsx` is an Expo shell
whose WebView loads the desktop's web app from a URL. It is not a native
client and not a local install, so the plan's open question — "second
client or full local install?" — is settled by the code that is already
there.

And a phone **cannot reach August today**, for two independent reasons:

1. `frontend/desktop/src-tauri/src/backend.rs:1574-1575` spawns uvicorn
   with `--host 127.0.0.1`. There is no bind-address option anywhere in the
   tree. A phone on the same network has nothing to connect to.
2. `backend-py/app/lib/local_api_guard.py` rejects any request whose
   `Origin` is not in the allowlist, and
   `backend-py/app/main.py:36-57` builds that allowlist from
   `localhost`, `127.0.0.1`, the Vite port, the Tauri schemes and one
   scoped embed. A phone at `http://192.168.x.x:8085` is not on it.

Neither is a bug. They are the design of an app that is **local only**,
and that is the right default for an app that holds a brain database, a
providers file, and a set of file-write tools.

The owner ruled on 2026-10-20: **opt-in LAN access**, off by default, with
a warning.

---

## The reasoning that decides the shape

**The trusted-origin guard is NOT a security boundary for the LAN.**

`local_api_guard.py` rejects a request whose `Origin` is not trusted. But
a request with NEITHER an `Origin` header nor a `Sec-Fetch-Site` header is
treated as a non-browser client and "passes untouched" — that is the
module's own documented rule, and it is deliberate: curl, SDKs, the test
suite and `/v1/*` proxy consumers must work.

So a script on the LAN sends no `Origin` and walks straight through the
guard. The origin guard stops a **drive-by webpage**; it does not stop a
**neighbour on the same network**. Those are different threats and the
guard only answers one of them.

**Therefore: when LAN access is ON, the per-install token is the
boundary, and it must cover the whole management API.**

The token exists today (`backend-py/app/lib/local_api_auth.py`, header
`X-August-Local-Token`, env `AUGUST_LOCAL_API_TOKEN`). It is applied as a
per-route `Depends(require_local_token)` on **five** routes:
`POST /api/subagents/spawn`, `/steer`, `/resume`,
`/workstreams/{name}/continue`, and `POST /api/harness/proposals/{pid}/decide`.

Those five are the routes that **start work**. They are not the routes
that can **read the user's memory** or **write files**. A LAN neighbour
with the token could drive the five; a LAN neighbour **without** it could
still GET the brain, the file tree, the session transcripts, and the
providers list.

Widening the token is therefore not an extra. It is the thing that makes
LAN access safe, and it is the part most likely to be forgotten by
someone who reads "add a bind address" and stops there.

---

## The shape

### Backend — `backend-py/app/lib/lan_access.py` (new)

| Function | Does |
|---|---|
| `lan_enabled() -> bool` | True when `AUGUST_LAN_BIND` is truthy. The backend is TOLD by the shell; it does not decide for itself. |
| `lan_origins(port) -> list[str]` | This machine's non-loopback IPv4 addresses, as `http://<ip>:<port>`. Discovery uses the standard no-traffic trick (a UDP socket "connected" to a public address, plus `gethostbyname_ex(gethostname())`). No packets are sent. An empty result is reported as empty, never invented. |
| `lan_status() -> dict` | `{enabled, origins, port}` — so the UI can be honest about what is reachable. |

### Backend — `backend-py/app/main.py`

- `_cors_allow_origins()` extends with the LAN origins when LAN is on.
  **One place, on purpose:** `local_api_guard.resolve_origins()` is built
  from `_cors_allow_origins()` + `_cors_extra_origins()`, so adding there
  covers the CORS middleware AND the origin guard, and the two cannot
  disagree. That is the entire reason `resolve_origins()` exists. A
  second allowlist would be the defect it was written to prevent.
- `/api/health` reports the LAN mode and the origins. Health may stay
  open — it says "August is here", not "here is your brain" — but nothing
  else may be reachable without the token.

### Backend — `backend-py/app/lib/local_api_auth.py`

- The token's scope becomes **conditional on LAN mode**. With LAN off,
  today's behaviour is unchanged, and the property that Docker, a bare
  `uvicorn`, and the mobile app depend on holds: **no token configured
  means no gate, by construction.**
- With LAN **on**, the whole management API requires the token. This
  belongs in a global dependency (FastAPI's `dependencies=[...]`), not in
  hundreds of route edits.
- A small, explicit allowlist stays open: the health endpoint, and
  whatever the desktop shell needs to boot. Each entry is named and
  justified in the code.
- **Three cases, not one.** A missing token, a wrong token, and a
  missing `AUGUST_LOCAL_API_TOKEN` are different. In LAN mode, a missing
  `AUGUST_LOCAL_API_TOKEN` must **fail closed** — the backend would
  otherwise be wide open — and the startup log must say so loudly.

### Shell — `frontend/desktop/src-tauri/src/backend.rs`

- `--host` becomes conditional: `127.0.0.1` normally, `0.0.0.0` when LAN
  access is on, with `.env("AUGUST_LAN_BIND", "1")` alongside.
- The setting is a small file in the app data dir (`{appData}/lan-access`,
  holding `on`/`off`), read at spawn time. `appDataDir(app)` is already
  used in this file.
- A new Tauri command `set_lan_access(enabled: bool)` writes that file and
  **restarts the backend**, because a bind address cannot change in a
  running process. `stopBackend(app, reason)` already exists and is the
  path to reuse.

### Frontend

The phone panel must be able to say one of two things, and which one it
says depends on the network mode:

- LAN on → "Your phone can reach August at `http://<lan-ip>:<port>`."
- LAN off → "August is only reachable on this machine. Turn on LAN access
  in Settings to connect a phone."

A panel that prints a LAN URL while the backend is loopback-only is
worse than no panel, because it teaches the user to believe something
false.

---

## The licence and safety shape, in one place

- **Off by default.** A local app that holds a brain and a set of
  file-write tools does not belong on the network until a person says so.
- **The warning must say what is true:** anyone on this network who has
  the token can read your memory and run tools.
- **The token never touches disk in a readable place.** It is minted by
  the shell, held in memory, and delivered to the phone over the pairing
  URL — which is then stripped from the URL so it does not sit in history,
  in a screenshot, or in a referrer.
- **The phone is a second client, not an admin.** If the token is widened
  to the whole management API, then the phone holds a key that can read
  the brain. That is a real increase in what a lost phone is worth, and it
  is the reason the pairing flow should be revocable: turning LAN access
  off should invalidate the pairing, not merely close the port.

---

## What is NOT in this design

- **No tunnel.** A tunnel would reach the same place with a different
  threat model and an extra dependency.
- **No new dependency**, on either side. The Rust side reads a two-line
  file with `std::fs`.
- **No exposure by default.** Every path here is opt-in, including the
  origin allowlist entries.

---

## Status

**Approved, not built.** The design above is complete; the implementation
is not started. It is a precondition for the mobile companion being
useful, and it is sequenced after the token plumbing — the token is
needed either way, because the phone has no other way to authenticate.
