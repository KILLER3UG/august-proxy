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
| 5 | **Two-order parallel tool execution** (events in completion order, transcript in source order) with a sequential opt-in per tool. Reads and searches are the bulk of a circuit/EDA turn and they are independent. | **Already shipped — this row was WRONG when written.** `chat_stages.run_regular_tools_stage` gathers a batch when every call is on `parallel_tools.PARALLEL_SAFE_TOOLS` and runs it serially otherwise, default ON via `HARNESS_P1_PARALLEL_TOOLS`. The original claim ("no `asyncio.gather` in the loop") came from grepping `workbench.py` for `gather` and missing the helper one call down — a reminder to follow the call graph, not one file. Measured with the bench harness: two reads reach `maxConcurrent=2`, a read+write batch stays at 1, and round 2's request carries `[call_a, call_b]` (source order) while the live events arrived completion-ordered — exactly pi's rule. | shipped |
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

---

# Second pass (same day, deeper)

Both repos were re-read file-by-file with a second team, and this pass
**corrects the first one** as well as extending it.

## Corrections to §A

- There is **no `ItemInfo` / `GenObject`** class anywhere in the clone. The real
  trio is `ItemLibrary` + `LibraryItem` + `CompBase`/`Component`/`eElement`, and
  `LibraryItem` is just `{name, category, icon, typeList, createItemFnPtr}` — a
  hardcoded C++ factory pointer (`src/gui/componentlist/itemlibrary.cpp:149-338`
  is 190 lines of `addItem(X::libraryItem())`).
- The register loop is `McuCreator::getRegisters`, `src/microsim/mcucreator.cpp:447-517`
  (the first pass cited `:457-485`, which is inside it).
- `Simulator::m_errors[3] = "LAST_SIM_EVENT reached"` is never assigned — the
  string exists, the detection does not.

## A9. The solver is the interesting part

`CircMatrix` is a **dense N×N** matrix with **Crout, no pivoting**
(`src/simulator/circmatrix.cpp:22-35`, `:153`), but it is decomposed: `analyze()`
flood-fills connectivity into groups (`:54-118`), size-1 groups never enter the
matrix (`:72-76`), and each group holds a matrix of *pointers into* the shared
dense array (`:95`). Two per-group flags — `m_admitChanged` / `m_currChanged`
(`circmatrix.h:29-39`) — decide what a re-solve costs: a **current-only** change
(a digital pin flipping level) skips factorisation and is O(n²) back-substitution;
a **conductance** change re-factors O(n³) — *of that group only*
(`circmatrix.cpp:120-137`). Nonlinearity is companion fixed-point, not Newton:
`eDiode::voltChanged` re-linearises to `dI/dV` + a Norton source, converges at
ΔV < 0.01 V and ramps `gmin` geometrically (`elements/active/e-diode.cpp:58-96`).
A zero diagonal does `continue` and `luSolve` returns `isOk=false` with volt 0
(`circmatrix.cpp:168-171`, `:220-223`) — and the caller **discards it** with the
warning commented out (`simulator.cpp:71-73`).

## A10. Event queue and its one guard

One global singly-linked list sorted by absolute `eventTime` in ps, threaded
through the element itself (`e-element.h:43-44`), inserted by linear scan
(`simulator.cpp:526-566`). The anti-runaway rule is **one pending event per
element**: `addEvent` refuses a second insert for the same element and sets
`m_warning = 200` (`:530-534`). There is no clamp on a *past* timestamp —
`addEventAt` will insert at the head and `m_circTime` rewinds (`:265`), and a
0-delay self-reschedule inside `runEvent` is legal (and `time/m_steps`
integer-divides to 0 when slope steps are off, `iopin.cpp:118`).

## A11. Nets have no names; pins do

`createNodes()` (`simulator.cpp:354-390`) flood-fills from `Circuit::m_pinMap`
and every eNode is synthetic (`"eNodeSim-N"`). Identity comes from **Tunnels**:
`Tunnel::registerEnode` fans one eNode out to every same-name tunnel
(`tunnel.cpp:95-108`, registry `:115-146`), a subcircuit's boundary pins *are*
tunnels (`subcircuit.cpp:305-322`), and instruments can be bound **by tunnel
name** rather than by a drawn wire (`oscope.cpp:140-156`). Bus is a propagating
attribute on pins, not a net (`pin.cpp:350`, `bus.cpp:61-71`).

