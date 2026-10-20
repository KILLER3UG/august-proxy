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
| The two WebSocket doors | open to this machine | **token or trusted browser origin** |

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
(`/api/*`, `/mcp/*`) — not only the five routes that start work. A neighbour
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

It has to be an exemption. The desktop shell's own workbench surface does not
send the token: `api/workbench/stream.ts` and `api/workbench.ts` call
`fetch()` directly, and only `api/client.ts` attaches the header. Requiring
the token from loopback would break the chat, BTW and brain-config surfaces
of the user's own app the moment LAN access was switched on.

The five routes that *start work* (`POST /api/subagents/spawn`, `/steer`,
`/resume`, `/workstreams/{name}/continue`, `POST /api/harness/proposals/{pid}/decide`)
keep their own per-route token requirement, from every peer, loopback
included. That gate predates LAN access and is unchanged by it.

## The two WebSocket doors are different

`/api/logs/stream` and `/api/terminal/connect` are the two endpoints where
an unauthenticated socket is worst: the log stream leaks prompt bodies and
the terminal writes to the user's shell on every frame.

They are also the two doors a phone could never authenticate to, because **a
browser's WebSocket handshake cannot carry a custom header**. Gating them on
the token alone would leave the phone with no terminal and no log stream.

So a socket from the network must present **either** the token (a
non-browser client *can* set a header on a handshake — only a browser cannot)
**or** a trusted browser origin (a browser always sends `Origin`, and the
allowlist is exact). A socket with neither is refused.

The residual hole, stated plainly: a script that **forges** a trusted
`Origin` can open those two sockets. That is the same trust the origin guard
has always given a browser request — the guard stops a drive-by webpage, not
a determined script — and it is why the HTTP half of the terminal (the
`/api/terminal/input`, `/command`, `/sessions` and `/buffer` routes) is
behind the token, not behind the origin.

## Known gap: a phone cannot chat yet

The phone's WebView loads the app from `http://<lan-ip>:<port>` and takes the
token from the pairing URL. `api/client.ts` sends it on every request it
makes — but the **raw** `fetch()` calls in `api/workbench/stream.ts`,
`api/workbench.ts` and `api/liveClient.ts` do not, and the chat, BTW,
brain-config and mutation-respond surfaces go through those. A phone can
therefore open August and browse it, but those four calls get a `401` while
LAN access is on.

The fix belongs in the frontend: `installFetchPatch()` in `api/client.ts`
already wraps `window.fetch` to rewrite the URL, and adding the token header
there would cover every raw call at once. It was out of scope for the
backend half of this feature, so it is recorded here rather than done.

## What a LAN peer cannot do

* Read the brain, the file tree, the session transcripts, the providers list
  — every one of those is behind the token now.
* Drive the five routes that start work — they have always required the
  token, from every peer.
* Use the terminal over HTTP (`/api/terminal/input`, `/command`,
  `/sessions`, `/buffer`) — behind the token.
* Open a WebSocket with no credential at all — a socket must present the
  token or a trusted origin.
* Reach `/v1/*` — that is the external proxy, closed by default and gated by
  the gateway bearer key, not by the local token.
