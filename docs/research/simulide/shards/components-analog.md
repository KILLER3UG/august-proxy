# simulide / components-analog

## Shard shape

**Scope: 183 files, all of them under `src/components/`.** The manifest's 4th
column (`owner-shard`) contains the literal value `components-analog` on
**183** rows, and every one of them is a path under `src/components/`. I
verified the count by grouping the manifest's column 4 over all 1 359 data rows;
the ten distinct shard values are `microsim` 258, `icons-assets` 224, `gui` 213,
`resources#1` 202, **`components-analog` 183**, `components-digital` 144,
`angel-jit` 85, `simulator-core` 30, `build-root` 13, `resources#2` 7.

> **Correction to the first pass.** The previous version of this report claimed
> that `components-analog` *did not exist* in the manifest and that the shard
> had to be reconstructed by hand from a "semantic" reading of the name, which
> produced an 82-file shard (`active/` + `passive/` + `sources/`). That was
> wrong: the shard name **is** in the manifest, and the shard is three times
> that size. The first pass read a different (or a stale) copy of the manifest.
> The manifest was **not** modified — it is read-only by instruction, and it is
> correct as it stands.

What the shard holds, by directory:

| directory | files | what it is |
|---|---:|---|
| `src/components/` (root, not counting `graphical/`) | 16 | the **core classes**: `Component`, `Comp2Pin`, `IoComponent`, `LogicComponent`, `LogicFamily`, `Linker`, `LinkerComponent`, `Node` |
| `src/components/active/` | 24 | non-linear semiconductors: BJT, JFET, MOSFET, diode family, op-amp, comparator, regulator, analogue mux |
| `src/components/passive/` | 36 | linear-but-stateful R/C/L/transformer and the resistive-sensor family |
| `src/components/sources/` | 22 | the circuit's stimuli: ground, rail, battery, fixed/dial/controlled sources, clock, wave generator |
| `src/components/graphical/` | 12 | pure-graphics parts: rectangle, ellipse, line, image, text |
| `src/components/other/` | 11 | dial, package (IC outline), package pin, test unit, truth-table dialog |
| `src/components/outputs/` | 62 | everything that *shows* or *moves*: lamp, LED family, displays, motors, audio out |
| **total** | **183** | |

**The central architectural claim, now visible in full.** SimulIDE's part
library is built from a **two-hierarchy design** joined by multiple
inheritance. A *graphical* hierarchy (`Component` → `Comp2Pin` / `IoComponent` /
`LinkerComponent` / `Dialed` / `Shape`) owns pins, labels, painting,
hit-testing and the property table; an *engine* hierarchy (`eElement` →
`eResistor` / `eReactive` / `eDiode` / `eBJT` / `eClockedDevice` / `eLed` / …)
owns the circuit equations. A part is a class that inherits from **one class of
each**: `class Resistor : public Comp2Pin, public eResistor`
(`src/components/passive/resistors/resistor.h:13`). The graphical side never
computes; the engine side never paints. The four junction points the engine
calls are `stamp()` (write this element's contribution into the nodal matrix),
`voltChanged()` (a node's voltage moved — re-evaluate), `updateStep()` (the
per-frame poll) and `runEvent()` (a scheduled event fired).

The root files of the shard make the *mechanics* of that join explicit, and
they are the most transferable part of this shard:

- `Component` is simultaneously a `CompBase` (the property table **is** the
  circuit-file format), a `QGraphicsItem` (the canvas) and an `Updatable` (the
  per-step poll) — `src/components/component.h:23`. It holds **two coordinate
  systems** (board and circuit) because a part can be drawn in two placements
  (`src/components/component.h:202-209`).
- `IoComponent` adds the *output queue* — two parallel queues of pending output
  values and their due times (`src/components/iocomponent.h:87-88`) — so a part
  that changes faster than its propagation delay does not drop edges.
- `LogicFamily` is a **data-file-driven** electrical characterisation: supply
  voltage, input thresholds, impedances, delays, pull-ups
  (`src/components/logicfamily.h:10-20`), loaded from `logic_families.model`
  at run time (`src/components/logicfamily.cpp:128-162`).
- `Linker` is the one part-to-part mechanism: one part's value drives another
  (`src/components/linker.cpp:114-117`), and it is the closest thing this repo
  has to a scriptable data path.
- `Node` is the wire junction, and it *rewires itself* when a wire is removed
  (`src/components/node.cpp:116-164`).

The four content groups differ in how much of the physics they own:

- **`active/`** — devices that are *not* linear. Each either delegates to a
  specialised engine element (`eBJT`, `eDiode`) or assembles a behaviour out of
  simpler elements (the DIAC is two diodes and a resistor;
  `src/components/active/diac.cpp:55-67`).
- **`passive/`** — elements that are linear but stateful. The whole of
  SimulIDE's reactive theory is two lines: a capacitor is a resistor whose value
  is `Δt/C` (`src/components/passive/reactive/capacitorbase.h:19-20`).
- **`sources/`** — the stimuli. Ground and rail are the interesting ones:
  **ground is an ordinary component** (`src/components/sources/ground.cpp:33-35`
  — a single source-type `IoPin` held low) and there is no special net handling
  anywhere.
- **`outputs/`** — the largest group, and the one with almost no physics: the
  displays are *protocol emulations* (SSD1306, SH1107, ST77xx, HD44780, KS0108,
  PCD8544, AIP31068) and the motors are *kinematic integrators* of an applied
  voltage. They are interesting for their **protocol fidelity** and their
  **rendering** strategies, not for their circuits.

How they fit together: every part that appears in the palette registers itself
with a `construct`/`libraryItem` static pair, and `ItemLibrary::loadItems()`
collects them **by hand** (`src/gui/componentlist/itemlibrary.cpp:149-337` —
one `addItem( X::libraryItem() );` line per part, plus an `#include` at the top
of the file). There is no dynamic loading, no discovery and no plugin manifest:
the "plugin model" is a factory-function pointer and a hand-maintained list.
The *simulation behaviour* of a part is a mix of (a) an engine element, (b) a
hand-assembled network of engine elements, (c) a per-timestep companion model,
(d) a scheduled event, and — for the outputs — (e) a **peripheral protocol
state machine** that consumes bytes and mutates a frame buffer.

## Per-file notes

### src/components/active/bjt.h
- Purpose: header for the BJT part.
- Key abstractions: `BJT : public Component, public eBJT` — the graphical half
  plus the engine half, in one class.
- Data flow: none; declarations only.
- Non-obvious design decisions: the class exposes exactly two statics,
  `construct` and `libraryItem`, because the library needs a factory function
  pointer (`createItemPtr` in `itemlibrary.h:33`).
- Edge cases / failure handling: none here.
- Surprising: 25 lines, no comments at all — the whole contract is the two
  statics plus three overrides.

### src/components/active/bjt.cpp
- Purpose: the BJT part: symbol, pins, properties, engine hookup.
- Key abstractions: `eBJT` owns the transistor equations; `BJT` owns three
  `Pin`s (`bjt.cpp:43-45`) and calls `eBJT::setup()` (`:47`).
- Data flow: property setter → `m_changed = true` → the engine's update list
  calls `updateStep()` → `eBJT::voltChanged()` (`:64-69`).
- Non-obvious design decisions: `eBJT::setNumEpins(6)` while only 3 pins are
  created (`bjt.cpp:41-45`) — the engine element keeps its own internal pin
  array, and the graphical layer maps three of them.
- Edge cases / failure handling: the paint code highlights the symbol only when
  `fabs(m_baseCurr) > 1e-9` (`:75-77`), i.e. conduction is a *visual* state.
- Surprising: the PNP/NPN symbol is drawn by two different 3-point polygons
  (`:86-98`) — the arrow is inverted for PNP, and there is no arrowhead drawing
  primitive, just a different triangle.

### src/components/active/comparator.h
- Purpose: header for the comparator.
- Key abstractions: `Comparator : public IoComponent, public eElement` —
  note it uses `IoComponent` (which owns a *logic* output pin) rather than
  plain `Component`.
- Data flow: declarations only.
- Non-obvious design decisions: the comparator is modelled as a **digital**
  part even though it is an analogue device, because its output is a two-state
  signal with a slew chain.
- Edge cases / failure handling: none.
- Surprising: `runEvent()` is overridden as a one-liner,
  `IoComponent::runOutputs()` (`comparator.h:25`) — the whole analogue
  comparison is reduced to "compute a bit, then let the pin model do the rest".

### src/components/active/comparator.cpp
- Purpose: a comparator that differences two input pins and drives a 0/1 output.
- Key abstractions: `IoComponent` (input pins, output pin with propagation
  delay, edge properties) + `eElement` (the engine side of the part).
- Data flow: `stamp()` registers callbacks on both input pins (`:70-74`);
  when a node voltage moves, `voltChanged()` computes `vd = V+ − V−` and sets
  `m_nextOutVal = (vd > 0) ? 1 : 0` (`:78-79`) then `scheduleOutPuts(this)`.
- Non-obvious design decisions: the threshold is **exactly zero** — there is no
  hysteresis band and no offset parameter, so a comparator sitting on its
  threshold will chatter.
- Edge cases / failure handling: `vd > 0` is a strict comparison, so `vd == 0`
  gives 0.
- Surprising: the comparator borrows the op-amp's icon and shape
  (`:31` `"opamp.png"`, `:83-97` the same trapezoid) — the library entry is a
  *presentation* choice with no effect on the model.

### src/components/active/diac.h
- Purpose: header for the DIAC.
- Key abstractions: `Diac : public Component, public eElement` with two
  `eDiode` members and an `eResistor`; five ePins.
- Data flow: declarations only.
- Non-obvious design decisions: the DIAC is **not** a primitive in the engine —
  it is a composite of two diodes and a resistor, assembled in the graphical
  class and wired in `stamp()`.
- Edge cases / failure handling: none in the header.
- Surprising: `m_state` is a plain `bool` with no initialiser (`:49`) and is
  only set in `stamp()` — so a DIAC that is never stamped has an undefined
  state.

### src/components/active/diac.cpp
- Purpose: a DIAC (trigger diode) built from two anti-parallel diodes and a
  series resistor.
- Key abstractions: `eDiode` ×2 in anti-parallel between Pin0 and a private
  `eNode`, plus an `eResistor` from that node to Pin1 (`:55-67`).
- Data flow: `stamp()` wires the internal nodes to the external ones and sets
  the resistor to `m_resOff` (`:100-119`); `voltChanged()` reads the voltage
  across the device and the current through the resistor, and flips the state
  when `|V| > m_brkVolt` or `|I| < m_holdCurr` (`:131-147`).
- Non-obvious design decisions: the state change calls
  `Simulator::self()->notCorverged()` (`:141`) — the device explicitly tells the
  solver that the circuit has not converged, rather than the solver noticing.
- Edge cases / failure handling: `qFabs` is used with a comment
  "Mingw needs qFabs" (`:137`) — a portability note for a Windows toolchain.
- Surprising: the two diodes are wired so that both are anti-parallel *to each
  other* but the mid node also feeds the resistor, so the conducting path is
  diode → node → resistor, and the off-state is a pure 100 MΩ — the "resistor"
  is what carries the leakage, and the diodes carry the on-state voltage.

### src/components/active/diode.h
- Purpose: header for the diode.
- Key abstractions: `Diode : public LinkerComponent, public eDiode` —
  `LinkerComponent` is what gives the part the ability to have its value
  *linked* to another part.
- Data flow: declarations only.
- Non-obvious design decisions: the constructor takes `bool zener=false`
  (`:16`) so the Zener class is a *flag* on the same implementation rather than
  a subclass with duplicated behaviour.
- Edge cases / failure handling: none.
- Surprising: `LinkerComponent` is the base that makes `emitLinkedValue()` and
  `setLinkedValue()` available — a linked part is one whose value is driven by
  another part's output, which is SimulIDE's closest thing to a scriptable or
  externally-driven value.

### src/components/active/diode.cpp
- Purpose: the diode: model selection, electrical limits, and a file-format
  migration hook.
- Key abstractions: `eDiode` for the Shockley equation and the model registry
  (`m_diodes`); `eResistor` for the series resistance.
- Data flow: `Model` property → `eDiode::setModel()` → the engine element
  reloads its parameters; `stamp()` (`:120-126`) rebinds the internal mid node
  and delegates to `eDiode::stamp()`.
- Non-obvious design decisions: **the legal values of the "Model" property are
  the engine registry's own key list** — `m_diodes.keys().join(",")` (`:65`) —
  so a new diode model shows up in the UI with no UI change, and the editor
  cannot offer a value the engine will reject. Zener does the same with
  `m_zeners`.
- Edge cases / failure handling: `updateStep()` sets `m_warning` above
  `MaxCurrent` and `m_crashed` above **twice** `MaxCurrent` (`:128-138`), and
  both drive a repaint — the part *shows* that it is out of spec rather than
  silently clamping.
- Surprising: `propNotFound()` (`:96-107`) claims the retired property name
  `"Zener_Volt"` and converts it to a zener flag plus a breakdown voltage —
  a per-component migration hook for an old file format, with the comment
  "Old: TODELETE".

### src/components/active/jfet.h
- Purpose: header for the JFET.
- Key abstractions: `Jfet : public Component, public eJfet`.
- Data flow: declarations only.
- Non-obvious design decisions: `virtual` is used redundantly on the overrides
  (`:22-24`), a stylistic marker of the file's age.
- Edge cases / failure handling: none.
- Surprising: none.

### src/components/active/jfet.cpp
- Purpose: the JFET part.
- Key abstractions: `eJfet` owns the model; the part owns three pins.
- Data flow: `updateStep()` → `updateValues()` → `voltChanged()` (`:60-69`),
  gated on `m_changed`.
- Non-obvious design decisions: the **gate is an `IoPin` of type `input`**
  (`jfet.cpp:41`) — a digital-class pin used on an analogue device, so the gate
  is a real node that loads the circuit rather than a probe. The drain and
  source are plain `Pin`s.
- Edge cases / failure handling: none.
- Surprising: a commented-out fourth pin for "debug monitoring of Rds for
  voltage controlled resistor applications" (`:43-44`) — a half-built feature
  left as a comment.

### src/components/active/mosfet.h
- Purpose: header for the MOSFET.
- Key abstractions: `Mosfet : public Component, public eMosfet`.
- Data flow: declarations only.
- Non-obvious design decisions: the header overrides `setPchannel` and
  `setDepletion` (`:24-25`) — the *engine* element exposes these setters and
  the graphical class shadows them to also mark the part dirty and repaint.
- Edge cases / failure handling: none.
- Surprising: none.

### src/components/active/mosfet.cpp
- Purpose: the MOSFET part, including enhancement/depletion rendering.
- Key abstractions: `eMosfet`; the part adds two boolean properties that the
  engine element understands.
- Data flow: `setPchannel`/`setDepletion` set `m_Pchannel`/`m_depletion` and
  `m_changed = true` (`:75-86`); `updateStep()` → `updateValues()` →
  `voltChanged()`.
- Non-obvious design decisions: the *depletion* mode is drawn as a solid
  channel bar and the enhancement mode as a broken one (`:122-131`) — the
  symbol changes with the parameter, so the schematic itself tells the student
  which mode the part is in.
- Edge cases / failure handling: none.
- Surprising: the paint highlights the body when `m_gateV > 0` (`:92-93`)
  regardless of P-channel or N-channel, so the visual "on" cue is
  gate-voltage-based, not current-based (unlike the BJT, which uses base
  current).

### src/components/active/mux_analog.h
- Purpose: header for the analogue multiplexer.
- Key abstractions: `MuxAnalog : public Component, public eElement` with a
  `Pin` for Z, a `Pin` for enable, and vectors of address pins, channel pins
  and channel `eResistor`s.
- Data flow: declarations only.
- Non-obvious design decisions: the class exposes `impedance()` and
  `setImpedance(double)` (`:32-33`) while the member is an *admittance*
  (`m_admit`, `:47`) — the property is called "Impedance" and the unit is
  "mΩ", but the stored quantity is a conductance.
- Edge cases / failure handling: none in the header.
- Surprising: the number of address pins and channel resistors is a *run-time*
  quantity, so the header has to carry `create*`/`delete*` helpers rather than
  fixed-size arrays.

### src/components/active/mux_analog.cpp
- Purpose: the analogue multiplexer: 2^N channels selected by N address bits,
  with a run-time-configurable width.
- Key abstractions: one `eResistor` per channel between the common node (Z)
  and that channel's pin (Y); the selected channel's resistor carries the
  configured admittance, the others are set to `low_imp`.
- Data flow: `stamp()` (`:68-83`) binds every channel resistor's Z side to
  the common node, sets channel 0 to the configured admittance and the rest to
  `low_imp`, and registers callbacks on the address and enable pins.
  `voltChanged()` (`:93-107`) reads the enable pin (`< 2.5` means enabled,
  because the enable pin is **inverted**, `:49`) and decodes the address bits
  into an integer; if either changed it **schedules an event 10 000 ps
  later** rather than switching now (`:104-105`). `runEvent()` (`:109-122`)
  performs the actual admittance swap.
- Non-obvious design decisions: the electrical change is *deferred* so the
  part has a modelled propagation delay (the `10000/*m_propDelay*/` comment
  shows the delay is meant to become a property), and `setAddrBits`
  (`:131-158`) **powers the circuit off** before it adds or removes pins and
  resistors — a topology change is never allowed mid-solve.
- Edge cases / failure handling: `setImpedance` refuses a non-positive
  impedance (`:126`); `setAddrBits` clamps the width to at least 1 bit
  (`:134`); `remove()` (`:218-228`) detaches the Z and enable connectors and
  deletes the channel resistors and address pins before the base class runs.
- Surprising: the part is *built* as it is configured — `createAddrBits` and
  `createResistors` (`:160-201`) allocate real `Pin`s and real `eResistor`s
  and re-lay-out the symbol's bounding box (`m_area`, `:152`), so an 8-bit
  mux is a different object graph from a 3-bit one.

### src/components/active/op_amp.h
- Purpose: header for the op-amp.
- Key abstractions: `OpAmp : public Component, public eElement` with three
  `IoPin`s (two inputs, one output) and two plain supply `Pin`s.
- Data flow: declarations only.
- Non-obvious design decisions: the supply pins are *optional* — `m_powerPins`
  toggles them on and off (`:40-44`), and the class keeps both a "default"
  rail voltage (`m_voltPosDef`/`m_voltNegDef`) and a live one, so the part
  works with no supply wiring at all.
- Edge cases / failure handling: none in the header.
- Surprising: the class carries its own `m_step` state machine field (`:58`)
  — the op-amp keeps a *convergence phase* of its own, outside the engine.

### src/components/active/op_amp.cpp
- Purpose: a finite-gain op-amp with supply rails **and a hand-written
  convergence-guessing loop** — the single most interesting file in this shard.
- Key abstractions: `IoPin` for the input/output pins (so the op-amp has a
  real input impedance and a real output slew), `eElement` for the engine
  identity, and the part's own two-phase convergence state (`m_step`).
- Data flow: `stamp()` puts the two input nodes and the output node on the
  solver's non-linear list and creates the output's current (`:114-123`);
  `voltChanged()` (`:134-179`) is where the work happens.
- Non-obvious design decisions: the convergence test is on **both** the input
  difference and the output, within `m_accuracy = 5e-6` (`:150-153`). If not
  converged, the op-amp does not just re-solve — it *guesses*: on the first
  step after a convergence it perturbs the output by ±1e-6 to learn the
  direction of travel (`:157-163`), and on the next step it extrapolates
  `out = (m_lastOut*dIn + vd*1e-6)/(dIn + m_k)` with `m_k = 1e-6/m_gain`
  (`:165-169`) — a damped guess whose damping constant is the model's own
  gain. It calls `Simulator::self()->notCorverged()` (`:155`) to keep the
  solver iterating.
- Edge cases / failure handling: the output is clamped to the supply rails
  twice — once before the convergence test and once after the guess (`:146-148`
  and `:172-173`); `setOutImp` clamps the impedance to `low_imp` (`:181-187`);
  `setPowerPins(false)` **removes the connectors** on the supply pins so a
  disconnected supply is not a dangling node (`:196-200`).
- Surprising: `m_lastIn != vd` is read as "We problably are in a close loop
  configuration" (`:165`) — a feedback loop is *detected* by the input
  changing between iterations, and the guess is weighted by that difference
  (`dIn`). A saturating amplifier and a linear one take different paths through
  the same code.

### src/components/active/scr.h
- Purpose: header for the SCR (thyristor).
- Key abstractions: `SCR : public Component, public eElement` with one
  `eDiode`, two `eResistor`s and a private mid node.
- Data flow: declarations only.
- Non-obvious design decisions: like the DIAC, the SCR is a *composite* of
  simpler engine elements, not a primitive.
- Edge cases / failure handling: none.
- Surprising: `m_state` again has no initialiser and is set only in `stamp()`.

### src/components/active/scr.cpp
- Purpose: the SCR, with a hysteretic on/off model.
- Key abstractions: `eDiode` (anode–cathode path) + `eResistor` (the series
  path) + `eResistor` (the gate path), glued by a private `eNode`.
- Data flow: `stamp()` (`:95-117`) binds the internal nodes, puts all three
  external nodes on the non-linear list, and sets the series resistance to
  `10e5` (off). `voltChanged()` (`:127-147`) computes the anode current from
  the series resistor and the cathode current from the gate resistor, and
  decides the state with a *weighted* comparison
  `-cathCurr*(1/trigCurr) + anodCurr*(1/holdCurr − 1/trigCurr) > 1`.
- Non-obvious design decisions: the on/off transition is **hysteretic by
  construction** — the trigger and hold currents are two different thresholds
  of the same inequality, so the device latches (`:141-146`). The on-state
  resistance is `0.0105` Ω and the off-state `10e5` Ω.
- Edge cases / failure handling: `voltChanged()` early-returns when both
  terminal voltages are within 0.01 V (`:131`) — "Converged" — so the device
  does not fight the solver in a quiescent circuit.
- Surprising: the gate resistor's current is *subtracted* from the cathode
  current (`:135`) — i.e. the gate current is modelled as flowing out of the
  cathode, which is what makes the trigger and hold thresholds two sides of
  one inequality.

### src/components/active/triac.h
- Purpose: header for the TRIAC.
- Key abstractions: `Triac : public Component, public eElement` with two
  `eDiode`s (anti-parallel) and two `eResistor`s.
- Data flow: declarations only.
- Non-obvious design decisions: structurally identical to the SCR but with two
  diodes — the TRIAC conducts in both directions.
- Edge cases / failure handling: none.
- Surprising: none.

### src/components/active/triac.cpp
- Purpose: the TRIAC: two anti-parallel diodes plus a series resistor, latched
  by the gate.
- Key abstractions: same as the SCR but with the second diode reversed
  (`:58-66`).
- Data flow: `stamp()` (`:102-125`) binds nodes and sets the series resistance
  to `10e5`; `voltChanged()` (`:136-151`) latches on `|I_gate| > m_trigCurr`
  and unlatches on `|I_series| < m_holdCurr`.
- Non-obvious design decisions: the latching decision uses **two different
  currents** (the gate current to turn on, the series current to stay on) and
  does *not* call `notCorverged()` — unlike the SCR, which does (contrast
  `scr.cpp:132` with `triac.cpp:136-151`). That asymmetry is a real
  inconsistency between two sibling devices.
- Edge cases / failure handling: same `qFabs` portability comment (`:142`).
- Surprising: the TRIAC's state machine reads the *gate* resistor's current
  for turn-on and the *series* resistor's current for turn-off — two different
  branches, inverting the roles compared to a physical device.

### src/components/active/volt_reg.h
- Purpose: header for the voltage regulator.
- Key abstractions: `VoltReg : public Component, public eResistor` — it
  *is* a resistor element, with the resistance slot used as a linearising
  conductance rather than a real resistance.
- Data flow: declarations only.
- Non-obvious design decisions: the header exposes `outVolt()` but the class
  stores the reference in `m_vRef` (`:32`) — the getter and the field name
  differ, so the property name ("Voltage") and the internal name disagree.
- Edge cases / failure handling: `m_connected` is a plain flag set in
  `stamp()`.
- Surprising: none.

### src/components/active/volt_reg.cpp
- Purpose: a voltage regulator modelled as a soft, lossy element.
- Key abstractions: `eResistor` for the admittance slot; three `Pin`s
  (input, output, reference).
- Data flow: `stamp()` (`:71-88`) requires **all three** pins to be connected
  before it will act at all — an unconnected reference silently disables the
  part. `voltChanged()` (`:98-117`) computes `delta = V_in − (V_ref + m_vRef)`
  and clamps it: below 0.7 V the drop is the input voltage itself, otherwise
  at least 0.7 V (`:103-109`); the current `delta*m_admit` is then stamped as
  an opposite pair on the input and output pins.
- Non-obvious design decisions: the 0.7 V floor is a *silicon dropout voltage*
  written as a magic number in the middle of the model, with no property and no
  comment (`:105-108`).
- Edge cases / failure handling: convergence is detected by comparing the
  *current* to the last current within 1e-3 (`:111`) and, if it moved, the
  part calls `notCorverged()` (`:113`).
- Surprising: the regulator is implemented as a Norton source with a series
  conductance, so its output impedance is `1/m_admit` = 1 µΩ (from `m_admit =
  1e6` at `:39`) — an essentially ideal regulator, with the 0.7 V floor as
  the only non-ideality.

### src/components/active/zener.h
- Purpose: header for the Zener diode.
- Key abstractions: `Zener : public Diode` — nothing else.
- Data flow: declarations only.
- Non-obvious design decisions: the subclass exists only to change the model
  registry and the name.
- Edge cases / failure handling: none.
- Surprising: 20 lines, the smallest header in the shard.

### src/components/active/zener.cpp
- Purpose: the Zener diode, i.e. a Diode with the zener flag set.
- Key abstractions: reuse of `Diode`'s whole implementation.
- Data flow: the constructor calls `Diode(type, id, true)` (`:27`), which
  selects the `"zener"` diode type and the `"Zener Default"` model.
- Non-obvious design decisions: it **removes** the inherited "Model" property
  and re-adds it bound to `m_zeners.keys()` instead of `m_diodes.keys()`
  (`:29-32`) — a subclass editing the parent's property table.
- Edge cases / failure handling: none.
- Surprising: `remProperty("Model")` + `addProperty(...)` is the mechanism for
  *narrowing* a parent's enum, and it is a two-line pattern worth stealing.

### src/components/comp2pin.h
- Purpose: header for the two-pin component base.
- Key abstractions: `Comp2Pin : public Component` — a component with exactly two
  pins, laid out left and right.
- Data flow: declarations only.
- Non-obvious design decisions: the class adds **nothing** to `Component`; the
  entire value of the abstraction is in the constructor that creates the two
  pins in the standard place, so every two-pin part (resistor, capacitor,
  battery, lamp, audio out) gets an identical geometry and identical pin ids
  for free.
- Edge cases / failure handling: none here.
- Surprising: the header is 15 lines and its only content is a constructor
  declaration — a "base class" that exists purely to fix a convention.

### src/components/comp2pin.cpp
- Purpose: creates the standard two-pin layout every two-terminal part uses.
- Key abstractions: `m_pin[0]` = left pin at `QPoint(-16,0)` angle 180°,
  `m_pin[1]` = right pin at `QPoint(16,0)` angle 0° (`:15-16`).
- Data flow: none; pure construction.
- Non-obvious design decisions: the pin **ids** are `-lPin` and `-rPin` (`:15-16`)
  — positional names that survive rotation and flipping, so a saved circuit file
  always names a resistor's terminals "lPin" and "rPin" no matter how the part
  was turned on the canvas.
- Edge cases / failure handling: none.
- Surprising: the bounding box is `QRectF(-11,-4.5,22,9)` (`:12`) — 22 px wide
  while the pins are 32 px apart, so the *hit box* is much smaller than the
  symbol. A derived part that draws something wider must widen `m_area` itself.

### src/components/component.h
- Purpose: the base class of every part on the canvas.
- Key abstractions: `Component : public CompBase, public QGraphicsItem, public
  Updatable` (`:23`), with `Q_INTERFACES( QGraphicsItem )` (`:25`) — it joins
  the *property/file-format* half, the *canvas* half and the *per-step update*
  half in one class, and knows about none of them except through their
  interfaces.
- Data flow: declarations only.
- Non-obvious design decisions: the class carries **two coordinate systems** —
  `m_boardPos/m_boardRot/m_boardHflip/m_boardVflip` and
  `m_circPos/m_circRot/m_circHflip/m_circVflip` (`:202-209`) — because a part
  can be drawn in two different placements (on a board, or inside a circuit) and
  switching between them must lose neither. That is the whole reason
  `SubPackage::setBoardMode()` has to save and restore both.
- Edge cases / failure handling: `setHflip`/`setVflip` (`:106`, `:109`) clamp
  anything that is not ±1 back to 1, so a corrupt file value cannot produce a
  zero-scale transform that would make the part vanish.
- Surprising: `m_isLinker` and `m_linkNumber` are **public** members
  (`:160-161`) — `Linker` reaches straight into a `Component` to paint its link
  index, rather than going through an accessor.

### src/components/component.cpp
- Purpose: the shared behaviour of every part: labels, selection, movement,
  undo, the context menu, and the three inherited property groups.
- Key abstractions: the constructor declares three property groups that
  **every** part inherits — `"CompBase"` (`:102-107`, the id/type/main-comp
  identity), `"CompGraphic"` (`:109-121`, position, rotation, flips, label
  positions) and `"Board"` (`:123-130`, the second coordinate system) — and
  marks all three `groupHidden | groupNoCopy`, i.e. none of them is written to
  the circuit file.
- Data flow: the mouse handlers (`:177-307`) collect the selection, and on the
  **first** mouse-move the drag's starting state is snapshotted into three
  member lists and written to the undo stack: `Circuit::self()->beginCircuitBatch()`
  (`:272`), `addCompChange( uid, "Pos", oldPos )` per component (`:273-274`) and
  `addCompChange( uid, "pointList", con->pListStr() )` per connector
  (`:276-277`).
- Non-obvious design decisions: **the undo entry is taken on the first
  mouse-move, not on mouse-press** (`:237-281`) — the batch is opened and the
  pre-move property values are captured in the same frame the drag starts,
  which is why a drag is *one* undo step rather than hundreds. The connector's
  whole polyline is snapshotted as a **string** (`pListStr()`), so a connector's
  shape is restored by re-parsing a string, not by restoring a geometry object.
- Edge cases / failure handling: a component that is a child item delegates
  every mouse event to its parent (`:179-184`, `:224-230`, `:295-300`,
  `:313-316`, `:322-325`) — a part inside a subcircuit cannot be grabbed on its
  own. The movement delta is snapped to the grid (`:233`) unless the component
  is freely movable (`:282`).
- Surprising: `paintSelected()` (`:666-710`) is where the *physical failure
  states* are drawn: a crashed part is filled orange, a warning part yellow,
  and the fill **pulses**, because `m_opCount` is advanced per paint and the
  painter's opacity is set from it (`:669-681`). A part that is out of spec
  therefore blinks — a far stronger signal to a student than a static colour.

### src/components/graphical/shape.h
- Purpose: header for the pure-graphics shape base.
- Key abstractions: `Shape : public Component` with size, border, colour,
  opacity and z-value; a `m_changed` flag of its own (`:54`).
- Data flow: declarations only.
- Non-obvious design decisions: `Shape` overrides `freeMove()` to always return
  `true` (`:43`) — a shape is *never* subject to the board-mode movement
  restriction, because it has no electrical meaning to protect.
- Edge cases / failure handling: `boundingRect()` is overridden to include the
  border width (`:18-21`), so a thick border is still clickable.
- Surprising: `Shape::m_changed` (`:54`) **shadows** the `eElement::m_changed`
  that the same name means in the rest of the codebase
  (`src/simulator/e-element.h:53`) — the same identifier, two meanings, one
  tree, and no compiler help.

### src/components/graphical/shape.cpp
- Purpose: the shared implementation of the shape family (rectangle, ellipse,
  line, image).
- Key abstractions: the constructor sets `m_graphical = true` (`:19`), the
  defaults 50×30 px, grey, border 2, opacity 1, and z-value −1 (`:27`) so
  shapes sit *behind* the circuit.
- Data flow: every setter (`setHSize`, `setVSize`, `setBorder`, `setColor`,
  `setOpac`) clamps its argument and then calls `changed()` (`:71-104`), which
  sets `m_changed = true` and, **if the simulator is not running**, applies the
  change immediately (`:106-110`).
- Non-obvious design decisions: a geometry change is **deferred to
  `updateStep()`** (`:60-69`) while the simulator is running, so a shape resized
  mid-simulation does not trigger a repaint storm; when idle, the change is
  applied synchronously. `updateStep()` recomputes `m_area` and calls
  `Circuit::self()->update()`.
- Edge cases / failure handling: every setter clamps — size ≥ 1 (`:73`, `:81`),
  border ≥ 0 (`:87`), opacity to [0,1] (`:100-101`).
- Surprising: `m_graphical = true` is what makes the part invisible to the
  electrical layer: `Component::setHidden` then hides only the *pins* rather
  than the whole item (`src/components/component.cpp:613-614`).

### src/components/graphical/ellipse.h
- Purpose: header for the ellipse shape.
- Key abstractions: `Ellipse : public Shape`, adding `shape()` for hit-testing.
- Data flow: declarations only.
- Non-obvious design decisions: the class exposes the `construct`/`libraryItem`
  static pair (`:18-19`) — the whole "plugin" contract in this repo is two
  static functions.
- Edge cases / failure handling: none.
- Surprising: none.

### src/components/graphical/ellipse.cpp
- Purpose: the ellipse shape: library entry, hit path and painting.
- Key abstractions: `shape()` returns a `QPainterPath` built from
  `Shape::boundingRect()` (`:32-37`) — hit-testing is the *bounding*
  rectangle, not the ellipse, so clicks in the corners of the box still select
  it.
- Data flow: `paint()` (`:39-60`) draws the filled ellipse at `m_opac`
  opacity and then, if `m_border > 0`, draws a second transparent-brushed
  ellipse as the outline.
- Non-obvious design decisions: the two-pass fill-then-outline means the border
  is drawn *over* the fill, so a 4 px border eats into the visible fill.
- Edge cases / failure handling: the fill pen is hard-coded black with width 0
  (`:43-44`) and the border pen is constructed separately (`:54`), so the
  border's colour is *not* the shape's `m_color`.
- Surprising: `m_opac` multiplies the painter's *current* opacity and then
  restores it (`:47-50`), so a shape can never be more opaque than whatever
  context it is drawn in.

### src/components/graphical/line.h
- Purpose: header for the line shape.
- Key abstractions: `Line : public Shape`.
- Data flow: declarations only.
- Non-obvious design decisions: none.
- Edge cases / failure handling: none.
- Surprising: none.

### src/components/graphical/line.cpp
- Purpose: the diagonal line shape.
- Key abstractions: the hit path is a hand-built four-point polygon
  (`:32-42`) approximating the thin diagonal, because a `QPainterPath` for a
  line has zero area and would never be clicked.
- Data flow: `paint()` draws the line from `(-hSize/2, vSize/2)` to
  `(hSize/2, -vSize/2)` (`:54`).
- Non-obvious design decisions: the polygon is deliberately 1 px *wider* than
  the line on each side (the `+1`/`-1` offsets) so the clickable region is a
  2-px band — a UI detail that only matters because a zero-width shape is
  unselectable.
- Edge cases / failure handling: none.
- Surprising: the line always runs bottom-left to top-right; the only way to
  change its angle is to rotate the whole component.

### src/components/graphical/rectangle.h
- Purpose: header for the rectangle shape.
- Key abstractions: `Rectangle : public Shape`; no `shape()` override, because
  the default bounding-rect hit test is exact for a filled rectangle.
- Data flow: declarations only.
- Non-obvious design decisions: none.
- Edge cases / failure handling: none.
- Surprising: the header is 22 lines and the class body is a constructor — the
  only difference from `Ellipse` is the paint routine.

### src/components/graphical/rectangle.cpp
- Purpose: the rectangle shape: library entry and painting.
- Key abstractions: none beyond `Shape`.
- Data flow: `paint()` fills `m_area` with `m_color` at `m_opac`, then draws
  the border rectangle if `m_border > 0` (`:32-50`).
- Non-obvious design decisions: the same two-pass fill-then-outline as the
  ellipse, so the border overlaps the fill.
- Edge cases / failure handling: none.
- Surprising: the outline is drawn with `p->setBrush(Qt::transparent)` set
  *after* the fill (`:46`) — the brush is reused, and the fill's brush was set
  by `Component::paint`.

### src/components/graphical/image.h
- Purpose: header for the image (and animated GIF) shape.
- Key abstractions: `Image : public Shape` with a `QPixmap m_image` and a
  `QMovie* m_movie`; it overrides `background()`/`setBackground()` so that the
  inherited word means *image file* rather than *background colour*.
- Data flow: declarations only.
- Non-obvious design decisions: the class carries a second, hidden property
  `"BckGndData"` (`:56-57`) holding the **hex-encoded image bytes**, so an
  image can be *embedded* in the circuit file rather than referenced by path;
  `bckGndData()` returns it only when `m_embeedBck` is set (`:27`).
- Edge cases / failure handling: none.
- Surprising: the spelling "Embeed" is in the **property name**
  `"Embeed_bck"` (in the .cpp) and in the API — the typo is in the file
  format, so it cannot be fixed without a migration.

### src/components/graphical/image.cpp
- Purpose: the image shape: load a picture, animate a GIF, embed it in the
  file, paint it.
- Key abstractions: `QPixmap` + `QMovie`; the image is stored as a hex string
  in `m_bckGndData` (`:138-140`).
- Data flow: `slotLoad()` (`:78-93`) opens a file dialog, calls
  `setBackground(fileName)` and resizes the shape to the image's pixel size.
  `setBackground()` (`:110-143`) resolves the path relative to the circuit's
  directory, starts a `QMovie` for `.gif` files, and — if the file exists —
  reads it into a `QByteArray` and hex-encodes it into `m_bckGndData`.
  `setBckGndData()` (`:158-174`) decodes the hex back and loads the image from
  the bytes.
- Non-obvious design decisions: the path stored in the property is **relative
  to the circuit file's directory** (`background()` returns
  `circuitDir.relativeFilePath( m_background )`, `:145-149`) — so a circuit
  with an embedded image can be moved as a folder and still find its picture;
  the absolute path is used only at load time.
