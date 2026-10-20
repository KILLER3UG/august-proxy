# After this round: the mobile companion, the board, and the chat surface

Date: 2026-10-20 · Status: **the round below has shipped; this file is
what comes NEXT** · Companion to `docs/ROADMAP.md`

This file exists so the next work is not lost between rounds. The order
is deliberate and it is the order the owner asked for.

---

## 1. The mobile companion — the NEXT build

The desktop round is the foundation; the phone is what comes after it.

The mobile app already exists — `frontend/mobile/` is an Expo app with its
own `tsc --noEmit` and a parity audit (`npm run test -w frontend/mobile`)
— and it is the smallest of the three frontends. What this round changed
that the phone has to pick up:

- **The per-install token.** The desktop shell generates it and hands it to
  the backend over the Tauri IPC. A phone has no Tauri IPC, so it needs
  its own way to authenticate to the backend it talks to. The gate is a
  no-op where no token is configured, so the mobile app keeps working
  unchanged — but a phone talking to a token-configured backend needs a
  token.
- **The activity-line grouping** is a render-time arrangement, so the
  mobile transcript can adopt the same contract from the same block
  stream, with no backend change at all.
- **The recovery notice** is a persisted system block, so it survives a
  reload and a phone's backgrounding.

### The decision that is still open

**Is the mobile app a second client of the user's own backend** (the phone
drives the desktop install over the network, and the token decides who may)
**or a full local install** (the phone runs its own backend and its own
brain)?

The first is a remote-control surface and is much smaller. The second is a
second August, and it is the one that needs a per-install token ON A
PHONE. This is the owner's call and it changes the size of the work by
roughly an order of magnitude.

### The work, if the answer is "second client"

1. A pairing flow: the desktop shows a QR code carrying the backend
   address and a one-time pairing secret; the phone scans it.
2. The phone stores the address and the token in the platform's secure
   store (Keychain / Keystore), never in `AsyncStorage` — the token is
   the thing that stands between a stranger's phone and the user's brain.
3. The transcript renders from the same SSE block stream, with the
   activity-line grouping and the recovery notice.
4. A push channel for "your turn finished" — which is the actual reason
   to have a phone app, and the one thing the desktop cannot do.

---

## 2. The board workbench — the SimulIDE half

**Shipped in this round:** `board_list`, `board_flash`, `board_monitor`.

**Not built, and it is the interesting half:** the board's pin map feeding
the deck. `firmware_stimulus` already turns a pin timeline into PWL
sources (`Vp13 N13 0 PWL(...)`), so the wiring exists; what does not is
the other direction — taking a **board's** pins and laying them out as a
schematic element, so the deck says "D5 drives this filter" and the
filter's input is the board's pin rather than a name the user invented.

That is a `circuit_read_schematic` shape: a board as a component with
named pins, an FQBN, and a logic level. It is the piece that would make
August's circuit workbench read like SimulIDE rather than like a compiler
with a simulator bolted on.

The engine stays `arduino-cli` — scriptable, already driven by
`firmware_compile`, and it is the same toolchain the Arduino IDE is a GUI
around. `arduino.exe` itself is a GUI: driving a GUI is a worse way to do
the same thing, and the IDE's board list and core installs are the same
files, so a board the IDE can flash is a board `board_flash` can flash.

**The safety shape is settled and should not be relaxed:** flashing is a
physical side effect, so `board_flash` is confirm-gated, plan-blocked, and
never auto-run by the harness loop. A board is not a credential store, but
`board_monitor` reads a serial line a sketch may be printing a WiFi
password on — so the monitor's output is subject to the same outbound scrub
as anything else the transcript carries.

---

## 3. The chat surface — closer to Claude, and what is left

**Shipped in this round:** the activity line and its bordered card; the
thinking disclosure; the recovery notice; a single command row that says
**"Ran"** instead of "Terminal", so the transcript reads the same whether
the run collapsed or not.

**Still open, and it is a product decision rather than a task:**

| Decision | The question | What it affects |
|---|---|---|
| Group every tool kind | A run of *reads* is already collapsed by `ExploreGroup` ("Explore · 2 searches, 3 files") and a run of *commands* by `ActivityGroup` ("Ran 4 commands"). Should a MIXED run — a read, a command, a read — become one line, or stay two? | The reference collapses everything into one line. Doing that here merges `ExploreGroup` and `ActivityGroup`, and the Explore group's own vocabulary ("Explore") goes away. |
| Group across a turn boundary | A turn that reads a file, answers, and reads another file is two groups, because the answer is between them. | Grouping across an answer would put unrelated work under one line, and the elapsed time would be the sum of two things that never ran together. |
| Should a failed command be grouped? | Today a run containing a failure is NOT grouped: each command keeps its own row, so the red line is always visible. | The reference groups failures too and marks the line. Grouping a failure is only safe if the group opens on failure, which is a different default state. |

**Not built, deliberately:** the inline terminal in the tool card (August
has a live terminal dock, and merging a dock that outlives the turn with a
card that dies with it is a lifecycle problem, not a layout one); the
copy / re-run buttons (a re-run resolves the workspace, the guard mode
and the approval state as they are NOW, which is a different command);
per-token cost on the activity line (the budget ladder can re-price a
turn after the fact, and a number that later changes is worse than no
number); and a diff view inline in the card (August shows a `±N` stat on
the edit rail row and opens the full `DiffView` on demand, which is
richer than the reference's).

**Not verified:** the chat surface was never rendered in a browser in this
round. Every change to it is a code change, not a screenshot, and it
should be looked at before the next build.

---

## 4. What this round did NOT verify

Stated plainly, because the difference matters:

- **The NSIS installer and the relaunch waiter were never run.** The
  waiter's race is fixed in code and the fix is negative-tested at the
  script level, but no packaged install was performed. The matrix in
  `docs/UPDATE_VERIFICATION.md` is the check, and it has not been run.
- **The chat UI was never rendered.** No browser, no screenshot.
- **No board was attached.** `board_list` was exercised against a real
  `arduino-cli` with the `arduino:avr` and `arduino:renesas_uno` cores
  installed, and it correctly reported no boards attached. `board_flash`
  and `board_monitor` were exercised as far as they can be without
  hardware: the port resolution, the ambiguity refusal, and the compile
  that precedes the flash.
