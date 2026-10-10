# Plugin auto-discovery + credential storage for august-proxy

**Date:** 2026-10-07
**Status:** Proposed
**Covers two asks:**
1. August should be able to find and import plugins/extensions on its own.
2. August should be able to ask for a user's email + password, store it safely, and use
   it later to sign in to sites (e.g. Google) to reach Calendar and more.

**Read section 3 before approving ask 2 — the Google-password approach as stated will
not work and should not be built.**

---

## 1. Ask 1 — plugin import: what exists today

August already has a real installer. This is more built than it looks.

### 1.1 Install machinery (works)

`backend-py/app/services/plugin_installer.py` (207 lines):

| Function | Does |
|---|---|
| `parse_source` | Accepts `owner/repo` or a github.com URL |
| `_clone_with_git` | `git clone --depth 1` when git exists |
| `_download_tarball` | HTTP codeload tarball fallback — installs with no git binary |
| `_detect_entry` | Finds `dist/index.js` → `index.js` → … |
| `_npm_install` | Best-effort `npm install --omit=dev` |
| `install_from_github` | Orchestrates the above into `data/plugins/<name>/` |

Model-callable via `installMcpServer(...)` in
`backend-py/app/services/integration_tools.py`, which accepts:
`command` (stdio), `url` (http/sse), or `source='owner/repo'` (GitHub plugin).

Registration goes through `mcp_client.registerServer(...)` with `persist=True`, and
`discoverTools` enumerates the server's tools after start.

**So: August can install essentially any MCP server or GitHub plugin today — if
something hands it the coordinate.**

### 1.2 Discovery (does not work)

Discovery is entirely static. Two hardcoded lists, in two places:

- `backend-py/app/routers/mcp.py:38` — `GET /api/mcp/directory` returns **5 literal
  entries** (filesystem, memory, fetch, github, google-workspace).
- `frontend/desktop/src/sections/settings/integrationDirectory.ts:99` — the UI's own
  `INTEGRATION_DIRECTORY`, also literal.

There is **no live registry fetch, no search, no pagination, no version resolution**
anywhere in the backend. Grepping the installer for registry/npm/PyPI/GitHub-search
endpoints returns nothing.

**The gap:** August can install anything it is told about, but cannot discover
anything on its own. Ask 1 is therefore a *discovery* problem, not an *installation*
problem.

### 1.3 What to add

**Action 1.1 — a registry client.** New
`backend-py/app/services/plugin_registry.py` that queries live sources and normalises
them into one shape (id, name, description, source, transport, install spec,
popularity, verified flag):

| Source | Endpoint | Notes |
|---|---|---|
| Official MCP registry | `registry.modelcontextprotocol.io` | Canonical, has server metadata |
| npm | `registry.npmjs.org/-/v1/search?text=<q>` | Covers `@modelcontextprotocol/*` |
| PyPI | `pypi.org/search` | For Python servers (`uvx`-style) |
| GitHub | `api.github.com/search/repositories?q=topic:mcp-server` | Long tail |

Normalise into the existing `IntegrationCatalogEntry` shape
(`integrationDirectory.ts:18`) so the UI needs no new type.

**Action 1.2 — a discovery tool.** Register `search_plugins(query, limit)` in
`integration_tools.py` so the model can find servers in chat, then call the existing
`installMcpServer` with the resolved coordinate. This is the "on its own" part: today
the model can install but not search.

**Action 1.3 — merge sources in the UI.** `GET /api/mcp/directory` should return the
curated 5 (as "recommended") *plus* live results, not replace them. Keep the curated
list — it is the verified path.

**Action 1.4 — install-time safety gate (do not skip).** Auto-installing arbitrary
third-party code that then runs with the user's credentials is a supply-chain and
prompt-injection surface. Before enabling unattended install:
- Default to **recommend-only**: search surfaces results; install requires an explicit
  user action (the existing inline setup widget is the right hook).
- Pin to a resolved version/commit — never install a floating `latest`.
- Keep the existing `mcp_client` launch validation (shell-command / catastrophic-args
  checks) as the hard floor.

**Risk:** 1.1–1.3 are low (additive, read-only). **1.4 is the real risk** — an
auto-install path that runs third-party code is the single most dangerous thing in
this document. Recommend shipping 1.1–1.3 first and treating unattended install as a
separate, deliberate decision.

---

## 2. Ask 2 — credential storage: current state

**There is no secret store.** `backend-py/app/lib/secrets.py` is 14 lines and contains
exactly one function, `mask(value, visible=4)`, which is display-only string masking.

Consequences today:

- `service_connections.py` writes Google/GitHub/Slack tokens **in plaintext** into
  `config.json` (`_save_sc` → `saveConfig`).
- Verified on disk: `%APPDATA%\com.august.proxy\data\config.json` is plain readable
  JSON. Any token placed there is readable by any process running as the user.
- `_write_workspace_mcp_credentials` (`service_connections.py:1073`) writes a second
  plaintext copy into `~/.google_workspace_mcp/credentials/`.

So "store it safely" is **not currently possible** in august-proxy without adding a
real secret store. That is a prerequisite, not a detail.

---

## 3. Why the Google-password approach should not be built

The ask was: ask the user for their Google email + password, store it, and use it to
sign in to reach Calendar and more. Three independent reasons this fails:

### 3.1 Google blocks it technically