- Edge cases / failure handling: a `.gif` that fails to load is reported with
  `qDebug` and the part keeps its old image (`:130`); an image that cannot be
  loaded falls back to the previous `m_background` (`:136`); the hex decode
  steps two characters at a time and ignores a trailing half-byte (`:166-172`).
- Surprising: `m_image.load( absPath )` runs *after* the GIF branch (`:135`), so
  a GIF is both animated (through `m_movie`) and loaded as a static pixmap.

### src/components/graphical/textcomponent.h
- Purpose: header for the free text / label shape.
- Key abstractions: `TextComponent : public LinkerComponent` — a text box that
  can be **linked** to other components so its content tracks their values.
- Data flow: declarations only.
- Non-obvious design decisions: the class overrides `setLinkedString` and
  `setLinkedValue` (`:59-60`), which is how a linked text box becomes a live
  readout.
- Edge cases / failure handling: none.
- Surprising: the text is stored **twice** — as the model `QString
  m_textString` and as a `QGraphicsTextItem*` view — and the model escapes five
  characters (`\n`, `"`, `=`, `<`, `>`) when written and unescapes them when
  read, so the text survives the property format.

### src/components/graphical/textcomponent.cpp
- Purpose: the text/label shape: rendering, geometry, and the `$dataN`
  substitution that makes it a live readout.
- Key abstractions: a `QGraphicsTextItem` child item whose document's
  `contentsChange` signal drives `updateGeometry()` (`:79-80`).
- Data flow: `updateStep()` (`:118-133`) walks `m_linkedComp` and replaces the
  literal token `$data0`, `$data1`, … with each linked component's *value
  label* text (`comp->getValLabelText()`, `:129-130`), then writes the result
  into the document. `setLinkedValue()` (`:245-251`) sets the whole text to a
  number; `setLinkedString()` (`:239-243`) sets or appends a string.
- Non-obvious design decisions: the substitution token is a **positional
  literal** (`$data` + index) rather than a name, so a text box linked to three
  components reads `$data0 $data1 $data2` — a tiny template language with no
  parser — and the linked component's *displayed* value is used, so the text
  shows exactly what the student sees on the part.
- Edge cases / failure handling: `setMargin()` keeps compatibility with older
  versions by *adjusting* the document margin when a negative margin is given
  (`:148-155`); `getText()` escapes `\n`, `"`, `=`, `<`, `>` into HTML entities
  (`:210-215`) because the property value lands in the circuit file.
- Surprising: `setLinkedValue` appends `"/n" + str` for index > 0 (`:250`) — a
  **typo** for `"\n"`, so linking a second value to a text box produces a
  literal `/n` in the text.

### src/components/iocomponent.h
- Purpose: header for the base of every part with digital (logic) I/O pins.
- Key abstractions: `IoComponent : public Component, public LogicFamily` — the
  graphical half plus the *electrical* characterisation of a logic family
  (thresholds, impedances, delays, pull-ups).
- Data flow: declarations only.
- Non-obvious design decisions: the class carries **two output queues** —
  `std::queue<uint> m_outQueue` (pending output values) and
  `std::queue<uint64_t> m_timeQueue` (their due times) (`:87-88`). A part that
  changes its output faster than its propagation delay does not drop edges: it
  queues them, and the queue is drained by scheduled events.
- Edge cases / failure handling: `m_eElement` (`:99`) is the engine element
  the queued events are attached to, so a queued edge survives even when the
  part's own `runEvent` is not the one that fires.
- Surprising: `setNumInps`/`setNumOuts` (`:56`, `:59`) are `virtual` and take
  a label and a `bit0`/`id0` pair — a part can therefore be **rebuilt with a
  different pin count at run time**, which is how one class covers the 8-bit and
  16-bit variants of a device.

### src/components/iocomponent.cpp
- Purpose: the shared machinery of every logic-I/O part: the property groups,
  the output-delay queue, and the pin factory.
- Key abstractions: the property groups `familyProps()` (`:41-52`),
  `inputProps()` (`:54-71`), `outputProps()` (`:73-92`), `outputType()`
  (`:94-105`) and `edgeProps()` (`:107-121`) — every Io part gets the same five
  groups, so a student meets the same knobs on every chip.
- Data flow: `scheduleOutPuts(el)` (`:154-179`) is the output path. If the
  family delay is zero it applies the value immediately (`:157-164`); otherwise
  it either schedules a single event (`:165-169`) or, **if an event is already
  pending**, pushes the new value and its due time onto the two queues
  (`:170-178`). `runOutputs()` (`:135-152`) pops the next value, schedules the
  *next* event if the queue is non-empty, and then applies the value bit by
  bit to the output pins.
- Non-obvious design decisions: the queue is a **depth-1 pipeline with a time
  stamp**, and the "new event while previous not dispatched" branch
  (`:170-177`) deliberately *re-times* the pending event rather than stacking
  it — so a fast-toggling output collapses to the latest value plus a
  re-scheduled event. This is the difference between a simulator that models a
  gate and one that models a race.
- Edge cases / failure handling: the zero-delay path is guarded by
  `if( m_nextOutVal == m_outValue ) return;` (`:159`, `:167`) so an unchanged
  value schedules nothing; the queued path compares against `m_outQueue.back()`
  (`:172`) for the same reason. `initState()` (`:123-133`) clears both queues,
  so a restart cannot inherit a stale edge.
- Surprising: `setInputImp`/`setOutImp`/`setOpenImp`/`setInvertOuts`/
  `setInvertInps`/`setOpenCol` all **pause the simulator, apply the change, and
  resume** (`:262-335`) — a pin's impedance is a *solver* parameter, so it may
  not change mid-solve. That is the single most important rule in this file for
  anyone extending it.

### src/components/linker.h
- Purpose: header for the link mechanism — one part driving the value of
  another.
- Key abstractions: `Linker` holds a list of linked components
  (`m_linkedComp`), the *string* form of the link set (`m_linkedStr`) and a
  static "currently linking" pointer (`m_selecComp`).
- Data flow: declarations only.
- Non-obvious design decisions: the class is a `friend class Circuit` (`:15`)
  so the circuit can drive the linking lifecycle without exposing internals;
  and `m_selecComp` is **static**, which makes linking a modal,
  application-wide mode — exactly one part can be the source at a time.
- Edge cases / failure handling: `removeLinked()` (`:24`) is the only public
  mutator for the list, and it is called from `Component::remove()` so a
  deleted part unlinks itself.
- Surprising: the link is stored **twice** — as a *pointer list* for the live
  session and as a *comma-separated string of UIDs* (`getLinks`/`setLinks`,
  `:21-22`) for the circuit file. The string is re-resolved against the
  circuit's component list when the file is loaded
  (`src/components/linker.cpp:38-52`).

### src/components/linker.cpp
- Purpose: the implementation of the link mechanism.
- Key abstractions: `Linker` + `Component`'s `setLinkedTo`/`setLinkedValue`.
- Data flow: `startLinking()` (`:54-62`) installs the link cursor and shows the
  currently linked parts; clicking a component calls `compSelected()`
  (`:72-96`) which toggles that component in and out of the link set and then
  registers or unregisters the linker with the circuit (`:94-95`).
  `emitLinkedValue(v, i)` (`:114-117`) pushes a value to *every* linked
  component.
- Non-obvious design decisions: linking is a **toggle**, not a one-shot
  selection (`:76-85`), so a second source can be added to an existing link
  without re-picking the first. `showLinked()` (`:98-112`) writes the link index
  into `comp->m_linkNumber`, which the canvas paints as a number on the linked
  part (`src/components/component.cpp:688-693`) — the link is therefore
  *visible* on the schematic.
- Edge cases / failure handling: `createLinks()` (`:38-52`) resolves the saved
  UID string by `comp->getUid().contains( uid )` (`:46`) — a **substring**
  match, not equality, so a UID that is a prefix of another can bind the wrong
  component. The destructor (`:18-22`) cancels a link in progress and unlinks
  every linked component.
- Surprising: the whole "linking mode" is one global raw pointer
  (`Linker::m_selecComp`) and one cursor override; there is no owner and no
  reference count.

### src/components/linkercomponent.h
- Purpose: header for a component that is itself a link *source*.
- Key abstractions: `LinkerComponent : public Component, public Linker` — the
  graphical part and the link machinery in one class, with `m_linkerIndex`,
  `m_minVal` and `m_maxVal`.
- Data flow: declarations only.
- Non-obvious design decisions: the class exposes `slotLinkComp()` (`:28`) so a
  context-menu action can start linking; and the commented-out
  `linkerProps()` (`:26`) shows the property table was never wired up — the
  link index and the value range are **not persisted**.
- Edge cases / failure handling: none.
- Surprising: `LinkerComponent` derives from `Component` while `Linker` is a
  *separate* base — so a link source is not a `Linker` in the polymorphic sense
  used by `Component::setLinkedTo`; it is a `Component` that additionally owns
  a `Linker` sub-object.

### src/components/linkercomponent.cpp
- Purpose: the shared construction of link-source parts.
- Key abstractions: `Component` + `Linker`; a single hidden property
  `"Links"` (`:24-27`) storing the comma-separated UID list of the linked
  parts.
- Data flow: `contextMenu()` (`:49-57`) adds a "Link to Component" action that
  calls `Linker::startLinking()`; the value the source emits is pushed out
  through `Linker::emitLinkedValue()`.
- Non-obvious design decisions: the `"Links"` property is `groupHidden` but
  **not** `groupNoCopy` (`:27`) — so the link set *is* written to the circuit
  file, which is what makes a link survive a save/load. Contrast `Component`'s
  own three groups, which are `groupHidden | groupNoCopy`.
- Edge cases / failure handling: none.
- Surprising: the entire `linkerProps()` block is commented out (`:31-47`) — the
  min/max value range of a link source is in the class but unreachable from the
  property dialog *and* from the file.

### src/components/logiccomponent.h
- Purpose: header for the base of every *clocked* logic part.
- Key abstractions: `LogicComponent : public IoComponent, public eClockedDevice`
  — the part is simultaneously a canvas object, a property owner and an engine
  element with a clock pin.
- Data flow: declarations only.
- Non-obvious design decisions: the output-enable pin is **inverted by
  construction** — `setOePin()` sets `pin->setInverted( true )`
  (`src/components/logiccomponent.cpp:55`) — because an output-enable is
  active-low on nearly every real chip, so a student wiring a 74HC125 gets the
  polarity right by default.
- Edge cases / failure handling: `m_triggerStr` / `m_triggerList` (`:34-35`,
  `:41`) name the trigger mode ("None,Clock,Enable") as a *string*, because
  the trigger is a property with a translated value.
- Surprising: the class inherits from **three** hierarchies at once
  (`IoComponent` → `Component` → `CompBase`/`QGraphicsItem`, plus
  `eClockedDevice` → `eElement` → the engine), so a single part can be a
  canvas item, a property owner and a solver element without any of them
  knowing about the others.

### src/components/logiccomponent.cpp
- Purpose: the shared behaviour of clocked logic parts: tri-state output
  enable, trigger mode, and the clock pin's electrical parameters.
- Key abstractions: `eClockedDevice` provides `m_clkPin`, `m_clkState` and
  `updateClock()`; `IoComponent` provides the output queue.
- Data flow: `stamp()` (`:27-35`) resets the output state, stamps the engine,
  registers the OE pin's callback and calls `voltChanged()`. `updateOutEnabled()`
  (`:67-74`) reads the OE pin and, on a change, flips every output pin to Z or
  from Z (`enableOutputs`, `:102-105`).
- Non-obvious design decisions: tri-state is implemented as a **pin mode**,
  not as a special driver: `enableOutputs()` sets `setStateZ(!en)` on every
  output (`:104`), and the *open-collector* mode is a different pin mode again
  (`IoComponent::setOpenCol`). One mechanism covers three output behaviours.
- Edge cases / failure handling: `setTristate(false)` **removes the connector**
  on the OE pin (`:80`) — turning tri-state off does not merely hide the pin, it
  disconnects whatever was wired to it, so the circuit itself changes.
- Surprising: `setInpHighV`/`setInpLowV`/`setInputImp` also apply to the
  *clock* pin (`:107-125`), and the impedance change is wrapped in
  `pauseSim()`/`resumeSim()` (`:122-124`) — the clock pin is a real circuit
  node with its own impedance, not a control signal.

### src/components/logicfamily.h
- Purpose: header for the "logic family" abstraction — the electrical character
  of a digital part.
- Key abstractions: `logicFamily_t` (`:10-20`) is a plain struct of nine
  doubles (supply, input thresholds as *percentages*, input impedance, input
  pull-up, output high/low, output impedance, output pull-up); `LogicFamily`
  holds the current values plus the static family registry.
- Data flow: declarations only.
- Non-obvious design decisions: the thresholds are stored **as fractions of the
  supply** (`m_inpHighVp` etc., `:89-95`) rather than as volts — so changing
  the supply voltage moves the thresholds with it, which is what a real logic
  family does.
- Edge cases / failure handling: the setters are `virtual` and mostly empty in
  the base (`:29`, `:38`, `:47`, `:52`), so the base class is a pure data
  holder that derived classes (`IoComponent`) override in order to push the
  values into their pins.
- Surprising: `getEnumUids`/`getEnumNames` (`:71-72`) are `virtual` and return
  the same thing by default — a hook for a part that wants to offer a
  *different* list of families than the global registry.

### src/components/logicfamily.cpp
- Purpose: the logic-family registry and the percentage-based threshold model.
- Key abstractions: `QMap<QString, logicFamily_t> LogicFamily::m_families`
  (`:11`) is a **static** registry; `getFamilies()` (`:128-162`) loads it from
  `logic_families.model` in the data folder.
- Data flow: `setFamily(f)` (`:86-91`) looks the family up and calls
  `setFamilyData()` (`:93-110`), which copies the fractions into the
  per-family fields and calls `updateData()`. `updateData()` (`:112-126`) sets
  `m_blocked = true`, recomputes the *volt* thresholds as `m_supplyV *
  fraction`, pushes them into the pins, and clears `m_blocked`.
- Non-obvious design decisions: **`m_blocked` is a re-entrancy guard on the
  whole threshold mechanism** (`:43`, `:49`, `:55`, `:61`, `:114`, `:125`).
  `LogicFamily::setInpHighV` divides by `m_supplyV` to store a fraction, but
  the derived `IoComponent::setInpHighV` sets the *volts* and then calls the
  base — so the base must be able to tell "the user set volts" from "I am
  recomputing volts from a fraction", and the flag is how it does.
