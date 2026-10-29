# Security: secrets, authority, sandbox doors

Read this before changing a sandbox rule, a path door, a secret path or an
agent-permission surface. The behaviour here is safety, not preference.

## Credentials never leave the process

**The outbound body is scrubbed of this install's own credentials.** A key that
rides into the transcript once — pasted by the user, quoted by a log line,
printed by a command whose path looked harmless — is re-sent to whichever
gateway is active on EVERY later turn, which is why the tool-boundary guard
(`hooks/secret_guard.py`: deny secret-shaped writes, redact protected-path
reads) was not enough. `scrubOutboundBody` runs at the **transport**:
`BaseProviderClient.wireBody(body)` wraps its two `self.client` calls
(`requestJson`, `streamSse`), which is the only place that sees every body. It
is NOT in the `dump_*_upstream_body` serializers, and a review round proved why:
the workbench dumps an empty `ChatCompletionRequest` and assigns
`body['messages']` afterwards (`workbench/providers.py`), and the `/v1` proxy
appends tool results and re-sends after its dump — a serializer door covered
neither, while the auth header (where a key legitimately belongs) stays
untouched at either.

**The encrypted store is a FOURTH source**, added when the service-connection
tokens, the provider keys and the `mcpGlobalEnv` secrets moved into it: the
collector reads the store after the providers, so a key in both is labelled
with its provider rather than with a store key. The stamp covers
`secrets.json` as well as `providers.json`, and a MISSING file contributes
`(-1,-1)` rather than collapsing the whole stamp — before, a fresh install
with no `providers.json` froze the credential set for the life of the process.

**Matched by VALUE, never by pattern**: a pattern scrub would rewrite
key-shaped text a user pasted to ask why their own key 401s. Values come from
the providers store, `settings.gatewayApiKey` and `*_API_KEY` env vars; anything
under 12 characters is ignored (a 3-char "key" would substring-mangle prose).
The cache is stamped on **both** `providers.json` and `config.json` — the
gateway key is minted through `saveConfig`, which fires no invalidation callback
at all — and the stat is taken once per body, never per leaf: on a 641 KB body
with 1,001 string leaves the per-leaf stamp cost 419.6 ms against 1.94 ms
hoisted (the `json.dumps` that follows costs 5.9 ms). An EMPTY result is never
cached, so a transient read failure cannot switch the gate off silently; failed
reads log at warning.

Stated limits: a value that arrives already escaped (`\u0073k-…`, base64 of the
transcript) does not match, and a keyring-held credential is out of reach. Env
collection is `*_API_KEY` only — a database password the user is working WITH
must stay visible while a provider key the install works FROM must not.

## Agent authority

**An agent's capability definition is not model-writable.** `create_agent`,
`update_agent` and `delete_agent` are ordinary registered tools, so whichever
model is talking could pass `agentId` plus `permissions: ['all']` for any agent
— measured before the fix: a turn holding `['read_file']` wrote itself `['all']`,
rewrote an unrelated agent's permissions *and* model routing, and deleted both
that stranger and its own root. Guard modes do not cover this:
`needs_approval_in` returns False for `full`, and **every Bot DM and room session
is created with `guardMode='full'`** (`rooms.py`), and no session is even
required. So `_authority_refusal` rejects `permissions` / `tools` /
`modelAlias` at the handler (they are gone from the advertised schemas too — a
knob that always refuses is a lie), the descriptive fields stay writable, and
the registry's own write stays open for the human door (`PUT /api/agents/{id}`,
`actor='ui'`).

`delete_agent` routes through `roster.delete_bot` like the UI route always has:
only that path refuses the default assistant Bot and cascades a deleted Bot's
private footprint; a bare registry delete left the facts, DM rows, room
memberships and canonical chat behind and `ensure_default_bot` re-minted a NEW
id for `assistant`, stranding every chat bound to the old one. On top of that a
turn may not delete itself, an ancestor, or a branch that still has children.
`POST /api/august/agents/manage` deletes through `roster.delete_bot` too, and
names the actor in the audit.

**An absent capability definition means inherit, and inheritance cannot
widen.** `permissions: []` was read as "allowed nothing", which is why
`evaluateAgentTool` denied every tool to a roster-created Bot — measured: a
delegated worker kept **0 of 6** tools, while the sibling controls (`['all']` →
6, prefix `read_` → 1) proved the probe could tell. Both real agents in this
install's store are `[]`, and `create_bot` never sets the field, so the empty
list is the ABSENCE of a definition, not a grant of nothing;
`_declaredPermissions` says so once and `evaluateAgentTool`,
`_effectivePermissions` and the spawn surface all read it. Inheriting is safe
because a worker's names are always drawn from `toolDefinitions(session)` — the
PARENT's list — so it cannot exceed the turn that spawned it.
`_effectivePermissions` applies the parent's bound even to a child declaring
`'all'`, because otherwise `'all'` launders the restriction away.

