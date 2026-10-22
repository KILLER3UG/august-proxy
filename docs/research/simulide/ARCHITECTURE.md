# SimulIDE — how the whole system fits together

**Repo:** `github.com/Arcachofo/SimulIDE-dev` @ `a7d9fc9` (AGPLv3).
**Clone:** `%LOCALAPPDATA%\Temp\harness-research\simulide` — shallow, read-only,
never built, never executed.
**Evidence:** per-file reading in `docs/research/simulide/shards/`; the
per-file ledger is in `docs/research/simulide/manifest.tsv`.

> **Licence decides everything below.** AGPLv3 (`COPYING:1`, with
> `copyright.txt` splitting owner files AGPLv3 / third-party GPLv3). The design
> is readable; the **code is not vendorable** into a closed desktop app. Every
> mechanism below is something to take as a *design* and write fresh.

---

## 1. What it actually is

**Not SPICE.** A nodal-analysis engine with an **event queue**, where digital
parts are expressed *as* analog parts.

```
src/simulator/     the engine      — Simulator, CircMatrix, eElement/eNode/ePin
src/components/    the parts       — ~300 Component subclasses (logic, analog,
                                     meters, micro, switches, subcircuits)
src/microsim/      the MCU core    — Mcu, McuCreator, peripherals, registers
src/gui/           the editor      — circuit canvas, properties, undo, icons
src/angel/         vendored        — AngelScript 2.35.1 + an x86-64 JIT
resources/         the content     — help pages, syntax, device models, i18n
```

**One clock, one queue.** `Simulator` keeps circuit time in **picoseconds**
(`src/simulator/simulator.h:47`, `:62` `psPerSec`) and schedules work as
`addEvent(time, element)` relative to it. A 20 Hz timer advances a per-frame
slice of sim time (`src/simulator/simulator.cpp:503-519`).

**A digital output is a Thevenin pair, not a logic level.** `IoPin` is one
class that is both a `QGraphicsItem` and an `eElement`; its slew is a chain of
scheduled events that stamp admittance/voltage into the matrix
(`src/gui/circuitwidget/iopin.cpp:96-120`). Ground and Vdd are ordinary parts,
so there is no analog↔digital boundary layer and no special net handling.

---

## 2. The extension model — three classes and a table

The whole plugin system is three small base classes plus a hand-maintained
registry:

| Class | Contract |
|---|---|
| `eElement` | four hooks — `initialize` / `stamp` / `runEvent` / `voltChanged` |
| `eNode` | a net: the pins attached to it, the admittances stamped into it |
| `ePin` | a terminal: it stamps into a node and is driven by an element |

**Registration is by hand.** `src/gui/componentlist/itemlibrary.cpp:149-338` is
190 lines of `addItem(X::libraryItem())`. `LibraryItem` is
`{name, category, icon, typeList, createItemFnPtr}` — a **hardcoded C++
factory pointer** (`src/gui/componentlist/itemlibrary.h:34-51`). Every part
follows the same three-part contract: a static `construct(type,id)` factory, a
static `libraryItem()` returning the library entry, and a constructor that
wires the part's pins and its `ComProperty` groups.

There is **no `ItemInfo` / `GenObject`** class anywhere in the clone — the
earlier report that said so was wrong, and the correction is recorded in
`docs/research/2026-10-21-simulide-and-pi-harness.md`.

**The property table IS the file format, the panel and the undo journal.**
`CompBase::toString()` — commented "Used to save circuit" — serialises by
iterating `m_propMap` (`src/gui/circuitwidget/compbase.cpp:117-129`). Undo
rows are `(uid, propertyName, oldValue)`.

**But the MCU is data, not code.** `McuCreator::createMcu` parses an XML
`.mcu` descriptor (`<mcu core= data= prog= inst_cycle=>` and
`<register addr= reset= mask=>`) into memory blocks, a named register map and
a list of peripheral instances
(`src/microsim/mcucreator.cpp:107`, `:163`, `:447-517`). Compiler toolchains
are likewise XML steps. **This is the single most transferable idea in
SimulIDE for August**: a chip is a *data file* the tool reads at load, not a
hand-written table per variant.

---

## 3. The solver — the interesting part

`CircMatrix` is a **dense N×N** matrix with **Crout, no pivoting**
(`src/simulator/circmatrix.cpp:22-35`, `:153`) — but it is decomposed:

