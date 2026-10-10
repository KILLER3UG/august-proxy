# Sharing capabilities between Hermes and august-proxy

**Date:** 2026-10-07
**Answers three questions:**
1. Build the credential vault into August (parity with Hermes).
2. Bring August's features — especially the circuit toolset — into Hermes.
3. Do it without breaking Hermes, and while still receiving updates.

---

## 1. Correction and framing: Hermes already has the vault

The user is right. Hermes ships a real encrypted credential vault. Verified on this host:

```
~/AppData/Local/hermes/vault/vault.json.enc   504 b   encrypted store
~/AppData/Local/hermes/vault/vault.key         44 b   key material
~/AppData/Local/hermes/vault/.vault.lock
```

Backed by the `browser_vault_*` tool family, which:
- stores **website logins** bound to an exact origin (origin re-checked at fill time),
- stores **payment cards** and **addresses**,
- integrates external managers (1Password, Bitwarden) when detected,
- **never** returns secret values to the model — values resolve server-side,
- types passwords only through the vault tools, never via generic input.

So this is not a novel feature to design. It is an existing design to match. That is
good news: the target is known and proven, not speculative.

**Important distinction, stated plainly:** Hermes' vault is for **website logins and
cards**, entered by the user into a masked prompt. It is *not* a general "store my
Google password and log me in" mechanism, and Google password-login still fails for
the technical/ToS reasons in the other doc. The vault makes credential handling *safe*;
it does not make password-login to Google *work*. Those are separate problems.

### 1.1 What August needs for parity

August's gap is narrow and already scoped in
`2026-10-07-plugin-discovery-and-credential-storage.md` §4.3.1. Concretely:

| Capability | Hermes | August today |
|---|---|---|
| Encrypted secret store | `vault/vault.json.enc` + key | **none** — `lib/secrets.py` is 14 lines of display masking |
| Provider tokens at rest | `auth.json` (separate from config) | **plaintext** in `config.json` |
| Origin-bound website logins | `browser_vault_*` | none |
| Masked entry prompt (never types secrets) | yes | inline widget exists for MCP env — reusable |

**August-side actions (no Hermes involvement):**

- **1.1.1** Implement the store: Windows **DPAPI** (`CryptProtectData`, per-user) or
  **Windows Credential Manager** (`keyring`). Cross-platform alternative: Argon2id-derived
  key + AES-GCM, passphrase never persisted.
- **1.1.2** Move `serviceConnections` tokens out of `config.json` into it. They are
  plaintext on disk **right now** — this is a live exposure independent of any new feature.
- **1.1.3** Add origin binding + a masked entry prompt, mirroring the vault contract:
  secrets never round-trip through the model, never appear in tool results, never logged.

This is Phase A of the other doc. It is August work and is not blocked by anything here.

---

## 2. Bringing August features into Hermes

### 2.1 The one architectural fact that decides this

Hermes consumes capability through exactly two doors:

| Door | What it accepts | Can it consume August? |
|---|---|---|
| **MCP** (`mcp_servers` in `config.yaml`) | any MCP server, stdio or HTTP | **Yes** — this is the bridge |
| **Hermes plugins** (`~/.hermes/plugins/<id>/`) | Python modules written against `ctx.register_tool` | Only if rewritten |

And critically: **MCP is one-directional in practice.** Hermes is an MCP *client*
(`references/native-mcp.md`). August is also an MCP *client* (`mcp_client.py`) but does
**not** expose an MCP *server* — verified: `backend-py/app/routers/` has `mcp.py`
(management) and `harness_mcp.py` (harness proposals), neither of which serves MCP.

So "share one codebase" is achievable in one direction only: **August serves, Hermes
consumes.** Hermes plugins cannot flow back into August.

### 2.2 Recommended: expose August as an MCP server (Tier 1)

Wrap selected August capabilities as MCP tools, then point Hermes at them.

```yaml
# ~/.hermes/config.yaml
mcp_servers:
  august:
    url: "http://127.0.0.1:8085/mcp"     # HTTP transport
    headers:
      Authorization: "Bearer <local-token>"
    timeout: 180
```