`deriveChildPermissions` — which existed, was called, and had its result
discarded behind a guard reading `session.agent_id` while the field is
`agentId`, so it never ran — is now the spawn-time ceiling in `_lineageCeiling`.

**Enforcement is the deny set, not the withheld surface**: `tool_call` dispatches
an arbitrary name through the real executor, so a worker spawned read-only could
still `write_file` by naming it. `_workerDeniedNames` (tier, restricted set,
never-tools, lineage ceiling, a declared list) is published on
`currentSubagentDenied`, read by both the worker's dispatch guard and the bridge.
It is a DENY set on purpose — the offered list is a progressive-disclosure slice
and `tool_search` → `tool_call` is the documented route to a tool outside it, so
gating on that slice would break delegation for weak models. `update_agent` and
`delete_agent` are in `_SUBAGENT_NEVER_TOOLS` alongside `create_agent`.

**The bridge decides "am I inside a worker" from the deny set's presence, never
from `currentSubagentDepth > 0`** — a worker's runtime depth is
`max(depth, agent.depth)` and every roster-created Bot has depth 0, so the depth
test skipped both the never-tool gate and the deny set for every real subagent
(`tool_call('remember')` executed), while a root turn publishes no deny set at
all. **Two unresolvable lineages resolve in opposite directions on purpose**: a
dangling `parentId` is reachable by ordinary use (the UI delete has no children
check) and means *no restriction* — the parent's bound left with the record, and
reading it as `set()` collapsed every such worker to zero tools — whereas a
`parentId` **cycle** is not reachable by a model turn, so it fails closed; before
the walk was bounded it raised `RecursionError`, which the ceiling swallowed into
"no ceiling", i.e. the fail-OPEN direction (measured, at
`agent_registry._effectivePermissions`).

## Listing and shell doors

