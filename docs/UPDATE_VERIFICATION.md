# Update verification — the manual matrix

The update path is the one flow in August that **cannot be verified by a
static gate**, because it spans four moving parts (the app, a detached Rust
waiter, an NSIS installer, and the Windows shell) and the only honest check
is to run it.

This is that matrix. Run it on a **packaged NSIS install** — not a dev
build. `npm run dev:desktop` never exercises the installer, the waiter, or
the relaunch, so a green dev run proves nothing here.

**Do not run this against a machine whose `data/` you care about.** An update
must keep everything, and that is one of the things this matrix checks. Use a
throwaway install (a Windows user account, or a VM) until it has passed.

## Why each row exists

The update flow has three independent failure modes, and each one leaves the
app in a state that looks like a different bug:

| Failure | What the user sees | What it actually was |
|---|---|---|
| The installer ran the OLD uninstaller | An uninstall wizard, then an install wizard | `PageLeaveReinstall` routed `$UpdateMode = 1` to `reinst_uninstall` |
| The app never came back | The app closes and nothing reopens it | The completion marker was written only in the non-silent branch, and the silent install skipped it |
| Two Augusts came back | Two windows, two backends fighting over the port | The POSTINSTALL's `ExecShell` and the waiter's relaunch both fired |

The matrix is one row per way those can happen, plus the ones that make the
update *wrong* rather than *broken*.

## The matrix

| # | Step | Expected | If not |
|---|---|---|---|
| 1 | Install the previous release. Create a session, add a provider key, write one memory, and set a non-default brain-config value. | The session, the key, the memory and the setting all persist. | Stop. Nothing below is meaningful if an update loses state. |
| 2 | Publish a new build. Launch August and wait 60 s. | The download starts on its own. No prompt, no click. | The preference "Download updates automatically" is off, or the check did not run. |
| 3 | Watch the download complete. | The UI offers "Restart to update". The app does NOT restart by itself. | The auto-download applied the update. That is the one thing it must never do — the restart interrupts whatever is running. |
| 4 | Click "Restart to update". | No uninstall wizard. No install wizard. No window of any kind. The app closes. | An uninstall wizard appeared → the NSIS route is still `reinst_uninstall`. An install wizard appeared → `/S` is not being passed. |
| 5 | Watch for the relaunch. | August reopens within a few seconds, on the NEW version. | Nothing reopened → the completion marker was not written, or the waiter was not scheduled. Check for `.august-update-complete` in the install directory. |
| 6 | Look for a second August. | Exactly one window. One backend on its port. | Two windows → the POSTINSTALL's `ExecShell` is not suppressed under `/UPDATE`. |
| 7 | Re-check the state from step 1. | The session, the provider key, the memory and the brain-config setting are all still there. | The update is not preserving state. That is the install/update promise; stop here. |
| 8 | Run a turn that makes a tool call. | The tool runs. The model list shows a long model id WITHOUT it painting over the badges beside it. | The truncate regression. `npm run check:truncate` should have caught it — check it ran. |
| 9 | Force a turn that the harness rescues (a budget breach, or a provider that 400s twice). | A notice appears in the transcript saying the turn was adjusted, and that the answer may be incomplete. | The `recovery` frame is invisible again — a handler is not being supplied. `npm run check:sse` should have caught it. |
| 10 | Turn "Download updates automatically" off. Wait for another new build, and refocus the window. | No download starts. | The preference is not being read, or the cancel path is not honoured. |

## The signature check

There is one more thing a user can hit that no row above reaches, and it is
the worst one: the installer is downloaded, and then the app **refuses it** as
untrusted. The user sees "this installer was rejected" and has to install by
hand.

That happens when the release was signed with a key that is not the one
`tauri.conf.json` pins. Nothing in the app can detect it — the app only finds
out when the signature fails. The release pipeline now checks it before
publishing:

```bash
npm run check:minisign
```

That proves the VERIFIER works. The release itself proves the pairing:
`scripts/release-desktop.mjs` verifies the produced `.sig` against the pinned
`pubkey` on every build, and refuses to publish if it does not match.

## If a row fails

1. Do not work around it by re-running the installer. The point of the row
   is the failure.
2. Capture the install directory's `.august-update-complete` marker (present
   or not), the app's log around the relaunch, and the version before and
   after.
3. The four moving parts are:
   - `src-tauri/src/backend.rs` — `launch_installer_and_exit` (the `/UPDATE
     /S` flags) and `schedule_post_update_relaunch` (the waiter);
   - `src-tauri/windows/installer.nsi` — the `$UpdateMode = 1` route;
   - `src-tauri/windows/hooks.nsh` — the PREINSTALL sweep and the POSTINSTALL
     marker write;
   - `hooks/useAppUpdate.ts` — the Windows branch, which must schedule the
     waiter BEFORE it launches the installer.