- `analyze()` flood-fills connectivity into groups (`:54-118`);
- size-1 groups **never enter the matrix** (`:72-76`);
- each group holds a matrix of *pointers into* the shared dense array (`:95`);
- two per-group flags — `m_admitChanged` / `m_currChanged`
  (`circmatrix.h:29-39`) — decide what a re-solve costs: a **current-only**
  change (a digital pin flipping level) skips factorisation and is O(n²)
  back-substitution; a **conductance** change re-factors O(n³) — *of that group
  only* (`circmatrix.cpp:120-137`).

Nonlinearity is **companion fixed-point, not Newton**: `eDiode::voltChanged`
re-linearises to `dI/dV` + a Norton source, converges at ΔV < 0.01 V and ramps
`gmin` geometrically (`src/components/active/e-diode.cpp:58-96`).

**A zero diagonal does `continue`, and `luSolve` returns `isOk=false` with volt
0 (`circmatrix.cpp:168-171`, `:220-223`) — and the caller DISCARDS it with the
warning commented out (`simulator.cpp:66-74`).** A solver whose silence looks
like an answer is the failure mode August's `circuit_simulate` lint and SOA
warnings exist to avoid. **Do not copy this.**

---

## 4. The event queue and its one guard

One global singly-linked list sorted by absolute `eventTime` in ps, threaded
through the element itself (`e-element.h:43-44`), inserted by linear scan
(`simulator.cpp:526-566`).

**The anti-runaway rule is one pending event per element**: `addEvent` refuses
a second insert for the same element and sets `m_warning = 200` (`:530-534`).
There is **no clamp on a *past* timestamp** — `addEventAt` will insert at the
head and `m_circTime` rewinds (`:265`), and a 0-delay self-reschedule inside
`runEvent` is legal (and `time/m_steps` integer-divides to 0 when slope steps
are off, `iopin.cpp:118`).

---

## 5. Nets have no names; pins do

`createNodes()` (`simulator.cpp:354-390`) flood-fills from `Circuit::m_pinMap`
and every eNode is synthetic (`"eNodeSim-N"`). **Identity comes from Tunnels**:
`Tunnel::registerEnode` fans one eNode out to every same-name tunnel
(`tunnel.cpp:95-108`, registry `:115-146`), a subcircuit's boundary pins *are*
tunnels (`subcircuit.cpp:305-322`), and instruments can be bound **by tunnel
name** rather than by a drawn wire (`oscope.cpp:140-156`). Bus is a propagating
attribute on pins, not a net (`pin.cpp:350`, `bus.cpp:61-71`).

---

## 6. Instruments and MCU time

Both channels inherit `DataChannel{QVector<double> m_buffer; QVector<uint64_t> m_time}`
— a circular buffer of **(value, simTime)** pairs (`plotbase.cpp:28`, default
600 k samples). The oscilloscope samples **on change**, deduped by
`delta == 0` and one write per simTime (`oscopechannel.cpp:136-151`); the logic
analyser stores **edges only** with dual hysteresis thresholds
(`lachannel.cpp:97-113`).

The MCU is an `eElement`: `runEvent()` executes exactly **one instruction**
then re-arms with `cycles · m_psTick` (`e_mcu.cpp:131-148`), and peripherals are
*analytic* — `McuTimer` computes `time2ovf` in ps, schedules one overflow event
and reconstructs the counter lazily from `circTime` (`mcutimer.cpp:117-141`,
`:183-200`). Register writes fan out through `McuSignal`, a hand-rolled LIFO
callback list whose order is load-bearing for interrupt-flag clearing
(`mcusignal.h:50-111`).

---

## 7. Scripting

`src/angel/` is the **entire vendored AngelScript 2.35.1 engine** — 85 tracked
files, ~2.5 MB of C++ — plus an **x86-64 JIT**. It is a fork of Andreas
Jonsson's AngelScript, lightly modified (`src/angel/src/COPYING:31` states
outright that *all* files in the folder were changed). Five layers, visible in
the file names: the public C++ API (`include/angelscript.h`, 1 607 lines), the
compiler, the VM, the JIT, and the library.

**Why this matters to August: the embedded-code surface is a whole vendored
compiler, not a thin interpreter.** That is a scale August has not chosen, and
`docs/research/2026-10-21-simulide-and-pi-harness.md` already recorded that
SimulIDE's real-programmer path was not found in the clone and that
`board_flash` → arduino-cli is *ahead* of it.

---

## 8. The content layer is data, and it is the part worth stealing

`resources/` is not decoration. It contains:

- **154 per-component help pages** — each a plain-text property sheet matched
  against the component's own `Q_PROPERTY` list. The help file *is* the
  property documentation, so it cannot drift from the code the way a wiki page
  can.
