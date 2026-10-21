# SimulIDE and the `pi` harness — deep dives, and what they say about August

Date: 2026-10-21. Owner ask: dive the **SimulIDE** and **pi harness** GitHub
repos, then propose improvements to August. Research only — no code from either
repo was vendored, and the only August files touched by this round are the board
tables and one transaction (recorded in `docs/ROADMAP.md`).

Both repos were shallow-cloned into `%LOCALAPPDATA%/Temp/` (never into this
checkout — `data/` here holds a real brain database). Nothing in either repo was
executed. Every `path:line` below was re-read in the clone; where a claim comes
from the dive report and was NOT re-verified, it says so.

---

## A. SimulIDE — `Arcachofo/SimulIDE-dev` @ `a7d9fc9d`

The official page (`simulide.com/p/source-code/`) names this as the development
repo; releases ship from Launchpad. `SimulIDE.pri:1` → version 2.0.0. ~881 C++
files: `src/simulator` (engine), `src/components` (parts), `src/microsim`
(MCU/registers), `src/gui`.

**Licence: AGPLv3** (`COPYING:1`, and `copyright.txt` splits owner files AGPLv3
/ third-party GPLv3). Design is readable; code is not vendorable into a closed
desktop app. This decides everything below: take mechanisms, write them fresh.

### What it actually is

Not SPICE. It is a nodal-analysis engine with an **event queue**, where digital
parts are expressed *as* analog parts.

1. **One clock, one queue.** `Simulator` keeps circuit time in **picoseconds**
   and schedules work as `addEvent(time, element)` relative to it —
   `src/simulator/simulator.h:47`, `:62` (`psPerSec`). A 20 Hz timer advances a
   per-frame slice of sim time (`simulator.cpp:503-519`). *Verified.*
2. **A digital output is a Thevenin pair, not a logic level.** `IoPin` is one
   class that is both a `QGraphicsItem` and an `eElement`; its slew is a chain
   of scheduled events that stamp admittance/voltage into the matrix —
   `src/gui/circuitwidget/iopin.cpp:96-120` (`m_gndAdmit = 1/(m_outputImp+delta)`,
   `stampVolt(...)`, `addEvent(time/m_steps, this)`). Ground and Vdd are
   ordinary parts, so there is no analog↔digital boundary layer and no special
   net handling. *Verified.*
3. **Parts are data, in three layers.** C++ primitives register by hand, but an
   **MCU is XML**: `McuCreator::createMcu` reads `<mcu core= data= prog=
   inst_cycle=>` and `<register addr= reset= mask=>` —
   `src/microsim/mcucreator.cpp:107`, `:163`, `:457-485`. Compiler toolchains
   are likewise XML steps (`src/gui/editorwidget/compiler.cpp`, reported by the
   dive, *not re-verified*). And any circuit is a part (`.sim1`/`.sim2` loaded
   by `SubCircuit`). *Verified for the register/mcu attributes.*
4. **The property table is the file format, the panel and the undo journal.**
   `CompBase::toString()` — commented "Used to save circuit" — serialises by
   iterating `m_propMap` (`src/gui/circuitwidget/compbase.cpp:117-129`). Undo
   rows are `(uid, propertyName, oldValue)` (reported: `circuit.cpp:754-787`,
   *not re-verified*). *Verified for the property-driven save path.*
5. **Instruments sample on edges, in sim time.** `LogicChannel` records
   `Simulator::self()->circTime()` and detects transitions
   (`src/components/meters/lachannel.cpp:69-103`) rather than sampling at a
   fixed rate. *Verified.*
6. **Firmware symbols become addresses.** `avrgccdebugger.cpp:~68` runs
   `avr-objdump -t -j.bss <elf>` and parses `symbol → address → type`, which is
   how a watch on a variables' memory works without debug info. *Verified.*
7. **Circuits as test fixtures.** `BatchTest` walks a folder recursively for
   `*.sim1`/`*.sim2` and runs each (`src/gui/testing/batchtest.cpp:20-58`), and
   `TestUnit` sweeps input combinations against a stored truth table.
   *Verified for the sweep/recursion; the truth-table body was not re-read.*

### Weaknesses worth naming, because August has already chosen otherwise

- `src/` contains **zero** hits for `QMutex|std::mutex` while the sim runs on a
  `QtConcurrent` thread — verified by scan. August's durability barriers and
  thread-local connections are the answer to the same problem.
