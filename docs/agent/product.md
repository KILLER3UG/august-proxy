# Product surface

**The product is the Tauri desktop app** (`frontend/desktop/` + bundled
`backend-py/`).

- Verify and ship fixes in the **desktop app**, not by treating August as a
  standalone browser/web product.
- `web-dist/` is the Vite build artifact that Tauri packages into the desktop
  shell (and that FastAPI can serve for local backend-only runs). It is **not**
  a separate "web app" to QA against for product work.
- Prefer `npm run dev:desktop` / packaged MSI·NSIS installs when checking UI +
  workbench behavior.
- Installed production builds copy bundled `backend-py` into AppData from the
  installer stamp — **desktop releases must include backend changes**, not
  UI-only rebuilds.

## Install and update: the two guards

**Two guards carry the whole install/update promise** (do not relax either to
make a build pass): a new download must start with an empty memory, and an
update must keep everything. `{appData}/data` holds everything a user owns
(brain DB, `providers.json`, learned skills, sessions, backups) and
`{appData}/backend-runtime` holds the re-extractable copy of the payload —
siblings, never nested. `scripts/desktop-backend-payload.mjs` therefore refuses
to stage runtime user state (`data/`, `*.sqlite*`, `providers.json`,
`config.json`, `.env`, `.usage.json`), because staging reads from a working
checkout and one stray `AUGUST_DATA_DIR` run would otherwise ship a developer's
memory and API keys to every user. And `wipeStaleTree` in `backend.rs` — the
only recursive delete the update path performs — refuses any target that is not
inside `backend-runtime/`. Uninstall deleting app data is deliberately opt-in
AND suppressed under `/UPDATE`.

## Update flow

**An update is an IN-PLACE, SILENT replace, and the app restarts itself.**
The Windows update path is a custom one (`backend.rs::launch_installer_and_exit`),
not the plugin's, because the desktop release must carry backend changes.
Four things have to line up or the app never comes back: the installer is
launched with `/UPDATE /S` (silent, and routed to `reinst_done` so the OLD
uninstaller is never run — the user sees no uninstall wizard); the app
schedules the detached waiter (`schedule_post_update_relaunch`) BEFORE
launching the installer; the NSIS POSTINSTALL writes the completion marker
UNCONDITIONALLY and skips its own `ExecShell` under `/UPDATE`, so the waiter is
the single owner of the relaunch; and the waiter waits for **the pid that
scheduled it** to exit before it starts looking for the marker.

That last one is not a detail. "August is running" does not mean "no update is
in progress" — it means the opposite, because at the moment the waiter starts
the old app is ALWAYS still alive. A waiter that treated "August is running" as
"nothing to do" exited on its first iteration, every iteration, and the update
left a DEAD APP. The stale marker is deleted when the waiter is SCHEDULED, not
by the waiter: by the time the waiter starts, the installer may already have
written a fresh one. The waiter waits 120 s for the old pid to exit, then up to
1800 s for the installer, polling at 400 ms, and it relaunches at its deadline
whenever no installer process is still running — so a slow copy leaves a live
app rather than a dead one. It used to expire at 600 s, delete the marker and
exit WITHOUT relaunching, which is the "the update took forever and August
never came back" bug; the claim that it "always relaunches at its 180 s
deadline" described no code in the file. These three numbers live in a
PowerShell string, not in a Rust constant, so `check:docs` cannot guard them —
edit them only while changing the waiter itself.

The DOWNLOAD is automatic (Settings → About → "Download updates automatically",
on by default, 60 s after launch); the RESTART never is — it interrupts whatever
is running, so it stays the user's click.

`npm run check:minisign` proves the VERIFIER matches the format the app
verifies with (it checks the `minisign-verify` crate's own published vector, so
a verifier and a signer cannot agree on a mistake) and that the key in
`tauri.conf.json` and the key hardcoded in `backend.rs` are the SAME key — they
are two sources of truth for "the key the user trusts" and nothing held them
together. The RELEASE is what verifies the published signature, against the
bytes it is about to publish. The whole flow is unverified on a packaged NSIS
install: the matrix in `docs/UPDATE_VERIFICATION.md` is the check, and it has
not been run.

## Chat surface

**A run of tool calls is ONE line in the transcript, not N.** The reference
transcript collapses consecutive tool calls into an activity line — a warm dot,
one phrase ("Ran 4 commands"), the elapsed time WHILE THE LINE IS STILL
RUNNING, a chevron — and reveals them in a bordered card. A SETTLED line
carries no time: the reference's reads "Ran 4 commands, read a file" with no
duration, and every duration it shows is on a line that is still running
("Running a command  1m 18s"). The run's own time is in the card, on the group
row. That grouping is a RENDER-TIME arrangement
(`components/chat/ActivityGroup.tsx` + `lib/tool-summary.ts`), not a new
persisted block kind: the transcript still stores one block per tool call, so a
reload produces the same grouping and the backend knows nothing about it.

**EVERY kind collapses into the one line** — a read, a command and an edit in a
row is ONE line whose phrase names each kind ("Ran a command, read 2 files"),
and the card reveals every row. The separate Explore group is gone; its
vocabulary went with it, so a run of web searches reads "read N files" rather
than naming searches — the one cost of the merge, named rather than hidden.

A run containing a FAILURE is still one line, but it **opens by default** and
carries a "failed" marker, because a failure hidden behind a collapsed line is
one nobody sees. A call that is waiting for approval, or carries an action
widget, stays on its own (an interactive control must be visible and clickable)
— and so do a subagent launch and `update_state`. A run of ONE is not a group.
A run is still a run of *consecutive* blocks: grouping across a turn boundary
remains an open decision in `docs/ROADMAP.md`. The live indicator
(`WorkingIndicator`) and the persisted activity line are BOTH kept: one is what
is happening, the other is what happened.

**A DISCLOSURE OWNS ITS BODY, and the body mounts lazily.** Every
`DisclosureRow` call site passes its body as the `content` prop, so the trigger
advertises a real `aria-controls` and `aria-expanded` in BOTH states and the
region is a Radix `CollapsibleContent` rather than a sibling subtree that is
merely absent from the DOM. The one non-obvious consequence: `forceMount` +
`hidden` kills the mount animation of a body that animates ITSELF, because the
motion element would already be at its final state on the frame the region
un-hides. The fix is to mount the body LAZILY — created in the same React
commit that un-hides the region — and to let a body that leaves on its own keep
the region rendered until it reports it is gone (the `DisclosureBodyApi`
channel on `DisclosureRow`). Both were measured in Chromium against the real
components, including the eager-mount counterfactual, which reproduces the flat
curve.

**Heading demotion postprocesses HTML** — `frontend/desktop/src/lib/
markdownHeadings.ts` shifts `<h1>`–`<h5>` in the rendered string, after `marked`
has decided what the headings are. It used to rewrite the markdown SOURCE, and a
fuzz against `marked` (217,831 documents) found 12 ways that second parser
disagreed with the real one — h1s escaping into the dialog and non-headings being
rewritten in the same pass, including every CRLF document being re-ended. Do not
move the decision back to the source: the live block cache also keys on the
flag, because the same streamed block renders at two levels on two surfaces.

## Settings

The rail lives in `frontend/desktop/src/settings/settings-registry.ts`. **Do not
add a new left-rail tab** for a slice of an existing hub. Prefer a stacked hub +
`tier: 'hidden'` + `railCanonicalId` so deep links still work. Memory / Access /
Appearance already follow that pattern.