**Listing doors** — a credential store is **unlistable**, and that one rule is
asked at seven doors today: `security.py::workspace_files` (the route the
composer's @-mention picker and the session list call),
`workbench.py::workspaceFiles`, `file_tools._listDirectory`,
`file_tools._searchFiles` (its root **and** every result line),
`file_tools._pySearchFilesSync` (the no-`rg` fallback), the code-mode
`list_files` in `workbench/code_runner.py`, and
`workbench/module_context._describe_directory`. Each calls
`sandbox.paths.listable_root` (a directory that is or lives inside a store) then
`listable_entry` / `listable_child` per entry — `is_credential_directory` matches
**any whole path component**, so `~/.ssh/keys` is refused, not just `~/.ssh`.
The file rule is name matching without a resolve, and it is safe **only** because
every lister clears its directory first. An eighth door is how the seventh was
found — do not add one, call the two helpers.

**Shell doors and the `.ssh` asymmetry** — `check_hardline_command` refuses a
store path only for a command that **enumerates** (`_ENUMERATING_COMMANDS`),
because `.ssh` is deliberately readable at its **public** members while its
contents may never be walked. That exception is an ALLOW list,
`_SSH_PUBLIC_MEMBERS` (`config`, `authorized_keys`, `known_hosts`, plus any
`*.pub`), judged by `_ssh_member_reason` on a DIRECT member — it used to be a
deny list (`id_\w+` in the read pattern), and `cat ~/.ssh/work_github`, a
hand-named identity key, read clean through every door. `id_rsa.pub` was
refused by the same defect: `(?:^|/)id_\w+` matched `id_rsa` inside it, so the
`.pub` exemption sits immediately after `id_` where backtracking cannot defeat
it. Globbing (`~/.ssh/*`) and copying a subtree out (`cp -r ~/.ssh/keys /tmp`)
are already refused by the read/write patterns, not by the store rule.

`backend-py/app/services/workbench/code_runner.py` carries a **port** of this
guard rendered into every code run (it cannot import `app`); a new table or
predicate in `sandbox/hardline.py` must be injected there too. The port must
probe the **resolved** path like `bind_path` does, or a workspace link into a
store reads the token. Parity is not proof: a corpus entry both copies miss is
green, which is why that file also asserts the port's own verdicts.

**One tokenizer, and what it must survive** — `_tokenize` is the only splitter
for a command line: `_is_write_intent`, `_enumerates_a_directory` and
`check_hardline_command` all read through `_segments`, because when each had its
own `re.split(r'\s+')` they disagreed and `ls${IFS}~/.ssh` was one word for the
enumeration rule and two for every other rule. It splits on shell terminators
(`; && | < > ( ) ` newline {}`) and expands `${IFS}`, and it must: a glued
terminator compared the component `.ssh;`, which is not `.ssh`, and
`bash -c "ls -la ~/.ssh;"` printed the store's whole key inventory. Store
components are also matched after `_strip_dangling_dots`, because NTFS drops a
trailing dot or space from the component it opens — `.aws./sso/cache/<hash>.json`
**is** the SSO cache and leaked a token while `is_credential_directory`, which
resolves, kept refusing it. Do not add a second split or a second form.

**The terminal is a gated shell, in both directions** — `writeTerminalInput`
(the REST route and the drawer's WebSocket both reach it) runs the hardline list
on **every** line, not on the `_interactive_needs_preflight` subset: that
predicate exempts anything starting with `cd `, which let `cd ~/.ssh/keys && cat
id_work` type a private key into a buffer readable through
`GET /api/terminal/buffer`, and exempts any single whitespace token, which let
`ls${IFS}~/.ssh` through unchecked. The exemption stays only for the soft
workspace preflight, whose subject is escaping a workspace.
`createTerminalSession` additionally refuses a `cwd` inside a store, because
`session['cwd']` is the launch directory and is never updated — a bare `ls`
names nothing for the line gate, and the store's contents are the secret set. A
human who wants their own `cd ~/.ssh` has a terminal outside the app.

## Write doors: execution and instruction state

**Hooks are execution policy, so the write door owns them** —
`<dataDir>/hooks.json` loads with **no** trust decision (the trust gate in
`user_hooks` keys on a *workspace* origin, and the user-level file has none), and
the data directory is an allowed root for an absolute `write_file` path. So a
model could install a shell command for August to run on the next event,
persistently. `hooks\.json$` is in `_PROTECTED_WRITE_PATTERN` (both the
user-level and the `.aug/` path); reads stay allowed because a hook definition
is not a secret.

**Instruction and execution state is a write-door rule, not a proposal rule.**
`skill_service._skillRoots` reads `<workspace>/.aug/skills`,
`<dataDir>/skills` and `<dataDir>/bots/<id>/skills` as live layers, and
`catalogue()` — the one door every prompt surface reads — renders the name and
description into the NEXT turn. So `write_file` into that layer is installing an
instruction: measured at 'Successfully wrote 209 bytes' with a payload telling
the agent to exfiltrate `providers.json`, with a `run.sh` beside it, bypassing
the proposal, the approval and the content rails in `harness_rails` that the
learning pipeline is held to.

`_agent_state_reason` closes the two agent layers plus `mcp-servers.json`
(launches a process per entry), `automations.json` (`jobType: 'shell'` with its
command), `<workspace>/.aug/kernel/**` (`run_command` is exempted to EXECUTE that
venv's interpreter, so a module dropped into its `site-packages` runs on the next
cell), `<dataDir>/memory/**` (the human-readable memory view) and the brain
database itself (from `AUGUST_BRAIN_SQLITE_FILE` **or** the data-dir default —
naming only the default protects a file that may not exist). The door is fed
`_store_match_form`, not `_canonical`: its comparisons are lower-cased, so the
raw spelling left every data-directory rule inert on Windows. Reads stay
allowed; the sanctioned writers (`skill_service`, `harness_self_improve`) use
`Path.write_text` and are deliberately NOT behind the door, which is what makes
the proposal route the only one a model can take. The BUNDLED layer
(`<repo>/skills`) and a workspace's own `AGENTS.md` stay writable on purpose:
that is a developer's checkout, reviewed in a diff, not app state a model owns.
Code mode has its own `write_file`, so the port carries the rule by injection.

**Project skills are trust-gated at the read door.** A workspace's
`.aug/skills` root is repo-supplied instruction content, so
`skill_service._skillRoots` includes it only when
`is_skill_workspace_trusted(workspace)` says the user approved that workspace
for skills. The approval lives in its own data-dir store, separate from the
hook-workspace store: trusting shell hooks is not consent to load instruction
packages. The raw root is still parsed for the pending-skill notice and the
Settings → Skills trust banner, so an untrusted repository is visible rather
than silently ignored; the model sees a count of inactive project skills and
`load_skill` cannot load them. Revoking busts the catalogue and prompt caches.

## Gate participation and file ceilings

**Gate participation** — every sandbox / permission / URL guard is an inline
`if toolName in (...)` prologue at one call site, so an **alias or aggregate
entry point is unguarded by default**. `bulk` routes `operation=<x>` to the
same handler as `x`. When you add a tool, a bulk operation, or a new router,
assert it is claimed by a gate: `npm run check:tool-registration` and the
smoke's policy checks are the floor. Five real guards were missing this way
(audit 2026-09-27 #2, #6, #8, #22, #30).

**File-read ceilings** — `read_file` refuses a file over `_MAXFileSize` (**20 MB**) and tells you to page it. Paging is the documented escape hatch and works
up to `_MAXPageFileSize` (**200 MB**), which is higher *on purpose* so a large log
is still readable — but it is finite, because the paged branch reads the file
twice (text, then raw bytes for the `fileHash` the edit gate needs).

Sandbox implementation lives in `backend-py/app/services/sandbox/`; changes
there affect tool execution safety in every mode, including the code-mode port.