- **Non-convergence is silent**: `solveCircuit()` calls `m_matrix->solveMatrix()`
  and discards the `bool`, with the diagonal-zero warning commented out
  (`src/simulator/simulator.cpp:66-74`). *Verified.* A solver that returns
  numbers nobody can tell apart from a solved answer is the failure mode
  August's `circuit_simulate` lint + SOA warnings exist to avoid.
- The circuit object **is** a `QGraphicsScene`, and the engine reaches into it
  as a `friend`; 18 `::self()` singletons mean one circuit per process.
  (Reported by the dive; *not re-verified*.)
- `rev=` in a saved file is a build date, not a schema version — a lesson for
  anything that must stay readable across versions.

---

## B. The `pi` harness — `earendil-works/pi` @ `cae9fd2`

`badlogic/pi-mono` redirects here (the owner renamed the org). Monorepo, MIT
(`LICENSE:1`). *Verified.* Packages: `agent` (`pi-agent-core`, ~2.5k LOC),
`ai` (provider layer), `coding-agent`, `tui`, plus `durable`, `codemode`,
`chord`, `mcp`, `evals`. Rejected as the referent: `cellinlab/how-pi-agent-works`
(a tutorial rewrite), the `@mariozechner/pi-*` npm scope (old names). The fork
`can1357/oh-my-pi` is a **different product** (Rust core, LSP/DAP, Hashline
edits) and was not read here; the earlier note about it still stands in
project memory.

### Mechanisms that are genuinely its own

1. **A truncated answer fails the whole tool batch.** Streamed tool-call
   arguments are salvaged best-effort, so a message cut by the output limit can
   yield calls that *validate* but are silently incomplete; `pi` refuses to run
   any of them and tells the model to re-issue
   (`packages/agent/src/agent-loop.ts:484-512`). *Verified.*
2. **Parallel tools with two orders.** Calls are preflighted sequentially,
   executed concurrently, and the UI events land in **completion** order while
   the tool-result messages are emitted in **assistant source** order
   (`agent-loop.ts:640-670`); one tool declaring `executionMode: "sequential"`
   forces the whole batch serial (`:526-532`); a batch terminates only when
   **every** result sets `terminate` (`:700-702`). *Verified.*
3. **Truncation is dual-limited and actionable.** 2000 lines OR 50 KB,
   whichever hits first, and never mid-line
   (`packages/coding-agent/src/core/tools/truncate.ts:1-15`); the receipt carries
   the next call (`[Showing lines X-Y of Z. Use offset=N to continue.]`,
   `Full output: <tempfile>`). *Verified for the limits; the receipt wording was
   read by the dive, not re-verified.*
4. **The transcript owns the prompt and the tool loadout.** System messages
   carry named `sections` and `toolsAdded/toolsRemoved` deltas, replayed into
   the current state (`packages/ai/src/utils/transcript.ts:55-96`), so a mid-run
   change is a diff in the log rather than a rewrite of history. *Verified.*
5. **No approval gate anywhere in the core, by design.** `SECURITY.md:1-12`:
   the user account and its writable files are *inside* the trust boundary; the
   human gate is an extension (`examples/extensions/permission-gate.ts`), and
   `project_trust` gates only startup resource loading. *Verified in
   SECURITY.md.* **There is also no read-before-edit gate** — grep for
   read-before-edit/`hasBeenRead` across `packages/**/*.ts` returns nothing.
   *Verified as an absence.*
6. **`compat` is a per-model capability table** (~30 booleans: mid-convo system
   messages, cache-control on tools, strict mode) and the transcript *degrades*
   through it rather than failing (`packages/ai/src/providers/compat-schema.ts`,
   `utils/transcript.ts:115-120`). Reported by the dive; *not re-verified
   line-by-line.*

---

## C. What August should take — ranked

