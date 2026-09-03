---
name: august-tools
description: "Tool-use rules the schemas don't state: hash-rejection recovery, edit_lines ordering, run_command shell semantics, native-tool-first. Load before new tool families."
category: harness
version: 1.1.0
platforms: [linux, macos, windows]
---

# August Tools — Usage Rules

Schemas cover parameters and basics (read-before-write hash, non-interactive
stdin, bulk cap 40, web_search snippets-only). This file is only the residue.

## Files
- A REJECTED hash means the file changed under you — re-read and re-apply;
  never retry the same write blind.
- edit_lines applies edits BOTTOM-UP so earlier line numbers stay valid;
  write_file for a one-line change just pays the full-file read cost.
- After an edit, the next result carries the NEW sha256 — diff it against the
  old one to prove the change landed.

## Shell
- On Windows, PowerShell/cmd semantics; common Unix head/tail/cat/ls are
  auto-translated where possible.
- Never shell out for what a native tool does — the sandbox may not even allow
  the shell path.

## Batch & web
- Repeats of one operation: one bulk call beats N single calls; independent
  different calls: emit them in parallel in one turn.
- web_search → cite → web_fetch only what you need in depth; browser_* only
  when the page needs real interaction (forms, JS).

## Circuit / HDL / FPGA (/circuit)
Engine-specific guidance lives in the circuit-sim and hdl-fpga skills — load
those; call circuit_env first to see which engines are installed (missing
engines return install guidance, never error walls). fpga_program (JTAG) is
confirm-gated hardware — never auto-run.

## Introspection
describe_environment / diagnose_proxy for the runtime; harness_introspect for
your own loop; harness_propose files human-gated improvements.

## Pitfalls
- Skipping the read_file → fileHash echo: the write is rejected, and a blind
  retry races whatever changed the file.
- Forgetting stdin is closed: pass --yes / -y / --non-interactive; never pipe
  into a REPL or pager.
- Treating a bulk tool as less dangerous than its single form: bulk keeps the
  caution level of its primary bucket — destructive bulk still needs confirmation.