- **13 syntax-highlighting definitions plus a 239-line format cookbook.**
- **5 external-toolchain descriptors** and one SPICE-style device model library.
- **7 Qt-Linguist translation catalogues** (`resources#2`): 2 000 334 bytes,
  49 888 lines of UTF-8 XML. Because every `<message>` carries a
  `<location filename="..." line="..."/>` pointer back into the source tree,
  the catalogue is a **machine-readable index of the whole application's
  user-visible surface** — 181 `<context>` blocks.

That last observation is a genuinely cheap way to get an inventory of a UI, and
it is the closest thing in this repo to an "eval" of the product surface.

---

## 9. Weaknesses worth naming, because August has already chosen otherwise

- `src/` contains **zero** hits for `QMutex|std::mutex`** while the sim runs on
  a `QtConcurrent` thread — verified by scan. August's durability barriers and
  thread-local connections are the answer to the same problem.
- **Non-convergence is silent** (see §3).
- The circuit object **is** a `QGraphicsScene`, and the engine reaches into it
  as a `friend`; 18 `::self()` singletons mean **one circuit per process**.
- `rev=` in a saved file is a **build date, not a schema version** — a lesson
  for anything that must stay readable across versions.
- The `m_NLstep` latch and the rewind-on-past-event are read-from-code
  inferences, not observed behaviour.

---

## 10. Viability as an August tool or skill for logic-circuit coursework

The prior research ranked this as a **decision**, and nothing found since
changes the ranking. What is available:

| Asset | Verdict |
|---|---|
| `src/icons/components/` — a **shape-first icon language** (1to1, 1to2, 1to3, 2to1, 2to3, 3to2 …) that encodes *signal shape* rather than part identity | **Take the idea.** For a teaching tool, "how many inputs, how many outputs" is the first thing a student must learn; SimulIDE teaches it in the palette. |
| `resources/` help pages as property sheets | **Take the idea** — a property sheet that cannot drift from the code. |
| The MCU as an XML data file | **Take the idea** — August's `_BOARD_PINS` are a hand-maintained table; SimulIDE reads the chip definition. |
| Change-sampled `(value, simTime)` circular buffers | **Take the idea** — it is what makes a VCD/trace export cheap. |
| Two-tier dirty flags (conductance-dirty vs current-dirty) | **Take the idea in adapted form** — August delegates solving to ngspice, so this lands as *"a value-only change is a cheaper tool call than a topology change"* in `circuit_simulate` and its caching, not as a new solver. |
| The dense N×N matrix, unpivoted Crout, fixed-point companion iteration, the discarded `isOk` | **Do NOT copy.** ngspice does trapezoid/Gear with truncation control; August must not regress, and a solver whose silence looks like an answer is precisely the failure mode August's lint already exists to catch. |
| The vendored AngelScript + JIT | **Do NOT copy.** A whole compiler is a scale August has not chosen. |
| AGPLv3 code | **Do NOT vendor.** Take the mechanisms, write them fresh. |

---

## 11. Coverage summary

| | simulide |
|---|---|
| Tracked files (`git ls-files`) | 1 359 |
| In manifest | 1 359 — **0 missing, 0 extra, 0 duplicate**, every file in exactly one shard |
| Shards | 10 |
| Shard reports | 10 / 10 |
| Files marked `read` | **1 348** |
| Files marked `skipped` (each with a one-line justification) | **11** |
| **Unresolved** | **0** |
| Rows with no note | 0 |
| Skipped rows with no reason | 0 |
| `path:line` citations in the reports, re-checked against the clone | **613 checked, 0 bad** |
| Reports spot-checked by reopening the source | 4 of 10 (40 % — above the 10 % floor), plus every citation in every report |

### The gaps, and why they happened

Two independent defects, both recorded rather than guessed:

1. **`components-analog` first came back short by 101 files.** The same
   manifest corruption that cost pi two shards reached this one: the worker
   read a `manifest.tsv` whose `owner-shard` column had been rewritten into a
   different partition, so it resolved 82 files where the ledger names 183.
   The manifest was restored from git, all six ledger files were set
   read-only, and the shard was re-dispatched against the restored
   partition. It now stands at 183 rows.
2. **Two bad citations.** `gui` cited `src/gui/properties/proputils.cpp:99`
   in a file that has 78 lines; `resources#2` cited
   `src/components/component.cpp:1260` in a file that has 722 lines. Both
   shards were re-dispatched to correct the reference, and both now verify.

**Every skipped file has a stated reason** — the seven Qt-Linguist
translation catalogues, the compiled-in resource blobs, the binary TrueType
faces and the macOS icon containers — and none was skipped silently.
