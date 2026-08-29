// firmware-runner.mjs — Node sidecar for August's firmware_run tool (P3.2).
//
// Loads an Intel HEX built by firmware_compile (arduino-cli/avr-gcc) into
// avr8js (MIT), executes it for a bounded simulated time, and reports:
//   - final GPIO state per digital pin (D0..D13, A0..A5)
//   - serial monitor capture (USART0 TX bytes, \r\n normalized)
//   - pin toggle counts + first/last toggle times (the PWL timeline seed)
//   - expectText / failText assertions (wokwi-cli vocabulary)
//
// Protocol: args are --hex <file> [--ms N] [--expect s]... [--fail s]...
//           [--pins p1,p2] (limit sampling; default = all). Emits ONE
//           JSON object on stdout; non-zero exit only on load/usage errors.
//
// SPDX-License-Identifier: MIT (avr8js); this glue is part of August.

import fs from 'node:fs';
import path from 'node:path';

import {
  CPU,
  AVRClock,
  AVRTimer,
  timer0Config,
  timer1Config,
  timer2Config,
  AVRUSART,
  usart0Config,
  avrInstruction,
} from 'avr8js';

// ── args ─────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { hex: '', ms: 2000, expect: [], fail: [], pins: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--hex') out.hex = argv[++i] ?? '';
    else if (a === '--ms') out.ms = Math.max(1, parseInt(argv[++i] ?? '2000', 10) || 2000);
    else if (a === '--expect') out.expect.push(argv[++i] ?? '');
    else if (a === '--fail') out.fail.push(argv[++i] ?? '');
    else if (a === '--pins') out.pins = (argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  }
  return out;
}

// ── Intel HEX loader (words) ─────────────────────────────────────────────
function loadHex(text, sizeWords) {
  const flash = new Uint16Array(sizeWords);
  let base = 0;
  let maxAddr = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith(':')) continue;
    const len = parseInt(line.substring(1, 3), 16);
    const addr = parseInt(line.substring(3, 7), 16);
    const type = parseInt(line.substring(7, 9), 16);
    if (type === 4) {
      base = parseInt(line.substring(9, 13), 16) << 16;
      continue;
    }
    if (type !== 0) continue;
    for (let i = 0; i + 1 < len; i += 2) {
      const lo = parseInt(line.substring(9 + i * 2, 11 + i * 2), 16);
      const hi = parseInt(line.substring(11 + i * 2, 13 + i * 2), 16);
      const wordAddr = (base + addr + i) >> 1;
      flash[wordAddr] = (hi << 8) | lo;
      maxAddr = Math.max(maxAddr, wordAddr);
    }
  }
  return { flash, usedWords: maxAddr + 1 };
}

// ── ATmega328P pin map (Arduino numbering) ───────────────────────────────
// IO register addresses (IO space): PORTB 0x25, DDRB 0x24, PINB 0x23; the
// pattern continues for C and D. Arduino pin → [port register, bit].
const PIN_MAP = {
  0: ['D', 0], 1: ['D', 1], 2: ['D', 2], 3: ['D', 3], 4: ['D', 4],
  5: ['D', 5], 6: ['D', 6], 7: ['D', 7],
  8: ['B', 0], 9: ['B', 1], 10: ['B', 2], 11: ['B', 3],
  12: ['B', 4], 13: ['B', 5],
  14: ['C', 0], 15: ['C', 1], 16: ['C', 2], 17: ['C', 3],
  18: ['C', 4], 19: ['C', 5],
};
const PORT_REGS = {
  B: { pin: 0x23, ddr: 0x24, port: 0x25 },
  C: { pin: 0x26, ddr: 0x27, port: 0x28 },
  D: { pin: 0x29, ddr: 0x2a, port: 0x2b },
};