- Edge cases / failure handling: the data file is optional — if
  `logic_families.model` is missing, `getFamilies()` returns with only the two
  built-in families (`:130-134`); the parse loop **breaks** on the first line
  that does not parse (`:142`), so one malformed line silently truncates the
  registry. `setPropDelay`, `setRiseTime` and `setFallTime` all clamp to a
  sane range (`:65-84`).
- Surprising: the whole family list is a **data file**, not code — adding a
  logic family (74HC00, 74LS00, CD4000) is a text edit, and the "Family"
  property's enum is built from the same map
  (`src/components/iocomponent.cpp:45-46`).

### src/components/node.h
- Purpose: header for the junction node — the "three wires meet here" part.
- Key abstractions: `Node : public Component` with **three** pins of zero
  length.
- Data flow: declarations only.
- Non-obvious design decisions: the node has three pins, not two or N (`:14`,
  `src/components/node.cpp:25-30`) — a Y-junction is the primitive and a
  four-way junction is two of them. The node is the only component whose pins
  have length 0 (`src/components/node.cpp:29`).
- Edge cases / failure handling: `checkRemove()` returns false while the node
  still has three connectors, so the node is only dissolved when it drops below
  three — that is how removing a wire collapses a junction.
- Surprising: `getPin(int)` (`:19`) is `const` and indexes `m_pin[pin]` with
  no bounds check.

### src/components/node.cpp
- Purpose: the junction node: connect three wires, compute the current through
  them, and dissolve itself when it is no longer needed.
- Key abstractions: the `eNode` (the engine's node) is what the component
  registers with — `registerEnode()` (`:47-52`) adds the component to the
  `eNode` and registers each connected pin.
- Data flow: `pinMessage(rem)` (`:38-45`) is the callback the pins use:
  `rem == 1` means "a connector was removed" → `checkRemove()`; `rem == 2`
  means "propagate the is-bus flag" → all three pins become bus pins.
  `hasCurrents()` (`:54-80`) computes the third pin's current by KCL from the
  other two.
- Non-obvious design decisions: **`checkRemove()` rewires the circuit before it
  removes itself**: with exactly two connectors left, `joinConns()` (`:107`,
  `:116-164`) splices the two connector polylines into one — it takes the
  point lists, reverses them as needed so the concatenation is continuous,
  creates a new `Connector`, and closes it on the far pin. With one connector
  left it simply removes it. So deleting a wire from a Y-junction leaves a
  *single continuous wire*, not a broken one.
- Edge cases / failure handling: `joinConns` returns early if either connector
  is missing (`:123`); the "connector between two pins of this node" case is
  detected and that connector removed without touching the node's own pins
  (`:93-99`). `hasCurrents()` accumulates into `current` (`:67`) which is
  *uninitialised* before the loop (`:58`); it is only read when exactly two
  pins have currents, and the first iteration sets it, so the value is correct
  in practice but the variable is technically read-uninitialised.
- Surprising: the node's pins have zero length, so a node is drawn as a small
  filled circle of radius 1.5 — or 1.8 if it is a bus (`:183-184`). A bus node
  is *bigger*, a purely visual cue that the net is a bus.

### src/components/other/dial.h
- Purpose: header for the standalone dial.
- Key abstractions: `Dial : public Dialed, public Linker` — the dial is both a
  value source (the `Dialed` half) and a link source (the `Linker` half).
- Data flow: declarations only.
- Non-obvious design decisions: the class re-declares `maxVal`/`minVal` as
  `int` (`:25-29`) while `Dialed` has them as `double` — the standalone dial
  is an integer-valued component with its own range semantics.
- Edge cases / failure handling: `setMaxVal`/`setMinVal` are `virtual` and
  clamp against each other (`:26`, `:29`).
- Surprising: the standalone `Dial` is a *link source*: it emits its value to
  whatever it is linked to, so a dial on the canvas can drive the value of a
  resistor somewhere else in the circuit.

### src/components/other/dial.cpp
- Purpose: the standalone dial: a canvas widget that emits a value.
- Key abstractions: `Dialed` (the widget and the value model) + `Linker` (the
  emission channel).
- Data flow: `updateStep()` (`:101-111`) maps the widget's 0..(steps−1) onto
  the part's [min,max] range (`m_minVal + v*range/(m_steps-1)`, `:108`) and
  calls `emitLinkedValue(v)` (`:110`).
- Non-obvious design decisions: the value is mapped by **fraction of range**,
  not by steps, so a dial with 1000 steps over 0–999 V and one with 10 steps
  over the same range behave identically; and the emission happens only when
  `m_needUpdate` is set (`:103`), i.e. only when the user actually moved it.
- Edge cases / failure handling: `setMinVal`/`setMaxVal` clamp to ≥ 0 and to
  each other (`:123-139`); `setSteps` forces a minimum of 2 steps and derives
  the widget's single-step from `s/40` (`:141-151`).
- Surprising: the dial's value is also a **hidden property** (`"Value"`,
  `:95-96`) alongside `"Links"` (`:92-93`) — so a dial's position is part of
  the saved file even though it is not shown in the property dialog.

### src/components/other/packagepin.h
- Purpose: header for a package's pin — the editable pin of a `SubPackage`.
- Key abstractions: `PackagePin : public Pin` with a back-pointer to its
  `SubPackage`.
- Data flow: declarations only.
- Non-obvious design decisions: the class overrides the three mouse handlers
  (`:23-25`) so a package pin can be **dragged** on the canvas, and the
  context-menu handler (`:26`) so it offers Edit/Delete.
- Edge cases / failure handling: the drag is rejected if it would collide with
  the owning component (the check lives in the .cpp).
- Surprising: `PackagePin` is a `Pin` — a *real* electrical pin — but it
  belongs to a `SubPackage`, a graphical container with no electrical meaning
  of its own. The same class is used for the pins a user draws by hand and for
  the pins read from a `.package` file.

### src/components/other/packagepin.cpp
- Purpose: the editable package pin: drag, context menu, and rendering.
- Key abstractions: `Pin` + `SubPackage` (for `editPin`/`deleteEventPin`).
- Data flow: `contextMenuEvent()` (`:54-68`) records the pin as "the event
  pin" (`m_package->setEventPin( this )`, `:56`) and then offers Edit / Delete,
  which call back into the package. `mouseMoveEvent()` (`:36-46`) moves the
  pin by the grid-snapped delta but **reverts the move if the pin would
  collide with its own component** (`:45`).
- Non-obvious design decisions: the collision check is
  `collidesWithItem( m_component )` — a pin may not be dragged *through* the
  body of the package it belongs to, and nothing else is checked.
- Edge cases / failure handling: the revert is a symmetric `moveBy(-delta)`
  (`:45`), so a rejected drag leaves no residue; a zero delta returns early
  (`:42`) so a click without movement does not even test collision.
- Surprising: the pin paints a tiny **cross** at its origin (`:88-89`) in light
  grey — a 2-pixel marker that is the only visual hint of where a package's
  pin actually sits.

### src/components/other/subpackage.h
- Purpose: header for the "Package" component — the user-drawn IC or board
  outline.
- Key abstractions: `SubPackage : public Chip, public Linker`, plus an
  `EditDialog` class (`:128-153`) declared in the same header.
- Data flow: declarations only.
- Non-obvious design decisions: `getPins()` is overridden to return an
  **empty** vector (`:44`) with the comment "Used to access wires (we have no
  wires)" — a package's pins are *not* circuit pins, so the electrical layer
  must not see them; the package's pins live in a separate `m_pkgePins` list
  (`:117`).
- Edge cases / failure handling: the header also declares `static QString
  m_lastPkg` (`:98`) — a class-static "last opened package file" used as the
  start directory for the next file dialog.
- Surprising: the class declares an entire modal dialog (`EditDialog`) with six
  widgets — name, id, spacing spinbox, angle combo and four checkboxes
  (invert / unused / point / bus) — inside a *component* header, and wires each
  widget's signal straight to the package's setter, so the dialog is a thin
  view over the package.

### src/components/other/subpackage.cpp
- Purpose: the Package component: draw a package outline, add pins to it,
  load/save `.package` files, and switch the whole circuit between board mode
  and circuit mode.
- Key abstractions: `Chip` (the drawing/background base) + `Linker` (the
  "select exposed components" mechanism).
- Data flow: `hoverMoveEvent()` (`:178-229`) computes a *fake* pin position
  from the mouse while Shift is held, and `mousePressEvent()` (`:238-262`)
  turns that fake pin into a real `PackagePin` and opens the edit dialog.
  `setPackageFile()` (`:505-527`) reads a `.package` file, converts it with
  `convertPackage()` and rebuilds the pins via `initPackage()`.
  `packagePins()`/`setPackagePins()` (`:529-553`) serialise the pins as
  `Pin; type=…; xpos=…` property strings separated by `&#xa;`.
- Non-obvious design decisions: **the circuit and the board are two views of
  the same placement**: `setBoardMode()` (`:299-339`) saves
  `circPos/circRot/circHflip/circVflip`, applies
  `boardPos/boardRot/…`, and does the inverse when leaving board mode — the
  dual coordinate fields in `Component` exist precisely for this. Second: the
  pins are stored *in the property table* (a hidden `"Pins"` property) and
  written as one string with `&#xa;` as the line separator (`:544`) — the same
  escaping convention the text component uses.
- Edge cases / failure handling: `setSubcTypeStr()` (`:155-176`) refuses to
  make a second Board — it logs "ERROR: Only one Board allowed" and returns
  without changing anything (`:162-166`). `setPackageFile()` clears the package
  if the file does not exist (`:510`). `setPackagePins()` returns early if a
  package *file* is set (`:541`), so a file-driven package is never overwritten
  by the inline pin list. The undo of a pin edit is **explicitly not
  implemented**: `editFinished()` (`:376-379`) carries the comment
  `/// FIXME UNDOREDO: if( m_changed ) Circuit::self()->saveState();`.
- Surprising: `savePackage()` (`:615-659`) writes an **XML** file
  (`<packageB name=… width=… >` with `<pin …/>` children, `:634-688`) — but
  the *circuit* file stores the same pins as a flat property string. Two
  different serialisation formats for the same object, and the XML one is the
  one a user can hand-edit to share a package.

### src/components/other/testunit.h
- Purpose: header for the Test Unit — the truth-table test harness.
- Key abstractions: `TestUnit : public IoComponent, public eElement` with a
  `TruthTable* m_truthTable`.
- Data flow: declarations only.
- Non-obvious design decisions: the class's *input* pins are the part's
  **outputs** and vice versa — `setInputs` calls `IoComponent::setNumOuts` and
  `setOutputs` calls `setNumInps` (`src/components/other/testunit.cpp:189`,
  `:206`). The test unit therefore *drives* the circuit under test and
  *observes* it, and it does so by being an `IoComponent` with the two roles
  swapped.
- Edge cases / failure handling: none.
- Surprising: the expected truth table is stored as a **hidden property**
  (`"Truth"`, `:58-59`) as a comma-separated list of hex values — so the
  expected behaviour of a circuit lives in the circuit file and travels with
  it.

### src/components/other/testunit.cpp
- Purpose: the Test Unit: drive every input combination, sample the outputs,
  and compare against a truth table.
- Key abstractions: `BatchTest` (the batch runner) + `TruthTable` (the dialog).
- Data flow: `stamp()` (`:79-94`) resizes the sample vector and, **only if a
  batch test is running**, creates the table, registers itself with
  `BatchTest::addTestUnit(this)` and schedules the first event. `runEvent()`
  (`:106-129`) alternates between two phases: apply the current output value
  to the output pins, and (on the next event) read the input pins back into
  `m_samples[m_outValue]`, incrementing `m_outValue` until all `2^n`
  combinations are done. `updateStep()` (`:96-104`) then calls
  `m_truthTable->checkThruth(&m_samples)` and reports the result.
- Non-obvious design decisions: the test unit is a **self-driving event
  loop**: it schedules its own next event with a fixed period of
  `m_period*1e12/2` ps (`:92`, `:118`, `:127`), so the sweep is paced by
  *simulation* time, not by wall clock. The sample index is the *output word*
  being presented (`m_samples[m_outValue] = inputVal`), which makes the sample
  vector a truth table indexed by the presented state.
- Edge cases / failure handling: `m_steps = pow(2, m_outPin.size())` (`:217`) —
  the number of combinations comes from the *output* pin count (the circuit's
  inputs) — and `resizeVectors()` re-allocates the truth vector whenever the
  size changes (`:221-223`), which is what keeps the table's row count and the
  part's sample count in step. `loadTest()` is **empty** (`:152-154`) — loading
  a saved test is not implemented.
- Surprising: `setTruth()` (`:166-179`) silently stops pushing when the vector
  reaches its old size (`:177`), so pasting a *longer* truth string into an
  existing part keeps only the first N entries — the extra ones are dropped
  without a warning.

### src/components/other/truthtable/truthtable.h
- Purpose: header for the truth-table dialog.
- Key abstractions: `TruthTable : public QDialog, private Ui::TruthTable` — a
  `uic`-generated form (`ui_truthtable.h`, `:10`).
- Data flow: declarations only.
- Non-obvious design decisions: the dialog **owns** the truth vector
  (`std::vector<uint> m_truthVector`, `:43`) and pushes it back into the part
  only when the user presses Save (`:26`), so editing a cell is a local change
  that can be discarded.
- Edge cases / failure handling: none.
- Surprising: the public method is spelled `checkThruth` — "Thruth", not
  "Truth" — and the same misspelling appears at the call site
  (`src/components/other/testunit.cpp:102`). A typo in a public method name is
  a permanent API wart.

### src/components/other/truthtable/truthtable.cpp
- Purpose: the truth-table dialog: render the table, let the student edit the
  expected outputs, run the test, and colour the mismatches.
- Key abstractions: a `QTableWidget` whose columns are [inputs | separator |
  outputs] and whose rows are the `2^n` input combinations.
- Data flow: `setup()` (`:23-104`) builds the header and the cells: input
  cells are coloured green when the bit is 1, output cells show the expected
  value from the truth vector as "H"/"L". `checkThruth()` (`:112-139`)
  compares each expected bit against the sampled bit and, on a mismatch,
  **overwrites the cell with the sampled value in orange** (`:131-135`) — the
  table becomes a report of what the circuit actually did. `getTruthVector()`
  (`:141-159`) reads the table back, and `on_saveButton_pressed()` (`:161-165`)
  hands it to the part.
- Non-obvious design decisions: the mismatch is shown by *changing the cell
  text* as well as its colour (`:132-133`), so the table literally shows the
  measured value where the expected one was — the student sees the failure,
  not just a red cell.
- Edge cases / failure handling: `checkThruth` indexes
  `table->item(row, size-bit)` (`:124`) with `size = m_numInputs+m_numOutputs`;
  if the table had fewer rows than the truth vector this would be out of
  range, which the part's `resizeVectors()` is expected to prevent.
- Surprising: the input columns are pre-filled with the binary count-up
  pattern (`row & 1<<(m_numInputs-col-1)`, `:84`) and shaded green/blue, so
  the table doubles as a *timing diagram* of the input sweep.

