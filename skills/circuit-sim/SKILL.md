---
name: circuit-sim
description: Search real parts and simulate SPICE circuits (ngspice); firmware-in-the-loop, HDL, FPGA, and KiCad flows under /circuit mode.
category: engineering
---

# Circuit lookup + simulation

Proteus-style flow: pick real parts, write a netlist, simulate, render.

## What this skill is

A workflow for circuit work in August: real-part lookup, SPICE netlist
authoring, ngspice simulation, and rendering schematics, 3D previews, and
waveform charts. It encodes the part-search → integrate → simulate →
render loop and the install requirements for ngspice.

## When to Use

- The user wants to design, simulate, or render a circuit.
- You need a real part's SPICE model before writing the netlist (classic
  parts like op-amps, BJTs, regulators, timers).
- A schematic, board preview, or waveform plot is a useful artefact for
  the answer.

## Prerequisites

- `ngspice` installed on the host (`winget install ngspice` on Windows, or
  set `AUGUST_NGSPICE_EXE` to the executable path).
- Network access for `web_fetch` when pulling a manufacturer model file
  (pass `network: true` on the `run_command` if installing ngspice mid-run).

## How to Run

1. `load_skill "circuit-sim"` so the netlist and tool names are fresh.
2. `circuit_search_component` (and `circuit_integrate_component` for board
   spec sheets) BEFORE writing the netlist.
3. Write a netlist with a title comment, real `.include` lines for
   manufacturer models, and explicit `.measure` statements.
4. `circuit_simulate` to run ngspice, then `render_chart` for waveforms.
5. `draw_circuit` for the schematic, `circuit_render_3d` for the board
   preview. State ideal-vs-real assumptions next to numeric results.

## 1. Find components

`circuit_search_component` looks up parts:

- Keyword or part number: `{"query": "lm358 opamp"}` → curated
  datasheet facts for classic parts (diodes, BJTs, regulators, op-amps,
  timers) plus live web datasheet links.
- `circuit_integrate_component` goes further: board spec sheets
  (Arduino/ESP/Raspberry Pi families) and ready-to-paste SPICE `.model`
  cards for the classics. Call it BEFORE designing with an unfamiliar part.
- If the network lookup fails, fall back to `web_search
  "<part> datasheet pinout"`.

## 2. Simulate

`circuit_simulate` runs ngspice batch on your netlist:

```
* RC low-pass
V1 in 0 AC 1
R1 in out 1k
C1 out 0 1u
.ac dec 10 1 1Meg
.control
run
meas ac vout_max find v(out) at=1k
.endc
.end
```

- First line is the title comment; end with `.end`.
- `.op` returns every node voltage `v(node)` and source current
  `i(vsrc)` parsed into `measures`. For `.tran`/`.ac`/`.dc` decks add
  `.measure` statements (or control-block `meas`) — those numbers come
  back parsed as `measures: {name: value}`.
- Real parts: fetch a manufacturer SPICE model with `web_fetch`,
  save it with `write_file` (e.g. `models/lm358.lib`), then
  `.include models/lm358.lib` in the netlist. When no model exists,
  use a behavioral equivalent (RC, ideal diode) and say so.
- ngspice must be installed (`winget install ngspice` or set
  `AUGUST_NGSPICE_EXE` to the executable path); the tool returns
  install guidance when missing.

## 3. Render

- `draw_circuit` draws the schematic PNG (series-loop elements with
  labels and directions).
- `circuit_render_3d` renders a board preview PNG from a netlist.
- `render_chart` plots waveforms from measured/wrdata columns.
- `circuit_annotate` runs `.op` and draws the voltage-colored schematic
  SVG (blue→red) with branch currents — the at-a-glance bias picture.
- `hdl_timing_diagram` renders WaveDrom WaveJSON to a timing SVG for
  protocol/handshake explanations (also emits a zero-install
  svg.wavedrom.com URL).

Always state assumptions (ideal vs real models, tolerances) next to
the numeric results.

## 4. Firmware-in-the-loop (MCU + analog together)

The compile → emulate → bridge chain:

1. `firmware_compile` — Arduino sketch (`board=uno/nano/mega`) or plain C
   (avr-gcc) → HEX artifact + flash/RAM usage.
