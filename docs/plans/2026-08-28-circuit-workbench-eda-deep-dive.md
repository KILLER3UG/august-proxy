# August Circuit Workbench — EDA Ecosystem Deep-Dive & Feature Plan

**Date:** 2026-08-28 · **Status:** IMPLEMENTED 2026-08-28/29 — Phases 0–4 committed (`884506bd`, `25e1bb7b`: circuit_env/test/inject_fault/export_vcd, traces/sweep, golden tests). **Exception: the ModelSim driver + hardened GHDL resolver (`hdl_tools.py`) and its test (`test_hdl_modelsim_driver.py`) are still UNCOMMITTED in the working tree as of 2026-09-03** — they are NOT part of those two commits. Phases 5–6 (Quartus flow, advanced EDA tools) pending · **Scope:** `backend-py` circuit/HDL tools + desktop Circuit panel + FPGA flow

**Review pass (2026-08-28, post-`471482a1`):** re-verified against the tree after the five commits that landed since this plan was written (workbench kernel split, `/verbose`, R-C billing, skill-template work, 7-bug batch + right-panel). Findings: `circuit_tools.py` / `artifact_tools.py` / the circuit frontend components are byte-identical, so every Part-2 anchor there still holds; the policy-table row mislabeled `_PROMPT_SHELL` as `_SHELL_EXACT` (corrected below); all planned tools remain greenfield; skills moved to root `skills/` (user correction folded in); and §5 now covers the new harness layer (`kernel.py` tool bridge, `edit_verification.py`, `read_before_edit.py`, `shadow_git.py`) that postdates the plan.

**Review pass 2 (2026-08-28, post-`ccb7485c`):** re-verified after five more commits (Part 15 memory CRUD `848b952c`, 3-header settings IA `4b7784eb`, sidebar Tasks group `cd8f0a26`/`44dd6693`/`ccb7485c`). Findings: circuit backend and circuit frontend are *still* byte-identical — every `circuit_tools.py` / `artifact_tools.py` anchor holds unchanged; `tool_policy.py` gained the Part 15 memory doors (`list_facts` read `:50-52`, `forget` write `:66-68`), shifting every policy anchor from line 50 down by +6 — the policy row and §5.4 are re-anchored below; the parity oracle was updated in the same commit as the policy (`848b952c`), confirming the §5.5 policy+oracle-together pattern; the right drawer became an overlay (Part 15.4: `RightDrawer.tsx` panel is now `absolute right-0 z-30` + Escape-dismiss) — cosmetic for the Circuit section, no plan impact; all planned tools remain greenfield; `backend-py/skills/` is gone (root `skills/` only). No §4 phase content changed.

This plan supersedes the unapproved pasted spec of 2026-08-27 (Phase-2 circuit enhancements). Its four proposals are folded in here: SPICE infix → Q1; topological placement → superseded by Phase 5 (tscircuit/KiCad placement replaces the sqrt-grid); library expansion → §4 P1.6; the four new EDA/FPGA tools → expanded into Phase 4 (seven tools).

Research basis: three parallel web-research sweeps (2026-08-28) covering Quartus Prime, SimulIDE, Proteus, Electronics Workbench/Multisim, Qucs-S, LTspice, Falstad/CircuitJS1, Wokwi/avr8js/rp2040js, tscircuit, KiCad 8–10 automation, ngspice 47, GHDL/Icarus/Verilator/cocotb, GTKWave/Surfer/WaveDrom, Digital/Logisim, SymbiYosys, Renode, PySpice, lcapy. Sources in §9.

---

## 0. Executive summary

August's circuit workbench today is a **netlist-in, numbers-out SPICE bench**: ngspice batch runs with lint + convergence ladder + SOA scan (`circuit_tools.py:380-534`), a 15-part offline library (`:717-733`), schemdraw schematic PNGs, and a matplotlib 3D placeholder (`:802-901`). It is accurate but has **no waveforms, no tests, no firmware, no HDL, no interactivity**.

