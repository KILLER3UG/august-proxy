# Google Workspace + Classroom capability for august-proxy

**Date:** 2026-10-07
**Status:** Proposed — needs an architecture decision before implementation
**Goal:** Give august-proxy the same Google Workspace reach Hermes now has, including Google Classroom.

---

## 1. What was built in Hermes (the working reference)

Hermes drives Google through a self-contained Python CLI + an OAuth setup script.
No MCP server, no external package. Everything is one token file.

| Piece | Path | Notes |
|---|---|---|
| CLI (8 services, 40+ commands) | `~/AppData/Local/hermes/skills/productivity/google-workspace/scripts/google_api.py` | 1,328 lines |
| OAuth setup | `…/scripts/setup.py` | `--auth-url` / `--auth-code` PKCE flow |
| Token | `~/AppData/Local/hermes/google_token.json` | `authorized_user` format, auto-refreshes |
| Client secret | `~/AppData/Local/hermes/google_client_secret.json` | Desktop client |

**Auth model:** Desktop OAuth client, PKCE, `redirect_uri = http://localhost:1`
(`setup.py:72`). The user copies the `localhost:1/?code=…` URL out of the browser's
address bar and pastes it back — no local HTTP listener needed.

**Scopes granted (15)** — `setup.py:50-67`:
```
gmail.readonly  gmail.send  gmail.modify
calendar  drive  contacts.readonly  spreadsheets  documents
classroom.courses  classroom.coursework.me  classroom.coursework.students
classroom.courseworkmaterials  classroom.announcements
classroom.rosters.readonly  classroom.profile.emails
```

**Classroom commands added** (`google_api.py:1155-1391`, parser at `:1571`):

| Command | Handler | API call |
|---|---|---|
| `classroom courses` | `classroom_courses` | `courses.list(courseStates=['ACTIVE'])` |
| `classroom overview` | `classroom_overview` | courses + per-course `courseWork.list` |
| `classroom work <id>` | `classroom_work` | `courses.courseWork.list` |
| `classroom submissions <id>` | `classroom_submissions` | `studentSubmissions.list(userId='me')` |
| `classroom announcements <id>` | `classroom_announcements` | `courses.announcements.list` |
| `classroom materials <id>` | `classroom_materials` | `courseWorkMaterials.list` |
| `classroom students <id>` | `classroom_students` | `courses.students.list` |
| `classroom turnin <c> <cw>` | `classroom_turnin` | `studentSubmissions.turnIn` |
| `classroom attach <c> <cw> --drive-file-id` | `classroom_attach` | `modifyAttachments` (+ optional `turnIn`) |
| `classroom reclaim <c> <cw>` | `classroom_reclaim` | `studentSubmissions.reclaim` |

Scope-per-method mapping was taken from the live discovery document
(`classroom.googleapis.com/$discovery/rest?version=v1`), not guessed. Notably
`studentSubmissions.turnIn` requires `classroom.coursework.me`; `courses.list`
accepts `classroom.courses`; `announcements.list` accepts `classroom.announcements`.

**Verified working:** courses (13), coursework, submissions, announcements, roster all
returned real data. `materials` returned `[]` legitimately (that course had none).

---

## 2. What august-proxy has today

### 2.1 OAuth layer — already exists and is good

`backend-py/app/services/service_connections.py` (1,289 lines) implements a
multi-provider connection store (google / github / slack) with:

- **Per-facet OAuth** — `GOOGLE_FACET_API_SCOPES` at `:33-37` covers `gmail`,
  `calendar`, `drive`. Identity scopes at `:32`. Alias table at `:39-55`.
- **PKCE + CSRF state** — `_native_google_auth_url` at `:619`, `_pkce_pair` at `:586`.
- **Callback + token exchange** — `google_oauth_callback` at `:812`; stores tokens in
  `config.json` under `serviceConnections.google`; refreshes on access at `:506`;
  marks the connection degraded on `invalid_grant` at `:489`.
- **Token bridging** — `_write_workspace_mcp_credentials` at `:1073` writes
  workspace-mcp-format credential files.
- **HTTP surface** — `backend-py/app/routers/service_connections.py`:
  `POST /api/service-connections/google/auth`, `GET …/google/callback`.

**Redirect URI** (`service_connections.py:595-609`):
`http://127.0.0.1:8085/api/service-connections/google/callback`

### 2.2 The catalog advertises tools that do not exist

`frontend/desktop/src/sections/settings/integrationDirectory.ts` lists:

