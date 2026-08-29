---
name: hdl-fpga
description: VHDL/Verilog lint, simulate, and verify with GHDL/Icarus/cocotb; compile to Intel FPGAs with Quartus. Load for HDL coursework, testbenches, or FPGA builds.
category: engineering
version: 1.0.0
platforms: [linux, macos, windows]
---

# HDL + FPGA workbench

## What this skill is

The workflow for digital design work in August: instant HDL linting,
testbench simulation with waveform artifacts, cocotb Python
verification with JUnit verdicts, VCD protocol analysis, and the full
Quartus compile flow to a Cyclone IV E bitstream. Everything is gated
behind `/circuit` mode and environment-detected — `circuit_env` first,
install guidance when an engine is missing.

## When to Use

- The user writes VHDL or Verilog (coursework, testbenches, IPs).
- A design must be verified (lint → simulate → cocotb verdicts).
- A waveform needs reading — signals, timings, or UART traffic decode.
- HDL targets real hardware — Quartus compile, pin map, utilization,
  bitstream.
- A timing/protocol diagram would explain the answer better than prose.

## How to Run

1. `/circuit` to open the workbench, then `circuit_env` — see which of
   ghdl / iverilog / verilator / cocotb / quartus_sh are installed.
2. `hdl_lint` after EVERY HDL edit (ghdl -a for VHDL; verilator
   --lint-only -Wall / iverilog -t null for Verilog). Diagnostics come
   back with file:line — fix those before simulating.
3. `hdl_simulate` on a self-contained testbench (top entity that
   finishes, or `$finish`); the `.vcd` waveform is saved to the
   workspace and rendered in the right Circuit panel.
4. `hdl_test` for cocotb Python testbenches: `module` = the testbench
   code, `sources` = the HDL under test; the JUnit XML verdict lists
   pass/fail per test. Needs `uv sync --extra eda` + a simulator.
5. `vcd_parse` on any waveform: edge counts, min/max pulse widths,
   value-at-time (`at="2ms"` or ticks), UART decode (`signal="rx"` —
   baud auto-detected from start-bit spacing, 8N1).
6. `fpga_compile` for the board build: `device` (default EP4CE6E22C6),
   `pins={signal: PIN_xx}` for the pin map, `top` when it differs from
   the entity name. Parsed results: errors/warnings with file:line,
   logic elements / registers / pins vs. capacity, fmax (clocked
   designs), `.sof` path. `hdl_timing_diagram` renders WaveDrom
   WaveJSON when a diagram explains the protocol better.

Example VHDL loop:

    hdl_lint(source)                     # file:line diagnostics
    hdl_simulate(testbench, top="tb")    # exit + asserts + .vcd
    vcd_parse("sim.vcd", signal="rx")    # decode the traffic
    hdl_test(module=testbench_py, sources=[design])   # JUnit verdict

## Pitfalls

- Editing HDL without linting — ghdl errors are cheapest at the lint
  step; simulation failures bury the line number in a log.
- Writing a testbench that never finishes: `hdl_simulate` has a 60 s
  timeout ladder; make the top process end (`assert ... severity
  failure` completes, `std.env.stop`, or `$finish`).
- Calling `fpga_program` (JTAG download) yourself — it is a
  confirm-gated hardware action; the user initiates board programming.
- Reading Quartus utilization as pass/fail: report the parsed numbers
  (LE/regs/pins vs. capacity, fmax) — an FPGA design can compile and
  still miss timing; `fmax` from the sta report is the receipt.
- Assuming cocotb is installed — `hdl_test` needs `uv sync --extra
  eda` AND a simulator (ghdl or iverilog); check `circuit_env`.
- Decoding UART on the wrong line — pick the actual RX scalar in the
  VCD (auto-detection tries the first signals; pass `signal=`).

## Verification

- `hdl_lint` returns zero errors (warnings read) before you simulate.
- `hdl_simulate` receipt: exitCode 0 + parsed assertion lines; the
  `.vcd` exists and `vcd_parse` sees the expected signal activity.
- `hdl_test` receipt: the JUnit XML — `passed`/`failed` counts per
  test, persisted as `<name>.xml`.
- `fpga_compile` receipt: `fit.status` "Successful", parsed
  `logicElements`/`registers`/`pins`, and the `.sof` artifact path
  (nonzero bytes). A compile without these parsed fields is not a
  build.
- Cross-check numbers: the same signal in `vcd_parse` (edge count,
  pulse width) should match what the testbench asserts.