### src/components/other/truthtable/truthtable.ui
- Purpose: the Qt Designer form for the truth-table dialog.
- Key abstractions: a `QDialog` named `TruthTable` with a `QTableWidget` named
  `table` and three buttons: `runButton` ("Run test"), `clearButton` ("Clear
  test") and `saveButton` ("Save as correct").
- Data flow: the .ui is compiled by `uic` into `ui_truthtable.h`, which
  `truthtable.h:10` includes; the auto-connected slots (`on_runButton_pressed`
  and friends) are matched by name.
- Non-obvious design decisions: the form declares `rowCount 4` and
  `columnCount 6` (`:52-57`) purely as designer placeholders — the real table
  size is set at run time by `TruthTable::setup()`. The vertical header is
  hidden (`:64-65`) because the row index is meaningless to the student.
- Edge cases / failure handling: none.
- Surprising: the button captions carry the whole pedagogy of the component:
  "Run test", "Clear test", **"Save as correct"** — the last one means "take
  whatever the circuit just did and call it the expected answer", which is how
  a student bootstraps a truth table from a circuit that already works.

### src/components/outputs/audio_out.h
- Purpose: header for the audio output (speaker / buzzer).
- Key abstractions: `AudioOut : public Component, public eResistor` with a
  `QAudioOutput`, a `QIODevice* m_audioBuffer` and a `QByteArray m_dataBuffer`.
- Data flow: declarations only.
- Non-obvious design decisions: the part is an `eResistor` — an 8 Ω load — and
  the *audio* is generated from the node voltage, not from a separate signal
  path.
- Edge cases / failure handling: the header stores a `QAudioDeviceInfo
  m_deviceinfo` **by value** and the code checks `m_deviceinfo.isNull()`
  everywhere, so "no audio device" is a first-class state rather than an
  exception.
- Surprising: the part has two *modes* in one — a buzzer (a fixed tone whose
  pitch comes from the "Frequency" property) and a line-level audio output (the
  node voltage scaled to an 8-bit sample) — selected by one boolean.

### src/components/outputs/audio_out.cpp
- Purpose: the audio output: turn a node voltage into sound, and drive the
  speaker's impedance from the buzzer/line mode.
- Key abstractions: `eResistor` for the load; `QAudioOutput` for the sink; the
  simulator's event queue for the sample clock.
- Data flow: `stamp()` (`:133-146`) sets the admittance (1e-4 for a buzzer,
  `1/m_impedance` otherwise), starts the audio output and schedules the first
  event. `runEvent()` (`:157-194`) computes the sample — a sine of the buzzer
  frequency in buzzer mode, or `voltPN*51` in line mode — clamps it to 0..255,
  appends it to `m_dataBuffer` and flushes the buffer to the device when it is
  full; it then computes the interval to the next sample from the simulator's
  *real speed* (`:184-192`) and schedules itself.
- Non-obvious design decisions: **the audio sample rate is derived from the
  simulation's real-time factor, not from the circuit time** (`:184-192`): if
  the simulation is running faster than real time, the part falls back to
  `psPerSec()/1e8` so the sound does not turn into a chipmunk. This is the only
  place in the shard where wall-clock pacing meets simulation time.
- Edge cases / failure handling: a missing audio device is detected in the
  constructor (`:66-83`) — the part prints a diagnostic naming the missing Qt
  multimedia packages, returns early, and paints a **cross over the symbol**
  (`:265-268`) so the user can see the part is not working.
- Surprising: the buzzer's tone is derived from the *simulator's* circuit time
  (`Simulator::self()->circTime()`, `:166`), so its phase is deterministic — a
  reproducible tone.

### src/components/outputs/lamp.h
- Purpose: header for the incandescent lamp.
- Key abstractions: `Lamp : public Comp2Pin, public eResistor` with its own
  brightness integrator (`m_intensity`, `m_avgCurrent`, `m_totalCurrent`,
  `m_lastPeriod`).
- Data flow: declarations only.
- Non-obvious design decisions: the class keeps a **running integral of
  current** (`m_totalCurrent`) and the elapsed simulation time
  (`m_lastPeriod`) so the brightness is a time-average, not an instantaneous
  value — a real filament's thermal inertia, approximated.
- Edge cases / failure handling: `overCurrent()` is `m_avgCurrent/m_maxCurrent`
  (`:35`), and the caller turns >1.5 into a warning and >2 into a crash.
- Surprising: the lamp derives from `Comp2Pin` and `eResistor` but owns
  *neither* the two pins nor the resistance — it reuses the base class's and
  adds only the photometric model.

### src/components/outputs/lamp.cpp
- Purpose: the incandescent lamp: model the filament as a resistor, integrate
  the current, and show the brightness.
- Key abstractions: `eResistor` (the filament) + a brightness integrator.
- Data flow: `voltChanged()` (`:99-103`) computes the current from the voltage
  across the lamp and calls `updateVI()` (`:105-114`), which accumulates
  `m_lastCurrent * period` into `m_totalCurrent` and rolls the period forward
  using the simulator's circuit time. `updateBright()` (`:116-137`) is called
  from `updateStep()` and, at most twice per frame (`m_lastPeriod > psPF/2`,
  `:129`), divides to get the average current and the brightness
  `pow(avg/max, 0.5)`.
- Non-obvious design decisions: the brightness uses a **square-root law**
  (`:132`) — the eye's response to a filament, not a linear scale — and the
  update is *rate-limited to twice per frame*, so the smoothing window is tied
  to the frame rate rather than to the timestep.
- Edge cases / failure handling: when the simulator is not running,
  `updateBright()` resets the integrator and the intensity to its floor
  (`:118-124`), so a stopped simulation shows a dark lamp rather than a stale
  one. `updateStep()` (`:81-97`) sets `m_warning` above 1.5× the rated current
  and `m_crashed` above 2×.
- Surprising: `paint()` (`:139-170`) *mutates* `m_intensity` while painting
  (`m_intensity += 15`, `:157`) — the drawing code has a side effect on the
  model's state, and it saturates at 255. The minimum brightness is
  deliberately non-zero (25) so a lit lamp is visible.

### src/components/outputs/leds/ledbase.h
- Purpose: header for the LED family base.
- Key abstractions: `LedBase : public Component, public eLed` with a
  `ledColor_t` enum (`:20-28`) and a `static eNode m_gndEnode` (`:55`).
- Data flow: declarations only.
- Non-obvious design decisions: the *ground* pin of every LED can be tied to a
  **shared, class-static engine node** (`m_gndEnode`, `:55`), set up in
  `initialize()` — one "ground" for all LEDs in the process, exactly the trick
  `ResistorDip::m_puEnode` uses for a pull-up rail.
- Edge cases / failure handling: `m_grounded` (`:48`) is the flag that decides
  whether pin 1 is tied to that shared node.
- Surprising: the colour enum's *values* are the painting recipe:
  `getColor( ledColor_t, int bright )` (`:39`) maps a colour and a brightness
  into an RGB triple, and it writes a static `m_overBright` (`:50`) as a side
  channel for brightness above 255.

### src/components/outputs/leds/ledbase.cpp
- Purpose: the shared LED behaviour: colour → forward voltage, over-current
  detection, brightness painting.
- Key abstractions: `eLed` (the engine element that models the LED's I-V
  curve).
- Data flow: `setColorStr()` (`:108-125`) maps the colour name to a *forward
  voltage* (Red 1.8 V, Green 3.5 V, Blue 3.6 V, Orange 2.0 V, Purple 3.5 V,
  White 4.0 V, Yellow 2.4 V) and pushes it into the engine with
  `eLed::setThreshold()`. `updateStep()` (`:71-92`) calls `eLed::updateBright()`,
  sets the warning/crash flags from `overCurrent()`, and, if `m_changed`,
  re-evaluates the voltage.
- Non-obvious design decisions: **the LED's colour is an electrical parameter,
  not just a paint colour** — choosing "Blue" raises the forward voltage to
  3.6 V, which changes what the circuit does. `getColor()` (`:127-151`) then
  builds the display colour from a brightness value, and any brightness above
  255 is *clamped* to 255 while the excess is stashed in the static
  `m_overBright` and re-added as a background tint (`:135-140`, `:173-174`).
- Edge cases / failure handling: `setGrounded()` (`:94-106`) **powers the
  circuit off** if the simulator is running (`:99`), then disables and hides
  pin 1 and removes its connector — a topology change is never allowed
  mid-solve.
- Surprising: `getColorList()` (`:21-24`) returns the enum list as
  `"Yellow,Red,Green,Blue,Orange,Purple,White;"` plus the *translated* names —
  the "canonical;translated" property-string format, built by hand here.

### src/components/outputs/leds/led.h
- Purpose: header for the plain LED.
- Key abstractions: `Led : public LedBase, public Linker` — an LED can be a
  link *source*.
- Data flow: declarations only.
- Non-obvious design decisions: the class adds `Linker` so the LED can report
  its current to another part.
- Edge cases / failure handling: none.
- Surprising: the LED is the only member of the LED family that is a link
  source; `LedSmd` (the surface-mount variant used inside bars, matrices and
  seven-segments) is not.

### src/components/outputs/leds/led.cpp
- Purpose: the plain LED: two pins, the diode symbol, and the current
  emission.
- Key abstractions: `LedBase` + `Linker`; the pins are created here rather than
  in the base.
- Data flow: `voltChanged()` (`:52-58`) calls `eLed::voltChanged()` and,
  **only if the engine reports convergence** (`m_converged`), emits the
  current to the linked parts (`emitLinkedValue( m_current )`, `:57`).
- Non-obvious design decisions: the emission is gated on `m_converged` (`:55`)
  — a link is fed a *converged* value, not an intermediate iterate, so a
  linked readout does not flicker through the solver's iterations.
- Edge cases / failure handling: none.
- Surprising: the LED's context menu offers "Link to Component" (`:69-70`) —
  the same entry the standalone dial offers — so the LED is a *value source*
  for other parts, and the link index is painted on the LED in blue.

### src/components/outputs/leds/ledsmd.h
- Purpose: header for the surface-mount LED, the building block of the LED
  bar, matrix and seven-segment.
- Key abstractions: `LedSmd : public LedBase` with a **constructor that takes
  the area and the two engine pins** (`:13`) — it is never registered in the
  library.
- Data flow: declarations only.
- Non-obvious design decisions: the class has **no `construct`/`libraryItem`
  statics** — it is a private building block, not a palette item. The `ePin*`
  parameters let the parent hand it pins it already owns, so the parent's
  electrical topology is not rebuilt.
- Edge cases / failure handling: none.
- Surprising: the class overrides `drawBackground`/`drawForeground` *without*
  `override` (`:17-18`) — a stylistic marker of the file's age, and it means
  the compiler would not catch a signature drift from the base.

### src/components/outputs/leds/ledsmd.cpp
- Purpose: the surface-mount LED: a 4×4 px rounded square drawn twice
  (background + foreground).
- Key abstractions: `LedBase`; the constructor creates default `ePin`s only if
  the parent did not supply them (`:18-19`).
- Data flow: `drawBackground()` (`:25-28`) and `drawForeground()` (`:30-33`)
  both draw the same rounded rectangle — the base's `paint()` calls the first
  with the background colour and the second with the lit colour, so the two
  passes are the "off" and "on" states of the same shape.
- Non-obvious design decisions: the two methods are identical apart from the
  brush the base sets; the "background/foreground" split is what lets a
  *matrix* of these be painted as one shape.
- Edge cases / failure handling: none.
- Surprising: the constructor disables the value label
  (`m_valLabel->setEnabled( false )`, `:16`) — an SMD LED inside a bar or a
  matrix must not draw its own value text.

### src/components/outputs/leds/ledbar.h
- Purpose: header for the LED bar — a vertical stack of LEDs.
- Key abstractions: `LedBar : public Component` owning a
  `std::vector<LedSmd*> m_led` (`:50`) — a *composite* of `LedSmd` children.
- Data flow: declarations only.
- Non-obvious design decisions: the class is a `Component`, **not** an
  `eResistor` — the bar is a container, and the electrical behaviour is
  entirely in the `LedSmd` children. Every electrical property of the bar is
  *delegated* to `m_led[0]` and then fanned out to all of them.
- Edge cases / failure handling: `createLeds`/`deleteLeds` (`:40-41`) are
  public so the size can change at run time.
- Surprising: the class stores `m_size` but the *real* size is
  `m_led.size()` — `m_size` is kept in step by `createLeds`/`deleteLeds`, and
  `m_size` is the property that is persisted.

### src/components/outputs/leds/ledbar.cpp
- Purpose: the LED bar: create, size and colour a stack of SMD LEDs.
- Key abstractions: `Component` + a vector of `LedSmd` children, each with
  its own pair of `Pin`s.
- Data flow: `createLeds()` (`:73-105`) creates two `Pin`s per LED and an
  `LedSmd` that *reuses* those pins, parents it to the bar, and makes it
  unselectable and mouse-transparent (`:94-97`). `setSize()` (`:135-146`)
  powers the circuit off, adds or removes LEDs, and resizes the bounding box.
  Every electrical setter (`setThreshold`, `setMaxCurrent`, `setResistance`,
  `setGrounded`, `setColorStr`) fans the value out to all the children
  (`:150-166`), and the getters read `m_led[0]` (`:148`, `:153`, `:158`,
  `:163`).
- Non-obvious design decisions: the bar is a **composite part whose children
  are real parts** — they are `QGraphicsItem` children with real pins and real
  engine elements, so the bar is not a special case in the engine at all.
  `setSize` powers the circuit off first (`:137`) because adding pins changes
  the topology.
- Edge cases / failure handling: `deleteLeds()` un-grounds the LEDs it is
  about to delete (`:112-113`) before deleting them, and deletes the pins
  through `Component::deletePin` (`:115`) so the connectors are removed
  properly. `setHidden()` (`:168-184`) also moves the children and hides the
  grounded pins.
- Surprising: `colorStr()` reads `m_led[0]` (`:124`) — with zero LEDs that
  would be out of range, but `setSize(8)` is called in the constructor (`:44`)
  so the vector is never empty in practice. The same "read element 0" pattern
  appears in `LedMatrix` and `SevenSegment`.

### src/components/outputs/leds/ledmatrix.h
- Purpose: header for the LED matrix.
- Key abstractions: `LedMatrix : public Component, public eElement` with a
  **two-dimensional** `std::vector<std::vector<LedSmd*>> m_led` (`:56`) plus
  separate row and column pin vectors.
- Data flow: declarations only.
- Non-obvious design decisions: the matrix has `m_rows + m_cols` pins
  (`src/components/outputs/leds/ledmatrix.cpp:111`) — an LED is addressed by
  the *pair* of row and column pins it sits at, so the number of connections
  is linear, not quadratic. `m_verticalPins` (`:60`) chooses whether the row
  pins are on the left or the top.
- Edge cases / failure handling: `setupMatrix`/`createMatrix`/`deleteMatrix`
  are private, but `setRows`/`setCols` are public and re-create the whole
  matrix.
- Surprising: the class is an `eElement` even though it owns no engine
  element of its own — it needs the identity so that the solver can call its
  `stamp()`.

### src/components/outputs/leds/ledmatrix.cpp
- Purpose: the LED matrix: build an N×M grid of SMD LEDs, wire each to a row
  pin and a column pin, and repaint.
- Key abstractions: `eElement` for the stamp callback; `LedSmd` children for
  the actual LEDs.
- Data flow: `stamp()` (`:78-89`) is where the topology is fixed: for every
  (row, col) it fetches the row and column `eNode`s and assigns them to the
  two pins of that LED (`:87-88`). `createMatrix()` (`:103-148`) creates the
  row pins, the `LedSmd` children and the column pins; `deleteMatrix()`
  (`:150-163`) tears them all down.
- Non-obvious design decisions: the *wiring* is done at **stamp time**, not at
  construction time — the LEDs are created in the constructor with no
  electrical connection, and the row/column `eNode`s are attached only when
  the circuit is stamped. That is what allows the matrix to be re-wired
  without rebuilding the object graph.
- Edge cases / failure handling: `setupMatrix()` powers the circuit off before
  deleting and re-creating (`:93`); `setThreshold`/`setMaxCurrent`/
  `setResistance` clamp to a floor of 1e-6 (or 1e-14 for a zero resistance,
  `:244`) and fan the value out to every cell; `setVerticalPins()` moves the
  row pins and re-issues `isMoved()` so the connectors follow (`:200-212`).
- Surprising: `setRows`/`setCols` are marked `propNoCopy` in the property
  table (`:56`, `:59`) — the matrix's dimensions are an *editor* choice and
  are not written to the circuit file, even though the pins they create are.

### src/components/outputs/leds/ledrgb.h
- Purpose: header for the RGB LED.
- Key abstractions: `LedRgb : public Component, public eElement` with three
  `eLed* m_led[3]` (`:62`) — the *engine* LEDs, not graphical children.
- Data flow: declarations only.
- Non-obvious design decisions: the class uses the **engine** `eLed` elements
  directly rather than the graphical `LedSmd`, and the four `Pin`s it creates
  are the three colours and the common terminal — the LEDs themselves have no
  pins of their own on the canvas.
- Edge cases / failure handling: `m_commonCathode` is initialised in-class to
  `true` (`:58`) — the only in-class initialiser in this shard, and it is
  there because the constructor calls `setComCathode(true)` before the pins
  exist.
- Surprising: the getters (`threshold_R()`, `maxCurrent_R()`, `res_R()`, …)
  read `m_led[0..2]` — nine accessors that exist only so the property system
  can bind to them.

### src/components/outputs/leds/ledrgb.cpp
- Purpose: the RGB LED: three diodes with a common (or separate) cathode and a
  per-colour brightness.
- Key abstractions: three `eLed` engine elements; four pins.
- Data flow: `stamp()` (`:104-118`) wires each LED's two pins to the colour
  pin and the common pin, **swapping them depending on `m_commonCathode`**
  (`:112-117`). `updateStep()` (`:120-137`) reads each LED's brightness,
  accumulates the warning/crash flags with `|=`, and repaints only when
  something changed (`:134-136`).
- Non-obvious design decisions: the common-cathode/common-anode choice is
  implemented by **swapping the two pins of each LED at stamp time** rather
  than by changing the model — one code path serves both parts. Changing the
  mode powers the circuit off (`:141`) because it changes the topology.
- Edge cases / failure handling: every threshold/current/resistance setter
  clamps (`1e-6`, and a zero resistance becomes 1e-14) and forwards to the
  right `m_led[i]`; the brightness is clamped to 255 (`:133`).
- Surprising: `updateStep()` reads the brightness **before** calling
  `updateBright()` (`:128-129`) — the value used for change-detection is one
  frame stale, so the repaint lags the model by one update. The paint code
  also draws the LED as a *rounded rectangle body plus an ellipse* (`:235`,
  `:241`) rather than the diode symbol the plain LED uses.

### src/components/outputs/leds/max72xx_matrix.h
- Purpose: header for the MAX72xx LED driver matrix.
- Key abstractions: `Max72xx_matrix : public LogicComponent` with a 16×8
  `m_ram` (`:43`), a per-display intensity array, and decode-mode, scan-limit,
  shutdown and test flags — i.e. a **model of the chip's register set**, not a
  model of the LEDs.
- Data flow: declarations only.
- Non-obvious design decisions: the part is a `LogicComponent` (so it has a
  clock pin and the logic-family machinery) but has **no output pins at all** —
  it drives a display directly by painting its own RAM.
- Edge cases / failure handling: none.
- Surprising: the class stores the register state in *exactly* the shape the
  real chip uses (16 digits × 8 rows, a 16-entry intensity array), so the
  emulation is faithful enough that a student's firmware sequence can be tried
  against it.

### src/components/outputs/leds/max72xx_matrix.cpp
- Purpose: the MAX72xx matrix: an SPI slave that decodes the chip's command
  set and paints the resulting matrix.
- Key abstractions: `eClockedDevice` for the SPI clock; the command decoder in
  `proccessCommand()`.
- Data flow: `voltChanged()` (`:109-133`) updates the clock, resets the
  receive register when CS is high (`:113-119`), and on a **rising** clock edge
  shifts the DIN bit into `m_rxReg` (`:122-123`); every 16 bits it calls
  `proccessCommand()` (`:125-129`). `proccessCommand()` (`:137-170`) decodes the
  register address (`(m_rxReg>>8) & 0x0F`) and dispatches to digit RAM, decode
  mode, intensity, scan limit, shutdown or display test.
- Non-obvious design decisions: the chip is **shift-register based**: the
  16-bit word is read MSB-first into `m_rxReg` and the address is the *high*
  byte (`:141`) — the same wire protocol as the real part, so a student's
  `sendByte()` sequence works. The display is *not* multiplexed in simulation:
  the whole matrix is painted from RAM every frame (`:220-238`) rather than
  scanned.
- Edge cases / failure handling: `m_inDisplay >= 16` aborts the command
  (`:139`); the paint honours the shutdown flag, the test flag, the decode mode
  and the scan limit exactly (`:227`), so a display the firmware has put into
  "test" mode lights every LED, as the real chip would.
- Surprising: `setNumDisplays()` changes the *width* of the symbol but not the
  number of RAM digits (`m_ram` is always 16×8) — the extra digits are simply
  not painted.

### src/components/outputs/leds/sevensegment.h
- Purpose: header for the seven-segment display.
- Key abstractions: `SevenSegment : public Component, public eElement` with
  per-display common pins (`m_commonPin`), per-segment anode/cathode `ePin`s
  and `LedSmd m_segment` (`:63-66`).
- Data flow: declarations only.
- Non-obvious design decisions: the class keeps **two** `ePin` vectors plus a
  `LedSmd` vector per segment (`:64-66`) — the segment's anode and cathode
  are tracked separately from the graphical LED because the common-cathode /
  common-anode choice swaps them.
- Edge cases / failure handling: `createDisplay`/`deleteDisplay`/`resizeData`
  (`:51-53`) are private, but `setNumDisplays` is public and rebuilds the
  display.
- Surprising: the eight segment inputs are the **same eight pins for every
  digit** (a multiplexed display) — the class has only 8 segment pins plus one
  common pin *per digit* (`:161`), and the multiplexing itself is not
  simulated.

### src/components/outputs/leds/sevensegment.cpp
- Purpose: the seven-segment display: build N digits, wire the segments, and
  paint them.
- Key abstractions: `eElement` for the stamp; `LedSmd` children for the
  segments.
- Data flow: `stamp()` (`:101-119`) fetches the eight segment `eNode`s and,
  for each digit, assigns the common pin's node to either the cathode or the
  anode of every segment according to `m_commonCathode` (`:112-118`).
  `createDisplay()` (`:237-281`) creates the common pin and the eight segment
  LEDs, each positioned and rotated to draw the "a"…"g" bars and the dot.
- Non-obvious design decisions: the segment geometry is *hard-coded* as
  positions and rotations (`:269-280`) — a hand-drawn 7-segment glyph, with a
  96° rotation on the diagonal segments. The common pin's label is `"|"` for
  common cathode and `"+"` for common anode (`:172`, `:242`).
- Edge cases / failure handling: `setNumDisplays` powers the circuit off before
  rebuilding (`:139`); `setResistance`/`setThreshold`/`setMaxCurrent` clamp
  out-of-range values *back to the default* rather than to the limit (`:212`,
  `:219`, `:226`) — a resistance below 1e-6 becomes 1 Ω, a threshold below 1e-6
  becomes 2.4 V, a current below 1e-6 becomes 20 mA.
- Surprising: `m_pin.resize(8+displays)` (`:161`) — the pin vector holds the
  eight segment pins *plus* one common pin per digit — and the segment pins are
  shared across digits, so the part has far fewer pins than it has segments.

### src/components/outputs/leds/ws2812.h
- Purpose: header for the WS2812 (NeoPixel) addressable RGB LED.
- Key abstractions: `WS2812 : public Component, public eClockedDevice` with a
  bit-level decoder (`m_state`, `m_word`, `m_byte`, `m_bit`, `m_data`) and the
  four WS2812B timing constants `m_RES`, `m_T0H`, `m_T0L`, `m_T1H`, `m_T1L`
  (`:64-68`).
- Data flow: declarations only.
- Non-obvious design decisions: the class models the **wire protocol**, not
  the LED: it measures the *high time* of the incoming signal to decide
  whether a bit was a 0 or a 1, using the real WS2812B timings with a ±150 ns
  tolerance window.
- Edge cases / failure handling: the timing constants are exposed as
  properties, so a student can teach the part a different family's timings.
- Surprising: `m_RES` is the reset-pulse duration in **microseconds** while
  the four timing constants are in **nanoseconds** (`:39-43`) — two different
  units for two different kinds of time in the same struct.

### src/components/outputs/leds/ws2812.cpp
- Purpose: the WS2812: decode the serial RGB stream and light the pixels.
- Key abstractions: `eClockedDevice` for the clock edge detection; `m_rgb[3]`
  and `m_led` (a `QVector<QColor>`) for the decoded colours.
- Data flow: `voltChanged()` (`:97-136`) measures the time since the last edge
  and classifies it: a gap longer than the reset pulse resets the decoder
  (`:107-113`); a low time inside the valid window is a candidate bit
  (`:114-121`); a high time inside the valid window decides whether the
  previous bit was 1 or 0 (`:127-130`). `saveBit()` (`:144-160`) assembles the
  bits into bytes and, after three bytes, into an RGB colour:
  `m_led[ m_word ] = QColor( m_rgb[1], m_rgb[0], m_rgb[2] )` (`:157`).
- Non-obvious design decisions: the decoder measures the **low time** to
  identify a bit's value and the **high time** to confirm it — the bit is only
  committed on the *next* rising edge (`:119-120`, `:132-135`), and the last
  byte's low time is explicitly allowed to be anything (`:132-135`). The
  ±150 ns tolerance is baked into every comparison (`:114`, `:119-120`, `:127`).
- Edge cases / failure handling: the reset pulse clears the word/byte/bit
  counters (`:108-113`); `m_leds` is `m_rows*m_cols` and `updateLeds()`
  resizes the colour vector (`:178-185`).
- Surprising: the colour byte order is **GRB**, not RGB —
  `QColor(m_rgb[1], m_rgb[0], m_rgb[2])` (`:157`) — because the WS2812
  transmits green first, and a model that got this wrong would show every
  colour wrong in a way that is hard to diagnose.

### src/components/outputs/motors/dcmotor.h
- Purpose: header for the DC motor.
- Key abstractions: `DcMotor : public LinkerComponent, public eResistor, public
  Watched` — three bases: the canvas + link source, the electrical load, and
  the *watcher* (the live monitor window).
- Data flow: declarations only.
- Non-obvious design decisions: the class implements `getDblReg(QString)`
  (`:38`) — the `Watched` interface that exposes named live registers to the
  monitor window.
- Edge cases / failure handling: none.
- Surprising: the motor is an `eResistor` — the electrical model is *just* a
  resistance; everything else (speed, angle, direction) is a kinematic
  integration of the applied voltage over simulated time.

### src/components/outputs/motors/dcmotor.cpp
- Purpose: the DC motor: turn the applied voltage into a speed and an angle,
  and publish them.
- Key abstractions: `eResistor` for the winding resistance; `LinkerComponent`
  for the angle output; `Watched` for the monitor.
- Data flow: `updatePos()` (`:138-147`) accumulates the *integral* of the
  normalised voltage over the elapsed simulation time
  (`m_delta += (m_LastVolt/m_voltNom)*(duration/1e12)`, `:145`) — that
  integral is the shaft angle. `updateStep()` (`:112-134`) divides the delta by
  the elapsed time to get the speed (`:116`), advances the angle by
  `m_motStPs * m_delta` (`:118`) and publishes the angle as a 0–1000 value to
  the linked parts (`:121-128`).
- Non-obvious design decisions: the motor has **no inertia and no load**: the
  angle is the exact integral of the voltage and the speed is that integral's
  rate. The angle is kept in units of 1/16 of a turn
  (`remainder( m_ang, 16.0*360.0 )`, `:119`) so the published 0–1000 value has
  1/5760-turn resolution.
- Edge cases / failure handling: the *over-speed* case is painted, not clamped:
  the speed is clamped to ±1 for the green arc and the excess is drawn in a
  second, orange arc (`:221-239`), so a motor driven past its nominal speed
  *looks* overloaded. `getPropStr("speed")` (`:83-90`) exposes the speed as a
  property string "to be called from scripts", and returns `-m_speed` so that
  1 means 100% and the sign follows the rotation convention.
- Surprising: the class explicitly supports a scripting surface —
  `getPropStr` carries a comment naming scripts (`:85`) and `getDblReg`
  publishes Voltage/Current/Speed to the monitor window (`:178-185`). This is
  the closest thing in the shard to an embedded-code API.

### src/components/outputs/motors/servo.h
- Purpose: header for the RC servo motor.
- Key abstractions: `Servo : public LogicComponent` with a position model
  (`m_pos`, `m_targetPos`) and a speed limit (`m_speed`).
- Data flow: declarations only.
- Non-obvious design decisions: the servo is modelled as a **position
  controller with a slew rate**: `m_pos` chases `m_targetPos` at a limited
  angular speed (`src/components/outputs/motors/servo.cpp:95-105`), which is
  what a real servo does and what makes the "Speed" property meaningful.
- Edge cases / failure handling: none.
- Surprising: the class has no electrical model at all beyond the
  `LogicComponent` pins — the servo draws current from the same pins it
  listens to on, and the position is derived purely from the pulse width.

### src/components/outputs/motors/servo.cpp
- Purpose: the RC servo: measure the pulse width on the signal pin, map it to
  an angle, and slew the horn towards it.
- Key abstractions: `LogicComponent` (so the signal pin is a real `IoPin` with
  a threshold); `eClockedDevice` for the clock edges.
- Data flow: `voltChanged()` (`:110-136`) records the rising edge as the
  pulse start (`:121-124`) and, on the falling edge, maps the elapsed
  microseconds onto 0–180°
  (`(steps-m_minPulse)*180/(m_maxPulse-m_minPulse)`, `:130`) and clamps it
  (`:132-133`). `updateStep()` (`:91-108`) moves `m_pos` towards `m_targetPos`
  by at most `updateTime/m_speed*60` degrees (`:97-102`).
- Non-obvious design decisions: the pulse width is measured in **microseconds**
  (`circTime()/1e6`, `:114`) and the mapping formula divides by
  `m_maxPulse-m_minPulse` in microseconds (`:130`) — the property's unit and
  the model's unit agree, but the conversion is done in three separate places.
  The default range is 1000–2000 µs (`:41-42`), the standard RC servo range.
- Edge cases / failure handling: if the power pins are not both high, the
  target snaps back to 90° and the pulse start is cleared (`:116-120`) — a
  servo with no power returns to centre. A pulse start of 0 is treated as "no
  pulse" and ignored (`:127`).
- Surprising: the part's `init()` call declares **three** pins in a compact
  string DSL — `"IL01 V+", "IL03 Gnd", "IL05 Sig"` (`:44-48`) — where `I` =
  input, `L` = left side, `01`/`03`/`05` = the row, and the rest is the label.
  The label `Sig` on the *third* pin becomes the clock pin (`:52`).

### src/components/outputs/motors/stepper.h
- Purpose: header for the stepper motor.
- Key abstractions: `Stepper : public LinkerComponent, public eElement` with
  **four `eResistor` windings and four `ePin`s held by value** (`:50-64`).
- Data flow: declarations only.
- Non-obvious design decisions: the four coils are `eResistor` members
  (`:50-53`) and the pins are `Pin` members (`:55-59`) — both held **by
  value** rather than by pointer, so the object graph is flat and the
  member-initializer list in the .cpp wires them (`:36-48`).
- Edge cases / failure handling: none.
- Surprising: the class holds *two* `ePin`s per winding (`:61-64`) — one for
  the winding terminal and one for the common terminal — because a stepper's
  coils are driven differentially between two terminals each.

### src/components/outputs/motors/stepper.cpp
- Purpose: the stepper motor: decode the two phase currents into a rotor
  position and drive four windings.
- Key abstractions: four `eResistor` windings; `eElement` for the stamp.
- Data flow: `stamp()` (`:100-115`) binds the four winding `ePin`s to the
  common pin's `eNode` and registers the change callbacks. `voltChanged()`
  (`:135-177`) computes the two phase differences relative to the common
  terminal (`:138-139`), quantises each to −1/0/+1 (`:141-147`), and then —
  with the honest comment "nosense algoritm.. just works" (`:150`) — maps the
  phase pair to one of eight rotor positions (`:152-158`), computes the
  shortest-path delta and advances `m_ang` by `delta*m_stpang` (`:160-171`).
- Non-obvious design decisions: the position decoding is a hand-written lookup
  with an explicit admission that it is not a principled algorithm (`:150`).
  The "shortest path" wrap-around (`:161-162`) makes the rotor move the short
  way round, which is what a real stepper does. When there is no input at all,
  the rotor is snapped back to a *full* step position (`:166-170`) so it does
  not stay parked in a half-step.
- Edge cases / failure handling: `setSteps()` rounds the step count to a
  multiple of four and adds a remainder of 4 if the count increased and was
  not a multiple of four (`:179-190`) — an odd request is coerced rather than
  rejected. `setResistance()` clamps to 1e-12 (`:194`). `setBipolar()` removes
  the common pin's connector and hides it (`:203-204`).
- Surprising: the motor is *not* driven by a step pulse train — it is driven
  by the **analogue voltages on the four winding terminals**, with the phase
  differences quantised to three levels. The "steps per rotation" property
  therefore sets the *angle per step*, not the number of steps the circuit
  takes.

### src/components/outputs/displays/aip31068_i2c.h
- Purpose: header for the AIP31068 character LCD, I²C variant.
- Key abstractions: `Aip31068_i2c : public Hd44780_Base, public TwiModule` —
  the LCD's own model plus the I²C slave protocol.
- Data flow: declarations only.
- Non-obvious design decisions: the class is a `TwiModule` (the I²C slave
  engine base) *and* a `Hd44780_Base` — the character-LCD behaviour is written
  once and the I²C variant only supplies the transport.
- Edge cases / failure handling: none.
- Surprising: the class has its own `m_controlByte` and `m_phase` (`:34-35`)
  because the I²C protocol puts a **control byte before every data byte**,
  unlike the parallel HD44780 which has an RS pin.

### src/components/outputs/displays/aip31068_i2c.cpp
- Purpose: the AIP31068 over I²C: read the control byte, then route each byte
  to the LCD's data or command path.
- Key abstractions: `TwiModule` (the I²C slave) + `Hd44780_Base` (the LCD
  model).
- Data flow: `readByte()` (`:93-110`) is the I²C callback: phase 0 captures the
  control byte (`:95-99`), phase 1 reads the data byte and dispatches on the
  control byte's RS bit — `writeData(data)` or `proccessCommand(data)`
  (`:100-108`). `voltChanged()` (`:85-89`) resets the phase to 3 (idle) on an
  I²C STOP.
- Non-obvious design decisions: the phase machine is a **three-state protocol
  decoder** (0 = control byte, 1 = data byte, 3 = idle) that is reset by the
  I²C STOP condition (`:88`) rather than by a timeout — so a truncated
  transaction leaves the LCD in a defined state.
- Edge cases / failure handling: `startWrite()` sets the phase to 0 (`:91`); the
  address is fixed at 0x3E (`:34`) and the frequency is a property (`:62-63`).
- Surprising: the SDA and SCL pins are created as `openCo` (open-collector)
  I²C pins (`:38`, `:43`) — the correct electrical model for I²C, and a detail
  the student would otherwise have to add by hand.

### src/components/outputs/displays/gc9a01a.h
- Purpose: header for the GC9A01A round TFT display.
- Key abstractions: `GC9A01A : public St77xx` with an overridden
  `setHeight()`.
- Data flow: declarations only.
- Non-obvious design decisions: the class overrides `setHeight` (`:18`) to
  force a **square** display — the panel is physically round.
- Edge cases / failure handling: none.
- Surprising: the header keeps a commented-out `endTransaction()` override
  (`:20`) and a commented-out `displayReset()` (`:28`) — the class was forked
  from a variant and the dead code was left in the header.

### src/components/outputs/displays/gc9a01a.cpp
- Purpose: the GC9A01A: a round TFT with a square panel and its own paint
  routine.
- Key abstractions: `St77xx` (the SPI transport and the command set) +
  `TftController` (the frame buffer).
- Data flow: `paint()` (`:109-137`) draws a rounded body, a circular screen
  outline, and — when the display is on — the frame buffer scaled into a
  **circular brush** (`:126-132`). The frame buffer itself is produced by
  `printImage()`.
- Non-obvious design decisions: the picture is clipped to a circle by using a
  scaled `QBrush` as the fill of the ellipse (`:126-132`) rather than by
  drawing an image and masking it — a neat trick that gets a round screen with
  one painter operation. The width property is *removed* from the part
  (`remProperty("Width")`, `:42`) because the panel is square.
- Edge cases / failure handling: `setHeight()` (`:97-107`) ignores the
  requested width and always sets a square display.
- Surprising: the file keeps ~50 lines of the display's own command table
  commented out (`:46-95`) — the GC9A01A's command set was never implemented,
  so the part relies entirely on the generic ST77xx command handling. That is
  a real functional gap, not a stylistic choice.

### src/components/outputs/displays/hd44780_base.h
- Purpose: header for the HD44780 character-LCD model, transport-independent.
- Key abstractions: `Hd44780_Base : public Component` holding the two LCD
  memories (`m_DDram[80]`, `m_CGram[64]`), the font image (`m_fontImg`) and
  the command state.
- Data flow: declarations only.
- Non-obvious design decisions: the class holds **two** memories — 80
  characters of DDRAM and 64 bytes of CGRAM (the eight user-definable glyphs)
  (`:45-46`) — and the *character set* is a bitmap image loaded from
  `":font2.png"` in the constructor
  (`src/components/outputs/displays/hd44780_base.cpp:15`), so a glyph is a
  10×16 pixel crop, not a font.
- Edge cases / failure handling: none.
- Surprising: the base class is a `Component` but **not** an `eElement` — the
  parallel and I²C variants each add their own engine identity, so the LCD
  *model* is shared while the *transport* is not.

### src/components/outputs/displays/hd44780_base.cpp
- Purpose: the HD44780's character-LCD model: command decoding, DDRAM/CGRAM
  writes, and the LCD rendering.
- Key abstractions: the `QImage m_fontImg` sprite sheet and the DDRAM/CGRAM
  arrays.
- Data flow: `proccessCommand()` (`:81-93`) decodes the command by **testing
  bits from the top down** — `command & 128` → set DDRAM address, `& 64` → set
  CGRAM address, `& 32` → function set, and so on down to `& 1` → clear
  display. `writeData()` (`:56-79`) writes to DDRAM or CGRAM depending on
  `m_writeDDRAM`, advancing the address and the display shift. `paint()`
  (`:211-303`) walks the rows and columns, maps each cell to a DDRAM position
  (`:237-251`), and draws either the font glyph, a CGRAM glyph, a blinking
  cursor or the cursor underline.
- Non-obvious design decisions: the command decoder is a **priority chain on
  the bit pattern** rather than a switch on the whole byte — the HD44780's
  commands are not a contiguous range, so the highest set bit identifies the
  command. Each branch carries the datasheet's timing note ("37 μs",
  "1.52 ms") as a trailing comment (`:85-92`), which is documentation *in the
  code* rather than a link to a datasheet.