## A12. Instruments and MCU time

Both channels inherit `DataChannel{QVector<double> m_buffer; QVector<uint64_t> m_time}`
— a circular buffer of **(value, simTime)** pairs (`plotbase.cpp:28`, default
600 k samples). The oscilloscope samples **on change**, deduped by
`delta == 0` and one write per simTime (`oscopechannel.cpp:136-151`); the logic
analyser stores **edges only** with dual hysteresis thresholds
(`lachannel.cpp:97-113`). The MCU is an `eElement`: `runEvent()` executes exactly
**one instruction** then re-arms with `cycles · m_psTick` (`e_mcu.cpp:131-148`),
and peripherals are *analytic* — `McuTimer` computes `time2ovf` in ps, schedules
one overflow event and reconstructs the counter lazily from `circTime`
(`mcutimer.cpp:117-141`, `:183-200`). Register writes fan out through
`McuSignal`, a hand-rolled LIFO callback list whose order is load-bearing for
interrupt-flag clearing (`mcusignal.h:50-111`, comment `:73-75`).

## B9. pi's compaction is the strongest thing in it

Cut points are chosen by **walking backwards from the newest entry accumulating
estimated tokens until `keepRecentTokens` (20000), then snapping forward to the
nearest LEGAL cut** (`compaction/compaction.ts:446-501`). Legal means
user/assistant/bashExecution/custom/summary and **never a `toolResult`**
(`:351-364`), so a cut never separates a call from its results — the invariant
August had to discover as a live 400-bug (`AGENTS.md`, "Pins are unit-safe").
Split turns are first-class (`isSplitTurn` + `turnStartIndex`, `:491-500`) and
cost two LLM calls merged into one summary (`:980-1104`). A summary over an
existing summary switches to an explicit **merge contract** with
`<previous-summary>` and PRESERVE/MOVE rules (`:540-575`, `:714`) — which is
exactly the "each note carries its predecessors as 600 chars" limit August
states in `reliefStrategy`. A **file-op ledger survives compaction**: the
previous run's `readFiles/modifiedFiles` are re-seeded and re-emitted as
`<read-files>/<modified-files>` (`:60-88`, `:1043-1044`). `prepareCompaction`
returns nothing when the tail is already a compaction or no visible content
precedes the cut (`:863`, `:901`; `durable/harness/compaction.ts:279-296`) —
August's manual-button `context_window=0` bug is the same failure class.
Usage captured before a later `context_edit`/compaction is **thrown away** rather
than trusted (`:227-262`).

## B10. Repair at the provider boundary, not by escalation

`transform-messages.ts:180-256` fixes a torn history deterministically *before
every request*: an orphaned tool call gets a synthetic `isError`
`"No result provided"`, errored/aborted assistant messages are dropped, and
system messages are held so they never split a call from its result. August's
`_stuckRequestEscape` reaches the same place by **escalating across turns off a
strike ledger** — pi's arm is cheaper, deterministic, and needs no strike count.

## What August should copy, second pass (ranked)

1. **Legality rule for the compaction cut** (never a tool result, snap forward
   after a token walk) → replaces `DEFAULT_HEAD_COUNT = 4`; touches
   `reliefHeadCount`/`reliefStrategy` and the `tailCount` card fields.
2. **Provider-boundary orphan repair** → a deterministic first arm ahead of the
   `_stuckRequestEscape` ladder; touches `session.messages` normalisation before
   each request.
3. **Merge contract for the summariser prompt** → attacks the stated
   note-on-note loss; prompt-only change.
4. **File-op ledger carried across compactions** → rotate loses "which files
   were touched" today; touches the compaction request builder + the receipt.
5. **Refuse a compaction that frees nothing** → the guard the manual button's
   `thresholdOverride` had to be preserved around; touches `compressMessages`.