| Line | id | kind | `tools:` claim |
|---|---|---|---|
| `:101` | `google-gmail` | account-facet | `gmail.read`, `gmail.send`, `gmail.search` |
| `:116` | `google-calendar` | account-facet | `calendar.list`, `calendar.create`, `calendar.update` |
| `:131` | `google-drive` | account-facet | `drive.search`, `drive.read_meta` |
| `:290` | `mcp-google-workspace` | mcp-extension | `search_gmail_messages`, `send_gmail_message`, … |

**None of these are registered tools.** Verified by scanning every
`tool_registry.register(...)` call in `backend-py/app/`: the only Google-related
registration is `connect_google` (`integration_tools.py`), which merely stores an
email string. There are **no native Gmail/Calendar/Drive handlers** anywhere in the
backend.

So today the `tools:` arrays are display metadata. Connecting Google in August yields
an OAuth token and a green "connected" card — and zero callable tools.

### 2.3 The MCP path is advertised but not viable on this machine

`mcp-google-workspace` (`integrationDirectory.ts:290`) declares:
```ts
mcp: { command: 'uvx', args: ['workspace-mcp', '--tool-tier', 'core'], transport: 'stdio', … }
```
On this host: **`uv`/`uvx` are not on PATH**, and **`workspace-mcp` is not installed**
in any Python environment. So that catalog entry cannot install as written.

### 2.4 Google is not yet connected in August

`%APPDATA%\com.august.proxy\data\config.json` contains only `{'auxiliary': {…}}` —
no `serviceConnections`, no `mcpGlobalEnv`. The existing `localhost:8085` Web OAuth
client (`…bem4ovk0…`) belongs to this project but has never completed a flow here.

### 2.5 Classroom: absent

Zero references to `classroom` in `backend-py/` or `frontend/` (the one hit is an
unrelated EDA doc). No facet, no scopes, no handlers, no catalog entry.

---

## 3. The gap, stated plainly

Three separate things are missing, in increasing order of size:

1. **A Classroom facet + scopes** — small, mechanical, mirrors existing `drive` facet.
2. **A native Google tool layer** — the real work. August has *no* Google tool
   handlers; the catalog is aspirational.
3. **Catalog/UI entries** for whatever gets built.

Item 2 is the headline: wiring OAuth differently does not produce capabilities.
August needs handlers that call the Google APIs, exactly as Hermes' `google_api.py` does.

---

## 4. Recommended architecture: port the Hermes pattern natively

**Do not** route through `workspace-mcp`. It adds a `uvx` dependency that is not
present, a stdio subprocess per session, a second credential store, and it has no
Classroom support at all.

**Instead**, port Hermes' approach — it is already proven, dependency-light, and
Classroom-capable:

- Reuse August's existing OAuth + refresh (`service_connections.py`) — it already
  does PKCE, refresh, and degradation correctly. Do not rewrite it.
- Add a `google_tools.py` registration module that reads the stored access token via
  the existing `_refresh_google_access_token`, calls Google's REST APIs with `httpx`
  (already a dependency), and registers each operation as a tool.
- Add `classroom` to the facet tables so the existing OAuth machinery requests its scopes.

This keeps one credential store, one refresh path, and one HTTP client.

---

## 5. Phases, ordered by risk (lowest first)

### Phase 1 — Classroom facet + scopes (low risk, isolated)

**Action 1.1** — `backend-py/app/services/service_connections.py:33-37`: add a
`classroom` key to `GOOGLE_FACET_API_SCOPES` with the seven Classroom scopes from
Hermes `setup.py:60-66`.

**Action 1.2** — same file, `:39-55`: add a `classroom` entry to
`_GOOGLE_FACET_SCOPE_ALIASES` (at minimum `classroom.courses`,
`classroom.courses.readonly`) so an existing token is recognised as covering it.

**Action 1.3** — same file, `:105-144` (`SERVICE_META['google']`): add
`'Classroom'` to `services` and a matching `scopes` entry so the card renders it.

**Action 1.4** — verify no other table enumerates facets exhaustively. `:192`
(`_google_card` facet loop) and `:935` (callback facet merge) both iterate
`GOOGLE_FACET_API_SCOPES`, so they pick up the new facet automatically. Confirm by
running the existing suite: `backend-py/tests/test_service_connections_api.py`.

**Risk:** low — additive to dicts, no control-flow change.
**Blocker:** Classroom scopes are restricted. The August OAuth client must have the
Classroom API enabled and the account added as a test user (same constraint hit in Hermes).

### Phase 2 — Native Google tool module (medium risk, largest payoff)

**Action 2.1** — new file `backend-py/app/services/tool_registrations/google_tools.py`
with a `register() -> None` following the `media_tools.register()` shape
(`tool_registrations/media_tools.py`, `def register()` — `tool_registry.register(name,
description, handler, parameters_dict)`).