function readPin(cpu, arduinoPin) {
  const spec = PIN_MAP[arduinoPin];
  if (!spec) return null;
  const regs = PORT_REGS[spec[0]];
  const ddr = (cpu.readData(regs.ddr) >> spec[1]) & 1;
  const port = (cpu.readData(regs.port) >> spec[1]) & 1;
  // Output pin: level = PORT bit. Input pin: pull-up when PORT=1, else hi-Z.
  return { mode: ddr ? 'out' : 'in', level: port };
}

// ── main ─────────────────────────────────────────────────────────────────
const MHZ = 16e6;

function fail(msg) {
  process.stdout.write(JSON.stringify({ ok: false, error: msg }) + '\n');
  process.exit(1);
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (!args.hex) fail('--hex <file> is required');
  if (!fs.existsSync(args.hex)) fail(`hex file not found: ${args.hex}`);
  const hexText = fs.readFileSync(args.hex, 'utf-8');
  const { flash, usedWords } = loadHex(hexText, 16384);
  if (usedWords === 1 && flash[0] === 0) fail('hex loaded no program data');

  const cpu = new CPU(flash);
  const clock = new AVRClock(cpu, MHZ);
  new AVRTimer(cpu, timer0Config);
  new AVRTimer(cpu, timer1Config);
  new AVRTimer(cpu, timer2Config);

  let serialRaw = '';
  const usart = new AVRUSART(cpu, usart0Config, MHZ);
  usart.onByteTransmit = (v) => {
    serialRaw += String.fromCharCode(v);
  };

  const pinsToTrack = args.pins
    ? Object.keys(PIN_MAP).filter((p) => args.pins.includes(p)).map(Number)
    : Object.keys(PIN_MAP).map(Number);

  // Toggle tracking for the PWL timeline export (P3.5 rung 1).
  const toggles = {};
  for (const p of pinsToTrack) toggles[p] = { count: 0, firstMs: null, lastMs: null, edges: [] };
  const prevLevel = {};
  const EDGE_CAP = 200; // bounded timeline per pin

  const targetCycles = Math.round((args.ms / 1000) * MHZ);
  while (cpu.cycles < targetCycles) {
    avrInstruction(cpu);
    cpu.tick();
    const nowMs = (cpu.cycles / MHZ) * 1000;
    for (const p of pinsToTrack) {
      const st = readPin(cpu, p);
      if (!st) continue;
      // Track the electrical LEVEL only. Mode (DDR) transitions are not
      // edges — pinMode(13, OUTPUT) with no level change must not feed a
      // phantom PWL step into the firmware→SPICE bridge. When a mode flip
      // genuinely changes the driven level, that level change IS the edge.
      const key = st.level;
      if (prevLevel[p] !== undefined && prevLevel[p] !== key) {
        const t = toggles[p];
        t.count += 1;
        if (t.firstMs === null) t.firstMs = nowMs;
        t.lastMs = nowMs;
        if (t.edges.length < EDGE_CAP) t.edges.push({ t: +nowMs.toFixed(3), to: st.level });
      }
      prevLevel[p] = key;
    }
  }

  const finalPins = {};
  for (const p of pinsToTrack) {
    const st = readPin(cpu, p);
    if (st) finalPins[String(p)] = st;
  }

  const serial = serialRaw.replace(/\r\n/g, '\n');
  const expectChecks = args.expect.map((text) => ({
    text, found: serial.includes(text),
  }));
  const failChecks = args.fail.map((text) => ({
    text, found: serial.includes(text),
  }));
  const assertionsOk =
    expectChecks.every((c) => c.found) && failChecks.every((c) => !c.found);

  process.stdout.write(
    JSON.stringify({
      ok: true,
      hexFile: path.resolve(args.hex),
      simulatedMs: +((cpu.cycles / MHZ) * 1000).toFixed(1),
      cycles: cpu.cycles,
      serial,
      serialTruncated: serialRaw.length > 20000,
      pins: finalPins,
      toggles,
      assertionsOk,
      expectChecks,
      failChecks,
    }) + '\n',
  );
} catch (err) {
  fail(String(err && err.stack ? err.stack : err));
}