- Edge cases / failure handling: the DDRAM address wraps at 79 in both
  directions (`:63-64`); the 40-column mode remaps addresses above 63 with
  `addr -= 24` (`:169`) — the HD44780's odd address layout. The cursor blink
  is driven by the *simulation* clock (409.6 ms period, `:226-231`), so it
  blinks in simulated time and freezes when the simulation stops.
- Surprising: the cursor underline is drawn by hand — a 2-pixel-wide,
  2-pixel-tall block at the bottom-right of the cell, painted with `setPixel`
  four times per column (`:268-274`) — because the font sheet has no
  underline glyph. The CGRAM glyphs are likewise assembled bit by bit from the
  user's 8-byte definitions (`:282-296`).

### src/components/outputs/displays/hd44780.h
- Purpose: header for the parallel HD44780 LCD.
- Key abstractions: `Hd44780 : public Hd44780_Base, public eElement` with
  `IoPin`s for RS, RW, En and eight data pins.
- Data flow: declarations only.
- Non-obvious design decisions: `readData()` and `readBusy()` are declared
  (`:31-32`) but their bodies are **empty**
  (`src/components/outputs/displays/hd44780.cpp:128-136`) — the read path of
  the LCD is not implemented, so a student cannot read the display back.
- Edge cases / failure handling: none.
- Surprising: the base class already declares `m_pinRS`, `m_pinRW`, `m_pinEN`
  and `m_dataPin` as `Pin*`/vectors
  (`src/components/outputs/displays/hd44780_base.h:75-78`), and the derived
  class declares them **again** as `IoPin*` (`:35-38`) — the derived members
  shadow the base ones, and the base's `showPins()` would therefore operate on
  null pointers if it were ever called on this class. It is overridden
  (`:146-153`), so it does not crash — but the shadowing is a real trap.

### src/components/outputs/displays/hd44780.cpp
- Purpose: the parallel HD44780: sample the data bus on the falling edge of
  Enable and drive the LCD.
- Key abstractions: `IoPin`s for RS, RW, En and D0–D7; `eElement` for the
  engine identity.
- Data flow: `voltChanged()` (`:78-126`) is the whole protocol: it detects the
  **falling edge of En** (`:80-87`), samples the data pins into `m_input` in
  8-bit or 4-bit mode (`:89-114`), and then dispatches on RW and RS — read or
  write, data or command (`:116-125`).
- Non-obvious design decisions: the 4-bit mode is handled by **latching the
  high nibble on one Enable pulse and the low nibble on the next**
  (`:98-113`) — the standard HD44780 handshake, implemented with a `m_nibble`
  toggle rather than a state machine. The data pins are declared as `input`
  mode with a 100 kΩ pull-up (`:142`) so an unconnected bus floats high,
  exactly as on real hardware.
- Edge cases / failure handling: the RW (read) branch calls
  `readData()`/`readBusy()`, which are **empty stubs** (`:128-136`) — so a read
  request is silently accepted and the bus is never driven. `m_lastClock`
  (`:80-87`) ensures the action happens once per Enable pulse.
- Surprising: the pin *labels* are `RS`, `RW`, `En` and `D0`…`D7` (`:39`,
  `:42`, `:45`, `:53`) but the *pin ids* in the file are `-PinRS`, `-PinRW`,
  `-PinEn` and `-dataPin0`… (`:38-52`) — the ids are the file-format
  contract, the labels are the drawing.

### src/components/outputs/displays/ili9341.h
- Purpose: header for the ILI9341 TFT.
- Key abstractions: `Ili9341 : public St77xx` overriding `setPixelMode()` and
  `writeRam()`.
- Data flow: declarations only.
- Non-obvious design decisions: the class overrides exactly the two methods
  that differ between TFT controllers — the pixel format and the RAM write —
  and inherits everything else.
- Edge cases / failure handling: none.
- Surprising: none.

### src/components/outputs/displays/ili9341.cpp
- Purpose: the ILI9341: a 16/18-bit TFT that packs two or three bytes per
  pixel.
- Key abstractions: `St77xx` (transport) + `TftController` (frame buffer).
- Data flow: `writeRam()` (`:42-68`) accumulates bytes into `m_data`
  (`m_data = (m_data<<8) | m_rxReg`, `:44`) and, when `m_dataBytes` bytes have
  arrived, unpacks the 16-bit (`:52-57`) or 18-bit (`:58-63`) pixel format
  into 0xRRGGBB and calls `TftController::writeRam()`.
- Non-obvious design decisions: the 16-bit format is **RGB565** and the 18-bit
  is **RGB666**, and the unpacking is done with explicit bit masks and shifts
  (`:54-56`, `:60-62`) rather than with a colour class — the code is a direct
  transcription of the datasheet's bit layout. `m_bgrInverted = true` (`:27`)
  tells the base to swap red and blue when reading the frame buffer.
- Edge cases / failure handling: `setPixelMode()` (`:70-74`) reads bit 4 of the
  COLMOD byte: set → 2 bytes (16-bit), clear → 3 bytes (18-bit).
- Surprising: the constructor **renames three pins for backwards
  compatibility** — `m_pinRS.setId( id+"-PinRst" )`,
  `m_pinDI.setId( id+"-PinMosi" )`, `m_pinCK.setId( id+"-PinSck" )` (`:29-31`)
  with the comment "Compatibility with older versions". The part's electrical
  pins have had different names in different releases of the file format, and
  the ids are pinned to the old names so old circuits still load.

### src/components/outputs/displays/ks0108.h
- Purpose: header for the KS0108 (graphic LCD) component.
- Key abstractions: `Ks0108 : public Component, public eElement` with a
  `unsigned char m_aDispRam[8][128]` (`:47`) — an 8×128 frame buffer, i.e. two
  64×64 halves.
- Data flow: declarations only.
- Non-obvious design decisions: the part has **two independent halves**, each
  with its own address pair (`m_addrX1/m_addrY1` and `m_addrX2/m_addrY2`) and
  its own chip-select (`:50-57`), matching the real KS0108's two-controller
  architecture.
- Edge cases / failure handling: `m_csActLow` (`:56`) selects the polarity of
  the chip-select lines, because real KS0108 boards are wired both ways.
- Surprising: the class holds its six control pins **by value**
  (`Pin m_pinRst; Pin m_pinCs2; …`, `:65-70`) while the eight data pins are
  `IoPin*` pointers (`:72`) — because the data pins change their *mode*
  between input and output, and the control pins never do.

### src/components/outputs/displays/ks0108.cpp
- Purpose: the KS0108 graphic LCD: a parallel 6800-style bus with two
  chip-selects.
- Key abstractions: `eElement` for the stamp; the two-halves address model.
- Data flow: `voltChanged()` (`:105-156`) does everything: it handles the reset
  pin (`:107-108`), **switches the data pins' direction between input and
  output according to RW** (`:110-118`), detects the clock edges — reads on the
  rising edge, writes on the falling edge (`:119-131`), samples the data bus
  for a write (`:132-137`), resolves the two chip-selects (`:138-145`) and
  finally dispatches to data or command (`:147-156`).
- Non-obvious design decisions: the data pins are **re-configured as the bus
  direction changes** (`:114-118`) — the part physically drives the bus when
  reading and releases it when writing, which is the correct 6800-bus
  behaviour and is why the pins are `IoPin`s and not plain `Pin`s. The "read
  on rising edge, write on falling edge" split (`:121-127`) is a non-obvious
  but faithful detail of the 6800 bus.
- Edge cases / failure handling: `if( !m_Cs1 & !m_Cs2 ) m_Cs2 = true;` (`:140`)
  — a bitwise `&` on two bools where `&&` was clearly meant; the effect is the
  same for 0/1 bools, but it is a latent bug if the values ever become
  non-0/1. Writes are refused while the part is in reset (`:149`).
- Surprising: the command decoder is a **range comparison chain** rather than
  a bit test (`:190-195`): `command < 62` → invalid, `< 64` → display on/off,
  `< 128` → set Y address, `< 184` → invalid, `< 192` → set X address, else →
  set display start line. The two "invalid" windows are the KS0108's reserved
  encodings.

### src/components/outputs/displays/oledcontroller.h
- Purpose: header for the generic I²C OLED controller.
- Key abstractions: `OledController : public Component, public TwiModule` with
  the addressing-mode constants as `#define`s (`:13-16`), a
  `std::vector<std::vector<uint8_t>> m_DDRAM` (`:112`) and the whole
  SSD1306-style register set (address window, scroll state, display flags).
- Data flow: declarations only.
- Non-obvious design decisions: the **addressing mode is a bitmask, not an
  enum** — `HORI_ADDR_MODE 0`, `VERT_ADDR_MODE 1`, `PAGE_ADDR_MODE 2`,
  `COLU_ADDR_MODE 3` (`:13-16`) — and the code tests it with
  `m_addrMode & VERT_ADDR_MODE`
  (`src/components/outputs/displays/oledcontroller.cpp:186`) and
  `m_addrMode != HORI_ADDR_MODE` (`:199`). That bitwise test only works
  because the modes are 0, 1, 2, 3 — i.e. the "vertical" bit is bit 0 and
  "page" is bit 1.
- Edge cases / failure handling: none.
- Surprising: the class is a `Component` and not an `eElement`; the
  `TwiModule` base provides the engine identity and the I²C slave state
  machine.

### src/components/outputs/displays/oledcontroller.cpp
- Purpose: the generic OLED: the I²C byte protocol, the DDRAM, the scroll
  engine and the renderer.
- Key abstractions: `TwiModule` (the I²C slave) + the frame buffer.
- Data flow: `readByte()` (`:161-180`) is the I²C callback: the first byte
  after a write is the **control byte** (`:165-174`) whose Co and D bits
  select "more bytes follow" and "this is data"; subsequent bytes go to
  `writeData()` (data) or `proccessCommand()` (command) or `parameter()`
  (command parameters). `writeData()` (`:182-204`) stores the byte in the
  DDRAM and advances the address according to the addressing mode.
  `updateStep()` (`:58-118`) implements the scrolling — a horizontal shift of
  the rows, plus a vertical scroll implemented by shifting a whole column
  through a 64-bit word (`:94-117`).
- Non-obvious design decisions: the **control byte is parsed with explicit
  masks** (`m_rxReg & 0b00111111` for the check, `& 0b10000000` for Co,
  `& 0b01000000` for D, `:168-173`) — the SSD1306's I²C control byte. The
  `m_start` flag distinguishes "the next byte is a control byte" from "the
  next byte is data" and is re-armed from the Co bit (`:179`).
- Edge cases / failure handling: the scroll only advances when the simulator is
  running and not paused (`:62`), and the "single column scroll" mode advances
  one step regardless of the step count (`:64-65`). The vertical scroll packs a
  column into a `uint64_t`, shifts it by `m_vScrollOffset` bits and writes it
  back byte by byte (`:98-116`) — the column height is capped at 64 bits.
- Surprising: the renderer draws the panel at **3× resolution** into a
  `QImage` and then scales it down (`:284-338`), and it does the whole thing
  *manually* — including the "bits spread over two bytes" case when a row
  starts mid-byte (`:306-310`) and the display-offset / scan-inversion /
  segment-remap transforms (`:293-329`). The 3× supersampling is what makes a
  128×64 OLED legible on a zoomed-out canvas.

### src/components/outputs/displays/pcd8544.h
- Purpose: header for the PCD8544 (Nokia 5110) graphic LCD.
- Key abstractions: `Pcd8544 : public Component, public eElement` with a
  `unsigned char m_aDispRam[6][84]` (`:46`) — an 84×48 frame buffer — and the
  controller's mode flags (`m_bPD`, `m_bV`, `m_bH`, `m_bD`, `m_bE`).
- Data flow: declarations only.
- Non-obvious design decisions: the file carries its **attribution in the
  header comment** (`:5-14`) — "Based on: C++ Interface: pcd8544 … Author:
  Roland Elek, (C) 2010" — so the provenance of the port is recorded in the
  source.
- Edge cases / failure handling: none.
- Surprising: the five controller flags are named after the PCD8544's
  datasheet bits — `PD` (power-down), `V` (vertical addressing), `H` (extended
  instruction set), `D` (display on), `E` (all segments on) — so the code
  reads like the datasheet.

### src/components/outputs/displays/pcd8544.cpp
- Purpose: the PCD8544: an SPI graphic LCD with a bit-serial command protocol.
- Key abstractions: `eElement` for the stamp; a byte-at-a-time serial decoder.
- Data flow: `voltChanged()` (`:90-161`) handles reset (`:92-96`),
  chip-select (`:97-102`), and then **shifts in one bit per rising clock
  edge** (`:111-113`), incrementing `m_inBit`; after eight bits the byte is
  complete and is interpreted as data (if DC is high, `:117-122`) or as a
  command (`:123-156`).
- Non-obvious design decisions: the byte is assembled **LSB-first**
  (`m_cinBuf &= ~1; if( DIN > 1.6 ) m_cinBuf |= 1;` then `m_cinBuf <<= 1`,
  `:111-113`, `:159`), which is the PCD8544's actual wire order. The command
  decoder recognises the *function set* (0x20), the *display control* (0x08) and
  the *address* commands (0x40 / 0x80) by masking (`:127-155`).
- Edge cases / failure handling: the extended instruction set is explicitly
  **not implemented** — the code comments that "None implemented yet - are they
  relevant at all?" (`:135-138`) and falls through, so contrast and temperature
  settings are ignored. The address setters reject out-of-range values
  (`addrY < 6`, `addrX < 84`, `:150`, `:155`).
- Surprising: the four display modes are painted as **four different flat
  fills** rather than as a frame buffer (`:208-210`): power-down and blank are
  the background colour, "all segments on" is solid black, and only the normal
  mode renders the RAM. A student sees the power-down mode as a blank screen,
  exactly like the real part.

### src/components/outputs/displays/pcf8833.h
- Purpose: header for the PCF8833 TFT.
- Key abstractions: `PCF8833 : public TftController, public Spi3Pins` — the
  frame buffer plus a 4-wire SPI transport.
- Data flow: declarations only.
- Non-obvious design decisions: the class inherits the *transport* from a
  separate mix-in (`Spi3Pins`) rather than composing it — the same pattern
  `St77xx` uses with `Spi5Pins`.
- Edge cases / failure handling: none.
- Surprising: the PCF8833 needs only RS/CS/DI/CK (no DC) — the "data vs
  command" bit is the *first* bit of each byte, which is why `Spi3Pins`
  captures `m_isData = bitIn` on the first bit of the byte
  (`src/components/outputs/displays/spi3pins.cpp:70`).

### src/components/outputs/displays/pcf8833.cpp
- Purpose: the PCF8833: a 132×132 TFT with three pixel formats.
- Key abstractions: `TftController` (frame buffer) + `Spi3Pins` (SPI).
- Data flow: `endTransaction()` (`:67-73`) takes the assembled byte and
  dispatches it to `dataReceived()` or `commandReceived()` depending on the
  first bit. `writeRam()` (`:85-142`) unpacks the pixel according to
  `m_dataBytes` — 3/3/3, 5/6/5 or 4/4/4 — and calls
  `TftController::writeRam()` at the right moment.
- Non-obvious design decisions: the **3/3/3 format is 3 bits per colour in 8
  bits total**, and the unpacking is done with explicit shifts and masks per
  format (`:93-141`) — the 5/6/5 format needs a *carry* between two bytes
  (`m_data` keeps the green channel while the red channel arrives in the next
  byte, `:105-116`), and the 4/4/4 format needs a *two-pixel* buffer
  (`m_colorData` holds the red channel for the next pixel, `:122-131`).
- Edge cases / failure handling: `m_dataIndex` cycles 1..m_dataBytes so the
  code knows which byte of a multi-byte pixel it is (`:87-88`).
- Surprising: the class reuses `TftController`'s `m_data` and `m_colorData`
  fields as scratch space for the format conversion (`:97`, `:122`) — the
  base's "pixel value" is a temporary in the derived class, which is confusing
  but avoids a second buffer.

### src/components/outputs/displays/sh1107.h
- Purpose: header for the SH1107 OLED.
- Key abstractions: `Sh1107 : public OledController` with an `m_xOffset` flag.
- Data flow: declarations only.
- Non-obvious design decisions: the SH1107's RAM is 132 columns wide but the
  visible area is 128, so the class carries an **X offset** flag (`:21-22`,
  `:29`).
- Edge cases / failure handling: none.
- Surprising: the class overrides `writeData()` (`:27`) — a write-path
  override — so the offset is applied on every byte written, not at paint
  time.

### src/components/outputs/displays/sh1107.cpp
- Purpose: the SH1107: a 128×128 I²C OLED with a 132-column RAM.
- Key abstractions: `OledController` (the generic SSD1306-style OLED) + the
  SH1107's own command table.
- Data flow: `writeData()` (`:131-148`) writes to `m_DDRAM[addrX][m_addrY]`
  with the X address **rotated by 96 columns** when `m_xOffset` is set
  (`:134-137`) — the SH1107's column mapping — and then advances the address
  according to the addressing mode. `proccessCommand()` (`:64-111`) decodes the
  SH1107's own command set.
- Non-obvious design decisions: the offset is applied as a **rotation** (`:135-
  136`) rather than a simple addition — because the SH1107's RAM is a
  *circular* buffer of 132 columns.
- Edge cases / failure handling: an unrecognised command is reported with
  `qDebug() << "Sh1107::proccessCommand Not implemented" << m_rxReg` (`:108`) —
  the only display in the shard that logs unknown commands. The addressing-mode
  commands are handled differently from the SSD1306's: `0x21` sets
  `COLU_ADDR_MODE` (`:89`) rather than reading two parameter bytes.
- Surprising: the panel is 128×128 but `setSize(128,128)` (`:40`) means the
  *drawing area* is 128 wide while the RAM is `m_maxWidth` = 132 — the offset
  is what makes the visible region the right 128 columns.

### src/components/outputs/displays/spi3pins.h
- Purpose: header for the three-signal SPI transport mix-in.
- Key abstractions: `Spi3Pins : public eClockedDevice` owning four `IoPin`s
  *by value* — RS, CS, DI, CK (`:29-32`).
- Data flow: declarations only.
- Non-obvious design decisions: the pins are members rather than pointers, and
  the mix-in is constructed with `( QString id, Component* comp )` (`:14`) so
  it can create the pins with a parent component it does not own.
- Edge cases / failure handling: none.
- Surprising: the mix-in has no `construct`/`libraryItem` and is not a
  `Component` at all — it is a pure protocol adapter that a display class
  inherits *alongside* `Component`. This multiple-inheritance pattern is how a
  single display part ends up being both a canvas item and a protocol engine.

### src/components/outputs/displays/spi3pins.cpp
- Purpose: the SPI transport: shift a byte in on the clock, gated by CS and RS.
- Key abstractions: `eClockedDevice` for the clock; a byte buffer (`m_buffer`)
  and a bit counter (`m_inBit`).
- Data flow: `voltChanged()` (`:49-85`) resets the buffer when RS is low
  (`:52-56`) or when CS is high (`:57-62`), and on a rising clock edge shifts
  the DI bit in (`:68-73`); after eight bits it calls `endTransaction()`
  (`:75-82`), which the display class overrides.
- Non-obvious design decisions: the **first bit of the byte is the
  data/command flag** (`if( m_inBit == 0 ) m_isData = bitIn;`, `:70`) — the
  transport captures the RS line's *value* out of the wire, which is what lets
  a 3-wire SPI display work. The RS pin is used as a *reset* here
  (`!m_pinRS.getInpState()` → reset, `:52-56`), which is a repurposing of the
  pin's name.
- Edge cases / failure handling: every non-transfer condition sets `ret = true`
  and returns early (`:51-66`), so the buffer is only touched on a genuine
  clock edge with CS low.
- Surprising: the input thresholds of all four pins are hard-coded to
  2.31 V / 0.99 V (`:17-27`) with a `/// FIXME: check voltages` comment
  (`:15`) — a 3.3 V logic family's thresholds, chosen so the pins work with
  both 3.3 V and 5 V drivers.

