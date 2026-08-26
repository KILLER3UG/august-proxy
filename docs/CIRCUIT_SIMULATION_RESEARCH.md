# Circuit Simulation Fidelity Research — how the open-source tools work, and what august now does

Research question: *how do KiCad / Proteus / SimulIDE / Falstad actually simulate, so that a
circuit august builds and simulates also works when built as a real machine?*

Every claim below carries a numbered citation from the retrieval ledger (see Sources).
Findings marked `[implemented]` are wired into `app/services/tools/circuit_tools.py`.

## 1. The landscape — who uses which engine

| Tool | Engine | Real-time interactive? | Accuracy stance |
|---|---|---|---|
| KiCad (Eeschema simulator) | **ngspice embedded** [1] | no (graph-based runs) | full SPICE accuracy |
| Proteus VSM (closed source) | mixed-mode **SPICE + MCU CPU simulators** [10] | yes | commercial-grade |
| SimulIDE | its own C++ engine; MCUs via gpsim (PIC) / simavr (AVR) [4] | yes | "not an accurate simulator for circuit analysis... simple and not very accurate electronic models" — their own words [4] |
| Falstad CircuitJS1 | its own engine (Java→GWT browser port), not SPICE [5] | yes | intuition-oriented |
| ngspice | the reference open-source SPICE-3f5 descendant [2][8] | batch/interactive | reference-grade |
| PySpice | Python wrapper driving ngspice/Xyce [6] | no | inherits ngspice |

**Decision for august:** use **ngspice** as the engine. It is literally what KiCad embeds [1],
so results line up with the most widely used open-source EDA flow, unlike SimulIDE/Falstad whose
own documentation disclaims analysis accuracy [4][5]. Proteus's differentiator is not the analog
engine (it is SPICE too) but Virtual System Modelling: firmware runs against the schematic as a
virtual prototype so "when the physical prototype finally arrives the firmware has already been
completed and tested" [10].

## 2. Why sims diverge from benches — the documented traps

1. **SPICE unit suffixes**: `M` = milli, `Meg` = mega; everything after a scale factor letter is
   ignored [8 Table 2.1][1]. A resistor typed `1M` in a deck meant as 1 MΩ simulates as 1 mΩ.
   KiCad calls this out explicitly in "Assigning models" [1].
   → **[implemented]** `parse_spice_value` implements Table 2.1 exactly;
   `lint_netlist` flags any R value that parses below 1 Ω with a "did you mean Meg?" warning.

2. **Implicit models come from refdes prefixes**: passives get models assigned implicitly when the
   reference matches the device type (`R*`, `C*`, `L*`) and use the value field [1]. A capacitor
   refdes'd `R12` silently simulates as a resistor.
   → **[implemented]** lint checks refdes-prefix/node-count consistency per device class.

3. **Ground node requirement**: SPICE solves nodal equations relative to node 0; decks without a
   ground produce singular-matrix failures or meaningless results [8 ch.2].
   → **[implemented]** lint requires node `0`.

4. **Convergence failures** are normal for real circuits (ideal switches, stiff sources). ngspice
   escapes them with gmin stepping then source stepping, tunable via `.options` (gmin/abstol/
   itl1/rshunt are documented knobs; rshunt adds a resistor from each node to ground) [8 ch.11.1,
   11.1.2.1].
   → **[implemented]** `simulate_circuit` retries on a 5-rung convergence ladder
   (defaults → gmin → +abstol → +itl1 → +rshunt) and reports which rung converged
   (`convergedWith`) — mirroring how ngspice itself coaxes operating points.

5. **"Simulates fine" ≠ "survives the bench"**: parts run outside their Safe Operating Area work
   in simulation but fail in hardware. ngspice has an explicit SOA checker (`.option warn=1`)
   that warns when device branch voltages, currents, dissipated power or die temperature exceed
   model limits during `.op/.dc/.tran` [8 ch.11.5].
   → **[implemented]** later ladder rungs enable warn-mode; `soaWarnings` are surfaced to the
   model/user so over-stress designs are flagged before prototyping.

6. **Temperature defaults**: device parameters are referenced at TNOM=27 °C and circuit temp is
   settable per deck (`.TEMP`, instance TEMP/DTEMP) [8 ch.1.3, 11.1]. Real machines run hot.
   → noted for the model prompt hint: thermal-sensitive designs should declare `.temp`.

7. **Netlist is the interchange contract**: KiCad exports SPICE netlists from schematics; that
   netlist is "the link" between capture, simulation and PCB layout [9]. August follows the same
   architecture — netlists (.cir/.net/.ckt/.sp) are first-class workspace files that both
   `circuit_simulate` and `circuit_render_3d` consume.

8. **`.meas` gives bench-equivalent numbers**: `.measure` statements analyze tran/ac/dc output
   data after the run [8 ch.11.4] — the same numbers a multimeter/scope would read.
   → already parsed into `measures` by `simulate_circuit`; lint nudges decks toward including
   measurement cards.

## 3. What this means for "works in the machine"

No simulator guarantees a working physical build — but the failure modes are known and checkable.
August's pipeline now enforces the same discipline the tools above document:

- correct SPICE semantics (units, refdes classes, grounds) before running;
- ngspice itself (KiCad's engine) for the numbers [1];
- convergence handled the way ngspice handles it [8];
- SOA stress surfaced instead of hidden [8];
- netlists kept as durable, editable artifacts so designs iterate like a KiCad project [9].

Remaining gaps vs. Proteus-class VSM (documented, deliberate): no MCU firmware-in-the-loop yet
(Proteus pairs SPICE with instruction-set simulators [10]; SimulIDE delegates to gpsim/simavr [4]).
That is the natural next milestone — ngspice shared-library binding (danchitnis/ngspice shows the
WASM path [3], PySpice the Python/CFFI path [6]) plus a simavr/gpsim bridge for firmware co-sim.

## Sources

[1] https://raw.githubusercontent.com/KiCad/kicad-doc/master/src/eeschema/eeschema_simulator.adoc — KiCad Eeschema Simulator Manual
[2] https://ngspice.sourceforge.io/docs.html — ngspice Documentation
[3] https://github.com/danchitnis/ngspice — WebAssembly ngspice (danchitnis)
[4] https://www.simulide.com/p/simulide-main-features.html — SimulIDE Features
[5] https://github.com/PFalstad/CircuitJS1 — CircuitJS1 (Falstad)
[6] https://github.com/PySpice-org/PySpice — PySpice
[8] https://ngspice.sourceforge.io/docs/ngspice-html-manual/manual.xhtml — ngspice User Manual
[9] https://raw.githubusercontent.com/KiCad/kicad-doc/master/src/eeschema/eeschema_create_a_netlist.adoc — KiCad: Create a Netlist
[10] https://www.labcenter.com/whyvsm — Proteus — Why VSM (Labcenter)
