# LAN access — reaching August from another device

**Off by default.** August binds `127.0.0.1`: the management API holds a
brain database, a providers file with API keys, and a set of file-writing
tools, and "reachable from the local network" is not a property a local app
should acquire by accident. The owner ruled on 2026-10-20 that LAN access
may be turned on — by a person, deliberately, with a warning.

The design and its reasoning live in
[plans/2026-10-20-lan-access.md](plans/2026-10-20-lan-access.md). This page
is the operational summary: what the switch is, where it lives, what it
changes, and what the phone panel needs to know.

---

## What turning it on changes

| | LAN off (default) | LAN on |
|---|---|---|
| Backend bind address | `127.0.0.1` | `0.0.0.0` (every interface) |
| Management API from the network | unreachable | reachable **with the per-install token** |
| Trusted origins | loopback + the desktop shell | the above **plus this machine's LAN addresses** |
| `/api/health` | open | open |
| Everything else under `/api/` and `/mcp/` | open to this machine | **token required from the network** |
| The two WebSocket doors | open to this machine | **token (query for a browser, header for a native client)** |

## The switch

A two-line file in the app data directory:

```
{appData}/lan-access      →  "on"   or   "off"
```

`{appData}` is the app-data **root** (the folder that holds `data/` and
`backend-runtime/`), NOT `{appData}/data/`. The data directory is a place a
model with `write_file` can write; a LAN switch kept there could be turned on
by something that is not the user. A missing file, an unreadable file, or
any content that is not one of the "on" spellings (`on`, `1`, `true`, `yes`,
case-insensitive) means **off** — the switch fails closed.

The desktop shell writes it and restarts the backend, because a bind address
cannot change in a running process:

```ts
import { invoke } from '@tauri-apps/api/core';

const { enabled, restarted } = await invoke<{ enabled: boolean; restarted: boolean }>(
  'set_lan_access',
  { enabled: true },
);
```

`restarted` is `false` when the backend did not come back on the new bind
address. The switch is written either way, so the next launch binds the new
way.

## The security model, in one paragraph

The trusted-origin guard is **not** a security boundary for the LAN. A
request with neither an `Origin` nor a `Sec-Fetch-Site` header is a
non-browser client — curl, an SDK, a script on the next desk — and it passes
through untouched. The origin guard stops a **drive-by webpage**; it does not
stop a **neighbour on the same network**. So when LAN access is on, **the
per-install token is the boundary**, and it covers the whole management API
(`/api/*`, `/mcp/*`) — not only the routes that start work. A neighbour
with the token can read the brain and run tools. That is the warning the
switch must carry.

Three cases, not one:

| Case | Result |
|---|---|
| no token presented | `401 local_token_missing` — the message names the `X-August-Local-Token` header |
| wrong token | `401 local_token_invalid` |
| no `AUGUST_LOCAL_API_TOKEN` configured at all | `503 local_token_unconfigured` — **fail closed**; the network gets nothing, and the startup log says so loudly |

With LAN access **off**, none of this applies: the gate is a no-op, and
"no token configured means no gate" still holds by construction (Docker, a
bare `uvicorn`, the mobile app).

## What the UI is told

`GET /api/health` is open in both modes — it says "August is here", not
"here is your brain" — and it carries the network state under `network`:

```json
{
  "status": "ok",
  "version": "0.18.18",
  "python": true,
  "port": 8085,
  "uptime": 12.3,
  "network": {
    "bindHost": "0.0.0.0",
    "lanAddress": "192.168.68.134",
    "lanEnabled": true,
    "origins": ["http://192.168.68.134:8085"],
    "port": 8085
  }
}
```

| Field | Meaning |
|---|---|
| `network.bindHost` | the address uvicorn is bound to (`127.0.0.1` when LAN access is off) |
| `network.lanAddress` | this machine's LAN address, or `null` when none was found |
| `network.lanEnabled` | whether LAN access is on |
| `network.origins` | every `http://<ip>:<port>` origin that answers |
| `network.port` | the port the backend is on |

Those three names are the phone panel's contract: the panel needs no change
when the backend starts answering them, and until then it falls back to the
loopback truth and says LAN access is off.

`network.lanAddress` is `null` when no LAN address could be discovered on
this machine. An empty answer is the honest one — a panel that prints a LAN
URL while the backend is loopback-only teaches the user to believe
something false, which is worse than no panel at all.

## The one exemption, and why it exists

A request that arrives over the **loopback interface** is served without a
token. That is a transport fact, not a header: a TCP peer cannot forge a
loopback source address. A request that arrives this way came from a program
on this machine — the desktop shell, or another local program — which is
exactly the client population the management API has always served without a
credential.

It has to be an exemption. The desktop shell's own workbench surface used to
call `fetch()` directly and only `api/client.ts` attached the header; the
fetch patch now attaches it on loopback too, which is what lets the
work-starting routes below require it from every peer without breaking the
chat.

The routes that *start work* or *approve something* keep their own per-route
token requirement, from every peer, loopback included: `POST
/api/subagents/spawn`, `/steer`, `/resume`, `/workstreams/{name}/continue`,
`/routines/{routineId}/run`, the harness proposal decide and promotion
doors, `POST /api/workbench/chat`, `/plan/approve`, `/mutations/respond`,
`POST /api/live/turn`, `POST /api/agents/rooms/{room_id}/send`, `POST
/api/automations/run`, the terminal REST doors (`/sessions`, `/buffer`,
`/input`, `/command`, `/approve`), and the preview/MCP/restart/pairing
approvals.

## The two WebSocket doors

`/api/logs/stream` and `/api/terminal/connect` are the two endpoints where
an unauthenticated socket is worst: the log stream leaks prompt bodies and
the terminal writes to the user's shell on every frame.

Both now require the per-install token. A browser's WebSocket handshake
cannot set a custom header, so the token rides in the same `august-token`
query parameter the pairing URL and the live-stream EventSources use. The
desktop terminal dock and Backend Monitor send it; a native client can send
the `X-August-Local-Token` header instead. A trusted `Origin` alone is no
longer enough: a local script can forge that header, and these are exactly
the sockets a local model must not read.

The HTTP half of the terminal (`/api/terminal/sessions`, `/buffer`, `/input`,
`/command`, `/approve`) was already behind the token, and the interactive
terminal's environment is scrubbed of `AUGUST_*` credentials, so a shell
cannot print the token for a model to read back.

## The phone can chat

The phone's WebView loads the app from `http://<lan-ip>:<port>` and takes the
token from the pairing URL. `api/client.ts`'s fetch patch now attaches the
token on every management request, including loopback and the raw `fetch()`
calls in `api/workbench/stream.ts`, `api/workbench.ts` and
`api/liveClient.ts`; the chat, BTW, brain-config and mutation-respond
surfaces are covered by that one patch.

## What a LAN peer cannot do

* Read the brain, the file tree, the session transcripts, the providers list
  — every one of those is behind the token now.
* Drive the routes that start work — the chat, live turn, subagent, routine,
  room-send, automation, proposal and terminal doors — they require the
  token from every peer.
* Use the terminal over HTTP (`/api/terminal/input`, `/command`,
  `/sessions`, `/buffer`) — behind the token.
* Open a WebSocket with no credential — the terminal and log sockets require
  the per-install token (query parameter for a browser, header for a native
  client).
* Reach `/v1/*` — that is the external proxy, closed by default and gated by
  the gateway bearer key, not by the local token.
