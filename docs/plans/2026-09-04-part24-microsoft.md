# Part 24 — Microsoft Graph connectors: Outlook, Calendar, OneDrive

Status: **CHARTER APPROVED 2026-09-04** per the OQ dossier
(`2026-09-04-oq-recommendations.md`, Part 22 §9c ruling). The auth flow is
**RESOLVED: authorization-code + PKCE** (device-code recorded as an explicit
non-goal, §4). The build is **size L and comes later** — this file is **charter
text only**; no Microsoft code exists in the tree today. Companion:
`2026-09-01-capability-research.md` §4 (the source report). Every anchor below
was re-read against the current tree; where the dossier's cited line numbers had
drifted, the corrected range is used and flagged.

Scope in one sentence: **connect personal Microsoft accounts (mail, calendar,
files) by mirroring the service-connection auth layer that already ships**, with
the Microsoft-specific token rules honored, and expose a thin native tool surface
behind the existing approval gates.

---

## 1. Resolved flow — authorization-code + PKCE

The flow is authorization-code + PKCE, mirroring the existing service-connection
auth layer (the Google path in `app/services/service_connections.py`), which is
complete and well-tested. **Path note:** the dossier referenced
`services/tools/service_connections.py`; the real module is
`app/services/service_connections.py` (there is no `tools/` copy). Verified
anchors, cited as found:

- **Auth-code + PKCE URL builder** — `_native_google_auth_url` at
  `service_connections.py:619-676`: builds the browser URL with a CSRF `state`,
  `response_type=code`, `code_challenge` + `code_challenge_method=S256`
  (`:655-656`), and stores the `code_verifier` server-side in `_oauth_pending`
  (`:641`). Public entry `google_auth_url` at `:696`.
- **PKCE pair generation** — `_pkce_pair` at `:586-592` (S256 over 64 url-safe
  bytes). Dossier cited `~:586+` — confirmed.
- **Loopback callback / redirect URI** — `_google_redirect_uri` at `:595-609`,
  returning `http://127.0.0.1:{port}/api/service-connections/google/callback`
  (`:609`). Dossier cited `:595-609` — exact.
- **Code exchange / callback handler** — `google_oauth_callback` at `:812`.
- **Refresh-token rotation persistence** — `_refresh_google_access_token` at
  `:506-583`; the rotate-and-keep-newest block is at **`:573-575`** (comment
  `:573`, `if tokens.get('refresh_token')` `:574`, assign `:575`). **Drift:** the
  dossier cited `:571-573`; the real block is `:573-575`.
- **Degraded-on-invalid_grant** — `_mark_google_degraded` at `:489-503`, called
  from the `invalid_grant` / HTTP-400 branch at `:546-552`. Dossier cited
  `:489-584` — accurate as the whole degraded + refresh block.

Part 24 mirrors this layer exactly: the same facet + alias scope model, the same
public-client PKCE-without-secret path, the same degraded marking on a revoked
grant, the same per-facet disconnect that preserves other facets, and the same
loopback callback. **The tool layer differs:** Part 24 ships **native thin tools**
over one Graph client rather than delegating to an external MCP server — Graph is
one consistent REST surface, native tools keep the S-1 approval gates in-process,
and delegation would introduce a second token owner refreshing the same grant.

---

## 2. Microsoft-specific constraints (the deltas from the mirrored layer)

These are the rules that differ from the flow being mirrored and that the build
must honor:

- **Authority** — `login.microsoftonline.com/consumers` (personal accounts;
  `common` also accepted). Delegated user auth only; no app-only client
  credentials.
- **`offline_access` scope is mandatory** — without it Microsoft returns **no
  refresh token**, so the connection cannot survive the ~1 h access-token expiry.
  It is appended to every facet's scope set.
- **Refresh tokens ROTATE on use** — every refresh returns a *new* refresh token
  and invalidates the old; the client **must persist the rotated token on each
  refresh**, exactly as the mirrored layer keeps-newest at
  `service_connections.py:573-575`. Failing to persist the rotated token strands
  the connection on the next refresh (the degraded-marking path at `:546-552`
  would then fire spuriously).
- **Redirect URI must be the `http://localhost` loopback variant** — register the
  loopback form (matching the `http://127.0.0.1:{port}/…/callback` pattern at
  `:609`), not a hosted redirect.
- **Consumer tokens may be opaque / encrypted** — parse nothing but the claimed
  identity; treat the access token as a bearer blob.

---

## 3. Facets and eventual tool surface (deferred build)

Charter-level only. The build is L and comes **after** Part 19 Phase B dogfood
(routines give the daily-briefing somewhere to land) and **after** S-1 (mail is
unattended-action territory).

- Provider `microsoft` with three facets: `outlook` (`Mail.ReadWrite`,
  `Mail.Send`), `calendar` (`Calendars.ReadWrite`), `onedrive`
  (`Files.ReadWrite`) — each + `offline_access`.
- Thin tool surface (~9): `mail_search`, `mail_read`, `mail_send_draft`,
  `mail_send` (approval-gated), `events_list`, `events_upsert`, `files_list`,
  `files_read`, `files_upload` (approval-gated on overwrite). One generic Graph
  client with pagination + 401-refresh.
- Scope gates: token cache in the existing credentials store (masked cards);
  consequential actions (`mail_send` / `files_upload` / event-delete) route
  through the existing approval / consent gate; egress pinned to
  `graph.microsoft.com` (the browser / fetch allowlist is untouched).
- **Scope strings are standard but flagged implementation-time-verify** — the
  research could not confirm the delegated scope strings on the fetched pages.

---

## 4. Non-goal — device-code flow

Device-code is recorded as an **explicit non-goal** (the headless fallback).
Rationale: August is a Tauri desktop that **always has a browser available**, so
the loopback authorization-code flow is sufficient. Device-code adds a user-code
+ verification-URI + polling path (`authorization_pending`, ~15-min expiry) that
buys nothing on a machine with a GUI and would fork the auth layer into two
flows. Recorded here so it does not creep back.

---

## 5. Open questions

**None blocking** — the flow is resolved (Part 22 §9c). The build is deferred;
what a future build spike must decide (non-blocking, do not gate the charter):

- **Exact scope set per facet** — and whether to offer read-only variants (e.g.
  `Mail.Read` vs `Mail.ReadWrite`) as a consent-reduction option for Bots that
  only summarize.
- **Consent UX** — single multi-scope consent vs per-facet progressive consent.
  The mirrored layer expands incrementally with `include_granted_scopes`; Graph
  has no exact equivalent, so the facet-expansion story needs a decision.
- **App registration** — BYO client id vs a shipped default client id (the
  mirrored layer supports both); Graph's personal-account app-registration policy
  needs a spike before the build.