6. **Per-group dirty flags with two tiers** (conductance-dirty vs current-dirty)
   → an agent edits one part per call; the re-solve cost should follow the change
   class. August delegates solving to ngspice, so this lands as *"value-only
   change is a cheaper tool call than topology change"* in `circuit_simulate`
   and its caching, not as a new solver.
7. **Change-sampled `(value, simTime)` circular buffers** → exactly what makes a
   VCD/trace export cheap; touches `circuit_export_vcd` and the waveform viewer.
8. **Probe by net NAME, never by coordinate or index** — tunnels are the alias
   mechanism; August's board pins already work this way, so this is a rule to
   keep, not to build.

## Must NOT be copied (second pass)

- Dense N×N matrices and **unpivoted Crout**; and above all the *discarded*
  `isOk` — a solver whose silence looks like an answer.
- Fixed-point companion iteration converging at ΔV < 0.01 V, and the fixed
  `AnalogClock` step for L/C (`e-reactive.cpp:92-97`): ngspice does
  trapezoid/Gear with truncation control. August must not regress.
- `uint64` picosecond absolute time with integer `time/m_steps` (a rewind and
  zero-delay hazard) and the `QtConcurrent` sim thread racing GUI reads.
- **`pi-durable`'s intent protocol**: self-described "Experimental. The API
  changes without notice", admits "this is not exactly-once execution", and
  `pi-coding-agent` **does not depend on it at all** — the shipped CLI never uses
  it. August's crash story is the interrupted-turn marker, deliberately.
- **`ToolExposure`'s five-way split** (`direct|model-only|codemode|deferred|hidden`)
  and `prepareLoadout`'s `hiddenDeclarations`: hiding is done by projecting the
  name out of the transcript's tool deltas, so the tool **stays callable**.
  August's stated rule is the opposite — *enforcement is the deny set, not the
  withheld surface* (`_workerDeniedNames`). Copy the projection trick for
  display only, never as a permission change.
- **`context_edit` as a rewrite primitive** — August's transcript is append-only
  AND archived; omission deltas would be a second source of truth for "what was
  really sent".
- pi's **cache warmer** (refresh at 90 % TTL when expected savings ≥ $0.05):
  August's pricing is per-model `price_for_model` and models no provider TTL.

## New, from pi's own gates and evals

- `mergeCompatProperties` **throws** when a capability property is duplicated
  across API schemas without a generic override (`compat-schema.ts:575-601`) — a
  schema-level drift gate, the same idea as `check:brain-config` and
  `check-version-sync`.
- `pi-evals` runs a **real `AgentSession` in a temp workspace with isolated
  HOME**, and scores by deterministic assertion — a *structured-submit tool
  called exactly once with `verdict=="match"`* — including a paired
  `with_docs`/`without_docs` lift. That is the two-arm measurement August still
  does not have, and it needs no test suite to exist.
- `scripts/coding-agent-smoke.mjs` installs the built package into a temp HOME
  and asserts `--version` equals the manifest — August's `e2e:smoke` shape.

## Still unverified after both passes

- Neither repo was built or run; every claim is source-reading at
  `a7d9fc9d` / `cae9fd2`. The grouping cost of `QList::contains`, the `m_NLstep`
  latch and the rewind-on-past-event are read-from-code inferences.
- Whether pi's `keepRecentTokens`/`reserveTokens` are per-model (settings-schema
  leg unread), and pi's eval lift math (README + call sites only).
- SimulIDE's released `data/` tree (`.mcu`, `.sim1/.sim2`, `diodes.model`,
  `logic_families.model`) — not in the repo, so the data-driven part formats are
  inferred from the parsers.

## Follow-up (2026-10-23)

The signal-shape palette idea was adapted to August's tool-driven circuit
surface: `circuit_search_component` now searches the curated logic parts by
function and signal topology, and labels clocked/serial-to-parallel parts so
they are not mistaken for combinational splitters. August has no visual part
palette to reorganize. The curated component metadata, signal shapes and
paste-ready XSPICE cards now live in `app/services/tools/circuit_parts.json`,
loaded beside the circuit tools and included in the desktop backend payload.
This is August's own data format; the broader SimulIDE reference formats remain
unverified because its released `data/` tree was not present in the source.
