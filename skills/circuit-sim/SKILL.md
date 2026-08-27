---
name: circuit-sim
description: Search real parts and simulate SPICE circuits (ngspice).
category: engineering
---

# Circuit lookup + simulation

Proteus-style flow: pick real parts, write a netlist, simulate, render.

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

Always state assumptions (ideal vs real models, tolerances) next to
the numeric results.