### src/components/outputs/displays/spi5pins.h
- Purpose: header for the five-signal SPI transport mix-in.
- Key abstractions: `Spi5Pins : public SpiModule` (the engine's SPI base)
  with six `IoPin`s — DC, RS, CS, DI, CK, DO (`:27-32`).
- Data flow: declarations only.
- Non-obvious design decisions: unlike `Spi3Pins`, this mix-in inherits the
  engine's `SpiModule` (with its own shift register `m_srReg`) rather than
  `eClockedDevice` — the engine already does the bit-shifting, so this class
  only wires the pins to it (`:37-42`).
- Edge cases / failure handling: none.
- Surprising: the mix-in owns a **DO (data out)** pin — the SPI engine can
  shift data back — and the display classes that use it expose that pin to the
  circuit even though none of them implements a read command.

### src/components/outputs/displays/spi5pins.cpp
- Purpose: the five-signal SPI transport: wire the pins into the engine's SPI
  slave and capture the data/command flag.
- Key abstractions: `SpiModule` (the engine) with `m_MOSI`, `m_MISO`, `m_SS`
  and `m_clkPin` assigned to the pins (`:37-40`).
- Data flow: `stamp()` (`:46-58`) resets the buffer, registers the
  clock/RS/CS callbacks and puts the engine into `SPI_SLAVE` mode.
  `endTransaction()` (`:66-71`) reads the DC line for the data flag and copies
  the engine's shift register into `m_buffer`.
- Non-obvious design decisions: the DC line is a **separate pin** here (not a
  wire bit as in `Spi3Pins`), which is the difference between 3-wire and
  4/5-wire SPI; the engine does the shifting and the mix-in only interprets.
- Edge cases / failure handling: `m_useSS = true` (`:42`, `:55`) tells the
  engine to honour the slave-select line; the same thresholds as `Spi3Pins`
  are hard-coded (2.31 V / 0.99 V) with the same `/// FIXME: check voltages`
  comment (`:17`).
- Surprising: the DO pin's output high voltage is set to **3.3 V** (`:34`)
  while the input thresholds assume 2.31 V — a part that mixes a 3.3 V output
  with a 5 V-tolerant input.

### src/components/outputs/displays/ssd1306.h
- Purpose: header for the SSD1306 OLED.
- Key abstractions: `Ssd1306 : public OledController` overriding
  `proccessCommand()` and `parameter()`, and adding `configScroll()`.
- Data flow: declarations only.
- Non-obvious design decisions: the class overrides exactly the two hooks the
  generic OLED leaves open — the command decoder and the parameter handler —
  plus a private helper for the scroll setup.
- Edge cases / failure handling: none.
- Surprising: the header is 26 lines and adds **no data members at all**;
  every SSD1306-specific behaviour is expressed in the command table.

### src/components/outputs/displays/ssd1306.cpp
- Purpose: the SSD1306: the command set of the most common OLED controller.
- Key abstractions: `OledController` (DDRAM, addressing modes, scrolling) + the
  SSD1306's command table.
- Data flow: `proccessCommand()` (`:67-131`) decodes the command: the low
  commands set the column address in page mode (`:77-83`), `0x40-0x7F` set the
  display start line (`:84-87`), `0xB0-0xB7` set the page (`:88-91`), and the
  rest is a `switch` over the command set (`:93-129`) that sets `m_readBytes`
  (the number of parameter bytes to expect) or a flag. `parameter()`
  (`:133-173`) consumes those parameters and applies them.
- Non-obvious design decisions: the decoder uses the **structure of the command
  byte** — the top bits select a family and the low bits are the operand —
  rather than a flat switch over every value: `m_rxReg < 0x20` is "column
  address" (`:73`), `0x40-0x7F` is "start line" (`:84`), `0xB0-0xB7` is
  "page" (`:88`). The `switch` then only lists the *irregular* commands.
- Edge cases / failure handling: `m_readBytes` is the mechanism for "this
  command takes N parameter bytes" — the base's `readByte()` calls
  `parameter()` once per byte and the base resets `m_readBytes` when the count
  is reached (`:135-137`). A command that arrives in the wrong addressing mode
  is **ignored** rather than applied (`:75`, `:143`, `:148`).
- Surprising: the scroll-step table (`:184-193`) maps the SSD1306's "frame
  frequency" codes to step counts, and it is written as a `switch` **without
  `break` statements** — every case falls through to the last one. Since the
  last case assigns `m_scrollStep = 2`, **all seven scroll-frequency codes
  set the step to 2**, so the scroll-speed setting is silently inert. This is a
  real bug, visible only because the whole table was read.

### src/components/outputs/displays/st77xx.h
- Purpose: header for the ST77xx family base (ST7735, ST7789, ILI9341,
  GC9A01A).
- Key abstractions: `St77xx : public TftController, public Spi5Pins` with a
  `m_pixelMode` and the width/height/scale properties.
- Data flow: declarations only.
- Non-obvious design decisions: the class adds a **scale** factor (`:28-29`)
  so a 240×320 panel can be drawn at half size on the canvas — the frame
  buffer stays at native resolution and only the *drawing* is scaled.
- Edge cases / failure handling: none.
- Surprising: the class's `width()`/`height()` getters (`:22`, `:26`) shadow
  the base's `uint16_t m_width`/`m_height` members with `int` returns, so a
  subclass reading `m_width` sees a `uint16_t` while the property sees an
  `int`.

### src/components/outputs/displays/st77xx.cpp
- Purpose: the ST77xx family: pixel-format handling, RAM writes, and a size
  that can be scaled.
- Key abstractions: `TftController` + `Spi5Pins`; `m_pixelMode` selects the
  format.
- Data flow: `endTransaction()` (`:56-62`) copies the assembled byte and routes
  it to the data or command path. `writeRam()` (`:83-147`) unpacks 4/4/4,
  5/6/5 or 6/6/6 into a 0xRRGGBB pixel and calls `TftController::writeRam()`.
  `setWidth`/`setHeight`/`setScale` (`:149-177`) resize the display and
  re-lay-out the pins; `updateSize()` (`:179-217`) moves the six SPI pins to a
  row under the panel and recomputes the bounding box.
- Non-obvious design decisions: the 4/4/4 format writes **two pixels** from
  three bytes (`:91-114`) — the second pixel's red channel is carried in
  `m_colorData` across bytes (`:95-97`) — so the format's packing is handled
  entirely in the derived class and the base's `writeRam()` is simply "write
  the pixel I just decoded".
- Edge cases / failure handling: `setWidth`/`setHeight` clamp to the panel's
  maximum and to a minimum of 32/16 (`:150-152`, `:161-163`); `setScale` only
  recomputes the scaled dimensions and the layout (`:171-177`).
- Surprising: the pin *layout* is recomputed on every size change — the six
  SPI pins are moved to `y = m_scaledHeight/2 + 22` and spread across
  `x = -20 … 20` (`:181-195`), and their label spacing is recomputed
  (`:197-205`) so the labels never overlap the panel. That is real canvas
  layout code living inside a protocol component.

### src/components/outputs/displays/st7735.h
- Purpose: header for the ST7735 TFT.
- Key abstractions: `St7735 : public St77xx` with nothing added.
- Data flow: declarations only.
- Non-obvious design decisions: the whole part is a constructor — a panel is a
  *size*, not a behaviour.
- Edge cases / failure handling: none.
- Surprising: none.

### src/components/outputs/displays/st7735.cpp
- Purpose: the ST7735: a 132×162 TFT.
- Key abstractions: `St77xx`.
- Data flow: the constructor sets the maximum size (`:27-28`), calls
  `setDisplaySize` and `setScale(1)`, and sets `m_addrBytes = 2` (`:32`) so
  the address commands carry two bytes per coordinate.
- Non-obvious design decisions: `m_addrBytes` (the address width) is a
  property of the *panel*, not of the command set — a 132×162 panel uses
  16-bit addressing while a 240×320 one may not (`:32`).
- Edge cases / failure handling: none.
- Surprising: the panel is 132 wide but the ST7735 in "greyscale" mode is 128
  — the class does not model the 132/128 offset, so a picture written to the
  rightmost four columns is off-screen.

### src/components/outputs/displays/st7789.h
- Purpose: header for the ST7789 TFT.
- Key abstractions: `St7789 : public St77xx` with nothing added.
- Data flow: declarations only.
- Non-obvious design decisions: none.
- Edge cases / failure handling: none.
- Surprising: none.

### src/components/outputs/displays/st7789.cpp
- Purpose: the ST7789: a 240×320 TFT.
- Key abstractions: `St77xx`.
- Data flow: the constructor sets the maximum size (240×320), calls
  `setDisplaySize` and `setScale(1)` (`:27-30`).
- Non-obvious design decisions: unlike the ST7735, it does **not** set
  `m_addrBytes = 2` — the default from `TftController::setRamSize` is 1 byte
  per coordinate for a panel ≤ 256×256 and 2 bytes above that
  (`src/components/outputs/displays/tftcontroller.cpp:335-336`). At 240×320 the
  *height* exceeds 256, so `setRamSize` sets `m_addrBytes = 2` anyway.
- Edge cases / failure handling: none.
- Surprising: the "must I set `m_addrBytes` explicitly?" question has two
  different answers in the two panels' constructors — one sets it, the other
  relies on the size-derived default — and both end up at 2. A reader
  comparing the two files would not immediately see that they agree.

### src/components/outputs/displays/tftcontroller.h
- Purpose: header for the generic TFT frame-buffer controller.
- Key abstractions: `TftController : public Component` with a
  `std::vector<std::vector<uint32_t>> m_DDRAM` (`:99`), a `QImage m_image`
  (`:101`) and the full set of display state (address window, mirroring,
  scrolling areas, pixel format).
- Data flow: declarations only.
- Non-obvious design decisions: the class owns **both** a DDRAM and a
  `QImage` — the RAM is the model's truth and the image is the rendered copy,
  refreshed by `printImage()`. The scroll state is expressed in the standard
  terms (Top Fixed Area, Vertical Scrolling Area, Bottom Fixed Area, Vertical
  Scrolling Pointer, `:73-76`), so a firmware's scroll setup is emulated
  faithfully.
- Edge cases / failure handling: none.
- Surprising: the class is a `Component` and **not** an `eElement` — like the
  OLED controller, the TFT's transport mix-in provides the engine identity.

### src/components/outputs/displays/tftcontroller.cpp
- Purpose: the generic TFT: the command table, the address window, the frame
  buffer and the renderer.
- Key abstractions: `m_DDRAM` (the frame buffer), `m_image` (the rendered copy)
  and a large `commandReceived()` switch.
- Data flow: `commandReceived()` (`:73-179`) is a **datasheet transcription**:
  each command sets `m_readBytes` (the number of parameter bytes that follow)
  or changes a flag. `dataReceived()` (`:181-263`) consumes those parameters,
  assembling 1- or 2-byte addresses into `m_startX/m_endX/m_startY/m_endY`
  (`:190-215`) and the vertical scrolling definition (`:220-228`).
  `writeRam()` (`:265-284`) applies the mirror/swap transforms and writes the
  pixel into the DDRAM, advancing the address with the window wrap.
  `printImage()` (`:358-385`) renders the buffer into the `QImage`, applying
  the vertical scroll offset.
- Non-obvious design decisions: the command table is a **flat list of
  `m_readBytes = n` assignments** (`:98-174`) rather than a structured
  decoder — the controller has no command bit-fields, so "how many bytes does
  this command take" is the whole model, and the derived classes override only
  the three commands they care about (pixel format, memory write, reset).
  `m_readBytes = -1` for the memory-write command (`:103`) is a sentinel
  meaning "keep reading until the next command" — a signed counter that goes
  negative.
- Edge cases / failure handling: the address setters deliberately **do not
  clamp** — the clamping lines are commented out (`:289`, `:296`, `:303`,
  `:310`) — so a firmware that sets an out-of-range address gets the
  out-of-range address and the wrap is handled in `writeRam()` (`:273-274`).
  The scroll offset is applied by *remapping the row index* rather than by
  moving pixels (`:368-377`).
- Surprising: the class renders at **2× resolution**
  (`m_image = QImage( x*2, y*2, ... )`, `:348`) and paints each pixel as a 2×2
  block (`:381`), so a 240×320 panel is drawn from a 480×640 image — an
  anti-aliasing trick that makes the display look like a real LCD.

### src/components/passive/reactive/reactive.h
- Purpose: header for the reactive-element base (capacitor/inductor).
- Key abstractions: `Reactive : public Comp2Pin, public eReactive`; owns a
  mid `eNode` and a series `eResistor`.
- Data flow: declarations only.
- Non-obvious design decisions: the base carries **both** a value setter
  (`setValue`) and a virtual `setCurrentValue` (`:30`) — the difference is
  that `setCurrentValue` is what a *linker* or a dial calls to change the
  element's value at run time, while `setValue` is the property path.
- Edge cases / failure handling: none.
- Surprising: the commented-out `reaStep` / `setReaStep` members (`:27-28`)
  show that the reactive step used to be a per-element property and was
  replaced by a global timestep.

### src/components/passive/reactive/reactive.cpp
- Purpose: the shared machinery of every reactive element.
- Key abstractions: the **companion model** — the element is physically a
  resistor whose value is recomputed from the timestep on every update.
- Data flow: `stamp()` (`:42-49`) binds the mid node and calls
  `eReactive::stamp()` **only if both pins are connected**; `updateStep()`
  (`:51-60`) calls `updtReactStep()` (which recomputes R and I from the
  current timestep) when `m_changed`, and refreshes the property dialog.
- Non-obvious design decisions: the element is stamped only when *both* pins
  are connected, so a dangling reactive element is simply not in the matrix
  rather than being a zero-impedance branch.
- Edge cases / failure handling: the constructor sets the series resistor to
  `1e-6` Ω (`:23`) — a tiny but non-zero ESR so the branch is never
  singular.
- Surprising: `setLinkedValue` divides by 1000 (`:81`,
  `setCurrentValue( m_value*v/1000 )`) — a fixed milli-scaling applied to
  *every* linked reactive value, with no comment explaining the unit.

### src/components/passive/reactive/capacitor.h
- Purpose: header for the plain capacitor.
- Key abstractions: `Capacitor : public CapacitorBase`.
- Data flow: declarations only.
- Non-obvious design decisions: none.
- Edge cases / failure handling: none.
- Surprising: none.

### src/components/passive/reactive/capacitor.cpp
- Purpose: the capacitor's symbol and library entry; all behaviour is
  inherited.
- Key abstractions: none beyond `CapacitorBase`.
- Data flow: none.
- Non-obvious design decisions: the library category is `"Reactive"`
  (`:20`), which is the taxonomy the UI groups by.
- Edge cases / failure handling: none.
- Surprising: 43 lines, of which 20 are the constructor (which is empty).

### src/components/passive/reactive/capacitorbase.h
- Purpose: the capacitor's companion model and value storage.
- Key abstractions: `updtRes()`/`updtCurr()` — the two virtuals
  `eReactive::updtReactStep()` calls.
- Data flow: `m_capacitance` → `updtRes()` → the series resistor's value.
- Non-obvious design decisions: `updtRes() { return m_tStep/m_capacitance; }`
  and `updtCurr() { return m_volt*m_admit; }` (`:19-20`) — a capacitor is
  simulated as a *backward-Euler companion resistor* `R = Δt/C` carrying a
  current `I = V·G`. There is no capacitance state vector anywhere.
- Edge cases / failure handling: none here (the division by zero is avoided
  upstream by clamping the capacitance).
- Surprising: this two-line header is the whole of SimulIDE's reactive
  element theory, and it is the *only* place in the shard where a stateful
  physical element becomes a linear one.

### src/components/passive/reactive/capacitorbase.cpp
- Purpose: the capacitor's property set and defaults.
- Key abstractions: three `DoubProp`s — Capacitance, Resistance, Initial
  Voltage — bound to member function pointers.
- Data flow: property → `setValue` → `setCurrentValue` → `m_capacitance` and
  `m_changed = true` (`:43-47`).
- Non-obvious design decisions: the property's *unit* is a display concern
  only (`"µF"`) while the stored value is in farads (`0.00001` at `:22`) — the
  unit lives in the property, not in the value.
- Edge cases / failure handling: none.
- Surprising: `setPropStr( "Capacitance", "10 µF" )` (`:39`) — the default is
  written as a *human string with a unit* and parsed by the property system.
  That is the file format's unit convention in one line.

### src/components/passive/reactive/elcapacitor.h
- Purpose: header for the electrolytic capacitor.
- Key abstractions: `elCapacitor : public CapacitorBase` with an
  `updateStep()` override.
- Data flow: declarations only.
- Non-obvious design decisions: the class name is lower-camel (`elCapacitor`)
  while every other class in the shard is PascalCase — a naming inconsistency
  that the project's own `check:naming`-style gates would catch elsewhere.
- Edge cases / failure handling: none in the header.
- Surprising: none.

### src/components/passive/reactive/elcapacitor.cpp
- Purpose: the electrolytic capacitor, with a reverse-polarity check.
- Key abstractions: same companion model; adds a visual "crashed" state.
- Data flow: `updateStep()` (`:35-43`) reads the voltage across the capacitor
  and sets `m_crashed` when it goes below −1e-6 V, repainting on the
  transition.
- Non-obvious design decisions: the part re-implements `updateStep()` entirely
  rather than calling `CapacitorBase`'s — so the base's `updtReactStep()` is
  **never** invoked for an electrolytic capacitor (it does not derive from
  `Reactive::updateStep`). The reactive companion model is therefore not
  recomputed for this part at all; only the base class's constructor-time
  values apply.
- Edge cases / failure handling: reverse polarity is *detected and shown*, not
  prevented.
- Surprising: this is a genuine behavioural divergence between two parts that
  claim to be the same device.

### src/components/passive/reactive/inductor.h
- Purpose: header for the inductor.
- Key abstractions: `Inductor : public Reactive` with the inductor's
  companion model.
- Data flow: `m_inductance` → `updtRes()`.
- Non-obvious design decisions: `updtRes() { return m_inductance/m_tStep; }`
  and `updtCurr() { return m_curSource - m_volt*m_admit; }` (`:30-31`) — the
  inductor is a companion **current source** in parallel with a resistance
  `R = L/Δt`, mirroring the capacitor's `R = Δt/C`.
- Edge cases / failure handling: none.
- Surprising: `indCurrent()` is exposed publicly (`:21`) but the *current* is
  maintained by the engine element, not by the part.

### src/components/passive/reactive/inductor.cpp
- Purpose: the inductor's properties, default (1 H) and symbol.
- Key abstractions: the same property pattern as the capacitor, but the
  "Initial Voltage" property is titled **"Initial Current"** with unit `"A"`
  (`:47-48`) — the property *name* and its *caption* disagree because the
  engine's field is `initVolt`/`setInitVolt` even for an inductor.
- Data flow: `setCurrentValue` sets `m_inductance` and marks dirty (`:59-63`).
- Non-obvious design decisions: the "InitVolt" property key is reused for the
  inductor's initial current — a file-format wart that a student opening the
  saved file would see.
- Edge cases / failure handling: none.
- Surprising: the unit string `"µΩ"` on the Resistance property (`:44`) while
  the *stored* value is in ohms — the unit is a label, the value is SI.

### src/components/passive/reactive/transformer.h
- Purpose: header for the transformer.
- Key abstractions: the `winding_t` struct (`:16-27`) holds a parsed winding
  specification — definition string, topology string, id prefix, pins, coils,
  coil count, start offset, angle, x position.
- Data flow: declarations only.
- Non-obvious design decisions: the winding spec is kept as a *struct with
  both the source string and the derived topology*, so the class can tell
  whether a change needs a rebuild (`create`) or just a re-layout (`modify`).
- Edge cases / failure handling: none in the header.
- Surprising: the transformer is a `Component` + `eElement` pair, *not* an
  `eReactive` — the coupling is handled by the transformer's own `eCoil`
  elements, not by the shared reactive machinery.

### src/components/passive/reactive/transformer.cpp
- Purpose: a multi-winding transformer with mutual coupling — the most
  mechanically interesting file in the shard.
- Key abstractions: `eCoil` (one per winding section), a `winding_t` per side,
  and an inverted admittance matrix `m_inva` reused every timestep.
- Data flow: `stamp()` (`:70-151`) builds the inductance matrix with mutual
  terms `m_coupCoeff * sqrt(L_i·L_j) * sign_i * sign_j` (`:92`), **inverts it in
  place** with a hand-written LU/Gauss-Jordan (`:97-113`), scales it by the
  timestep (`:135`), stamps each coil's admittance from the diagonal
  (`:140-141`) and wires the off-diagonal terms as induced currents
  (`:144-149`); it then schedules itself for the next step (`:150`).
  `runEvent()` (`:153-164`) recomputes `current_i = Σ_j V_j · inva[i][j]` and
  stamps it, then reschedules.
- Non-obvious design decisions: the matrix inverse is computed **once per
  stamp** and reused every timestep, so a coupled element costs O(n²) per step
  and no Newton solve. The coupling coefficient is clamped to
  `[0.0001, 0.9999]` (`:211-212`) so a perfect transformer (k = 1) is
  impossible — a deliberate numerical guard. `setBaseInd` and `setCoupCoeff`
  both **power the circuit off** if the simulator is running (`:186`, `:210`).
- Edge cases / failure handling: `getLeght()` (`:238-262`) parses the winding
  definition — sections separated by `:` and coils by `,` — and returns
  `nCoils*3 + nSections − 1` pins; a definition with no sections returns 0
  and `create()` bails out (`:336`).
- Surprising: the **winding definition is a text DSL** in a property
  (`"Primary"`/`"Secondary"`): `"1"` is a single 1:1 coil, `"2,3:1"` is a
  centre-tapped winding where the sign of each number is the winding polarity
  (`:301-306`). The `winding_t::topology` string is a normalised form used to
  decide rebuild-vs-relayout.

### src/components/passive/reactive/varcapacitor.h
- Purpose: header for the variable capacitor.
- Key abstractions: `VarCapacitor : public Dialed, public eReactive` — note it
  derives from `eReactive` directly, not from `Reactive`, so it re-implements
  the mid-node and series-resistor wiring itself.
- Data flow: declarations only.
- Non-obvious design decisions: `updtRes()`/`updtCurr()` are duplicated here
  and in `VarInductor` (`:33-34`) rather than shared.
- Edge cases / failure handling: none.
- Surprising: the duplication means the variable capacitor does **not** share
  `Reactive`'s "stamp only when both pins connected" guard — it repeats the
  guard itself at `varcapacitor.cpp:103-104`.

### src/components/passive/reactive/varcapacitor.cpp
- Purpose: a dial-driven variable capacitor.
- Key abstractions: `Dialed` (the dial widget and its min/max/step range) +
  `eReactive`.
- Data flow: `updateStep()` (`:107-119`) copies the dial value into
  `m_capacitance` and calls `updtReactStep()`; the value label is refreshed
  from the property string.
- Non-obvious design decisions: the dial widget is a real Qt widget embedded
  via `QGraphicsProxyWidget` (`updateProxy()` at `:126-129`), and the part
  sets `m_needUpdate` rather than `m_changed` — a *separate* dirty flag from
  the rest of the library, because the dial's value is not a property value.
- Edge cases / failure handling: `m_maxVal = 10e-6` (`:57`) with the dial
  starting at 0 (`:59`) — a variable capacitor at zero is a short, so the
  companion resistance `Δt/C` is infinite rather than zero.
- Surprising: the "Current Value" property is bound to `getVal`/`setVal` of
  the *dial*, not to the capacitance, so the property editor and the on-canvas
  dial are two views of one number.

### src/components/passive/reactive/varinductor.h
- Purpose: header for the variable inductor.
- Key abstractions: `VarInductor : public Dialed, public eReactive`.
- Data flow: declarations only.
- Non-obvious design decisions: `updtCurr() { return m_volt*m_admit; }`
  (`:34`) — this is the **capacitor's** current formula; the fixed inductor
  uses `m_curSource - m_volt*m_admit`. The variable inductor is therefore
  modelled as a variable *capacitor*.
- Edge cases / failure handling: none.
- Surprising: a copy-paste divergence between two sibling parts that the
  shared base class would have prevented.

### src/components/passive/reactive/varinductor.cpp
- Purpose: the dial-driven variable inductor.
- Key abstractions: as `VarCapacitor`, with `m_maxVal = 10e-3` H (`:57`).
- Data flow: `updateStep()` (`:107-119`) copies the dial value into
  `m_inductance` and calls `updtReactStep()`.
- Non-obvious design decisions: the "InitVolt" property is titled "Initial
  Voltage" here (`:74-75`) — for an inductor with a current-based model this
  is a mis-caption, and the fixed inductor at least titles it "Initial
  Current".
- Edge cases / failure handling: none.
- Surprising: it is a near-verbatim copy of `varcapacitor.cpp` with the
  symbols and units changed — the two files differ in about eight lines.

### src/components/passive/resist_sensors/ldr.h
- Purpose: header for the light-dependent resistor.
- Key abstractions: `Ldr : public VarResBase` with the two physical
  parameters R1 and γ.
- Data flow: declarations only.
- Non-obvious design decisions: none.
- Edge cases / failure handling: none.
- Surprising: none.

### src/components/passive/resist_sensors/ldr.cpp
- Purpose: the LDR: a physical law mapping illuminance to resistance.
- Key abstractions: `VarResBase` (the dial and the `eResistor`).
- Data flow: `updateStep()` (`:64-73`) computes
  `res = m_r1 * pow(m_value, -m_gamma)` and calls `eResistor::setResistance()`;
  it runs only when `m_needUpdate` is set — i.e. only when the dial moved.
- Non-obvious design decisions: the parameters are the *standard* CdS LDR
  values: R1 = 127 410 Ω and γ = 0.8582 (`:35-36`), with the dial starting at
  1 lux (`:38`).
- Edge cases / failure handling: at 0 lux the resistance is infinite
  (`pow(0, -γ)`), which the engine's `setResistance` presumably guards
  elsewhere; the part itself does not.
- Surprising: the dial unit is "Lux" (`:41`) and the minimum/maximum are also
  in lux, so the *same* dial means different things in different parts (lux
  here, newtons in the strain gauge, °C in the thermistor) — the unit is a
  per-part string, not a typed quantity.

### src/components/passive/resist_sensors/rtd.h
- Purpose: header for the RTD (resistance temperature detector, e.g. Pt100).
- Key abstractions: `RTD : public ThermistorBase` — i.e. it reuses the
  *thermistor's* temperature-valued dial rather than inventing one.
- Data flow: declarations only.
- Non-obvious design decisions: the third-order polynomial coefficients
  (`:42-44`) are hard-coded with the linear approximation kept as a comment
  (`:40-41`).
- Edge cases / failure handling: none in the header.
- Surprising: `m_tau` (thermal time constant) and `m_lastTime` are declared
  (`:35-37`) but only used by the commented-out lag model in the .cpp —
  dead state that documents an intended feature.

### src/components/passive/resist_sensors/rtd.cpp
- Purpose: the RTD's resistance-versus-temperature law.
- Key abstractions: `sensorFunction(temp)` (`:68-77`) — the whole model.
- Data flow: `updateStep()` (`:48-66`) calls `sensorFunction(m_value)` and
  sets the resistance.
- Non-obvious design decisions: the law is
  `R = R0·(1 + a·T + b·T²)` with a cubic correction below 0 °C
  (`:73-74`) — the "more realist third order polynomial approximation" the
  comment claims.
- Edge cases / failure handling: the third-order term is applied only for
  `temp < 0` — a negative-temperature extrapolation that is easy to get
  wrong and is worth reading before trusting.
- Surprising: an entire **first-order thermal-lag model** (`τ`, exponential
  approach) is written out in comments (`:53-60`) and then not used — the
  part responds instantly to a temperature change, which is physically wrong
  and would be noticed by a student.

### src/components/passive/resist_sensors/strain.h
- Purpose: header for the force strain gauge.
- Key abstractions: `Strain : public VarResBase` with a large physical
  parameter set (Poisson's ratio, Bridgman constant, Young's modulus, test
  body section, temperature coefficients).
- Data flow: declarations only.
- Non-obvious design decisions: `m_drPrecalc` is declared with a comment
  "Precalculate known parameters to speed up resistance update" (`:66`) — an
  explicit performance intent.
- Edge cases / failure handling: none in the header.
- Surprising: `double m_drPrecalc;` has **no initialiser** (`:66`), and the
  constructor's member-initialiser list does not set it, while
  `updateParameters()` — the only writer — is called only from `setRefTemp()`
  and `setTemp()` (`strain.cpp:143`, `:149`). The constructor never calls it,
  so the first `updateStep()` reads an indeterminate value.

### src/components/passive/resist_sensors/strain.cpp
- Purpose: the strain gauge's force-to-resistance law.
- Key abstractions: `sensorFunction(forceN)` (`:120-128`) and
  `updateParameters()` (`:130-138`).
- Data flow: `updateStep()` (`:80-105`) → `sensorFunction(m_value)` →
  `eResistor::setResistance()`; `updateParameters()` precomputes the gauge
  factor `K = 1 + 2ν + k_B(1−2ν)`, the effective gauge factor
  `K·(1−coefficient_transverse)`, the thermal drift term and
  `m_drPrecalc = R0·K/(E·A)`.
- Non-obvious design decisions: the "precalculate to speed up the update" is
  done in a separate function that is *only* reachable from the two
  temperature setters — so the optimisation is not actually applied on the
  common path.
- Edge cases / failure handling: none.
- Surprising: **`m_drPrecalc` is read at `strain.cpp:124` before it is ever
  written** on a freshly constructed part (the constructor never calls
  `updateParameters()`), so the first computed resistance is
  `R0 + indeterminate + ΔR_t` — a real bug, and the reason the class carries
  an `initialize()` that calls `updateStep()` directly (`strain.cpp:77`).
  A second, similar smell: the whole exponential-lag model is commented out
  (`:85-94`), so the gauge responds instantly to force.

### src/components/passive/resist_sensors/thermistor.h
- Purpose: header for the thermistor.
- Key abstractions: `Thermistor : public ThermistorBase` with the B constant
  and R25.
- Data flow: declarations only.
- Non-obvious design decisions: the B constant and R25 are **integers**
  (`:32-33`), which is physically coarse but matches how the parts are
  specified.
- Edge cases / failure handling: none.
- Surprising: none.

### src/components/passive/resist_sensors/thermistor.cpp
- Purpose: the thermistor's β-equation.
- Key abstractions: the law lives entirely in `updateStep()` (`:48-63`).
- Data flow: the dial's temperature value → `k = (t0−t)/(t·t0)`,
  `res = R25 · e^(B·k)` → `eResistor::setResistance()`.
- Non-obvious design decisions: the correct β-equation is written out in a
  comment above the code that replaced it (`:56-57`) — the commented form
  `R25 / e^(B/t)`-style expression is the textbook one, and the live code
  uses the equivalent `R25·e^(B(t0−t)/(t·t0))`.
- Edge cases / failure handling: none; the kelvin conversion (`:53-54`)
  prevents the division-by-zero at 0 °C.
- Surprising: `e = 2.7182` is a **local literal** rather than `M_E`
  (`:55`) — the constant is spelled out inline, and `qPow` is used instead of
  `std::pow` for a double.

### src/components/passive/resist_sensors/thermistorbase.h
- Purpose: header for the thermistor family base.
- Key abstractions: `ThermistorBase : public VarResBase` — a dial whose value
  is a temperature.
- Data flow: declarations only.
- Non-obvious design decisions: `setMaxVal`/`setMinVal` are overridden
  (`:19-20`) so the range cannot cross.
- Edge cases / failure handling: the overrides clamp the new value against the
  other bound.
- Surprising: the base does not implement the PTC/NTC behaviour — it only
  stores the flag.

### src/components/passive/resist_sensors/thermistorbase.cpp
- Purpose: the temperature-valued dial base for the thermistor family.
- Key abstractions: `Dialed` with a temperature unit (`"ºC"`, `:23`).
- Data flow: the dial's value is the temperature; the derived class converts
  it to resistance.
- Non-obvious design decisions: `setPtc()` **does nothing** — `return; //
  TODO` at `:40-42` — so a PTC thermistor silently behaves as an NTC one.
  The base sets `m_ptc = false` by default (`:17`), and nothing ever sets it
  true.
- Edge cases / failure handling: `setMinVal`/`setMaxVal` clamp against each
  other and call `updtValue()` (`:45-59`).
- Surprising: the "PTC" concept exists in the data model, in the header and in
  the property table of the derived classes — and is not implemented. A
  student who selects a PTC thermistor gets an NTC one with no warning.

### src/components/passive/resistors/potentiometer.h
- Purpose: header for the potentiometer.
- Key abstractions: `Potentiometer : public Dialed, public eElement` with two
  `eResistor`s and three pins (A, wiper M, B).
- Data flow: declarations only.
- Non-obvious design decisions: the pins and the engine elements are members
  **by value** (`:44-51`) rather than by pointer — unlike almost every other
  part in the shard, which news its `Pin`s.
- Edge cases / failure handling: none.
- Surprising: the wiper pin `m_pinM` is a `Pin` (not an `IoPin`), so the
  wiper is not a driven digital node.

### src/components/passive/resistors/potentiometer.cpp
- Purpose: the potentiometer: two resistors whose split follows the dial.
- Key abstractions: `eResistor m_resA` / `m_resB` in series through a
  shared mid node.
- Data flow: `initialize()` (`:89-99`) takes the mid node **from the middle
  pin** (`m_pinM.getEnode()`) and only creates a private `eNode` if the wiper
  is unconnected (`:91-92`) — the wiper node is therefore shared with
  whatever the user wired to it. `updateStep()` (`:101-122`) splits the total
  resistance: `res1 = R·dial/1000`, `res2 = R − res1`, with both halves
  clamped away from zero (`:109-116`).
- Non-obvious design decisions: the clamp is asymmetric — the lower half is
  floored at 1e-3 Ω and the upper at 1e-6 Ω (`:110`, `:114`) — because a
  shorted half would be a zero-resistance branch in the matrix.
- Edge cases / failure handling: `setValue` clamps to `[1e-12, R]`
  (`:128-129`); `setResistance` re-applies the current value (`:136-141`).
- Surprising: the dial's value is expressed in **per-mille** (`dial/1000`) —
  a `QDial` is 0–1000 — and `getValue()` (`:124`) returns a resistance in
  ohms computed from the same per-mille.

### src/components/passive/resistors/resistor.h
- Purpose: header for the plain resistor.
- Key abstractions: `Resistor : public Comp2Pin, public eResistor`.
- Data flow: declarations only.
- Non-obvious design decisions: `drawAnsi` is **public and static** (`:22`) so
  that every resistor-family part can paint the ANSI zigzag without
  inheriting from `Resistor`.
- Edge cases / failure handling: none.
- Surprising: none.

### src/components/passive/resistors/resistor.cpp
- Purpose: the plain resistor, and the shared ANSI symbol painter.
- Key abstractions: `eResistor`; the two pins are `m_ePin[0]`/`m_ePin[1]`
  (`:33-34`).
- Data flow: the "Resistance" property is bound to
  `&Resistor::resistance` / `&Resistor::setResistance` (`:40-41`) — a
  member-function-pointer binding, so the property editor, the file format
  and the engine all read the same field.
- Non-obvious design decisions: `m_ansiSymbol` selects between the ANSI zigzag
  and the IEC rectangle (`:67-68`) — a *global* symbol convention, not a
  per-part one.
- Edge cases / failure handling: none.
- Surprising: `drawAnsi` takes `sX`/`sY` scale factors (`:49`) so the DIP
  switch can draw a squashed version of the same symbol
  (`resistordip.cpp:202`).

### src/components/passive/resistors/resistordip.h
- Purpose: header for the resistor DIP switch.
- Key abstractions: `ResistorDip : public Component, public eElement` with
  N resistors and N×2 pins.
- Data flow: declarations only.
- Non-obvious design decisions: `static eNode m_puEnode;` (`:61`) — a
  **class-static** engine node shared by every instance in the process.
- Edge cases / failure handling: none in the header.
- Surprising: the pull-up rail is a static node, not a per-instance one, so
  two resistor-DIPs with different pull-up voltages would fight over the same
  node's voltage.

### src/components/passive/resistors/resistordip.cpp
- Purpose: a DIP switch built from N resistors, with an optional pull-up.
- Key abstractions: `std::vector<Pin*> m_pin` and
  `std::vector<eResistor*> m_resistor`, resized at runtime by
  `createResistors`/`deleteResistors`.
- Data flow: `stamp()` (`:79-90`) — when pull-up is on, it sets the shared
  node's voltage (`m_puEnode.setVolt( m_puVolt )`), ties every odd pin to that
  node, and stamps a current `m_puVolt/m_resistance` on every even pin.
  `updateStep()` (`:92-99`) re-applies the resistance to every resistor and
  re-stamps.
- Non-obvious design decisions: the pull-up is a **current source into the
  shared node** — an ideal rail with zero impedance, implemented by one
  static node, so it costs nothing in the matrix. `setPullUp` (`:158-176`)
  removes the connectors on the odd pins and hides them, so a pull-up-enabled
  DIP has half its pins invisible.
- Edge cases / failure handling: `setSize` powers the circuit off before
  adding or removing resistors (`:149`); `setResistance` clamps to 1e-12 Ω
  (`:139`).
- Surprising: the part is a *pull-up*, not a pull-down, and the pull-up
  voltage is a property of the switch, not of the rail it connects to.

### src/components/passive/resistors/varresbase.h
- Purpose: header for the dial-driven resistor base.
- Key abstractions: `VarResBase : public Dialed, public eResistor`.
- Data flow: declarations only.
- Non-obvious design decisions: the base holds *no* electrical behaviour —
  it is purely the dial + the `eResistor` identity; the derived class decides
  what the dial value means.
- Edge cases / failure handling: none.
- Surprising: this one class is the base of the variable resistor *and* of
  all four resistive sensors, which is why a thermistor has a "Dial Step" in
  °C and a strain gauge has one in newtons.

### src/components/passive/resistors/varresbase.cpp
- Purpose: the shared construction of the dial-resistor family.
- Key abstractions: `Dialed` + `eResistor`.
- Data flow: `initialize()` sets `m_needUpdate = true` (`:36-39`) so the
  first update computes the value; `updateProxy()` positions the dial widget
  (`:41-44`).
- Non-obvious design decisions: `m_graphical = true` (`:21`) marks the part as
  having an embedded widget, which changes how it is drawn and hit-tested.
- Edge cases / failure handling: none.
- Surprising: none.

### src/components/passive/resistors/varresistor.h
- Purpose: header for the variable resistor.
- Key abstractions: `VarResistor : public VarResBase`.
- Data flow: declarations only.
- Non-obvious design decisions: none.
- Edge cases / failure handling: none.
- Surprising: none.

### src/components/passive/resistors/varresistor.cpp
- Purpose: the variable resistor: a dial whose value *is* the resistance.
- Key abstractions: `VarResBase`.
- Data flow: `updateStep()` (`:54-62`) calls `eResistor::setResistance(
  m_value )` when `m_needUpdate` is set, then refreshes the dialog or the
  on-canvas value label.
- Non-obvious design decisions: the property set is min/max/current/step
  (`:37-47`) with the "Current Value" bound to the *dial* (`getVal`/`setVal`),
  and the dial controls go in a `groupNoCopy` group (`:50`) so they are not
  written to the circuit file.
- Edge cases / failure handling: `setSmall` is not used here; the part
  reuses `Resistor::drawAnsi` when the ANSI convention is on (`:69`).
- Surprising: `groupNoCopy` (and the per-property `propNoCopy` flag) is the
  mechanism that keeps *editor* controls out of the saved file — a "what is
  part of the circuit and what is part of the editor" distinction expressed as
  a flag on a property group.

### src/components/sources/battery.h
- Purpose: header for the battery.
- Key abstractions: `Battery : public Comp2Pin, public eResistor` — again,
  the resistor slot carries the internal source resistance, not a branch
  resistance.
- Data flow: declarations only.
- Non-obvious design decisions: `setResistance` is declared `override`
  (`:25`) — the part overrides the engine element's setter to maintain
  admittance rather than resistance.
- Edge cases / failure handling: none.
- Surprising: none.

### src/components/sources/battery.cpp
- Purpose: the battery: an ideal voltage source with a small internal
  resistance.
- Key abstractions: `eResistor` for the internal resistance; two `createCurrent`
  / `stampCurrent` calls for the source itself.
- Data flow: `stamp()` (`:58-70`) calls `eResistor::stamp()` and then, only
  if **both** pins are connected, stamps `±m_volt*m_admit` — the source is a
  large admittance in parallel with an ideal current source.
- Non-obvious design decisions: `m_admit = 1e3` (`:36`) is the *conductance*
  of the source branch, i.e. 1 mΩ of internal resistance, and the actual
  voltage is delivered by the stamped current — so the battery is a
  current source in parallel with a small resistance, not a voltage source
  in series with one.
- Edge cases / failure handling: `setVoltage` clamps at 1e-12 V (`:85`);
  `setResistance` clamps at 1e-14 Ω (`:92`).
- Surprising: the "Resistance" property's unit is "mΩ" but the *default* is
  1e3 of *admittance* — the property reads `&Battery::resistance`, which is
  `1/m_admit`, so the displayed value and the stored field are inverses of
  each other.

### src/components/sources/clock-base.h
- Purpose: header for the clock base: frequency → time, and the fraction
  accumulator.
- Key abstractions: `ClockBase : public FixedVolt` (a clock *is* a fixed
  voltage source that toggles).
- Data flow: declarations only.
- Non-obvious design decisions: **`getRemainer()`** (`:39-45`) carries the
  fractional part of the period across events: it adds
  `m_psPerCycleDbl − m_psPerCycleInt` to a double accumulator and returns the
  integer part, so the *average* period is exact even though every individual
  interval is an integer number of picoseconds.
- Edge cases / failure handling: `setRunning` forces `running = running &&
  (m_freq > 0)` (`:68`) — a zero frequency cannot be "running".
- Surprising: the remainder accumulator is the standard "Bresenham" trick
  applied to time, and it is invisible in the class's public surface.

### src/components/sources/clock-base.cpp
- Purpose: the clock's frequency handling and the "always on" mode.
- Key abstractions: inherits `FixedVolt`'s push-button and output pin.
- Data flow: `setFreq` (`:55-64`) computes `m_psPerCycleDbl = 1e6·1e6/freq`
  (picoseconds per cycle from a frequency in kHz), truncates it to an integer,
  resets the remainder, and restarts the clock.
- Non-obvious design decisions: `setAlwaysOn` hides the button and forces the
  clock running (`:48-53`) — "always on" is expressed by *removing the
  user's control*, not by a separate code path. `setHidden` (`:80-88`)
  reshapes the part's bounding box for the three display modes (normal, in a
  board, totally hidden) and moves the embedded button's z-order.