Tools then appear as `mcp_august_<name>` in every Hermes conversation, auto-injected
into all platform toolsets.

**Why this wins:**
- **No porting.** Zero lines of August logic move.
- **No drift.** August updates propagate to Hermes automatically — nothing to re-sync.
- **Update-safe.** Hermes core is untouched; the integration is one `config.yaml`
  block. Hermes upgrades cannot break it, and it cannot break Hermes.
- **Already half-built.** August has ~40 routers; the work is a thin MCP surface over
  a chosen subset, not a rewrite.
- **Reversible.** Delete the config block and it is gone.

**What to build:**
- **2.2.1** New `backend-py/app/routers/mcp_server.py` exposing an MCP endpoint.
  Reuse the existing `tool_registry` (`tool_registry.py:560 listTools`, `:625 dispatch`)
  — it already has the exact (name, description, schema, handler) shape MCP needs.
  The registry is effectively already an MCP tool table.
- **2.2.2** Gate the endpoint with the existing `lib/local_api_guard.py` and require a
  token — it is a local HTTP surface with real capability behind it.
- **2.2.3** Expose a **curated subset**, not all 40+ routers. Start with the tools that
  are genuinely useful in a chat agent (circuit, board, artifact, retrieval).
- **2.2.4** Restrict to localhost. Do not expose it on the LAN.

**Risk:** medium. The endpoint is new, but it wraps existing handlers and the auth
pattern already exists. The real hazard is exposing too much surface at once — hence 2.2.3.

### 2.3 Alternative: port the circuit toolset into a Hermes plugin (Tier 2)

Choose this only if you want circuit capability **independent of August running**.

Feasibility is high. `circuit_tools.py` is 3,660 lines / 157 KB and is **almost
entirely self-contained**:

```
imports: asyncio, colorsys, hashlib, json, logging, math, os, re,
         shutil, tempfile, dataclasses, pathlib, typing
         app.services.sandbox.paths   <-- the ONLY August-internal import
```

**Exactly one coupling point**, at `circuit_tools.py:208`:

```python
bound, err = bind_path(path, workspace, for_write=for_write)
```

**What to build:**
- **2.3.1** New plugin `~/.hermes/plugins/august-circuit/` with `plugin.yaml` +
  `tools.py`, modelled on the working `plugins/homeassistant/` package
  (`plugin.yaml` declares `provides_tools`; `tools.py` ends with
  `register_tools(ctx)` calling `ctx.register_tool(name=…, toolset=…, schema=…,
  handler=…, check_fn=…, emoji=…)`).
- **2.3.2** Port the handlers verbatim, replacing the single `bind_path` call with a
  Hermes-equivalent path guard (or a local `workspace`-scoped resolver).
- **2.3.3** Keep the August tool names so both surfaces stay consistent.
- **2.3.4** Declare the external binaries as prerequisites via `requires_env` /
  the README — `simulate_circuit` shells out to **ngspice**; the module already has
  `resolve_ngspice` / `_bundled_ngspice` discovery logic that should be preserved.

**Tools that would come across** (from `circuit_tools.py`):
`create_netlist`, `read_netlist`, `update_netlist`, `delete_netlist`, `list_netlists`,
`render_schematic`, `render_logic`, `lint_netlist`, `simulate_circuit`, `circuit_test`,
`circuit_symbolic`, `circuit_annotate`, `circuit_export_vcd`, `list_boards`,
`integrate_component`, `search_component`, `render_board_3d`.

**Risk:** medium. Large module, but a single coupling point and no hidden August
imports. The `ngspice` dependency is the main runtime risk.

**Tradeoff vs Tier 1:** this *duplicates* logic, so the two codebases drift. Tier 1
does not. Take Tier 2 only for the independence.

### 2.4 Not recommended: register August's whole codebase as one plugin

August is a FastAPI app with ~40 routers and its own app lifecycle. Hermes plugins are
Python modules registering tools against `ctx`. Forcing one into the other means
carrying August's config, sandbox, and session assumptions into Hermes' process. High
effort, high breakage risk, no benefit over the MCP bridge.