Each row names August's current state so the gap is checkable, and whether the
change is a **defect fix** (just do it) or a **feature-shape decision** (the
owner's call).

| # | Idea | August today | Kind |
|---|------|--------------|------|
| 1 | **Board facts audited against the platform, not remembered** — SimulIDE's chip definitions are data (`<register addr=>`), read at load. | Done this round: `_BOARD_PINS` rows are now justified by the installed core's `boards.txt` + `pins_arduino.h`, and descriptions derive from the table (`firmware_tools.py`). The next step is to *read* a variant's rail from the platform when the FQBN names one, instead of a hand row per variant. | defect fixed; the read-from-core step is a **decision** |
| 2 | **A board outline in the schematic.** The deck already carries the board as `.subckt` + `X` with real pin nets, but `services/tools/schematic.py` draws it as the generic 2-pin subckt box, so the one thing that makes SimulIDE read as a *board* is missing. | `docs/ROADMAP.md` §"NEXT — the board workbench" records this as the remaining piece. | **decision** (UI surface) |
| 3 | **Edge-triggered instruments keyed to sim time.** August's waveform viewer and `firmware_run` timeline sample at a fixed grid; a transition-keyed ring buffer makes a 1 ms spike and a 1 s idle cost the same. | `CircuitWaveformViewer.tsx`, `firmware_run` `<name>_pins.json` (edges are already recorded per pin — the analog side is what samples). | **decision** |
| 4 | **Circuits as fixtures (`BatchTest`/`TestUnit`).** A folder of decks run headlessly, each with expected measures, and a truth-table sweep for logic. This is the acceptance test the circuit workbench has never had — and it is the *only* thing standing between a renderer change and "it looked fine". | Nothing. `e2e:smoke` asks doors, not decks; `circuit_test` exists for a single deck. | **decision** (new capability) |
| 5 | **Two-order parallel tool execution** (events in completion order, transcript in source order) with a sequential opt-in per tool. Reads and searches are the bulk of a circuit/EDA turn and they are independent. | Strictly sequential: `workbench.py:4699+` awaits each call; no `asyncio.gather` in the loop. Interacts with the stall/runaway counters, hooks, approval cards and block ordering. | **decision** (harness shape) |
| 6 | **Transcript-owned prompt sections + tool-loadout deltas.** August freezes the boot memory index per session *to protect the provider prefix cache* and rebuilds the surface ad hoc; a named-section diff gets cache stability and a truthful history at once. | `loop/prompt.py`, `workbench/module_context`, the frozen boot index (documented in `AGENTS.md`). | **decision** (largest of the six) |
| 7 | **Make the truncation receipt carry the next call.** August's marker says `[... N characters omitted ...]`; a paged read said `[lines 120-319 of 4200]` but never `use offset=320`. | **done this round** — `tool_registrations/file_tools.py:557` renders `[lines 10-14 of 50, use offset=15 to continue]`, and omits the clause at end-of-file so a complete read claims nothing is left. | defect fixed |
| 8 | **Never let a solver's silence look like an answer.** SimulIDE discards `solveMatrix()`'s bool; August's `circuit_simulate` parses ngspice output and lints, and should keep treating a *missing* measure as an error rather than a zero. | Already the design (lint warnings, convergence options echoed, `measures` parsed). | no change — a warning to keep |

## D. What the dives did **not** discover (already shipped)

Recorded so the next dive does not re-propose them:

- **Length-stop fails the whole tool batch** — `workbench.py:4655-4698`, with a
  self-heal message and a UI warning. Same mechanism as pi, independently.
- **Read-before-edit is a gate** — `workbench/read_before_edit.py` (pi has none;
  August's is stricter).
- **Spill with a retrieval route** — `loop/prompt.py:220-300`; August refuses to
  spill when the offered surface cannot read the file back, which is *more*
  careful than pi's unconditional `Full output: <tempfile>`.
- **Edit failures quote the file** — closest-region hinting
  (`tool_registrations/file_tools.py:675,859`) and hash-anchored edits.
- **Outbound credential scrub at the transport** — pi has no permission model
  at all; August's `scrubOutboundBody`, guard modes, hardline shell policy and
  listing doors are a defence layer pi explicitly declines to have. Do not
  "simplify" toward pi's posture.

## E. Unverified / needs a check before building on it

- SimulIDE's `McuCreator` handles the *only* part-definition path; whether a
  plain analog part can also be defined by data (vs C++) was not established —
  the `.mcu`/`.sim1` data files and `logic_families.model` ship in releases, not
  in this repo.
- SimulIDE flashes to **simulated** flash; no `avrdude` path was found in the
  clone. A real-programmer path may exist in the `SimulIDE/SimulIDE` community
  fork — unchecked. (August's `board_flash` → arduino-cli is ahead of it here.)
- pi's line counts for `pi-durable` internals were grepped, not read; that
  package self-describes as experimental.
- Neither repo was built or run; nothing here is a claim about runtime
  behaviour, only about source.
- pi's `compat` flag list and its retry/overflow message tables were sampled,
  not enumerated.