- Edge cases / failure handling: `propNotFound` (`:32-40`) claims the retired
  `"Out"` property and maps it to the running flag — another file-format
  migration hook, marked "Old: TODELETE".
- Surprising: the frequency unit is **kHz** in the property but the internal
  conversion `1e6*1e6/freq` yields picoseconds per cycle — so `freq` is in
  kHz and the period in ps, two different scalings, both in the same file.

### src/components/sources/clock.h
- Purpose: header for the clock.
- Key abstractions: `Clock : public ClockBase` with `updateStep`/`runEvent`
  and a `m_state` toggle.
- Data flow: declarations only.
- Non-obvious design decisions: none.
- Edge cases / failure handling: none.
- Surprising: none.

### src/components/sources/clock.cpp
- Purpose: the clock: a self-rescheduling event that toggles the output.
- Key abstractions: the engine's event queue — `Simulator::self()->addEvent(
  time, element )` and `cancelEvents( element )`.
- Data flow: `updateStep()` (`:51-61`) **cancels its own pending events**,
  forces the output low and, if running, schedules the next toggle at
  `m_psPerCycleInt/2`. `runEvent()` (`:63-71`) flips `m_state`, sets the
  output pin's state, takes the remainder from `getRemainer()` and schedules
  the next half period with the remainder added.
- Non-obvious design decisions: the clock is the only component in this shard
  that *owns* its schedule — it cancels and re-arms rather than being
  re-driven every frame. A property change therefore takes effect at the next
  update without leaving a stale event behind.
- Edge cases / failure handling: `updateStep` cancels first (`:56`), so a
  frequency change while running cannot leave two interleaved event chains.
- Surprising: the half-period is `m_psPerCycleInt/2` — an *integer* division,
  so an odd number of picoseconds per cycle loses half a picosecond per
  toggle, which is exactly what the remainder accumulator exists to correct.

### src/components/sources/csource.h
- Purpose: header for the controlled source.
- Key abstractions: `Csource : public Component, public eResistor` — one
  element covering four topologies.
- Data flow: declarations only.
- Non-obvious design decisions: the two booleans `m_currSource` and
  `m_currControl` (`:67-69`) select the topology; `m_controlPins` decides
  whether the source is controlled by pins or by a fixed value.
- Edge cases / failure handling: none in the header.
- Surprising: the header declares `m_lastTime` and `m_step` (`:63-65`) — the
  controlled source carries a convergence accelerator of its own.

### src/components/sources/csource.cpp
- Purpose: a controlled source — VCVS, CCVS, VCCS or CCCS in one part — with
  its own convergence accelerator.
- Key abstractions: `eResistor` for the internal conductance slot; four pins
  (two control, two source).
- Data flow: `stamp()` (`:93-158`) sets the internal admittance to
  `1/cero_doub` (current-controlled) or `cero_doub` (`:95-96`), then, when
  controlled by pins, stamps a **transconductance** between the control and
  source nodes with `addSingAdm` (`:112-122`): the gain is negated for a
  current source (`:114`) and scaled by the internal admittance for a
  current-controlled source (`:117`). When not controlled by pins, it stamps
  the fixed value directly (`:136-143`).
- Non-obvious design decisions: the voltage-controlled case uses a **geometric
  under-relaxation**: when the same simulation timestamp is seen twice, the
  new current is moved only part of the way from the last one
  (`curr = m_lastCurr + (curr−m_lastCurr)/m_step`) and the step is multiplied
  by **1.8** each attempt (`:212-221`); a change of timestamp resets the step
  to 1, and convergence is `|curr − m_lastCurr| < 1e-7` (`:222-228`).
  `setVoltage` also refuses a NaN input outright (`:201`).
- Edge cases / failure handling: `updateStep()` (`:166-196`) enables, disables
  and relabels the control pins depending on the mode, removes their
  connectors when they are not used, and re-stamps if the simulator is
  running.
- Surprising: the topology is chosen by *two booleans* and the code branches
  on them in three separate places, so a fourth topology (a transformer-like
  VCVS with a different sign) would need a third flag — and the four
  topologies are what the help text calls "Feasible to make: VCVS, CCVS, VCCS,
  CCCS".

### src/components/sources/currsource.h
- Purpose: header for the current source.
- Key abstractions: `CurrSource : public VarSource`.
- Data flow: declarations only.
- Non-obvious design decisions: the output is a plain `Pin` (not an `IoPin`) —
  the current source does not have a digital output state.
- Edge cases / failure handling: none.
- Surprising: none.

### src/components/sources/currsource.cpp
- Purpose: the dial-driven current source.
- Key abstractions: `VarSource` for the dial and the button.
- Data flow: `stamp()` calls `m_outPin->createCurrent()` (`:55-58`) so the
  branch equation exists; `updateStep()` (`:59-67`) stamps
  `m_button->isChecked() ? m_outValue : 0` — the button *enables* the source.
- Non-obvious design decisions: the on/off is a button, and the value is a
  dial; the two are independent, so a source can be "on at 0 A".
- Edge cases / failure handling: none.
- Surprising: unlike `VoltSource`, the current source's output pin is a plain
  `Pin`, so it cannot be used as a logic node.

### src/components/sources/fixedvolt.h
- Purpose: header for the fixed voltage source.
- Key abstractions: `FixedVolt : public Component, public eElement` with an
  `IoPin` output, a `CustomButton` and a `QGraphicsProxyWidget`.
- Data flow: declarations only.
- Non-obvious design decisions: the class declares a `public slots: void
  onbuttonclicked()` (`:39-40`) so the button's behaviour is a slot that can
  be invoked from elsewhere.
- Edge cases / failure handling: none.
- Surprising: `updateOutput()` is declared (`:44`) but the implementation at
  `fixedvolt.cpp:98-102` does not actually update anything except the pin's
  high voltage — the name promises more than it does.

### src/components/sources/fixedvolt.cpp
- Purpose: a push-button-controlled fixed voltage — the canonical "digital
  stimulus" part.
- Key abstractions: `IoPin` (so the output has a real logic state and slew),
  `CustomButton` in a `QGraphicsProxyWidget`.
- Data flow: the button's `clicked` signal is connected to a lambda that
  calls `onbuttonclicked()` (`:59`); that method sets the output pin's state
  if the simulator is not running, or marks the part changed if it is
  (`:89-96`). `updateStep()` (`:81-87`) applies the button state to the pin.
- Non-obvious design decisions: the part exposes a **hidden** property group
  `"Hidden"` containing a single `Out` boolean bound to the button
  (`:69-72`) — so the state of the button is readable and writable as a
  property, which is what makes it drivable from a batch test or a script.
- Edge cases / failure handling: `setSmall` (`:119-141`) resizes the button,
  the part's bounding box and the label font together, so the small variant
  is still clickable.
- Surprising: `stamp()` (`:76-79`) does nothing but set `m_changed` — the
  part is entirely event-driven, and `updateStep` is the only place the pin is
  touched.

### src/components/sources/ground.h
- Purpose: header for the ground.
- Key abstractions: `Ground : public Component` — **no engine element at
  all**; it is a pure graphical part.
- Data flow: declarations only.
- Non-obvious design decisions: ground is not special-cased anywhere in the
  engine.
- Edge cases / failure handling: none.
- Surprising: the class has no `eElement` base, yet it participates in the
  circuit — because an `IoPin` of type `source` held low *is* the mechanism.

### src/components/sources/ground.cpp
- Purpose: the ground symbol: one pin, held at 0 V.
- Key abstractions: an `IoPin` created with type `source` and
  `setOutState(false)` (`:33-34`).
- Data flow: the pin is the whole model; the engine's node-0 handling is
  elsewhere.
- Non-obvious design decisions: the library entry is titled **"Ground (0 V)"**
  (`:20`) — the *name in the palette* states the voltage, which is the UI
  telling the student what a ground is.
- Edge cases / failure handling: none.
- Surprising: this 54-line file is the clearest statement of SimulIDE's
  central design claim — ground is an ordinary part, so there is no
  analog↔digital boundary layer and no special net handling anywhere.

### src/components/sources/rail.h
- Purpose: header for the supply rail.
- Key abstractions: `Rail : public Component, public eElement` with one
  `IoPin` output.
- Data flow: declarations only.
- Non-obvious design decisions: none.
- Edge cases / failure handling: none.
- Surprising: none.

### src/components/sources/rail.cpp
- Purpose: a fixed supply rail (a logic-high net at a chosen voltage).
- Key abstractions: `IoPin` as the output.
- Data flow: `stamp()` (`:65-70`) sets the output pin's high voltage and
  forces its state high. `setVolt` (`:57-63`) **pauses the simulator, stamps,
  and resumes** — so changing a rail's voltage cannot land in the middle of a
  solve.
- Non-obvious design decisions: the rail's output is an `IoPin` at a *chosen*
  voltage, not 5 V — it is a configurable logic-high rail.
- Edge cases / failure handling: the pause/resume in `setVolt` is the
  mechanism, not a lock.
- Surprising: `Rail` has no `updateStep` override and never joins the
  update list — it is entirely event-driven through `stamp()`.

### src/components/sources/varsource.h
- Purpose: header for the dial-driven source base.
- Key abstractions: `VarSource : public Component, public eElement` with an
  embedded `SourceWidget` (dial + button).
- Data flow: declarations only.
- Non-obvious design decisions: the base owns the widget (`SourceWidget
  m_voltw`, `:49`) **by value** and reaches into it (`m_voltw.pushButton`,
  `m_voltw.dial()`), so the derived classes share a single widget
  implementation.
- Edge cases / failure handling: none.
- Surprising: `setflip()` is overridden (`:41`) so the embedded widget is
  mirrored when the part is flipped — a detail every widget-bearing part has
  to remember, and here it is centralised in the base.

### src/components/sources/varsource.cpp
- Purpose: the shared behaviour of the dial-driven sources.
- Key abstractions: `SourceWidget` (a `QDial` and a `CustomButton`).
- Data flow: the dial's `valueChanged` is connected to `dialChanged()`
  (`:50`), which maps the 0–1000 dial onto the min/max range
  (`m_minValue + (m_maxValue − m_minValue)·val/1000`, `:81`) and marks the
  part changed. The button's `clicked` is connected to `onbuttonclicked()`
  (`:49`).
- Non-obvious design decisions: `setVal` (`:86-96`) **widens the range
  automatically** when the requested value is outside it
  (`if (val > m_maxValue) m_maxValue = val; else if (val < m_minValue)
  m_minValue = val;`) — so typing a value never gets silently clamped, it
  moves the range. `setMaxValue`/`setMinValue` (`:98-114`) keep the range
  non-degenerate with a 1e-3 epsilon.
- Edge cases / failure handling: the button's text shows the value with two
  decimals, truncated to five characters (`:67`) — `QString::number(...,'f',2)
  .left(5)` — so a large value is shown truncated with no ellipsis.
- Surprising: `setVal` calls `updateStep()` directly when the simulator is
  not running (`:95`), so a property edit takes effect immediately offline.

### src/components/sources/voltsource.h
- Purpose: header for the voltage source.
- Key abstractions: `VoltSource : public VarSource` with one `IoPin` output.
- Data flow: declarations only.
- Non-obvious design decisions: none.
- Edge cases / failure handling: none.
- Surprising: none.

### src/components/sources/voltsource.cpp
- Purpose: the dial-driven voltage source.
- Key abstractions: `VarSource`; the output is an `IoPin` whose *high
  voltage* is the dial value.
- Data flow: `updateStep()` (`:57-65`) sets `m_outPin->setOutHighV(
  m_outValue )` and the button's state onto the pin.
- Non-obvious design decisions: the output pin is a **digital-class `IoPin`
  with a settable high voltage** (`:36-37` sets both high and low to 0) — so
  a "voltage source" is really a logic-high pin at an arbitrary voltage, not
  an analogue source. That is why a voltage source and a ground are the two
  things a logic circuit needs.
- Edge cases / failure handling: none.
- Surprising: the "Max. Voltage"/"Min. Voltage" properties are in volts, and
  the dial default is `MaxValue = 5 V` (`:52`) with `dialChanged(0)` (`:53`)
  so the part starts at 0 V.

### src/components/sources/wavegen.h
- Purpose: header for the wave generator.
- Key abstractions: `WaveGen : public ClockBase` with a `waveType_t` enum
  (Sine/Saw/Triangle/Square/Random/Wav), a per-type generator method, a WAV
  sample buffer and a second (ground) pin.
- Data flow: declarations only.
- Non-obvious design decisions: the enum and the *string* names are kept in
  parallel (`m_waveTypeStr` and `m_waveType`, `:91-92`) because the property
  value is a translated string while the dispatch is an integer.
- Edge cases / failure handling: none in the header.
- Surprising: the header carries a full WAV-file format description
  (`:109-113`: audio format, channels, sample rate, block size, bits per
  sample) — the part reads audio files.

### src/components/sources/wavegen.cpp
- Purpose: the wave generator: six wave types, event-driven, with a
  hand-written WAV reader.
- Key abstractions: `ClockBase` (frequency, remainder, always-on) +
  `AnalogClock` (the *global* timestep) + a `std::vector<double> m_data` of
  samples.
- Data flow: `initialize()` (`:119-133`) registers itself with the global
  `AnalogClock` for the continuous wave types and schedules an event for the
  discrete ones. `runEvent()` (`:167-202`) computes the phase from the
  simulator's circuit time (`fmod(circTime − phaseTime, psPerCycle)`),
  dispatches to the type-specific generator, and stamps the output. The
  square wave changes its own event interval (`:221-232`) — the generator
  schedules the *next edge*, not the next period.
- Non-obvious design decisions: `setFreq` (`:261-287`) computes the minimum
  step per cycle and, if that is finer than the **global** clock step,
  *coarsens the global clock* — `AnalogClock::self()->setDivider(
  std::ceil( divider ) )` (`:269-273`) — so a fast waveform does not force
  the whole simulation into a tiny timestep. The clock's `getRemainer()`
  is used for the square wave's duty edge (`:231`).
- Edge cases / failure handling: the WAV reader (`:406-532`) validates the
  RIFF/WAVE/fmt /data headers, skips unknown sections with a warning
  (`:452-461`), supports PCM 8/16-bit and IEEE float 32/64-bit (`:469-521`),
  and rejects anything else with a `qDebug` error and a clean return. A
  missing file is reported and the part keeps its old data (`:417-421`).
  `setWaveType` pauses the simulator while it swaps the wave and re-initialises
  (`:333-352`).
- Surprising: `genRandom` uses the global `rand()` (`:236`) with no seeding
  and no per-instance state — two wave generators in one circuit produce
  *correlated* noise from the same global stream, and the sequence is
  identical between runs only because the seed is not changed.

## Ideas worth stealing

- **A non-linear element guesses its own next iterate instead of waiting for
  the matrix to converge** — `src/components/active/op_amp.cpp:150-171` — the
  op-amp declares convergence only when *both* the input difference and the
  output are within `m_accuracy = 5e-6` of the last step (`:150-153`); if not,
  it runs a two-phase guess: the first non-converged step perturbs the output
  by ±1e-6 to learn which way it should move (`:157-163`), and the second
  computes `out = (m_lastOut*dIn + vd*1e-6)/(dIn + m_k)` with
  `m_k = 1e-6/m_gain` (`:165-169`) — a damped extrapolation whose damping
  constant is the model's own gain. *Why it matters for August:* an iterative
  solver needs a rule for "what value do I try next"; this rule is
  model-derived (the damping is 1/gain), so it generalises across models
  instead of being a magic iteration count.

- **A complete geometric under-relaxation policy in eight lines** —
  `src/components/sources/csource.cpp:212-228` — when the same simulation
  timestamp is seen twice, the new value moves only part of the way
  (`curr = m_lastCurr + (curr−m_lastCurr)/m_step`) and `m_step *= 1.8`
  (`:215`); a new timestamp resets the step to 1, and convergence is
  `|curr − m_lastCurr| < 1e-7` (`:222`). *Why it matters for August:* this is
  a complete, tiny, copyable shape for "iterate until stable" — a per-attempt
  step that grows geometrically, reset by the clock, with an explicit
  epsilon. August's `simulate_circuit` convergence ladder could use exactly
  this shape for the "same timestamp, try a gentler step" case.

- **A reactive element is a resistor whose value is recomputed from the
  timestep** — `src/components/passive/reactive/capacitorbase.h:19-20`
  (`updtRes() = m_tStep/m_capacitance`, `updtCurr() = m_volt*m_admit`) and
  `src/components/passive/reactive/inductor.h:30-31` (`updtRes() =
  m_inductance/m_tStep`, `updtCurr() = m_curSource − m_volt*m_admit`), driven
  by `src/components/passive/reactive/reactive.cpp:51-60`. *Why it matters for
  August:* one line of arithmetic turns a stateful element into a stampable
  linear one, so the solver never needs a separate state vector for C and L.
  Any August-side model that needs memory can be collapsed the same way.

- **A coupled multi-element device: invert the coupling matrix once, then do
  O(n²) work per step** —
  `src/components/passive/reactive/transformer.cpp:96-149` — the inductance
  matrix with mutual terms `k·√(L_i·L_j)·sign_i·sign_j` (`:92`) is inverted
  in place by a hand-written LU/Gauss-Jordan (`:97-113`), scaled by the
  timestep (`:135`), and then reused every step as a current-injection matrix
  (`current_i = Σ_j V_j·inva[i][j]`, `:157-162`). The coupling coefficient is
  clamped to `[0.0001, 0.9999]` (`:211-212`) so a perfect transformer is
  numerically impossible. *Why it matters for August:* a transformer, a coupled
  inductor, a multi-port or a thermal network is handled by pre-computing the
  inverse at setup and then never solving again — a large performance win
  that a naive Newton-per-step implementation would miss.

- **A part's geometry can change at run time, and the electrical change is
  *scheduled*, not immediate** —
  `src/components/active/mux_analog.cpp:131-158` (changing the address width
  creates/deletes address pins and channel resistors, resizes the bounding box,
  and **powers the circuit off first** if the simulator is running, `:138`) and
  `:104-105` (the switch itself is deferred: `voltChanged()` computes the new
  address and schedules an event 10 000 ps later; `runEvent()` does the
  admittance swap). *Why it matters for August:* two separable lessons — (a) a
  topology change must not happen mid-solve, and (b) a change that has a
  propagation delay should be *modelled* as a delay rather than applied
  instantly. The `10000/*m_propDelay*/` comment shows the delay is intended to
  become a named property.

- **A multi-part device specified by a tiny text grammar in one property** —
  `src/components/passive/reactive/transformer.cpp:238-262` — the "Primary" /
  "Secondary" property is a string where `:` separates sections (a
  centre-tapped winding), `,` separates coils, and the **sign of each number
  is the winding polarity** (`:301-306`); `getLeght()` derives the coil count,
  the topology string and the pin count (`nCoils*3 + nSections − 1`), and
  `create()`/`modify()` then build or re-lay-out the pins and coils.
  *Why it matters for August:* one editable field describes a whole
  multi-part device, and the same string is what the circuit file stores — a
  student-facing grammar and a serialisation format are the same artefact.

- **A per-component migration hook for a retired file-format key** —
  `src/components/active/diode.cpp:96-107` (`"Zener_Volt"`),
  `src/components/sources/clock-base.cpp:32-40` (`"Out"`),
  `src/components/sources/wavegen.cpp:112-117` (`"Volt_Base"`). Every part may
  override `propNotFound(prop, val)` and *claim* a property name the current
  version does not have, converting it into the modern state.
  *Why it matters for August:* the property table **is** the file format, so
  an old file names properties the new code has never heard of; a per-part
  claim hook is the clean, already-established place to keep that migration —
  and it keeps the migration next to the thing it migrates instead of in a
  central table.

- **The legal values of a property are derived from the engine's own
  registry** — `src/components/active/diode.cpp:64-67` — the "Model" property
  is a `StrProp` whose enum value list is `m_diodes.keys().join(",")`; the
  Zener narrows the inherited property to `m_zeners.keys()` by removing and
  re-adding it (`src/components/active/zener.cpp:29-32`). *Why it matters for
  August:* the property editor physically cannot offer a value the engine will
  reject, and a new model appears in the UI with no UI change. This is the same
  discipline August's `check:brain-config` gate enforces between the Settings
  panel and the backend — but enforced *structurally* here, rather than by a
  separate check.

- **A violated physical limit becomes a visible state, not a silent clamp** —
  `src/components/active/diode.cpp:128-138` — above `MaxCurrent` the part sets
  `m_warning`; above twice `MaxCurrent` it sets `m_crashed`; both drive a
  repaint, so the student *sees* the part in trouble. The electrolysis
  capacitor does the same for reverse polarity
  (`src/components/passive/reactive/elcapacitor.cpp:35-43`).
  *Why it matters for August:* this is the analogue of August's `soaWarnings`
  — a simulator that silently clamps a violated limit teaches the student
  nothing, and one that *marks* the part turns a physical mistake into a
  teachable event.

- **An ideal rail is one shared node, not a net** —
  `src/components/passive/resistors/resistordip.cpp:25` and `:79-90` —
  `eNode ResistorDip::m_puEnode("")` is a **class-static** engine node; every
  pull-up resistor in every instance stamps its top terminal onto that one
  node, whose voltage is set with `m_puEnode.setVolt( m_puVolt )`. Ground is
  the same idea from the other side — an ordinary component whose single
  source-type `IoPin` is held low
  (`src/components/sources/ground.cpp:33-35`). *Why it matters for August:*
  an ideal reference is O(1) instead of O(n), and — more importantly — "ground
  is a part" is why this codebase has no boundary layer between analogue and
  digital and no special net handling anywhere.

- **A fraction accumulator keeps an integer-timestep clock exactly on
  average** — `src/components/sources/clock-base.h:39-45` and
  `src/components/sources/clock.cpp:63-71` — the half-period is an integer
  number of picoseconds, but the fractional remainder of the true period is
  carried in a double and added to the next interval, so a 3 ns period on a
  1 ns grid still averages 3 ns instead of drifting. *Why it matters for
  August:* every periodic stimulus in a harness — a polling loop, a cron-like
  job, a waveform generator — has the same integer-rounding drift and the same
  two-line fix.

- **One component that covers four topologies via two booleans** —
  `src/components/sources/csource.cpp:59-64` (`m_currSource`, `m_currControl`)
  and `:93-158` — the "Controlled Source" is VCVS, CCVS, VCCS or CCCS
  depending on two flags, and the stamp code branches on them in three places
  (`:95-96` sets the internal admittance to `1/cero_doub` or `cero_doub`;
  `:114-122` sets the sign and the transconductance; `:136-143` stamps the
  fixed value). *Why it matters for August:* one learnable part that spans a
  family of behaviours beats four near-identical parts — the same insight the
  `resources#1` shard reached from the help text.