Google has blocked automated password sign-in for years. A programmatic login attempt
gets `This browser or app may not be secure` / `Couldn't sign you in`, because Google
fingerprints the client (no real browser TLS/JS fingerprint, no device history). It
also routes straight into 2FA/CAPTCHA challenges. A headless Playwright login to
Google is exactly the pattern Google's abuse detection is built to catch. This is not
a "needs more engineering" problem — it is an intentional block.

### 3.2 It violates Google's terms and risks the account

Storing and replaying a Google password violates the Google Terms of Service and the
API Services User Data Policy. Practical consequence for the user: account lockout,
forced password reset, or suspension. For a *Workspace* (school/work) account it can
also breach the institution's acceptable-use policy.

### 3.3 It is strictly worse than what already exists

OAuth is already implemented and working. `service_connections.py` does PKCE, CSRF
state, refresh-on-access, and degradation handling correctly. OAuth:
- is the sanctioned path, so it will not get the account locked;
- grants scoped, revocable access (user can revoke in one click);
- never exposes the password to August at all;
- covers Calendar, Gmail, Drive, and Classroom.

A stored password grants **everything**, forever, and cannot be scoped. It is more
power and less safety.

### 3.4 The prompt-injection problem

An agent that holds a reusable Google password and browses untrusted web content can
be induced — by a page, an email, or a plugin — to use that credential. That is a
complete account takeover with no second factor. This is the single strongest argument
against the design.

**Recommendation: for Google, use OAuth. Do not build password login for Google.**

---

## 4. What actually achieves the goal

The underlying want is legitimate: *let August reach my logged-in web services, and
let that survive across sessions.* Three approaches, in order of preference:

### 4.1 OAuth where offered (Google, GitHub, Slack, Microsoft, …)

Already built for three providers. Extend the existing facet model rather than adding
passwords. This is the answer for "access its calendar and more."

### 4.2 Persistent browser profile where OAuth is not offered

For sites with no OAuth, the correct mechanism is a **persistent browser profile**, not
a stored password:

- Playwright supports `launch_persistent_context(user_data_dir=...)` — the user signs
  in **once, manually, in a real browser window**; cookies/localStorage persist on disk.
- Alternatively `context.storage_state(path=...)` saves and restores cookies per site.

**This is the key design change:** it means August never holds the password. The user
authenticates themselves; August only holds a session cookie — which is revocable
server-side, expires naturally, and is useless without the site.

**Current blocker:** `backend-py/app/services/browser/session_manager.py:89` uses
`browser.new_context()`, and its docstring states the isolation is deliberate — "so
cookies and localStorage don't leak across sessions." A persistent profile is a
direct reversal of that design intent. It needs a per-site opt-in, not a global switch,
or every session inherits every other session's logins.

**Actions:**
- **4.2.1** Add an opt-in "trusted sites" concept with a dedicated persistent profile
  directory, separate from the ephemeral per-session contexts.
- **4.2.2** Expose a "Sign in to <site>" flow that opens a headed browser for the user,
  then stores only `storage_state` — never form values.
- **4.2.3** Scope the saved state per origin, and never inject it into a session
  browsing a different origin.

### 4.3 If passwords must be stored anyway

Only if 4.1 and 4.2 are both unavailable for a target site, and only after 4.3.1:

- **4.3.1 — add a real secret store first.** `config.json` is plaintext and must not
  hold secrets. On Windows use **DPAPI** (`CryptProtectData`, per-user key, via
  `pywin32`) or the **Windows Credential Manager** (`keyring`). Cross-platform
  alternative: Argon2id-derived key + AES-GCM, with the passphrase never persisted.
- **4.3.2 — migrate existing tokens** out of `config.json` into that store. Today's
  Google/GitHub/Slack tokens are already sitting in plaintext; that is a live issue
  independent of this feature.
- **4.3.3 — never log, echo, or send secrets to the model.** The existing pattern is
  correct: `installMcpServer` deliberately omits the raw server record because it
  carries `env` (`integration_tools.py`, comment at the return). Follow it. Masking
  for display (`lib/secrets.py`) is not storage protection.

**Never** store a password for a service that offers OAuth.

---

## 5. Phases, ordered by risk

| Phase | Work | Risk |
|---|---|---|
| **A** | Secret store (4.3.1) + migrate existing plaintext tokens (4.3.2) | Low-medium — fixes a live exposure |
| **B** | Plugin registry client + `search_plugins` (1.1–1.3) | Low — read-only, additive |
| **C** | Persistent-profile sign-in for non-OAuth sites (4.2) | Medium — reverses a deliberate isolation choice; needs per-site scoping |
| **D** | Unattended plugin install (1.4) | **High** — runs third-party code; separate decision |

**Phase A should arguably come first regardless of these asks** — plaintext OAuth
refresh tokens are sitting in `config.json` today.

---

## 6. Verification plan

- **A:** after migration, `config.json` contains no token/secret values; a connected
  provider still authenticates. Attempt to read the store from another user account
  and confirm failure (that is what DPAPI/keyring buys).
- **B:** `search_plugins("calendar")` returns live results from at least two sources;
  an entry round-trips into `installMcpServer` and registers successfully.
- **C:** sign in to a non-OAuth site once; restart August; confirm the session
  survives. Then confirm a *different* origin's session does **not** inherit those
  cookies.
- **D:** install a deliberately malformed plugin and confirm the launch validation
  refuses it.

---

## 7. Deliberately out of scope

- Password login for Google (section 3 — should not be built).
- Rewriting the OAuth layer (it is correct; extend the facet tables).
- A full plugin marketplace with ratings/reviews — search + install is enough.