---

## 3. Not breaking Hermes, and still getting updates

This is the constraint that should drive the choice, and it cleanly separates the tiers.

### 3.1 Never modify the Hermes source tree

Hermes installs its source at
`~/AppData/Local/hermes/hermes-agent/` and is updated by the installer. Editing files
under it means the next update either overwrites your work or conflicts.

**Both Tier 1 and Tier 2 respect this:**

| Tier | Lives in | Survives Hermes update? | Breaks Hermes? |
|---|---|---|---|
| 1 — MCP bridge | `config.yaml` block + August code | **Yes** — config is user data, not source | No — no Hermes code changes |
| 2 — Hermes plugin | `~/.hermes/plugins/august-circuit/` | **Yes** — plugins are user data, git-tracked | No — loaded via public `ctx.register_tool` API |

Both are supported extension points, not patches. That is the whole point.

### 3.2 Rules that keep it update-safe

- **3.2.1** Write only under `$HERMES_HOME` (`~/.hermes/plugins/`, `config.yaml`) or in
  August's own repo. Never under `hermes-agent/`.
- **3.2.2** Use the **public** plugin API only — `ctx.register_tool` and friends, as
  `plugins/homeassistant/tools.py:356` does. Do not import Hermes internals
  (`tools.registry`), which is exactly what the Home Assistant plugin's docstring says
  it moved away from.
- **3.2.3** Pin the compatibility floor in `plugin.yaml` via `requires_hermes`
  (Home Assistant's declares `">=0.21.5"`). If a future Hermes changes the plugin API,
  it will refuse to load loudly instead of half-working.
- **3.2.4** For Tier 1, keep the MCP surface versioned and additive. Renaming a tool
  breaks the Hermes side silently.

### 3.3 Keeping the port current

Tier 1 needs nothing — August is the single source of truth.
Tier 2 needs a discipline: keep a `SYNC.md` in the plugin recording the August commit
the port was taken from, and re-diff `circuit_tools.py` when August's circuit code
changes. This is the cost of the duplicate, and it is why Tier 1 is recommended first.

---

## 4. Phases, ordered by risk

| Phase | Work | Where | Risk |
|---|---|---|---|
| **A** | Encrypted secret store + migrate plaintext tokens | August | Low-med — fixes a live exposure |
| **B** | MCP server surface over a curated tool subset | August | Medium — new endpoint, reuse `tool_registry` |
| **C** | `mcp_servers.august` in Hermes `config.yaml` | Hermes (config only) | **Very low** — one block, reversible |
| **D** | Circuit plugin port (only if independence is wanted) | Hermes `plugins/` | Medium — 1 coupling point, ngspice dep |

Phase A is independent and should arguably go first regardless: plaintext OAuth
refresh tokens are on disk today.

---

## 5. Verification plan

- **A:** after migration, `config.json` contains no token values; a connected provider
  still authenticates; reading the store as a *different* OS user fails (that is what
  DPAPI/keyring buys).
- **B:** an MCP client can `initialize`, `tools/list`, and call a tool successfully;
  unauthenticated requests are refused by the local API guard.
- **C:** `mcp_august_*` tools appear in a Hermes session and return real data. Confirm
  Hermes still boots normally with the block removed (no residue).
- **D:** `create_netlist` → `simulate_circuit` round-trips in Hermes; confirm the
  Hermes source tree is byte-identical to a fresh install (`git status` clean under
  `hermes-agent/`).

---

## 6. Recommendation

1. **Do Phase A** — it is August parity work and closes a real exposure.
2. **Do Phases B + C for the general case** — one MCP bridge gives Hermes *all* the
   August tools you choose to expose, with zero porting and zero drift, and it is
   config-only on the Hermes side. This is the answer to "all features."
3. **Do Phase D only if** you specifically need circuit capability with August closed.
   It is feasible — one coupling point — but it duplicates logic and will drift.

The MCP bridge is the design that satisfies both "don't break Hermes" and "keep getting
updates," because it touches no Hermes code and needs no re-sync.