- **A part declares its resolution requirement and the engine coarsens the
  global timestep** — `src/components/sources/wavegen.cpp:261-287` —
  `setFreq` computes the minimum step per cycle (`psPerCycleDbl/m_minSteps`)
  and, if that is finer than the current global step, raises the global
  clock's divider: `AnalogClock::self()->setDivider( std::ceil( divider ) )`
  (`:269-273`). *Why it matters for August:* a project that must run a 10 MHz
  waveform and a 1 Hz waveform in the same session needs exactly this — one
  part declares what resolution it needs and the engine coarsens the global
  step, instead of every part dragging the timestep down.

- **A shared symbol painter for a family of parts** —
  `src/components/passive/resistors/resistor.cpp:49-61` — `drawAnsi` is a
  `public static` member of `Resistor`, and it is reused by the variable
  resistor (`varresistor.cpp:69`), the potentiometer
  (`potentiometer.cpp:160`), the thermistor (`thermistor.cpp:83`), the LDR
  (`ldr.cpp:93`), the RTD (`rtd.cpp:89`) and the resistor DIP
  (`resistordip.cpp:202`, with scale factors). *Why it matters for August:* the
  visual vocabulary of a part family is defined once, and every member stays
  consistent for free — the cheapest possible "family resemblance" in a UI.

- **The property table *is* the file format, and two flags decide what is in
  it** — `src/components/component.cpp:102-130` — every part inherits three
  property groups (`"CompBase"`, `"CompGraphic"`, `"Board"`) that are all
  marked `groupHidden | groupNoCopy`, so identity, geometry and the board
  coordinates are *never* written to the circuit file; the flags themselves
  are `src/gui/circuitwidget/compbase.h:19-22`. The converse case is the
  interesting one: `LinkerComponent`'s `"Links"` group is `groupHidden` but
  **not** `groupNoCopy` (`src/components/linkercomponent.cpp:24-27`), so the
  link set *is* persisted. *Why it matters for August:* one flag decides
  "editor-only" vs "part of the artefact", and a serialisation format that
  needs no separate schema can be built directly on top of it — the same
  discipline as August's `check:brain-config`, but structural.

- **A pending-output queue that RE-TIMES a change instead of dropping it** —
  `src/components/iocomponent.cpp:154-179` — `scheduleOutPuts` keeps two
  parallel queues (the pending output values and their due times,
  `src/components/iocomponent.h:87-88`); if an event is already in flight the
  new value is pushed with a *new due time* rather than stacked, and
  `runOutputs()` (`:135-152`) drains the queue and re-arms the next event.
  *Why it matters for August:* a tool that reports a changing value (a
  progress figure, a tool result, a stream frame) needs this exact policy —
  "the newest value wins, and it is delivered at the time it was asked for" —
  and it is only five lines.

- **A whole library of electrical characteristics can live in a DATA file** —
  `src/components/logicfamily.cpp:128-162` and
  `src/components/logicfamily.h:10-20` — the "logic family" (supply voltage,
  input thresholds, impedances, delays, pull-ups) is a `logicFamily_t` struct
  of nine doubles, the registry is a `QMap` loaded from
  `logic_families.model`, and the property editor's enum is built from the
  *same map* (`src/components/iocomponent.cpp:45-46`). The thresholds are
  stored as *fractions of the supply* (`logicfamily.h:89-95`), so changing the
  supply moves them with it. *Why it matters for August:* a harness that
  supports several model tiers (cheap/local vs hosted, fast vs accurate) can
  put the tier definitions in a data file and derive the choices UI from the
  same source — and August already has the `check:brain-config` gate that
  keeps the two in step.

- **A part-to-part value link, persisted by UID** —
  `src/components/linker.cpp:38-52` and `:114-117`, with the property at
  `src/components/linkercomponent.cpp:24-27` — a `Linker` holds a list of
  linked components live and a comma-separated UID string on disk; on load
  the string is re-resolved against the circuit (`:38-52`), and
  `emitLinkedValue` pushes a value to every linked part. The linked part
  shows its link index painted on its symbol
  (`src/components/component.cpp:688-693`). *Why it matters for August:* this
  is the closest thing in the whole repo to a live data path between two
  parts, and it survives a save/load — the shape an August "one tool's output
  drives another's input" link would need. (Caveat: the resolution is a
  *substring* match, `linker.cpp:46`, so a UID that prefixes another can bind
  the wrong part — see Uncertainties.)

- **A colour can be an ELECTRICAL parameter, not just a paint choice** —
  `src/components/outputs/leds/ledbase.cpp:108-125` — choosing "Blue" on an
  LED sets its forward voltage to 3.6 V, and that threshold goes into the
  engine element (`eLed::setThreshold`). *Why it matters for August:* in a
  logic-circuit course the *appearance* of a part is a teaching surface; if
  the palette entry changes the model's numbers, the student sees the
  consequence immediately instead of reading a datasheet.

- **A violated physical limit becomes a BLINKING state, not a silent clamp**
  — `src/components/component.cpp:666-682` — `paintSelected` fills a crashed
  part orange and a warning part yellow, and the fill **pulses** because the
  painter's opacity is driven by a per-paint counter. The LED family sets the
  same two flags from the over-current ratio
  (`src/components/outputs/leds/ledbase.cpp:76-85`). *Why it matters for
  August:* a simulator that clamps teaches the student nothing; one that
  *marks* the part turns a physical mistake into a teachable event — the
  analogue of August's `soaWarnings`.

- **Undo is captured at the START of a drag, as a snapshot of property
  strings** — `src/components/component.cpp:272-278` — the first mouse-move
  opens a circuit batch, writes the pre-move `"Pos"` of every moved component
  and the pre-move `"pointList"` of every moved connector, and closes the
  batch at the end. The connector's whole polyline is captured as a
  *string*, so restoring it is a re-parse, not a geometry restore. *Why it
  matters for August:* one gesture becomes one undo entry, and the undo
  payload is the same text the file format uses — so an undo entry and a
  saved file are the same kind of thing.

- **A topology change powers the circuit off first — every time** —
  `src/components/outputs/leds/ledbase.cpp:94-106` (grounding an LED),
  `src/components/outputs/leds/ledbar.cpp:135-146` (resizing the bar),
  `src/components/outputs/leds/ledmatrix.cpp:91-101` (rebuilding the
  grid), `src/components/outputs/leds/sevensegment.cpp:134-157` (adding a
  digit), `src/components/other/subpackage.cpp:299-339` (board mode) — the
  pattern is always the same: `if( Simulator::self()->isRunning() )
  CircuitWidget::self()->powerCircOff();` before anything is added, removed
  or rewired. *Why it matters for August:* one rule ("never change the model
  mid-solve") enforced in one idiom, visible in every place that violates it
  — and the same idiom is used for *solver* parameters, not just topology
  (`src/components/iocomponent.cpp:262-299` pauses and resumes around a pin
  impedance change).

- **A protocol controller modelled as "how many bytes does this command
  take"** — `src/components/outputs/displays/tftcontroller.cpp:73-179` — the
  whole SSD/ILI-style command table is a flat list of `m_readBytes = n`
  assignments, and `dataReceived()` (`:181-263`) consumes that many bytes and
  assembles the addresses from them. The derived displays override only the
  three commands they differ on. *Why it matters for August:* an emulated
  peripheral with a command table can be written as a *data* table plus one
  dispatcher, rather than a switch per command — and the same shape works for
  an MCP tool schema or a skill manifest.

- **The hardware protocol is faithful enough that real firmware works** —
  `src/components/outputs/leds/ws2812.cpp:157` (the WS2812's colour bytes
  arrive **GRB**, not RGB, and a model that got it wrong would show every
  colour wrong) and
  `src/components/outputs/leds/max72xx_matrix.cpp:122-133` (the MAX72xx
  is a 16-bit shift register with the address in the *high* byte, so a
  student's `sendByte()` sequence works unchanged). *Why it matters for
  August:* a logic-course simulator that gets the wire order wrong teaches the
  wrong lesson; the discipline of copying the protocol from the datasheet
  bit-for-bit — masks and shifts, no clever colour classes — is the thing to
  copy.

- **A part's pin IDs are the file-format contract; the labels are only the
  drawing** — `src/components/outputs/displays/hd44780.cpp:38-53` — the
  labels read `RS`, `RW`, `En`, `D0`…`D7` while the saved ids are `-PinRS`,
  `-PinRW`, `-PinEn`, `-dataPin0`…; and where a part's pins were renamed
  between releases, the ids are *pinned to the old names* for compatibility
  (`src/components/outputs/displays/ili9341.cpp:29-31`). *Why it matters for
  August:* an id is a durable, machine-facing name and a label is a
  human-facing one; conflating them means every UI change breaks every saved
  file.

- **A composite part whose children are REAL parts** —
  `src/components/outputs/leds/ledbar.cpp:73-105` — the LED bar creates N
  `LedSmd` children, each with its own pair of `Pin`s and its own engine
  element, parents them to itself and makes them unselectable; the bar then
  delegates every electrical property to element 0 and fans it out
  (`:148-166`). *Why it matters for August:* a multi-element widget (a
  keyboard, a register file, a pin bank) can be built as a container of real
  components rather than a special case in the engine — and the container's
  property dialog is then just a fan-out.

- **A geometry change is deferred to the per-step poll while the simulator
  runs** — `src/components/graphical/shape.cpp:106-110` — `changed()` sets a
  dirty flag and applies the change immediately *only when the simulator is
  not running*; otherwise `updateStep()` (`:60-69`) picks it up on the next
  frame. *Why it matters for August:* a redraw storm is prevented by one
  dirty-flag idiom, and the same idiom (a `m_changed` flag + an `updateStep`
  poll) is the performance mechanism across this whole shard.

- **A test harness whose expected answer is a HIDDEN saved property** —
  `src/components/other/testunit.cpp:79-129` and `:166-179` — the Test Unit
  drives every input combination on a *self-rescheduling event paced by
  simulation time* (`:92`, `:118`, `:127`), samples the outputs into a truth
  vector, and compares against a truth table stored as the hidden property
  `"Truth"` (`:58-59`); the dialog then shows the *measured* value in the
  mismatching cell (`src/components/other/truthtable/truthtable.cpp:131-135`).
  *Why it matters for August:* a "the harness checks its own output" skill —
  sweep the inputs, record the outputs, compare against a stored expectation,
  and show the student the measured value where it differs — is exactly this
  shape, and the expectation travels with the circuit.

- **A protocol state machine reset by a PROTOCOL event, not a timeout** —
  `src/components/outputs/displays/aip31068_i2c.cpp:85-110` — the I²C
  variant keeps a three-state phase (control byte, data byte, idle) that is
  reset by the I²C **STOP** condition (`:88`) rather than by a clock, so a
  truncated transaction leaves the device in a defined state. *Why it matters
  for August:* a skill that drives a serial protocol should end on a
  protocol-level terminator, so a half-finished run cannot masquerade as a
  clean one.

- **A bus that changes direction with a control line** —
  `src/components/outputs/displays/ks0108.cpp:110-118` — the RW line decides
  whether the part *drives* the eight data pins or releases them, and the
  pin mode is switched accordingly; reads happen on the rising clock edge and
  writes on the falling (`:119-131`). *Why it matters for August:* a
  simulated device that has to *both* talk and listen has to model the
  direction, and the pin-mode switch is a one-line way to express it.

## Files skipped (with reasons)

None. Every one of the **183** files in this shard was opened and read in
full; none is generated, vendored, binary or large. The largest file is
`src/components/other/subpackage.cpp` (27 721 bytes, 859 lines) and the
smallest is `src/components/comp2pin.h` (483 bytes, 15 lines); the shard
totals 617 251 bytes. The one file that is not C++ —
`src/components/other/truthtable/truthtable.ui` (110 lines) — is a Qt
Designer form and was read in full as well, because it carries the three
button captions ("Run test", "Clear test", "Save as correct") that are the
component's whole pedagogy.

## Uncertainties

- **The previous version of this report claimed the shard name was not in the
  manifest, and that was wrong.** It stated that the manifest's `owner-shard`
  column held only `src-components-01/02/03` and that no row matched
  `components-analog`, and it therefore invented an 82-file "semantic" shard
  out of `active/` + `passive/` + `sources/`. The manifest has **183** rows
  whose column 4 is exactly `components-analog`, covering the whole
  `src/components/` tree. I re-derived the file set mechanically this time
  (group the manifest's column 4 over all 1 359 data rows) and every one of
  the 183 paths now has its own note and its own ledger row. **The manifest
  was not modified** — it is read-only by instruction, and it is correct as it
  stands. The likely cause of the first pass's error is that it read a
  different or stale copy of the manifest; I did not investigate further,
  because the file is not mine to change.

- **I did not read the engine core, so I cannot state the solver's iteration
  limits or its convergence policy.** I read `src/simulator/e-element.h` and
  `src/gui/circuitwidget/compbase.h`, and grepped `itemlibrary.cpp` and
  `compbase.cpp`, but I did not read `simulator.cpp`, `matrix.cpp` or the
  non-linear solver. So I verified that `eElement::m_changed` exists
  (`src/simulator/e-element.h:53`), that the `IoComponent` output queue
  exists, and that `Component::paintSelected` renders the warning/crash
  states — but **not** how many iterations the solver allows, what it does
  when it does not converge, or how the update list is walked. The
  `simulator-core` shard owns those.

- **Several conclusions in this report are code-reading conclusions, not
  measured ones.** I did not compile, execute or run anything from the clone.
  The findings that would benefit from a runtime check are: (a) the
  **SSD1306 scroll-speed table is inert** — the `switch` at
  `src/components/outputs/displays/ssd1306.cpp:184-193` has no `break`
  statements, so every scroll-frequency code falls through to the last case
  and sets `m_scrollStep = 2`; (b) the **text component's `"/n"` typo** at
  `src/components/graphical/textcomponent.cpp:250`, where a newline was
  clearly meant; (c) the **KS0108's `&` where `&&` was meant** at
  `src/components/outputs/displays/ks0108.cpp:140`, harmless for 0/1 bools;
  (d) the **HD44780's empty read path**
  (`src/components/outputs/displays/hd44780.cpp:128-136`), so a read request
  is accepted and the bus is never driven; (e) the **GC9A01A's command table
  left commented out** (`src/components/outputs/displays/gc9a01a.cpp:46-95`),
  so that panel relies entirely on the generic ST77xx command handling; and
  (f) the **`Strain::m_drPrecalc` uninitialised read**, inherited from the
  first pass, where the member has no initialiser
  (`src/components/passive/resist_sensors/strain.h:66`) and the only writer,
  `updateParameters()` (`src/components/passive/resist_sensors/strain.cpp:137`),
  is reachable only from the two temperature setters (`:143`, `:149`) — never
  from the constructor.

- **`Node::hasCurrents()` reads a variable that is technically
  uninitialised** — `src/components/node.cpp:58-74` — `current` is declared
  without an initialiser at `:58` and accumulated at `:67`; it is only read
  when exactly two pins carry a current, in which case the first loop
  iteration has already set it, so the value is correct in practice. I flag
  it because the code is right by accident, not by construction.

- **`Linker::createLinks()` resolves saved UIDs by SUBSTRING, not equality**
  — `src/components/linker.cpp:46` (`comp->getUid().contains( uid )`) — so a
  UID that is a prefix of another can bind the wrong component when a
  circuit is loaded. I did not construct a case where this bites.

- **I did not verify the previous pass's citations exhaustively.** I
  re-opened and content-checked **64** of its `path:line` references
  (spanning all three of its directories) and every one resolved to the
  right line with the right content, so I kept its notes verbatim. The
  remaining ~40 of its inline references I did not re-open individually;
  they are the same kind of in-file pointer and carry the same risk. All of
  the citations in the *new* notes in this pass were written from files I
  read directly in this pass, and I ran an automated range-and-content check
  over every `path:line` reference in the finished report.

- **The undo/redo story for this shard is indirect.** No file in this shard
  implements undo. The connection is: the property table is the file format
  (`src/gui/circuitwidget/compbase.cpp:117-135` — `toString()` iterates the
  property groups), and the property *widget* is what records an undo entry.
  `Component::mouseMoveEvent` is the one place in this shard that writes
  undo entries directly (`src/components/component.cpp:272-278`), which is
  why it is cited above; the widget path, and the undo machinery itself,
  belong to the GUI shard.

- **The component/plugin model in this repo is *not* directory-driven, which
  contradicts the sibling `build-root` shard's framing.** `build-root.md:143`
  says the `components-analog` and `components-digital` shards' "construct /
  libraryItem() pairs" rely on a directory-driven registry. What I found is
  the opposite: `ItemLibrary::loadItems()`
  (`src/gui/componentlist/itemlibrary.cpp:149-337`) is a **hand-maintained
  list** — one `addItem( X::libraryItem() );` line per part, plus an
  `#include` at the top of the same file (`:6-133`) — so adding a part costs
  one file plus two lines. The *build* is glob-driven (`SimulIDE.pri` globs
  sources), but the *library* is not. The `construct`/`libraryItem()` pair is
  a factory-function-pointer registration, not a plugin system: there is no
  dynamic loading, no version negotiation and no discovery. The only parts
  that are **not** in the library are the ones that are not palette items —
  `LedSmd` (`src/components/outputs/leds/ledsmd.h:13`), the transport mix-ins
  `Spi3Pins`/`Spi5Pins`, and `SubPackage`'s `EditDialog`.

- **The "scripting and embedded-code support" lens has almost no surface in
  this shard.** The closest things are: the `propNoCopy` / `groupNoCopy` /
  `groupHidden` property flags
  (`src/gui/circuitwidget/compbase.h:19-22`), which keep editor-only
  controls out of the saved file and expose hidden boolean properties such as
  the fixed voltage's `"Out"`
  (`src/components/sources/fixedvolt.cpp:69-72`) and the clock's `"Running"`
  (`src/components/sources/clock-base.cpp:25-28`) that a batch test or an
  external driver can set; the **link** mechanism
  (`src/components/linker.cpp:114-117`), which lets one part's value be
  driven by another part's output; and the DC motor's explicit
  `"to be called from scripts"` property accessor
  (`src/components/outputs/motors/dcmotor.cpp:83-90`) plus its `Watched`
  register interface (`src/components/outputs/motors/dcmotor.cpp:178-185`).
  There is no embedded scripting language and no user-programmable component
  in this shard; the MCU simulation lives in `src/microsim/`, outside it.