**Action 2.2** — in that module, obtain a live token by calling the existing
`_refresh_google_access_token` (`service_connections.py:506`) rather than
reimplementing refresh. Return a clear `[NOT CONNECTED]` string when the facet is
absent, matching the house style used by `dispatch` in `tool_registry.py:625`.

**Action 2.3** — implement handlers with `httpx` against the REST endpoints
(`gmail.googleapis.com`, `www.googleapis.com/calendar/v3`,
`www.googleapis.com/drive/v3`, `classroom.googleapis.com/v1`). Port the JSON shapes
from Hermes `google_api.py` so both surfaces return the same field names.

**Action 2.4** — gate each tool on its facet being connected, using the existing
`_google_connected_facets` (`service_connections.py:86`). A tool whose facet is not
connected must refuse with an actionable message, not 401.

**Action 2.5** — register the module in
`backend-py/app/services/tool_registrations/__init__.py:10-66` (`register_all`):
add `google_tools` to the import block and call `google_tools.register()` alongside
`media_tools.register()`.

**Risk:** medium — new code path, but additive and gated. The main hazard is
duplicating refresh logic; Action 2.2 exists to prevent that.

### Phase 3 — Classroom tool handlers (medium risk, depends on Phase 2)

**Action 3.1** — add to `google_tools.py`, one handler per Hermes command, mirroring
the names the catalog should advertise: `classroom_courses`, `classroom_overview`,
`classroom_work`, `classroom_submissions`, `classroom_announcements`,
`classroom_materials`, `classroom_students`.

**Action 3.2** — write operations (`classroom_turnin`, `classroom_attach`,
`classroom_reclaim`) must be gated behind whatever approval mechanism August uses for
mutating tools. In Hermes these are confirm-first by rule. **Do not ship these
ungated** — turning in coursework is irreversible from the user's perspective.

**Action 3.3** — reuse the discovery-document scope mapping (Hermes `google_api.py:55-66`):
`turnIn`/`reclaim` need `classroom.coursework.me`; `courses.list` needs
`classroom.courses`; `announcements.list` needs `classroom.announcements`. Requesting
a broader scope than needed will fail consent for restricted scopes.

**Risk:** medium — same shape as Phase 2, plus the write-gating decision in 3.2.

### Phase 4 — Catalog + UI (low risk, depends on 2 and 3)

**Action 4.1** — `frontend/…/integrationDirectory.ts`: add a
`classroom` facet entry next to `google-drive` (`:131`), `accountProvider: 'google'`.

**Action 4.2** — correct the existing aspirational `tools:` arrays (`:101`, `:116`,
`:131`) so they name tools that actually exist after Phase 2. Today they are wrong.

**Action 4.3** — decide the fate of `mcp-google-workspace` (`:290`). Either mark it
unavailable on hosts without `uvx`, or drop it now that native tools exist. Leaving it
advertising a non-installable server is a support trap.

**Risk:** low — but 4.2 is a correctness fix, not cosmetics: the current arrays
promise tools the backend cannot serve.

---

## 6. Open decision (blocks Phase 1)

The August OAuth client currently in the project is a **Web** client with redirect
`http://localhost:8085/api/service-connections/google/callback`
(`service_connections.py:595-609`). The Hermes Desktop client uses
`redirect_uri = http://localhost:1` (`setup.py:72`).

These are incompatible. Choose one:

- **(a) Keep August's Web client + 8085 callback.** Works with the existing router.
  Requires the Web client to have Classroom scopes and the account as a test user.
- **(b) Create a Desktop client for August.** Simpler PKCE, no secret, but the
  existing `GET /google/callback` router still needs to receive the redirect — so the
  loopback listener on 8085 has to stay, and the Desktop client's redirect must be
  registered as that 8085 URL.

Either way, **the Classroom API must be enabled on whichever Cloud project backs the
client**, and the account added as a test user while the consent screen is in Testing.
That exact combination is what blocked the Hermes setup until it was fixed.

---

## 7. Verification plan

1. `backend-py/tests/test_service_connections_api.py` still passes after Phase 1.
2. After Phase 2: a `list_tools`-equivalent call shows the new Google tools, and a
   Gmail read against the connected account returns real data.
3. After Phase 3: `classroom_courses` returns the account's active courses (Hermes
   sees 13 on the account used for this work — a useful cross-check).
4. Confirm the refusal path: with a facet disconnected, its tools return an
   actionable message rather than a 401 or a stack trace.

---

## 8. Deliberately out of scope

- Rewriting August's OAuth/refresh (it is correct; reuse it).
- The `workspace-mcp` route (missing `uvx`; no Classroom support).
- Docs/Sheets/Sheets-write parity — Hermes has it, but nothing in August's catalog
  asks for it. Add later if wanted.