2. `firmware_run` — emulate the HEX for bounded milliseconds: serial
   monitor capture, GPIO state per pin, `expect`/`fail` serial
   assertions, and with `timeline=<name>` a pin-edge timeline persisted
   as `<name>_pins.json`.
3. `firmware_stimulus` — convert that timeline into ngspice PWL sources
   (`Vp<pin> N<pin> 0 PWL(...)`, board-aware logic level 5V/3.3V) and
   optionally inject them into a deck copy (`<name>.cir`) → hand to
   `circuit_simulate` for PWM-into-RC-filter mixed-signal runs.
4. `circuit_lint_diagram` — validate a diagram.json breadboard-wiring
   artifact (Wokwi-compatible parts + `"part:pin"` connections) when the
   task involves wiring around the MCU; netlists stay the SPICE source
   of truth, the diagram describes the breadboard and pins the co-sim
   mapping.

## 5. HDL + FPGA

- `hdl_lint` — instant file:line syntax/semantic check (ghdl for VHDL,
  verilator/iverilog for Verilog); run it after every HDL edit, before
  any sim.
- `hdl_simulate` — run a self-contained testbench; the `.vcd` waveform
  lands in the workspace and the right Circuit panel renders it
  (Surfer viewer).
- `hdl_test` — cocotb Python testbenches with a JUnit XML verdict
  (requires `uv sync --extra eda` for cocotb + ghdl/iverilog installed).
- `vcd_parse` — read any VCD: signal activity, pulse widths,
  value-at-time queries, and UART decode (baud auto-detected, 8N1) —
  the protocol-analyser slice for both HDL and SPICE-digital dumps.
- `fpga_compile` — full Quartus flow (`quartus_sh --flow compile`),
  pin map via `pins={signal: PIN_xx}`, reports parsed to
  logic-elements/registers/fmax vs. device capacity, `.sof` artifact to
  the workspace. `fpga_program` (JTAG download) is confirm-gated
  hardware — never auto-run it.
- `kicad_checks` / `kicad_render` — ERC/DRC gates and real-board
  PNG/GLB visuals on genuine `.kicad_sch`/`.kicad_pcb` designs.

## Pitfalls

- Skipping the part search and writing a behavioral circuit for a part
  with a real model. The user expects real-part simulation when one
  exists; use the integrate step first.
- Forgetting `.measure` statements on `.tran` / `.ac` / `.dc` decks. The
  tool returns `measures: {name: value}` parsed from those, so absent
  measures means you get no numeric receipt.
- Running ngspice without `.end` (or with the title line missing). The
  tool returns a parse error; fix the netlist, do not retry with
  cosmetic changes.
- Mixing `i(vsrc)` references when the source is named differently
  (`V1` vs `Vin`). Names are case-sensitive in SPICE.
- Calling HDL/FPGA/KiCad tools without `/circuit` mode — they are
  gated; run `circuit_env` first and follow its install guidance when
  an engine is missing instead of shelling out manually.
- Editing HDL without an immediate `hdl_lint` pass. Small VHDL syntax
  errors surface best at the lint step with file:line, not deep in a
  testbench run.
- Treating a `firmware_run` GPIO toggle count as proof the circuit
  works — the analog half needs the `firmware_stimulus` →
  `circuit_simulate` chain (or bench measurement) for that claim.

## Verification

- The simulate result includes parsed `measures` and (for `.tran`/`.ac`)
  waveform data you can plot. Numbers without units or "around zero"
  prose are not a receipt — re-run with explicit `.measure`.
- The render step (schematic / 3D / chart) must visibly match the
  netlist: if the rendered netlist has nodes the simulation did not
  reference, your schematic generator drifted from your deck.
- State ideal-vs-real assumptions next to any number you report.
- For firmware claims, the receipt is the `firmware_run` serial capture
  + `assertionsOk` flag (expect/fail text), and for mixed-signal claims
  the `firmware_stimulus` deck's simulated waveform (e.g. RC-filter
  output that actually settles toward the rail, not a pass-through).
- For FPGA claims, the receipt is `fpga_compile`'s parsed `fit`
  utilization + `.sof` artifact path — not "the tool ran".