What every computer-engineering student actually lives in is a superset of that: a SPICE simulator with **virtual instruments** (Electronics Workbench/Multisim's signature), **firmware running inside the schematic** (Proteus VSM, SimulIDE, Wokwi), and an **FPGA flow** (Quartus + HDL simulation + waveforms). The research shows all three layers are now reachable with permissively-licensed, headless, agent-drivable pieces:

1. **There is no open-source synthesis/P&R for Cyclone IV** (confirmed: nextpnr tops out at experimental Cyclone V via Mistral; F4PGA is Xilinx; IceStorm/Trellis/Apicula cover other families). The user's installed **Quartus 18.1 is the only implementation path — and it is fully scriptable**: `quartus_sh --flow compile`, plain-text QSF assignments, machine-parseable `.rpt` reports, `quartus_pgm` for flashing (§1.1). So the FPGA story is *Quartus CLI for implementation + open tools (GHDL/cocotb/Surfer) for simulation and viewing*.
2. **The Proteus VSM gap is closable without proprietary code.** `avr8js` (MIT, ATmega328p/2560/ATtiny + GPIO/UART/SPI/I2C/ADC/timers) and `rp2040js` (MIT, dual-core + PIO) run real firmware headlessly in Node; ngspice 47's XSPICE `d_process`/`d_cosim` + dac/adc bridges are the *sanctioned* mixed-mode coupling points; a time-sliced co-sim loop is the pragmatic first step (§1.7, §1.10, P3).
3. **The EWB/Multisim "virtual instruments" UX is reproducible** as post-processing over ngspice outputs plus embedded viewers — Surfer (EUPL, Rust/WASM waveform viewer) ships an **explicit iframe + postMessage embedding API**; WaveDrom renders timing diagrams from JSON with zero install (§1.12, P2).
4. **LTspice's two gold-standard ideas map 1:1 onto ngspice**: `.meas` (already parsed at `circuit_tools.py:239,493-500`) and `.step` parametric sweeps. Wrapping them gives the agent a self-verification loop (circuit + assertions → pass/fail) for near-zero engine effort — the same idea as SimulIDE's `-test` batch mode and wokwi-cli's `--expect-text` (§1.5, §1.2, P1).

**License guardrail adopted throughout** (§1.14): *link* only MIT/BSD/LGPL (avr8js, rp2040js, @wokwi/elements, tscircuit/circuit-json, cocotb, lcapy LGPL-2.1, ngspice BSD-style, @o.z/ngspice-wasm BSD-3); *iframe-embed as separate programs* GPL/EUPL assets (CircuitJS1, Surfer, KiCanvas); take *ideas only* from proprietary/AGPL tools (Proteus, Multisim/EWB, SimulIDE AGPLv3, XOD AGPL, QucsStudio, LTspice).

**The plan** is six phases (§4): P0 environment doctor + golden regression decks; P1 SPICE depth (waveforms, sweeps, assertions, symbolic, faults, library); P2 virtual instruments + interactive viewers; P3 firmware-in-the-loop (the CE headline); P4 HDL/FPGA workbench (GHDL/cocotb/Quartus CLI); P5 real PCB/3D via KiCad CLI + tscircuit. Fourteen new tools, each wired through the standard checklist (§5).

---

## Part 1 — Research: the EDA landscape, tool by tool

### 1.1 Intel Quartus Prime (the tool the user actually has)

Quartus Prime **Lite is free** and 18.1 is the frozen university line for **Cyclone IV E (EP4CE6E22C6)**; it bundles **ModelSim-Intel FPGA Starter Edition** (free, `vsim -c -do` headless). Everything a student does in the GUI except floorplanning has a text/CLI equivalent:

- **CLI batch flow** (18.1 Scripting UG, UG-20144): `quartus_sh --flow compile <prj>` (syn+fit+sta+asm in one command), per-stage `quartus_map` / `quartus_fit` / `quartus_sta` / `quartus_asm` / `quartus_eda` / `quartus_pow`, `quartus_pgm -m jtag -o "p;out.sof"`, `jtagconfig --debug`, and `quartus_sh -t script.tcl` against the embedded Tcl API (`project`, `flow`, `report`, `chip_planner`, `jtag` packages).
- **QSF/QPF are plain text** — device, file list, and pin assignments (`set_location_assignment PIN_23 -to clk`) are diffable and agent-editable; Pin Planner output is just QSF lines.
- **Reports are plain text**: every stage emits `<revision>.<stage>.rpt` (resource usage, fmax, errors) — machine-parseable.
- GUI features worth emulating conceptually: Block Diagram editor (.bdf), RTL Viewer, Signal Tap (.stp), Pin Planner.

**Agent takeaway:** Quartus CLI is the centerpiece of the FPGA phase — zero new install for synthesis, everything headless, everything text.

### 1.2 SimulIDE

Free real-time simulator, event-driven engine (1 ps ticks), **AGPLv3** (site footer + dev-repo `COPYING`). Current stable **1.1.0-SR2** (2026-03); 2.0.0 line in development. Headline: **MCU-in-circuit** — drop an AVR/PIC/8051/Arduino part, right-click → *Load firmware* (`.hex`), with RAM/ROM/register **Monitor**, serial monitor, fuse editing, breakpoints. Instruments: 4-channel oscilloscope, logic analyzer, volt/amp/freq meters, probes. Circuits are XML (`.sim1`/`.sim2`); components defined in extensible XML; scripted components via AngelScript.

**Agent-relevant hook (verified in dev source `src/main.cpp`):** `-nogui` and **`-test <folder>`** → `BatchTest` recursively loads every circuit, powers it on, runs embedded test-unit components, prints `All tests passed` or the failed list. That is a headless circuit regression harness — the *concept* we reproduce natively over ngspice (P1.3) without touching AGPL code.

User sentiment: praised for speed and the unique MCU+circuit combo; criticized for analog fidelity vs. real SPICE (their own docs disclaim analysis accuracy) — which validates August's ngspice choice.

### 1.3 Proteus Design Suite (Labcenter)

Proprietary; stable **9.1 (Oct 2025)**. The differentiator is **VSM (Virtual System Modelling)**: mixed-mode SPICE co-simulated with firmware-executing MCU models (**750+ MPU variants**: PIC, AVR/Arduino, 8051, Cortex-M0/M3, MSP430…), peripherals modeled "down to waveform level". The CE-student feature checklist to emulate:

- **Virtual instruments**: docked System Scope that live-probes any wire without pre-placed components; placable logic analyser, function/pattern generators, virtual terminal; **SPI and I2C protocol analysers** wired onto the bus.
- **The killer workflow**: single-step firmware while watching the circuit react; source breakpoints **plus hardware breakpoints on schematic conditions** (break when LCD busy goes high); per-peripheral trace/diagnostics.
- Graph-based AC/noise/distortion/sweep analyses; "Conformance Analysis" for firmware QA.

No integration surface — ideas only. Its architecture (SPICE + instruction-set simulators coupled at pin level) is exactly what P3 reproduces with MIT engines.

### 1.4 Electronics Workbench → NI Multisim

EWB (Interactive Image Technologies) was *the* educational lab simulator (100k+ copies by 1999); merged into Multisim (1999), acquired by NI (2005); latest desktop **Multisim 14.3**. One of the few EDA tools on the Berkeley SPICE lineage under an interactive lab UI. **Multisim Live (browser) shuts down 2026-09-15** — desktop is the future, which is also August's posture.

The iconic, borrowable ideas:
- **Virtual instruments as first-class objects**: multimeter, function generator, oscilloscope (2/4-channel), **Bode plotter**, wattmeter, frequency counter, **word generator**, **logic analyzer**, **logic converter** — wired like real bench gear.
- **Live interactive simulation**: toggle switches while running; instruments update live.
- **Fault simulation (Education edition)**: instructor injects open/short/leakage faults; student troubleshoots — trivially expressible as netlist edits (P1.5).
- 555-timer and 74xx digital labs as the canonical example corpus; MultiMCU co-simulation (2006).
- Modern grapher UX (Multisim Live): cursors, expression plotter (math on traces), CSV export.

### 1.5 Qucs family & LTspice

- **Qucs** (GPL, own Qucsator engine, S-parameter/Harmonic Balance RF focus) is dormant since 0.0.19 (2017). **Qucs-S 26.1.1 (2026-04, GPL-2.0)** is the living successor: Qt6 GUI over *existing* engines — ngspice recommended, Xyce, SpiceOpus. Value: reference architecture for "GUI over ngspice". **QucsStudio** is RF-capable but *not open source* (redistribution/embedding forbidden) — legally off-limits.
- **LTspice** (freeware, closed; "most widely distributed SPICE in the industry"; XVII): the borrowable ideas are its text-native formats and directive language, which ngspice implements compatibly:
  - `.asc` schematics are plain ASCII — diffable and LLM-generatable;
  - **`.step param` sweeps** with overlaid steps in the viewer — the gold-standard parametric UX (→ P1.2);
  - **`.meas` statements** evaluated per sweep step into a results table — the gold-standard machine-readable measurement contract (August already parses `.meas` output; P1.2/P1.3 build on it);
  - SOA/power/temperature views; SMPS-optimized convergence.

### 1.6 Falstad CircuitJS1

GPL-2.0 browser analog simulator (sharpie7/circuitjs1, ~2.9k stars). Pedagogically the single most influential visual: **animated current dots + voltage coloring** (green positive / red negative), click-to-toggle switches, hover state tooltips, hundreds of example circuits, scopes with spectrum view. Embeddable by design: iframe with query params (`running`, `editable`, `hideSidebar`, `whiteBackground`, `conventionalCurrent`, `euroResistors`), `?cct=`/`?ctz=` (LZString) circuit URLs, documented JS interface. An **AVR8js-Falstad** fork already puts MCU-in-circuit in the browser (GPL-2.0). Integration: iframe-only as a separate program (P2.4); the *concepts* (voltage coloring, current animation) we reimplement over our own SVG (P2.2).

### 1.7 Wokwi, avr8js, rp2040js

- **Wokwi** (wokwi.com): browser simulator for Arduino (ATmega328p/2560/ATtiny85), ESP32 family, STM32, RP2040. Architecture: AVR on **avr8js**, Pico on **rp2040js** — both MIT; **the ESP32 engine is proprietary and cloud-bound** (avoid). Huge parts library (LCD1602/HD44780, SSD1306 OLED, 7-seg, WS2812, keypad, servo/stepper, DHT22, HC-SR04, MPU6050, 74HC595, gates/flip-flops, 8-channel logic analyzer…).
- **diagram.json** — `{version, parts:[{id,type,left,top,attrs}], connections:[["led1:A","uno:13","green",[...]]], serialMonitor}` with a tiny `v/h/*` wire-routing mini-language. Compact, schema-able, trivially LLM-generatable (→ P3.3).
- **wokwi-cli** (MIT but **cloud-token-dependent** — clone its *vocabulary*, not its dependency): `--expect-text`/`--fail-text` (assert on serial output), `--scenario` automation scripts, `--vcd-file` logic-analyzer export, `--screenshot-part`, `lint` for diagram.json. Also an experimental stdio MCP server.
- **avr8js** (npm 0.21.0, MIT, active): TypeScript AVR core — ATmega328p focus, modular configs for 2560/ATtiny85; peripherals verified in `src/peripherals/`: **ADC, GPIO (INT/PCINT), SPI, TWI, USART, timers, EEPROM, watchdog**. Headless: feed Intel HEX, instantiate CPU + peripherals, tick — Node or browser.
- **rp2040js** (npm 1.3.3, MIT): dual-core Cortex-M0+, runs Arduino/MicroPython/CircuitPython from UF2; **PIO support confirmed** (with PIO assembler); GDB server on 3333; UART to console; `--expect-text`.
- **@wokwi/elements** (npm 1.9.2, MIT): SVG web-components for parts — *presentation only; functional glue is yours to write* (Wokwi's functional part sims are not open-sourced — budget glue code per part).

### 1.8 tscircuit

"React for circuits" — MIT, extremely active (2.5k stars, 432-repo org). TSX (`<board><resistor resistance="1k"/></board>`) compiles to **Circuit JSON** (npm `circuit-json`, zod-validated): one typed array drives schematic, PCB, 3D, Gerbers, BOM, and SPICE (`circuit-json-to-spice`). Viewers ship as React components (`@tscircuit/schematic-viewer`, `pcb-viewer`, `3d-viewer`, `circuit-to-svg`); `@tscircuit/runframe` sandboxes runs in a webworker. Built-in DRC (`@tscircuit/checks`) plus a `<drccheck/>` element for custom rules. MIT autorouter. **Simulation exists**: `<analogsimulation duration timePerStep spiceEngine="ngspice"/>` + `<voltageprobe/>` — engine chain is `@tscircuit/ngspice-spice-engine` → **`eecircuit-engine` (MIT): ngspice compiled to WASM**. AI-friendly extras: `footprinter` footprint DSL, JLC search, an official agent-skill repo, `llms.txt` docs.

**Agent takeaway:** Circuit JSON is the strongest candidate for a modern schematic/PCB/3D rendering layer (P5.3), and its `<analogsimulation>`+probe schema is a good declarative simulation contract.

### 1.9 KiCad automation (8/9/10)

Current: **KiCad 10.0.5**; IPC API stabilized in 9.0.
- **kicad-cli**: `sch erc` / `pcb drc --format json --exit-code-violations` (machine-checkable gates); `pcb export glb/step/stl/svg/gerbers/…`; **`pcb render`** — headless 3D board render to image (direct replacement for the matplotlib placeholder when KiCad is installed); `sch export bom/netlist/…`; `jobset run` for batch jobs.
- **IPC API** (protobuf over NNG) controls a *running* GUI instance — not headless; out of scope for agent automation, which must go through kicad-cli.
- **MCP servers** (2025–26 trend): mixelpixx/KiCAD-MCP-Server (MIT, ~2k stars, 169 tools; successor Konnect is AGPL — mind license), lamaalrajih/kicad-mcp (MIT), Seeed's, and IPC-API-based ones. References only.
- **KiCanvas** (MIT, theacodes): browser KiCad sch/pcb viewer with an official embedding API (web components), parses KiCad 6+ files — iframe path for viewing student `.kicad_sch/.kicad_pcb` in-app (P5.4).

### 1.10 ngspice 47 — what the engine already gives us

Current stable **47**. Beyond what August uses today:
- **XSPICE code models** (manual ch. 8): ~30 analog (gain, summer, multiplier, limiters, PWL, filesource, switches, zener, hysteresis, S-domain TF, oscillators, one-shot, memristor, 2D table), **9 hybrid A/D (dac bridge, adc bridge, bidirectional bridge, PWM osc…)**, **25 digital (gates, D/JK/T/SR flip-flops, latches, state machine, freq divider, RAM, LUT, d_source, d_process, d_cosim)**. This is the built-in answer to 74xx-style digital + mixed-signal without a second engine.
- **`d_process` / `d_cosim` — the firmware-in-the-loop hooks**: `d_process` bridges digital nodes to an **external process**; `d_cosim` loads a shared library into the ngspice process (`cosim.h` C interface) intended as a container for other digital simulators. Paired with dac/adc bridges for analog pins, this is ngspice's *sanctioned* path to couple an MCU emulator into a `.tran` run (P3.5 deep option).
- **Scripting/IO**: `.control` language with `stop`/`resume`/`alter` (interactive probing), `-b` batch, `-s` server mode, `-p` pipe, **shared-library API** (`libngspice`, `NgSpice_Command`, callbacks — ch. 28), digital VCD output (`eprint/edisplay/eprvcd`), `wrdata` for ASCII trace export.
- **OSDI/OpenVAF (since 39)**: runtime-loadable Verilog-A compact models (VBIC, Mextram, HICUM, CMC standards) — the curated-model pipeline lever.
- **WASM builds**: `@o.z/ngspice-wasm` (BSD-3, ngspice 46) and `eecircuit-engine` (MIT). Caveat: verify XSPICE/OSDI enablement in WASM builds; native ngspice stays the full-featured path.

### 1.11 HDL simulators

- **GHDL** (GPLv2; MSYS2/winget on Windows): *the* open VHDL simulator — full VHDL-93/2002, partial 2008 (matching Quartus 18.1's own subset); mcode/LLVM/GCC backends; waveform out as **GHW/VCD/FST**. CLI: `ghdl -a → -e → -r --wave=sim.fst` or one-shot `ghdl --elab-run`. Also analyzes fast enough to be the "does it even compile" gate after every edit. **Most important open tool for this user — the course language is VHDL.**
- **Icarus Verilog** (GPL, V13): full Verilog-2005 + growing SV subset; `iverilog -o tb.vvp && vvp tb.vvp`; VCD/FST dumps; easiest cocotb backend.
- **Verilator** (LGPL-3.0/Artistic): fastest open Verilog/SV sim (C++ codegen, multithreaded); `--lint-only -Wall` instant static feedback; **no VHDL**.
- **cocotb** (BSD): **Python testbenches driving real simulators** — GHDL, Icarus, Verilator, Questa/ModelSim. Two modes: Makefile flow and the **`cocotb_tools.runner` Python API (pytest-friendly)** → pass/fail + JUnit XML. This is the highest-leverage agent-verifiable HDL loop. `cocotbext-*` (AXI, UART, Ethernet, PCIe…) provides bus functional models.
- Amaranth (BSD, Python HDL with in-process sim) and Clash (BSD, Haskell) noted as different languages, not emulations of the student's flow — no adoption.

### 1.12 Waveform & logic-viewing tools

- **GTKWave** (GPL): classic viewer for VCD/FST/GHW/LXT; `gtkwave sim.fst save.gtkw`; `.gtkw` save files persist signal layout; Windows builds. Desktop fallback.
- **Surfer** (EUPL-1.2, Rust): modern waveform viewer — reads VCD/FST/GHW; browser build, Windows binaries, VS Code extension, `surver` client-server mode, and — key fact — **explicitly designed to be embedded as an iframe controlled via postMessage** (`surfer/assets/integration.js`). The most embeddable viewer found → P2.3.
- **WaveDrom** (MIT-ish JSON→SVG): WaveJSON timing diagrams rendered in-browser or via `wavedrom-cli` (npm); `https://svg.wavedrom.com/{...}` renders inline in markdown — the agent can draw bus handshakes/clock diagrams directly in answers with zero binary tooling → P4.7.
- **Digital** (HNEemann, GPLv3, Java): educational gate-level designer with FSM editor, test cases, 74xx library, **VHDL/Verilog export** (and GHDL/Icarus-backed VHDL components) — the closest open analog to Quartus' `.bdf` schematic entry. GUI-centric; noted, low agent priority.
- **Logisim-evolution** (GPL, Java) and **CEDAR Logic**: classroom GUI tools, no meaningful headless surface — skip.

### 1.13 Formal & system-level

- **SymbiYosys (sby)** (ISC): formal front-end for Yosys — `bmc/prove/cover/live` tasks; on failure writes a **counterexample VCD + Verilog testbench** — superb agent feedback. Caveat: VHDL input needs ghdl-yosys-plugin, which OSS CAD Suite does **not** ship for Windows → WSL only. Stretch (P6).
- **Renode** (Antmicro, MIT, v1.16.1): full-system SoC emulation (Cortex-M/A/R, RISC-V, x86, MSP430), deterministic multi-node, Monitor/`.resc` scripting, Robot Framework CI, `pyrenode3` Python bindings. Co-sim is HDL-oriented (Verilator); **no SPICE bridge exists publicly** — analog out of scope. Stretch path for RTOS/multi-node courses where avr8js/rp2040js don't reach (P6).
- **PySpice** (GPL-3.0): ngspice shared-library binding via CFFI, OO circuit API, NumPy output — the reference for in-process ngspice driving, but GPL: we reimplement the thin `libngspice` pattern rather than depend on it.
- **lcapy** (LGPL-2.1, active): symbolic linear circuit analysis on SymPy — transfer functions, poles/zeros, `cct[1].V(t)` time-domain expressions. LGPL is safe to link → P1.4 explanation/cross-check layer.

### 1.14 License matrix (the guardrail)

| Class | Tools | Treatment |
|---|---|---|
| **Link/bundle** (MIT/BSD/LGPL) | avr8js, rp2040js, @wokwi/elements, tscircuit + circuit-json + viewers, cocotb, lcapy (LGPL), ngspice (BSD-style), @o.z/ngspice-wasm (BSD-3), eecircuit-engine (MIT), WaveDrom, KiCanvas (MIT), wokwi-cli ideas | npm/pip deps or vendored assets |
| **Iframe as separate program** (GPL/EUPL) | CircuitJS1 (GPL-2.0), Surfer (EUPL-1.2), GTKWave (launch externally) | bundled asset in iframe / external launch; never linked |
| **Process/file interaction only** (AGPL) | SimulIDE (AGPLv3), XOD (AGPL) | never link; concepts reimplemented natively |
| **Ideas only** (proprietary) | Proteus, Multisim/EWB, LTspice, QucsStudio, Wokwi ESP32 engine, Quartus internals | feature blueprints; Quartus CLI is used as an installed user tool, not redistributed |
| **Installed user tools** (CLI-driven) | Quartus 18.1, KiCad, ngspice, GHDL, Icarus | detected at runtime (`circuit_env`), graceful degradation when absent |

---

## Part 2 — Current-state audit (what August has today)

All anchors re-verified against the working tree 2026-08-28 (post-`ccb7485c`; circuit files unchanged since the plan was written; policy anchors re-anchored after the Part 15 memory doors).

| Capability | Where | Notes |
|---|---|---|
| Circuit-mode gate | `circuit_tools.py:42-54` (`set_circuit_mode`/`is_circuit_mode`) | session metadata `circuitMode`, wired to `/circuit` |
| Prompt hint | `circuit_tools.py:59-79` (`CIRCUIT_HINT`) | lists the 9 tools + SPICE unit rules |
| Netlist CRUD | `circuit_tools.py:145-231` | `.cir/.net/.ckt/.sp`, workspace-bound via `bind_path` |
| ngspice resolution | `circuit_tools.py:115-139` | `AUGUST_NGSPICE_EXE` override, PATH, common dirs |
| SPICE value parsing | `circuit_tools.py:244-272` | Table-2.1 scale factors; **KiCad infix (`4k7`) deliberately unsupported** (policy, see Q1) |
| Lint | `circuit_tools.py:275-342` | refdes/node-count, ground, source, M-vs-Meg, C≥1F |
| Convergence ladder + SOA | `circuit_tools.py:348-355, 477-511` | 5 rungs, `warn=1` on every rung |
| Measure parsing | `circuit_tools.py:239, 493-500` | `_MEASURE_RE` handles `v(node)`/`i(vsrc)#branch` |
| Board KB | `circuit_tools.py:541-596` | 26 boards (Arduino/ESP/Pi families) |
| Component library | `circuit_tools.py:717-733` | **15 parts**; no 74xx, no MOSFETs, op-amps only lm358/lm741 |
| 3D board render | `circuit_tools.py:777-901` | matplotlib mplot3d PNG; **sqrt-grid placement** (`:788`) |
| Schematic PNG | `artifact_tools.py:303` (`draw_circuit`) | schemdraw, series-loop elements |
| Charts | `artifact_tools.py:129` (`render_chart`) | matplotlib PNG from columns |
| HTML artifacts | `artifact_tools.py:357` | sandboxed iframe (`allow-scripts`, no `allow-same-origin`) |
| Policy gates | `tool_policy.py:36-39` (read-only), `:70-72` (write), `:87` (`_PROMPT_DESTRUCTIVE` delete), `:90` (`_PROMPT_SHELL` incl. `circuit_simulate`), `:129-130` (plan-mode block), `:155-163` (`_SHELL_EXACT` edit-mode gate, circuit entries `:162`, dispatch `is_shell_mutation:209`) | parity oracle in `tests/test_tool_policy_parity.py`; the `/circuit` advertisement gate lives in `workbench.py` (hint injection `:1048-1051`, `circuitMode` SSE `:2229-2242`) |
| Frontend | `CircuitArtifactCard.tsx` (155 ln), `RightDrawerCircuitSection.tsx` (151 ln), `lib/artifacts.ts` (168 ln) | card + drawer panel; **no three.js/uPlot/viewer deps in `package.json`** |
| Skill | `skills/circuit-sim/SKILL.md` | accurate post-2026-08-26 rewrite (moved from orphaned `backend-py/skills/` on 2026-08-27) |

**Environment fact:** ngspice is **not installed** on the user's machine — `circuit_simulate` currently degrades to install guidance. Quartus 18.1 **is** installed (the user's course tool).

**What does not exist anywhere** (greenfield): waveform trace return, `.step` sweep wrapper, assertion/test tool, symbolic tool, fault injection, VCD export/parse, all HDL tools (`hdl_lint/hdl_simulate/hdl_test/fpga_compile/fpga_program`), firmware compile/run/co-sim, diagram.json, any embedded viewer.

---

## Part 3 — Gap analysis: what every CE student uses vs. what August has

| Student need | Reference tool(s) | August today | Plan |
|---|---|---|---|
| SPICE sim with numeric results | Multisim, LTspice, Proteus ISIS | ✅ measures + lint + SOA | keep |
| **Waveforms on screen** (scope/Bode) | EWB scope & Bode plotter, LTspice viewer | ❌ measures only | P1.1 + P2.1 |
| Parametric "what-if" sweeps | LTspice `.step`, Multisim Live | ❌ | P1.2 |
| Pass/fail self-verification | SimulIDE `-test`, wokwi-cli `--expect-text`, cocotb | ❌ | P1.3, P4.4 |
| Symbolic explanation (H(s), poles) | lcapy, textbook math | ❌ | P1.4 |
| Troubleshooting exercises | Multisim Education fault sim | ❌ | P1.5 |
| Real part library (74xx, MOSFETs, op-amps) | Proteus, Multisim, Falstad | ⚠️ 15 parts | P1.6 |
| **Firmware in the schematic** | Proteus VSM, SimulIDE, Wokwi | ❌ | **P3** |
| Serial monitor / protocol decode | Proteus analysers, Wokwi LA | ❌ | P3.2, P2.3 |
| VHDL/Verilog simulation | ModelSim, GHDL, Icarus | ❌ | P4.1–P4.4 |
| FPGA synthesis + fmax + resources | Quartus GUI | ❌ | P4.5 (Quartus CLI) |
| Flashing the board | Quartus Programmer | ❌ | P4.6 (confirm-gated) |
| Waveform viewing (VCD/FST) | GTKWave, ModelSim | ❌ | P2.3 Surfer iframe |
| Timing diagrams in explanations | WaveDrom, textbook | ❌ | P4.7 |
| Schematic that isn't a static PNG | Falstad, KiCad, tscircuit | ⚠️ PNG only | P2.2, P5.3 |
| Real board 3D | KiCad 3D viewer, Proteus ARES | ⚠️ matplotlib placeholder | P5.1–P5.2 |
| ERC/DRC correctness gates | KiCad, Quartus | ⚠️ lint only | P5.1, P4.5 |

---

## Part 4 — The plan (six phases)

Ordering principle: each phase ships standalone value; P0–P1 have **zero new runtime dependencies** beyond ngspice itself.

### Phase 0 — Environment doctor + golden regression (foundation, ~1 day)

**P0.1 `circuit_env` tool** — one call reports availability + version of every external engine the workbench can drive: ngspice, ghdl, iverilog, verilator, quartus_sh (+ detected device families), kicad-cli, arduino-cli/avr-gcc, node. Output drives graceful degradation messages everywhere else (replaces the ad-hoc ngspice-missing text at `circuit_tools.py:406-417`). Read-only → allowed in plan mode.

**P0.2 Golden-circuit regression** — `tests/test_circuit_golden.py`: a small corpus of decks (voltage divider `.op`, RC `.tran` with `.meas`, RC filter `.ac` with −3 dB measure, 555 astable `.tran`, XSPICE inverter if available) with expected measures ± tolerance, skipped cleanly when ngspice is absent. This is the accuracy anchor the research ranks as the top fidelity lever, and it must exist *before* P1 starts changing the sim path.

**P0.3 Install ngspice on the user's machine** (`winget install ngspice`) — not code, but a plan step: nothing in P1–P3 is verifiable without it.

### Phase 1 — SPICE depth: waveforms, sweeps, tests, symbols, faults, parts (~3–4 days)

**P1.1 Waveform extraction (the oscilloscope data path).** Today `circuit_simulate` returns only scalar measures. Add: inject `wrdata <file> <exprs>` (or parse the `.raw` binary) into `.tran/.ac/.dc` decks; return `traces: {name: {x: [...], y: [...], unit, xunit}}` downsampled to a budget (e.g. ≤2k points/trace, ≤8 traces) alongside `measures`. `render_chart` gains a `traces` input so the model can plot real waveforms immediately. This single change converts August from "multimeter" to "oscilloscope" at the data level. Bonus now that the T13 kernel exists (§5.6): traces returned through the bridge spill oversized payloads to disk automatically (`kernel.py` `BRIDGE_SPILL_CHARS`), so code-mode cells get NumPy-friendly waveform files without inline bloat.

**P1.2 Parametric sweeps (LTspice `.step` idea).** `circuit_simulate` accepts `sweep: {param, from, to, steps}` → emits `.step param` + per-step `.meas`; result carries `sweepResults: [{paramValue, measures}]`; `render_chart` renders the curve family. The model gets "sweep R1 1k→10k and find where the cutoff hits 1 kHz" in one tool call.

**P1.3 `circuit_test` — assertions over measures (SimulIDE BatchTest + wokwi-cli semantics).** Signature: `circuit_test(netlist_or_path, assertions: [{measure, expect, tolerance | min | max}], ...)`. Runs the deck once, evaluates every assertion, returns `{passed, results: [{name, value, expect, ok, note}]}`. This is the agent's self-verification loop: design → assert → fix, with a machine-readable verdict instead of prose. Golden decks (P0.2) migrate onto this tool as their harness.

**P1.4 `circuit_symbolic` via lcapy (LGPL — linkable).** Input: netlist or a two-node transfer query. Output: symbolic `H(s)`, poles/zeros, `V(t)` step response, LaTeX string. Two uses: *explain* a circuit to the student, and *cross-check* ngspice numbers (symbolic −3 dB point vs. measured). Optional dep — degrades to "install lcapy" guidance.

**P1.5 `circuit_inject_fault` (Multisim Education).** Given a deck + `{ref, fault: open|short|drift(±%)}`, emit the faulted variant deck (open = delete line; short = replace with `R<ref>_f n1 n2 1m`; drift = scale value). Powers troubleshooting exercises: August (or the user) faults a circuit, the student diagnoses with sims, or August demonstrates why a symptom occurs. P1.4 + P1.5 are natural inputs to the existing `skills/tutor/` study loop (§5.8).

**P1.6 Library expansion (15 → ~35 parts) + XSPICE digital.** Add to `_COMPONENT_LIBRARY` (`circuit_tools.py:717`): MOSFETs (2N7000, IRF540/IRF9540, BS170), op-amps (TL072, OP07, LM324 + macro-model cards), more regulators (LM337, 78xx family), zeners, the classic 555 internals card. **74xx via XSPICE**: ngspice ships digital primitives (gates, flip-flops, LUT, state machine — §1.10); add `circuit_search_component` knowledge + paste-ready XSPICE subcircuit cards for 7400/02/04/08/32/74/76/161/595. Gate on runtime detection: the winget ngspice build must include XSPICE code models — `circuit_env` probes this (simulate a 1-line inverter deck) and the library only advertises 74xx when present.

**P1.7 VCD export for digital decks.** Wrap ngspice `eprvcd` so digital-node `.tran` runs can emit a `.vcd` artifact — input for the Surfer viewer (P2.3) and `vcd_parse` (P4.3).

*Policy touch:* `parse_spice_value` infix question goes to Q1 — no change without ruling.

### Phase 2 — Virtual instruments & interactive viewing (EWB/Falstad UX, ~3–4 days)

**P2.1 Instrument tabs in the Circuit panel.** `RightDrawerCircuitSection.tsx` grows three views fed by P1.1 traces: **Scope** (transient, cursors + Δ measurement), **Bode** (magnitude/phase from `.ac`, cursor at −3 dB), **Meter** (`.op` node-voltage/source-current table). Chart lib: **uPlot** (MIT, ~45 KB, canvas) — Q4. This is the EWB "instruments" idea rebuilt as post-processing: no live simulation needed, bench-style presentation of real ngspice data.

**P2.2 Falstad-style operating-point overlay.** `draw_circuit` already uses schemdraw, which can emit **SVG**; add a second output mode that, after an `.op` run, colors nodes by voltage (blue→red gradient, Falstad convention) and annotates branch currents on the SVG returned as an HTML artifact. The #1 pedagogical "wow" per research, built on data we already compute.

**P2.3 Surfer waveform viewer embed.** Bundle Surfer's web build as a static asset; iframe it in the Circuit panel (postMessage integration API is official, `integration.js`) to open any workspace `.vcd/.fst/.ghw` — covers SPICE digital exports (P1.7) *and* HDL sim output (P4.2) with one component. EUPL-1.2 + separate-process iframe = compliant.

**P2.4 CircuitJS1 interactive playground (optional, Q3).** Bundle the standalone CircuitJS1 build as a separate asset; `create_html_artifact` gains a `circuitjs` template that iframes it with `?ctz=` circuits (August generates the `ctz` string from a deck for simple analog circuits). GPL-2.0-safe because it runs as a separate program in the existing sandboxed iframe posture. Gives students a live, draggable analog sandbox that August's batch engine can't be.

### Phase 3 — Firmware-in-the-loop: the Proteus VSM gap (the CE headline, ~5–7 days)

**P3.1 `firmware_compile`.** Arduino sketches → HEX via `arduino-cli compile` (or raw avr-gcc); C for AVR via avr-gcc; Pico C → UF2 via pico-sdk when present. Returns artifact path + build log tail. Detected by `circuit_env`.

**P3.2 `firmware_run` — headless avr8js/rp2040js runner.** A small **Node sidecar** (Q5) the backend spawns on demand: loads `avr8js`/`rp2040js` from npm deps, runs the HEX/UF2 for a bounded simulated time, and returns: final GPIO state per pin, **serial monitor capture**, ADC reads seen, and `expectText`/`failText` assertions (wokwi-cli vocabulary) evaluated against serial output. This alone — no analog coupling — already delivers the Wokwi core loop: "does my sketch print the right thing and set the right pins."

**P3.3 `diagram.json` as the agent-native wiring format.** Adopt Wokwi's schema (parts + connections + attrs) as a first-class workspace artifact alongside `.cir`: LLM-generatable, schema-validated (`circuit_lint_diagram`), and the natural input to P3.4 visuals and P3.5 co-sim pin mapping. Netlists remain the SPICE source of truth; diagram.json describes *breadboard wiring around the MCU*. Q2.

**P3.4 Live part visuals.** `@wokwi/elements` (MIT web components) rendered in the Circuit panel inside the artifact iframe; a thin glue layer maps emulator pin state (P3.2) onto element inputs — LED on/off, LCD1602 text, 7-seg digits, servo angle, WS2812 colors. Budget glue per part (Wokwi's functional sims are not open source — §1.7): start with LED, resistor-LED, LCD1602, 7-seg, servo, buzzer.

**P3.5 Co-simulation ladder (ngspice ↔ MCU), three rungs:**
1. **Standalone + stimulus export (ship first):** firmware run produces a pin timeline → converted to ngspice `PWL` sources injected into the analog deck. One-way, zero engine changes, already useful (e.g. PWM from the MCU drives an RC filter sim).
2. **Time-sliced loop:** run ngspice `.tran` in windows (shared-library `stop`/`resume` or repeated batch runs); between windows advance the MCU emulator by the same Δt and exchange GPIO/ADC states. A simplified Proteus VSM loop; needs the `libngspice` binding (reimplement the thin PySpice pattern — GPL means no dependency).
3. **XSPICE `d_process` bridge (deep):** a tiny bridge process hosting avr8js behind ngspice's documented `d_process`/`d_cosim` interface + dac/adc bridges for analog pins — true waveform-level mixed-mode. Requires an XSPICE-enabled ngspice build; gated by `circuit_env` probe.

**P3.6 rp2040js track.** Same runner, UF2 input, PIO support — Pico labs (WS2812 via PIO, quadrature) and MicroPython REPL capture.

### Phase 4 — HDL/FPGA workbench (Quartus + open sim, ~4–5 days)

New tool family, gated behind the existing circuit mode (or a sibling `/hdl` mode — Q6):

**P4.1 `hdl_lint`** — `ghdl -a --std=08` (VHDL) / `verilator --lint-only -Wall` (Verilog) as instant post-edit feedback: syntax/semantic errors with file:line, no full sim. The VHDL equivalent of the netlist lint.

**P4.2 `hdl_simulate`** — GHDL `--elab-run --wave=sim.fst` for VHDL testbenches; `iverilog -o tb.vvp && vvp tb.vvp` for Verilog. Returns: exit status, parsed stdout asserts, waveform artifact path, and a `vcd_parse` summary (P4.3). 60 s timeout ladder like `circuit_simulate`.

**P4.3 `vcd_parse`** — pure-Python VCD reader: signal list, edge counts, min/max pulse widths, value-at-time queries, and protocol hints (UART baud/bytes decoded from an RX line — the first "protocol analyser" slice, Proteus-style). Feeds both HDL and SPICE-digital (P1.7) workflows.

**P4.4 `hdl_test` — cocotb runner.** Agent writes Python testbenches; the tool runs them via `cocotb_tools.runner` against GHDL/Icarus and returns **JUnit XML verdict** (pass/fail per test + failure traces). `WAVES=1` produces the FST for P2.3 viewing. This is the single biggest quality-of-life upgrade for AI-driven VHDL verification (BSD license, pip-installable).

**P4.5 `fpga_compile` — Quartus CLI flow.** Agent generates/edits the **QSF** (device `EP4CE6E22C6`, VHDL file list, `set_location_assignment` pin map — emulating Pin Planner), runs `quartus_sh --flow compile <prj>`, then **parses the `.rpt` files** and returns: errors/warnings (with file:line from the reports), logic elements/registers/memory used vs. EP4CE6 capacity, fmax from `.sta.rpt`, and the `.sof/.pof` artifact paths. Tcl via `quartus_sh -t` for assignment manipulation. Degrades to install guidance when Quartus is absent.

**P4.6 `fpga_program`** — `quartus_pgm -m jtag -o "p;<rev>.sof"` (+ `jtagconfig` chain check). **Always confirm-gated** (hardware action — Q7), never auto-run by the harness loop.

**P4.7 WaveDrom in answers** — a tiny helper (`hdl_timing_diagram`) that turns a signal description into WaveJSON and renders SVG via bundled wavedrom-cli (or emits the `svg.wavedrom.com` URL form for markdown). Zero-install protocol/handshake diagrams in chat.

### Phase 5 — Real boards: KiCad CLI + tscircuit (PCB reality, ~3–4 days)

**P5.1 `kicad_checks` + `kicad_render`** — when kicad-cli is present: `sch erc` / `pcb drc --format json --exit-code-violations` as agent-verifiable gates; `pcb render` (headless 3D PNG) and `pcb export glb` for real board visuals — replacing the matplotlib placeholder (`circuit_tools.py:802-901`) *for real designs* (the placeholder stays as the zero-dependency fallback).

**P5.2 GLB viewer in the drawer** — add `<model-viewer>` (Apache-2.0 web component, one script tag) to the Circuit panel to display exported `.glb` interactively (rotate/zoom), replacing the static mplot3d PNG for the real-board path.

**P5.3 tscircuit Circuit JSON path** — adopt Circuit JSON as the *second* interchange format: agent emits TSX or raw circuit-json; `circuit-json-to-spice` generates the ngspice deck (single source of truth stays executable); `@tscircuit/schematic-viewer`/`pcb-viewer`/`3d-viewer` render interactively in the artifact iframe. This is the modern replacement for both schemdraw PNGs and the sqrt-grid placement problem — autorouted, topological, real footprints. MIT throughout.

**P5.4 KiCanvas embed** — iframe the MIT viewer for student-supplied `.kicad_sch/.kicad_pcb` files so coursework projects are inspectable in-app.

### Phase 6 — Stretch (post-1.0 of the workbench)

- **Renode** integration for Cortex-M/RISC-V + RTOS courses (MIT; Monitor scripting; `pyrenode3`); the SPICE bridge would be our own time-sliced coupling (none exists publicly — novel opportunity).
- **SymbiYosys formal** under WSL for VHDL (ghdl-yosys-plugin not shipped for Windows); counterexample VCDs feed P2.3.
- **OSDI/OpenVAF curated model pipeline**: ship VA-Models compilation for precision parts (VBIC/Mextram), the top "curated models" accuracy lever.
- **LCSC/JLCPCB part data** (the struck skill claim made true): tscircuit's `jlcsearch` is an MIT reference.

---

## Part 5 — Harness wiring checklist (every new tool)

Per the established pattern (and the parity-oracle lesson — green tests ≠ correct policy), updated for the post-kernel-split harness:

1. Implementation in `backend-py/app/services/tools/circuit_tools.py` (SPICE/firmware) or a new `hdl_tools.py` (Phase 4).
2. Wrapper + `register()` in `tool_registrations/circuit_tools.py` (or sibling `hdl_tools.py`).
3. `CIRCUIT_HINT` (`circuit_tools.py:59-79`) updated with the new surface. The constant is injected from `workbench.py:1048-1051` — no change needed there unless the session-block format changes.
4. `tool_policy.py` classification: read-only tools (`circuit_env`, `vcd_parse`, `hdl_lint`) → read set; mutating tools (`circuit_test` writes nothing, `firmware_compile` writes artifacts) → write set + plan-mode block where they mutate; **any tool that spawns an external binary** (`hdl_simulate`→ghdl/iverilog, `fpga_compile`→quartus_sh, `firmware_compile`→arduino-cli, the Node sidecar) **goes into `_SHELL_EXACT`** exactly like `circuit_simulate` (`:155-163`) — edit-mode gating applies to binary launchers, not just `run_command`. `fpga_program` additionally confirm-gated.
5. **`tests/test_tool_policy_parity.py` oracle updated in the same commit** (policy + oracle together, always).
6. **Kernel bridge comes free.** The T13 code-mode tool bridge (`workbench/kernel.py:284` `bridge_call`) re-applies `_checkToolGuard` + `_resolveCommandApproval` and dispatches through `_executeTool`, so every new circuit/HDL tool is automatically callable from `code`-mode Python cells with the same gates — no extra wiring, but it means students can orchestrate sweeps/co-sim/firmware runs programmatically in Python (this is the PySpice DX without the GPL dependency; see P1.1).
7. **New-harness interactions:** post-edit verification (`workbench/edit_verification.py`, T1/T14) covers the generic file-edit tools — `circuit_test` (P1.3) and `hdl_test` (P4.4) are the domain-specific analogs and should not double-gate; read-before-edit (`read_before_edit.py`, T17) applies when the model edits a `.cir`/`.vhd` via `edit_lines` (desirable — leave it); **shadow-git** (`shadow_git.py`) snapshots every workspace artifact automatically, so netlists/VCD/HEX flow into the ChangesCard for free — but watch snapshot size once Phase 3/4 start emitting `.sof`/UF2/FST binaries (check the snapshot caps; add binary globs to the ignore list if they bloat).
8. Skill updates: `skills/circuit-sim/SKILL.md` extended; new `skills/hdl-fpga/SKILL.md` for Phase 4; `skills/charts/SKILL.md` already claims "waveform data coming out of a circuit sim" — P1.1/P2.1 must make that true; `skills/august-tools/SKILL.md` (the load-before-tools reference) gains the new tool families; `skills/tutor/SKILL.md` cross-referenced from P1.4/P1.5 (symbolic explanation + fault-injection exercises are tutor material).
9. Frontend: Circuit panel sections are additive; artifact templates register in `lib/artifacts.ts`.

---

## Part 6 — Environment & install matrix (Windows, the user's machine)

| Tool | Needed by | Install | License | Status on user machine |
|---|---|---|---|---|
| ngspice (≥43, XSPICE build) | P0–P3 | `winget install ngspice` or `AUGUST_NGSPICE_EXE` | BSD-style | **missing — P0.3** |
| GHDL | P4.1–P4.4 | MSYS2 `mingw-w64-x86_64-ghdl` or winget | GPLv2 (process) | missing |
| Icarus Verilog | P4.2/P4.4 | MSYS2 `mingw-w64-x86_64-iverilog` | GPL (process) | missing |
| cocotb | P4.4 | `uv pip install cocotb` | BSD | missing |
| Verilator | P4.1 (Verilog only) | MSYS2/WSL | LGPL (process) | optional |
| Quartus Prime Lite 18.1 | P4.5–P4.6 | already installed | Intel license (user's) | **present** |
| arduino-cli / avr-gcc | P3.1 | winget/scoop | GPL (process) | missing |
| Node + npm deps | P3.2/P3.4, P5.3 | desktop build already has Node; runtime sidecar is new (Q5) | MIT deps | build-time only today |
| KiCad (kicad-cli) | P5.1 | winget | GPL (process) | missing, optional |
| lcapy | P1.4 | `uv pip install lcapy` | LGPL-2.1 (link ok) | missing, optional |
| Surfer web build | P2.3 | vendored static asset | EUPL (iframe) | n/a |
| uPlot | P2.1 | npm | MIT | n/a |

Everything degrades gracefully: each tool's absence returns install guidance (the existing ngspice pattern at `circuit_tools.py:406-417` generalized by `circuit_env`).

---

## Part 7 — Validation plan

- **Backend fast path** (per AGENTS.md): `cd backend-py && uv run ruff check . && uv run mypy app/ && uv run pytest -q` (with `--basetemp="$TEMP/august_pytest"`; suite ≈9.5 min).
- **Golden decks** (P0.2) must pass with ngspice installed; skip-marked otherwise.
- **Parity oracle** updated with every policy change (policy + oracle in one commit).
- **Frontend:** `tsc` + vitest (`npm run test:frontend`); eslint has pre-existing errors at HEAD — compare, don't blame.
- **Desktop verification** per AGENTS.md: `npm run dev:desktop` for panel/viewer work; packaged installs must include backend changes (version-sync across all 7 files only when shipping a release).
- **Firmware/HDL smoke tests** in CI are skip-unless-tool-present; local verification on the user's machine where Quartus exists.

---

## Part 8 — Open questions for ruling

1. **Q1 — KiCad infix values (`4k7`, `1R2`).** Currently a deliberate policy *against* (`circuit_tools.py:250-272` docstring + lint advice). Options: (a) keep the ban (status quo, SPICE-purist); (b) accept-and-normalize in lint with an informational note (friendlier for students copying KiCad BOMs). Recommend (b) — normalization is lossless and removes a foot-gun the lint already has to explain.
2. **Q2 — diagram.json adoption.** Wokwi-compatible schema as a first-class artifact *alongside* `.cir` (recommended), or keep netlists as the only format (simpler, but forfeits the MCU-wiring + visuals path)?
3. **Q3 — Bundle CircuitJS1 (GPL-2.0) as an iframed asset?** Separate-program iframe is license-compliant and matches the existing artifact sandbox posture; cost is a ~few-MB vendored asset. Recommend yes, optional P2.4.
4. **Q4 — Waveform chart library.** uPlot (MIT, tiny, canvas, recommended) vs. staying PNG-only via `render_chart` (no new dep, no cursors/zoom).
5. **Q5 — Node sidecar for avr8js/rp2040js.** The desktop app builds with Node but doesn't run a Node process at runtime today. Options: (a) spawn a bundled `node` sidecar from the backend (recommended — engines are Node-native, MIT); (b) run the engines inside the frontend iframe only (no backend access to pin state → no co-sim, no assertions).
6. **Q6 — Gating for Phase 4 tools.** Reuse the existing `/circuit` mode (one workbench) or add a sibling `/hdl` mode (cleaner separation, second SSE flag + panel tab)? Recommend reusing `/circuit` — it's one "electronics workbench" mentally.
7. **Q7 — `fpga_program` scope.** Ship it confirm-gated (recommended; the student's whole point is flashing the board), or stop at producing the `.sof` and let the user flash via Quartus Programmer?
8. **Q8 — Phase order.** As written (P0→P1→P2→P3→P4→P5), or firmware-first (P3 before P2) since firmware-in-the-loop is the differentiator for CE users? Recommend as-written: P1's traces/assertions are prerequisites P3's co-sim consumes.

---

## Part 9 — Sources (retrieval ledger)

Quartus: Intel Quartus Prime Lite 18.1 software-kit 665990 (archived); 18.1 Scripting UG-20144 (archived PDF); wikipedia.org/wiki/Intel_Quartus_Prime. SimulIDE: simulide.com (features, MCU page, download 1.1.0-SR2/2.0.0, news, forum); github.com/SimulIDE/SimulIDE; github.com/eeTools/SimulIDE-dev (`src/main.cpp`, `src/gui/testing/batchtest.cpp`). Proteus: labcenter.com/simulation, labcenter.com/whyvsm; wikipedia.org/wiki/Proteus_Design_Suite. EWB/Multisim: wikipedia.org/wiki/NI_Multisim; web.archive.org electronicsworkbench.com (1999 homepage, Multisim 9 academic page); multisim.com + /help (Live shutdown notice). Qucs: qucs.github.io; github.com/ra3xdh/qucs_s (26.1.1); qucsstudio.de (+ /legal). LTspice: wikipedia.org/wiki/LTspice; analog.com LTspice page. Falstad: github.com/sharpie7/CircuitJS1; falstad.com/circuit; github.com/mark-mega/AVR8js-Falstad; github.com/SEVA77/circuitjs1. Wokwi: wokwi.com; docs.wokwi.com (diagram format, supported hardware, CLI usage, MCP support, chips API); github.com/wokwi/wokwi-cli. avr8js/rp2040js/elements: github.com/wokwi/avr8js (v0.21.0, `src/peripherals/`), github.com/wokwi/rp2040js (v1.3.3, `pio.ts`), npm @wokwi/elements 1.9.2. tscircuit: tscircuit.com; github.com/tscircuit/tscircuit; github.com/tscircuit/circuit-json; docs.tscircuit.com/llms.txt; github.com/tscircuit/ngspice-spice-engine; github.com/eelab-dev/EEcircuit-engine. KiCad: kicad.org/blog (10.0.5); docs.kicad.org/9.0/en/cli/cli.html; dev-docs.kicad.org IPC API; kicanvas.org + github.com/theacodes/kicanvas; github.com/mixelpixx/KiCAD-MCP-Server; github.com/lamaalrajih/kicad-mcp. ngspice: ngspice.sourceforge.io (download v47; HTML manual ch. 8 XSPICE, ch. 11 convergence/SOA, ch. 28 shared lib); github.com/z-wasm/ngspice-wasm. HDL: github.com/ghdl/ghdl; github.com/ghdl/ghdl-yosys-plugin; github.com/steveicarus/iverilog; verilator.org; github.com/cocotb/cocotb + docs.cocotb.org simulator support; github.com/alexforencich/cocotbext-axi. Waveforms: gtkwave.github.io/gtkwave; surfer-project.org + gitlab.com/surfer-project/surfer (`assets/integration.js`); github.com/wavedrom/wavedrom. Educational: github.com/hneemann/Digital; github.com/logisim-evolution/logisim-evolution; github.com/CedarvilleCS/CedarLogic. OSS flows: github.com/YosysHQ/yosys, nextpnr, icestorm, sby, oss-cad-suite-build; github.com/Ravenslofty/mistral; f4pga.org; github.com/efabless/openlane2. Python: github.com/PySpice-org/PySpice; github.com/mph-/lcapy. Renode: renode.io; renode.readthedocs.io; github.com/renode/renode (v1.16.1). XOD: github.com/xodio/xod. PartSim shutdown: partsim.com.
