# simulide / microsim

## Shard shape

`src/microsim/` is SimulIDE's **microcontroller simulation engine** — 258 files, no tests, no build files, no undo/redo (the editor's undo stack lives in a different shard; this shard only *executes* the circuit). The architecture is a three-layer stack. At the bottom sits a **core-agnostic MCU substrate** (`src/microsim/*.cpp|h`): `Mcu` is the QGraphics component, `eMcu` is the electrical/clocking heart, `DataSpace` is the flat register file, `McuModule` is the base class every peripheral derives from, and `McuCreator` is a **declarative device builder** that parses an XML `.mcu` descriptor into memory blocks, a named register map and a list of peripheral instances. In the middle sit the **shared bus engines** (`src/microsim/modules/`): `TwiModule` (I2C), `SpiModule` (SPI), `UsartModule`/`UartTx`/`UartRx` (UART), `OneWire`, `TcpModule` and the AngelScript host `ScriptBase`/`ScriptModule` — these are bus-level, chip-agnostic and reused by every family. On top sit the **per-family CPU cores** (`src/microsim/cores/`): AVR (ATmega family, 38 files), PIC (mid-range / enhanced / 12-bit, 50 files), 8051, 6502, Z80 + the ZX Spectrum ULA, a scriptable CPU whose "CPU" is a user-written AngelScript program, and a QEMU bridge that runs real `qemu-system-*` binaries out-of-process across a shared-memory arena. Every family plugs into the same five seams: `Cpu8bits` (PC/STATUS/stack contract), `Mcu8bits` (RAM + SFR + stack helpers), `DataSpace` (register file with masked reads/writes), `McuModule` (peripheral lifecycle: setup/reset/configureA|B|C/callBack/sleep) and `McuCreator` (per-family factory `createTimer`/`createAdc`/`createUsart`/… keyed off a `type` attribute in the XML). Time is measured in **picoseconds** throughout (`m_psInst`, `m_psTick`, `m_psPerTick`), and the simulation clock is the only source of truth for a timer's counter.

## Per-file notes

### src/microsim/mcu.h
- Purpose: the `Mcu` QGraphics component — the chip on the canvas.
- Key abstractions: friend `McuCreator` (so only the builder may populate the internals); `Mcu::construct` is the LibraryItem factory entry point.
- Data flow: `Mcu` owns an `eMcu` (`m_eMcu`) that owns the CPU and the peripherals; the component only owns pins, properties and UI.
- Non-obvious design decisions: `m_forceFreq` defaults to **true** and `m_uiFreq` to 0, so a device without a declared frequency runs at the simulator's nominal rate rather than stalling.
- Edge cases / failure handling: `propNotFound` is overridden so an unknown property is a soft failure, not a crash.
- Surprising: `mcu.h:99-103` — the constructor mangles PIC part names ("p…a" → trailing 'a' removed, 'f' → 'F'); a legacy hack still in the constructor.

### src/microsim/mcu.cpp
- Purpose: builds the `Mcu` component, finds its device descriptor, loads firmware.
- Key abstractions: `Mcu::construct` → `McuCreator::createMcu`; on error the component removes itself from the circuit and returns nullptr.
- Data flow: descriptor lookup order is (1) `<circuit folder>/<device>/<device>.mcu`, (2) `<circuit folder>/data/<device>/<device>.mcu`, (3) the component list's XML data file.
- Non-obvious design decisions: the component is *removed from the circuit* on a construction error rather than left half-built (`mcu.cpp:62-69`) — a failed device leaves no ghost in the canvas.
- Edge cases / failure handling: `m_error` is a static member reset to 0 at the top of `construct`, so a failed build does not poison the next one.
- Surprising: `mcu.cpp:758-798` — mouse press/release/move events are forwarded to a script CPU, so a scripted MCU can have an interactive UI on the canvas.

### src/microsim/e_mcu.h
- Purpose: the electrical/clocking core of a simulated MCU.
- Key abstractions: `eMcu : DataSpace, eIou`; owns program memory (`std::vector<uint16_t> m_progMem`), EEPROM (`QVector<int>`), the module list, the interrupt controller and the debugger hook.
- Data flow: `eMcu::runEvent()` is the heartbeat — it is rescheduled by the simulator every clock tick and calls `m_cpu->runStep()`.
- Non-obvious design decisions: the clock model keeps **two** periods — `m_cPerInst` (clock ticks per instruction) and `m_cPerTick` (clock ticks per CPU cycle) — because some architectures (8051, 6502) have a multi-cycle bus.
- Edge cases / failure handling: `mcuState_t` is a four-state machine (`mcuStopped / mcuError / mcuRunning / mcuSleeping`); `stepCpu()` and `runEvent()` both guard on `m_state != mcuRunning`.
- Surprising: `e_mcu.h:162-163` — `m_psInst` / `m_psTick` are **picoseconds** per instruction/tick, stored as `uint64_t`; every peripheral converts its own timing to ps, so the whole engine has one unit.

### src/microsim/e_mcu.cpp
- Purpose: reset sequencing, external-clock edge handling, the running heartbeat, sleep/wake.
- Key abstractions: `eMcu::hardReset(bool)` toggles between stopped and running; `eMcu::voltChanged()` handles a pin-driven external clock.
- Data flow: `runEvent()` → `m_cpu->runStep()` → the CPU sets `m_mcu->cyclesDone`; the debugger consumes `cyclesDone` instead of the CPU advancing.
- Non-obvious design decisions: the **debugger substitutes for the clock** — under debug, `runEvent()` decrements `cyclesDone` and calls `m_debugger->stepDebug()` instead of running an instruction (`e_mcu.cpp:135-140`).
- Edge cases / failure handling: `reset()` order is deliberate — modules first, then `DataSpace::initialize()`, then the CPU, then a forced `readPort(0)` so the input registers are not stale (`e_mcu.cpp:70-91`).
- Surprising: `e_mcu.cpp:89-90` — EEPROM is only cleared to 0xFF on reset when `m_saveEepr` is false; with the flag set, EEPROM content survives a reset.

### src/microsim/e_iou.h
- Purpose: declares the IO-unit half of a simulated MCU — the CPU pointer, the external-clock pin and the IoPort registry.
- Key abstractions: `eIou : eElement` with `m_component`, `m_cpu`, `m_clkPin` and a per-instance `QHash<QString, IoPort*> m_ioPorts`.

### src/microsim/e_iou.cpp
- Purpose: implements the IO-unit base — looks a pin up by name across the registered IoPorts.
- Data flow: `eIou::getIoPin(name)` scans every registered IoPort; an empty name returns nullptr rather than a null-deref.
- Non-obvious design decisions: the port hash is **per-instance**, not static, so several MCUs can coexist in one circuit without name collisions.

### src/microsim/mcudataspace.h
- Purpose: declares the register file — the single most reused mechanism in the shard.
- Key abstractions: `m_dataMem` is one flat `vector<uint8_t>` holding RAM *and* SFRs; `m_addrMap` maps logical→physical addresses; `m_regMask` is the per-register write mask; `m_regInfo`/`m_bitMasks`/`m_bitRegs` are the name→address/bit tables.
- Non-obvious design decisions: `m_regOverride` is a public member — it is the value-override backchannel every callback uses to substitute the value the CPU sees.

### src/microsim/mcudataspace.cpp
- Purpose: implements the register file — the only way peripherals touch registers.
- Data flow: `readReg(addr)` / `writeReg(addr, v, masked)` emit the address's `McuSignal`; a callback may set `m_regOverride` to substitute a different value.
- Non-obvious design decisions: the **override backchannel** is how a read-side callback works at all: a timer publishes its current count by overriding the value the CPU reads (`mcudataspace.cpp:56-59`), and the AVR comparator clears ACO by overriding the ACSR value it just read.
- Edge cases / failure handling: the write mask is applied *before* the callback fires, so a callback sees the already-masked value; a mask of `0x00` means "read only" and the write is dropped entirely.
- Surprising: `mcudataspace.cpp:101-110` — `getRamValue`/`setRamValue` toggle `m_isCpuRead` so that a callback can tell "the CPU read this" from "the monitor read this" (the PIC port uses this to return live pin state to the CPU but the RAM value to the monitor).

### src/microsim/mcusignal.h
- Purpose: the typed, masked callback list behind every register read/write hook.
- Key abstractions: `CallBackBase` (linked-list node) + `CallBack<Obj>` (template, holds an object pointer and a member-function pointer).
- Data flow: `connect(obj, &Obj::func, mask)` appends; `emitValue(val)` calls every slot with `val & slot->m_mask`.
- Non-obvious design decisions: **new slots are PREPENDED (LIFO)**, and the comment at `mcusignal.h:74-76` says why: "Interrupt flag clearing after register write callback / Because Interrupts are created first". The ordering is a *semantic* guarantee, not an accident.
- Edge cases / failure handling: `disconnect` does a `dynamic_cast<CallBack<Obj>*>` to find the right slot, so a disconnect for a different type is a no-op; the destructor deletes the whole chain.
- Surprising: the mask is applied at *emit* time, not connect time, so one signal can serve several callbacks with different bit masks.

### src/microsim/regwatcher.h
- Purpose: template helpers that attach a member-function callback to a register.
- Key abstractions: `watchRegister(addr, write, inst, func, mcu, mask)`, `watchRegNames("A,B", …)`, `watchBitNames("X,Y", …)`.
- Data flow: `watchRegNames` resolves names through `mcu->regInfo()`; `watchBitNames` resolves the mask through `mcu->bitMasks()` and the address through `mcu->bitRegs()`.
- Non-obvious design decisions: the signal object is created **on demand** and stored in the DataSpace's `writeSignals`/`readSignals` hash — the watcher table and the signal table are the same thing.
- Edge cases / failure handling: an unknown register name logs an error and is skipped, not fatal.
- Surprising: `R_READ`/`R_WRITE` (defined in `e_mcu.h:21-24`) are passed as a bare `int`, not an enum — a small typing hole in an otherwise type-safe API.

### src/microsim/mcucreator.h
- Purpose: declares the device builder — one `createXxx()` per peripheral kind.
- Key abstractions: the static state the builder carries while parsing one device (`m_CompName`, `m_basePath`, `m_core`, `m_mcuComp`, `mcu`, `m_twi`, `m_spi`, `m_newStack`).

### src/microsim/mcucreator.cpp
- Purpose: **the device builder** — the mechanism that makes a new simulated chip a data file rather than a code change.
- Key abstractions: one `createXxx(QDomElement*)` per peripheral kind; the parsed state is static for the duration of one build.
- Data flow: `createMcu` → `processFile` → walk the XML root's children, dispatching on tag name (`regblock`, `datablock`, `progblock`, `stack`, `interrupts`, `port`, `timer`, `ocm`, `ccpunit`, `msspunit`, `usart`, `twi`, `spi`, `tcp`, `usi`, `adc`, `dac`, `comp`, `vref`, `wdt`, `rom`, `sleep`, `configwords`, `intosc`, `display`, `include`).
- Non-obvious design decisions: the `core` attribute picks the CPU family, and each `createXxx` then asks the *family* for the right subclass via a `createXxx(mcu, name, type)` factory — so the XML says `type="160"` and `AvrTimer::createTimer` decides between the 8-bit and 16-bit variant.
- Edge cases / failure handling: `include` is resolved recursively (`mcucreator.cpp:204-206`), so a device description can be composed from several files; every register outside the RAM size is a logged error, not a crash.
- Surprising: `mcucreator.cpp:497-501` — bit names support **aliases** with `A|B` syntax and the comment "Example tiny WDTCR.WDTIE is 328 WDTCSR.WDIE": the same bit is named differently on different chips, and the alias table lets one core handle both.

### src/microsim/mcumodule.h
- Purpose: declares the base class of every MCU peripheral.
- Key abstractions: lifecycle hooks `setup()` (bind register bits), `reset()`, `configureA/B/C(uint8_t)` (a config register was written), `callBack()` / `callBackDoub(double)` (an event fired), `sleep(int mode)`; three `regBits_t` config-bit sets.

### src/microsim/mcumodule.cpp
- Purpose: implements the peripheral base — the sleep-mode bitmask bookkeeping and the interrupt handle.
- Non-obvious design decisions: `m_sleeping` is a bitmask test (`m_sleepMode & 1<<mode`), so a peripheral declares *which* sleep modes it participates in; `sleep(-1)` is the "wake up" signal.

### src/microsim/mcutimer.h
- Purpose: declares the generic timer.
- Key abstractions: `m_countVal`, `m_ovfMatch`, `m_ovfPeriod`, `m_psPerTick`, `m_timeOffset`, and the list of attached output-compare / input-capture units.

### src/microsim/mcutimer.cpp
- Purpose: the generic timer.
- Data flow: `sheduleEvents()` computes the absolute sim time of the next overflow and schedules it; `calcCounter()` **derives** the current count from the simulator clock rather than counting ticks; `updtCount()` pushes the derived value into the RAM registers when the CPU reads them.
- Non-obvious design decisions: `calcCounter()` (line 183) recomputes `m_countVal` from `m_ovfTime - circTime`, so a timer is *correct* even if its event was late or coalesced — the count is a function of time, not of event deliveries.
- Edge cases / failure handling: `sheduleEvents()` only cancels and re-adds the Simulator event **if the absolute overflow time actually changed** (line 133) — otherwise a register write would churn the event queue.
- Surprising: `mcutimer.cpp:126` — "OVF before counter: next OVF missed" adds `m_maxCount` to the period when the counter has overrun the match, so a late reschedule does not lose an overflow.

### src/microsim/mcuprescaled.h
- Purpose: declares the prescaler mix-in shared by timers, ADC, SPI, TWI, USI, WDT, OCM and Vref.
- Key abstractions: `m_prSelBits` (the prescaler-selection bits), `m_prIndex`, `m_prescaler`, `m_prescList`.

### src/microsim/mcuprescaled.cpp
- Purpose: implements prescaler selection.
- Data flow: `setPrescIndex(i)` picks `m_prescList[i]`.
- Edge cases / failure handling: an out-of-range index is clamped to 0 rather than crashing.
- Surprising: the *value* `0x8000`/`0x8001` in the prescaler list is overloaded to mean "external clock, falling/rising edge" — a magic value in a numeric list, decoded by `AvrTimer::configureClock`.

### src/microsim/mcuinterrupts.h
- Purpose: declares `Interrupt` (one source: flag mask + register address, enabled, priority, auto-clear, continuous, wake-up mask) and `Interrupts` (the pending list, the running list, the global enable flag).

### src/microsim/mcuinterrupts.cpp
- Purpose: the interrupt controller.
- Data flow: a peripheral calls `m_interrupt->raise()`; the flag bit is set in RAM, the interrupt joins the pending list; `Interrupts::runInterrupts()` picks the highest-priority pending one and calls `m_cpu->INTERRUPT(vector)`.
- Non-obvious design decisions: the pending list is **kept sorted by priority on insert** ("High priority first & last In, las Out", `mcuinterrupts.cpp:230`) and a *running* list preserves nesting — a higher-priority interrupt preempts a running one and the preempted one is pushed onto the running list.
- Edge cases / failure handling: "write 1 to clear" semantics are implemented in `writeFlag()` by setting `m_regOverride` (`mcuinterrupts.cpp:66-79`); a flag raised while its source is disabled is **remembered** (`m_remember`) and fires as soon as it is enabled.
- Surprising: `mcuinterrupts.cpp:180` — a *continuous* (level-triggered) interrupt that is still raised at RETI is re-added to the pending list, so a level-held IRQ keeps re-firing. This is exactly the "Pin INT" AVR case.

### src/microsim/mcupin.h
- Purpose: declares an MCU pin — the `extIntTrig_t` enum, the out/dir control flags and the pin mask.

### src/microsim/mcupin.cpp
- Purpose: implements an MCU pin.
- Data flow: `voltChanged()` detects a pin-state change, raises the external interrupt if the trigger matches, and reports the change to the port so the port input register is updated.
- Non-obvious design decisions: the `pinLow` trigger case fires **once at simulation start** (`mcupin.cpp:72`: "Trigger Low level without pin change at simulation start") — a level-triggered IRQ that is already asserted at reset must fire, not wait for an edge.
- Edge cases / failure handling: `m_inpMask` is *inverted* (true means "always input"), and `setDirection` computes `m_isOut = (out || m_outMask) && m_inpMask` so a permanently-input pin can never be driven.
- Surprising: `getInpState()` calls `voltChanged()` first (`mcupin.cpp:89-93`) — reading the pin forces the edge-detection path, so a read always sees a fresh state.

### src/microsim/mcuport.h
- Purpose: declares an 8-bit GPIO port of an MCU — the out/in/dir register pointers, the pin vector, the direct-control API and the interrupt mask.

### src/microsim/mcuport.cpp
- Purpose: implements an MCU GPIO port.
- Data flow: `pinChanged(mask, val)` merges the changed bits into `m_pinState` and writes the port input register **directly to RAM** (bypassing `writeReg`, with the reason in the comment: "RAM Table reads actual RAM value").
- Non-obvious design decisions: `outChanged()` and `dirChanged()` compute `*m_outReg ^ val` and only touch the pins whose bit **actually changed** — a register write of the same value costs nothing.
- Edge cases / failure handling: `m_dirInv` supports the PIC convention (1 = input, 0 = output) versus the AVR convention (1 = output) with a single flag.
- Surprising: `mcuport.cpp:51` — `if( m_sleeping ) return;` means the port input register is **not** updated while the MCU sleeps, so a wake-up sees the pin states at the moment it wakes.

### src/microsim/mcuocunit.h
- Purpose: declares the generic output-compare unit (PWM and compare share it) — the compare-match value, the pin and the `ocAct_t` action enum.

### src/microsim/mcuocunit.cpp
- Purpose: implements the generic output-compare unit.
- Data flow: `sheduleEvents(ovf, countVal, rot)` computes the time from now until the counter reaches `m_comMatch` and schedules the match; `runEvent()` raises the interrupt and drives the pin.
- Non-obvious design decisions: the `rot` parameter is the **PWM duty-resolution rotation** — the PIC uses 2 extra bits, so the compare value and the time are both shifted (`mcuocunit.cpp:76-79`, `104-105`).
- Edge cases / failure handling: the match is only scheduled if `match <= ovf && match >= countVal` — "be sure next comp match is still ahead" — otherwise the event is simply not scheduled and the next period re-arms it.
- Surprising: `mcuocunit.cpp:62-64` — for a reverse-counting timer the "set" state is inverted, so a PWM output looks the same forwards and backwards.

### src/microsim/mcuocm.h
- Purpose: declares the output-compare-modifier — the two OC units and the abstract `OutputOcm()`.

### src/microsim/mcuocm.cpp
- Purpose: implements the output-compare-modifier.
- Data flow: the OC units call `setOcActive` / `setState`; `McuOcm::setOcActive` gives the pin back to the OCM when **both** units are active, and `OutputOcm()` (implemented by `AvrOcm`) computes the pin state.
- Non-obvious design decisions: the OCM takes control only when both units are active — a single active unit drives the pin directly.

### src/microsim/mcuicunit.h
- Purpose: declares the generic input-capture unit — the capture pins/registers, edge polarity and prescaler.

### src/microsim/mcuicunit.cpp
- Purpose: implements the generic input-capture unit.
- Data flow: `voltChanged()` on the selected edge counts to the prescaler, then samples `m_timer->getCount()` into the capture registers and raises the interrupt.
- Non-obvious design decisions: the captured value is the **parent timer's count at the edge**, not a separate counter — capture and compare therefore always agree.

### src/microsim/mcuadc.h
- Purpose: declares the generic ADC — the ADC pins, reference pins, conversion time and resolution.

### src/microsim/mcuadc.cpp
- Purpose: implements the generic ADC.
- Data flow: `startConversion()` reads the selected pin's voltage, subtracts the negative reference, clamps to [0, Vref], scales by `m_maxValue/(VrefP-VrefN)` and schedules `m_convTime`; `runEvent()` writes ADCL/ADCH and raises the interrupt.
- Non-obvious design decisions: the conversion is **asynchronous** — the ADC is a scheduled event, not a blocking operation, so firmware that polls the "conversion complete" bit sees realistic timing.
- Edge cases / failure handling: the voltage is clamped on both sides, and the channel index is bounds-checked against the pin list.

### src/microsim/mcucomparator.h
- Purpose: declares the generic analog comparator — the +/-, reference and output pins.

### src/microsim/mcucomparator.cpp
- Purpose: implements the generic analog comparator.
- Data flow: the Vref module calls `callBackDoub(vref)`; the comparator compares against the N pin and updates its output.
- Non-obvious design decisions: `m_vref` is left at 0 in `initialize()` with the comment "Let Vref Module set this value" — the base class never invents a reference.

### src/microsim/mcudac.h
- Purpose: declares the generic DAC base — the reference/output pins and the output-value register pointer.

### src/microsim/mcudac.cpp
- Purpose: implements the generic DAC base; the base class deliberately holds only state (`m_enabled`, `m_outVoltEn`, `m_vRefP/N`, `m_outVal`) and the actual voltage computation is family-specific.

### src/microsim/mcueeprom.h
- Purpose: declares the generic EEPROM — the address and data register pointers.

### src/microsim/mcueeprom.cpp
- Purpose: implements the generic EEPROM over the ROM-backed store.
- Non-obvious design decisions: `readEeprom`/`writeEeprom` are *immediate*; the write-timing behaviour is entirely in the subclasses (AVR's 4-cycle EEMPE window, PIC's 0x55/0xAA unlock).

### src/microsim/mcuvref.h
- Purpose: declares the generic voltage reference — the output pin and the callback list.

### src/microsim/mcuvref.cpp
- Purpose: implements the generic voltage reference.
- Data flow: `addCallBack(mod, true/false)` registers a module that must be told when the reference changes; `callBackDoub(vref)` is the notification.

### src/microsim/mcuwdt.h
- Purpose: declares the generic watchdog base — the fuse, overflow-interrupt, overflow-reset and period fields.

### src/microsim/mcuwdt.cpp
- Purpose: the generic watchdog base; only initialises the state.
- Surprising: the file is 18 lines — the "generic" class is a header; the real behaviour lives in `AvrWdt` and `PicWdt`.

### src/microsim/mcuconfigword.h
- Purpose: declares `ConfigWord` with a `QHash<uint16_t, uint16_t>` of address → 16-bit configuration word.

### src/microsim/mcuconfigword.cpp
- Purpose: implements the configuration-word store (the fuses).
- Data flow: `setCfgWord(addr, data)` only accepts addresses already in the table (the table is populated from the XML), so an unknown fuse address is rejected with `false`.
- Non-obvious design decisions: the debug print of every config word write is deliberate — it is the only feedback a user gets that a fuse actually took.

### src/microsim/mcuintosc.h
- Purpose: declares the internal/external oscillator — the clock-in/out pin handles, the PLL multiplier and the external-clock flag.

### src/microsim/mcuintosc.cpp
- Purpose: implements the internal/external clock source and the clock-output pin.
- Data flow: `configPins(inIo, outIo, clkOut)` (called from the config word) decides whether OSC1/OSC2 are I/O or oscillator pins; `runEvent()` toggles the clock-out pin every `m_psInst/2`.
- Non-obvious design decisions: `m_extClock = !m_clkInIO || !m_clkOutIO` — if **either** pin is reused as I/O, the device is on an external clock, which is a surprising consequence but is how the real chips behave.
- Edge cases / failure handling: `m_clkInPin->setUnused(...)` marks a pin as not-present in the package when the config word repurposes it.

### src/microsim/mcusleep.h
- Purpose: declares the generic sleep module — the sleep mode byte and the enable flag.

### src/microsim/mcusleep.cpp
- Purpose: implements the generic sleep module; `callBack()` is the wake-up path and puts the MCU back into running mode.

### src/microsim/mcuspi.h
- Purpose: declares the MCU-side SPI wrapper over the shared `SpiModule` — the data and status register pointers.

### src/microsim/mcuspi.cpp
- Purpose: implements the MCU-side SPI wrapper; initialises the shared `SpiModule` and clears the status register.
- Surprising: the file is 31 lines and its only real content is clearing the status register on init — the SPI protocol lives entirely in `modules/spi`.

### src/microsim/mcutwi.h
- Purpose: declares the MCU-side TWI wrapper over the shared `TwiModule` — the address/data/status register pointers.

### src/microsim/mcutwi.cpp
- Purpose: implements the MCU-side TWI wrapper; sets the prescaler to 1 and calls `updateFreq()`.
- Surprising: the file is 29 lines — all the TWI protocol is in `modules/twi`.

### src/microsim/mcuuart.h
- Purpose: declares the MCU-side USART — the 9th-bit (TXB8/RXB8) bit handles and the module number.

### src/microsim/mcuuart.cpp
- Purpose: implements the MCU-side USART.
- Data flow: raises the data-register-empty interrupt, prints the sent frame to the serial monitor and overrides the receive register with the received byte.
- Non-obvious design decisions: `readByte` only overrides the register when `m_mcu->isCpuRead()` — the monitor reading the register must not consume the byte from the FIFO.

### src/microsim/mcutypes.h
- Purpose: two POD structs shared by every core — `regInfo_t` (address + reset value) and `regBits_t` (base bit, mask, live pointer into RAM, address).
- Non-obvious design decisions: `regBits_t` holds a **raw pointer into the RAM vector**, so bit access is a direct memory read/write with no lookup — the expensive name resolution happens once at setup.

### src/microsim/datautils.h
- Purpose: declares the register-bit helpers — `overrideBits`/`replaceBits`/`getRegBits`/`getRegBitsVal`/`getRegBitsBool`/`setRegBits`/`clearRegBits`/`writeRegBits` plus the two name-resolution functions.

### src/microsim/datautils.cpp
- Purpose: implements the register-bit helpers.
- Data flow: `getBitMask(QStringList, DataSpace*)` ORs the named bit masks; `getRegBits("A,B", mcu)` returns a `regBits_t` for a set of consecutive bits.
- Non-obvious design decisions: `getRegBits` finds the base bit by **rotating the mask right** until the low bit is set (`datautils.cpp:24-28`) — the caller does not have to know the bit position, only the names.
- Edge cases / failure handling: `writeBitsToReg` writes through `mcu->writeReg` (not directly to RAM), so bit writes still fire the watchers.

### src/microsim/cores/cpu8bits.h
- Purpose: declares the minimum contract every CPU core honours.
- Key abstractions: `m_PC`, `m_STATUS` (a pointer into RAM), `m_RET_ADDR`, `m_spl`/`m_sph`, and the virtuals `runStep()`, `extClock(bool)`, `INTERRUPT(vector)`, `CALL_ADDR(addr)`, `RET_ADDR()`.
- Non-obvious design decisions: the comment "All CPUs must use this" on `m_STATUS` / `m_PC` is a soft contract enforced only by the monitor reading `getStatus()`.

### src/microsim/cores/cpu8bits.cpp
- Purpose: implements the 8-bit CPU base; the constructor nulls the status/stack pointers and `reset()` clears the PC and the return address.

### src/microsim/cores/mcu8bits.h
- Purpose: declares the shared 8-bit MCU memory and stack helpers.
- Key abstractions: `GET_RAM`/`SET_RAM` split on the SFR window (`m_regStart`..`m_regEnd`): SFR addresses go through `readReg`/`writeReg` (so watchers fire) and RAM addresses go straight to the vector; `PUSH_STACK`/`POP_STACK` write `m_progAddrSize` bytes (1–3) with a configurable pre/post-increment and direction.
- Non-obvious design decisions: the stack is expressed in terms of `GET_SP`/`SET_SP` and `m_spPre`/`m_spInc`, so an AVR (pre-decrement, 2 bytes) and a PIC14e (16-level hardware stack) share the same primitive.

### src/microsim/cores/mcu8bits.cpp
- Purpose: implements the shared 8-bit MCU CPU base.
- Data flow: the constructor caches the RAM pointer, program-memory pointer, register window bounds and the STATUS register address; `CALL_ADDR` pushes the PC and sets the return-cycle count.
- Surprising: `mcu8bits.cpp:13` — `m_dataMemEnd = mcu->ramSize(); if( m_dataMemEnd ) m_dataMemEnd--;` — the "end of RAM" is one past the last valid address, and the off-by-one is corrected immediately.

### src/microsim/cores/avr/avr_defines.h
- Purpose: the AVR decoder's field-extraction macros (`get_d5`, `get_vd5`, `get_io5_b3mask`, `get_h4_k8`…) and the SREG bit indices.
- Non-obvious design decisions: the macros expand to **declarations** (`const uint8_t d = …`) so a decode arm reads like a sentence.

### src/microsim/cores/avr/avrcore.h
- Purpose: declares the AVR CPU — the status-flag helper set, the optional RAMPZ/EIND extended-address registers and the self-programming SPM bits.

### src/microsim/cores/avr/avrcore.cpp
- Purpose: the AVR CPU — instruction decode and execution.
- Key abstractions: a giant `switch` on the 16-bit opcode word; helpers `flags_zns`, `flags_sub`, `flags_add_zns` etc. that maintain SREG.
- Data flow: `runStep()` fetches `m_progMem[m_PC]`, decodes, updates the PC and sets `m_mcu->cyclesDone = cycle`.
- Non-obvious design decisions: the file is explicitly *"Based on simavr decoder"* (Michel Pollet) — the opcode semantics come from a proven simulator, and the flag helpers were re-derived rather than copied.
- Edge cases / failure handling: `if( new_pc >= m_progSize ) new_pc = 0;` — the PC wraps at the top of flash.
- Surprising: `avrcore.cpp:884` — a 16-bit instruction is detected by `is_instr_32b(new_pc)` and the skip instructions add 2 cycles and 2 bytes when they skip over one.

### src/microsim/cores/avr/avrtimer.h
- Purpose: declares `AvrTimer` and its variants (800/801/810/820/821/822/160); the WGM (waveform generation) mode enum and the OCA/OCB/OCC output-compare handles live here.

### src/microsim/cores/avr/avrtimer.cpp
- Purpose: the AVR timers.
- Data flow: `configureA(TCCRxA)` fans the WGM bits out to the compare units; `configureB(TCCRxB)` sets the prescaler and the WGM32 bits; `updtWgm()` recomputes the compare/PWM actions.
- Non-obvious design decisions: the timer keeps `m_OCA`/`m_OCB`/`m_OCC` and identifies them by the **suffix of their name** ("A"/"B"/"C") — the XML names the units, the code parses the name.
- Edge cases / failure handling: `configureClock()` decodes the overloaded `0x8000`/`0x8001` prescaler values into "external clock, falling/rising edge".
- Surprising: `avrtimer.cpp:93` — `enable( m_prIndex )` is used to enable the timer: the *prescaler index* doubles as the "is it running" flag, so a timer with prescaler 0 is considered stopped.

### src/microsim/cores/avr/avrocunit.h
- Purpose: declares the AVR output-compare unit — the OCR register width mask and the pin-state override.

### src/microsim/cores/avr/avrocunit.cpp
- Purpose: implements the AVR output-compare unit.
- Non-obvious design decisions: `m_OCRXmask` restricts the compare value to the implemented bits of that timer (8-bit timer → 8-bit mask), applied on every OCR write.

### src/microsim/cores/avr/avrocm.h
- Purpose: declares the AVR OCM with a `configureA` entry point and an abstract `OutputOcm()`.

### src/microsim/cores/avr/avrocm.cpp
- Purpose: implements the AVR OCM; `OutputOcm()` ANDs the two OC states when the TIMSK mode bit is clear and ORs them when set.

### src/microsim/cores/avr/avrspi.h
- Purpose: declares the AVR SPI — the SPCR/SPSR/SPDR register-bit handles and the 2× speed flag.

### src/microsim/cores/avr/avrspi.cpp
- Purpose: implements the AVR SPI.
- Data flow: maps SPCR (MSTR/CPOL/CPHA/DODR/SPR) onto the shared `SpiModule` edge/prescaler state, and raises SPIF on transaction end.
- Non-obvious design decisions: `m_sampleEdge = ( clkPol == clkPha ) ? Clock_Rising : Clock_Falling;` with the comment "This shows up in the truth table" — the four SPI modes are derived from the datasheet truth table rather than tabulated.

### src/microsim/cores/avr/avrtwi.h
- Purpose: declares the AVR TWI — the TWEN/TWWC/TWSTO/TWSTA/TWEA/TWINT bit handles and the TWSR pointer.

### src/microsim/cores/avr/avrtwi.cpp
- Purpose: implements the AVR TWI master/slave.
- Data flow: TWCR writes are diffed against the previous TWCR to detect the START/STOP/TWINT edges; TWDR writes either send a byte or set the TWWC (write-collision) bit.
- Non-obvious design decisions: the AVR TWI status codes are published by *clearing the low three bits and OR-ing the new state* into TWSR (`avrtwi.cpp:154-155`) — the register's upper bits are the prescaler and are preserved.
- Edge cases / failure handling: a slave that receives STOP while addressed raises `TWI_SRX_STOP_RESTART`, which is how AVR firmware detects a bus error.

### src/microsim/cores/avr/avrtwicodes.h
- Purpose: the Atmel AVR315 TWI status-code enum (TWI_START…TWI_NO_STATE) — the shared vocabulary between the AVR TWI driver and the generic I2C module.

### src/microsim/cores/avr/avrusart.h
- Purpose: declares the AVR USART — the UCSRnA/B/C and UBRRnL/H bit handles (the instance suffix is derived from the module name).

### src/microsim/cores/avr/avrusart.cpp
- Purpose: implements the AVR USART.
- Data flow: UBRR writes are watched directly (`watchRegNames("UBRR"+n+"L", R_WRITE, …)`) because the baud rate depends on two bytes and the atmega8 folds UBRRH into UCSRnC.
- Non-obvious design decisions: `setBaurrate()` computes `period = 16*(ubrr+1)*psInst` (÷2 in double-speed) — the formula is the datasheet's, expressed in picoseconds.

### src/microsim/cores/avr/avrusi.h
- Purpose: declares the AVR Universal Serial Interface — the USICR/USISR bit handles and the three-mode (SPI/TWI/timer) state flags.

### src/microsim/cores/avr/avrusi.cpp
- Purpose: implements the AVR USI — one bit-level engine reused for 3-wire SPI, 2-wire TWI and timer-clocked modes, including start/stop-condition detection.
- Non-obvious design decisions: mode 3 ("2-wire, SCL held low at counter overflow") is implemented by the same `shiftData`/`setOutput` pair as the SPI modes; the TWI start/stop detector runs on the *same* clock-edge callback.

### src/microsim/cores/avr/avrwdt.h
- Purpose: declares the AVR watchdog plus two generation variants (AvrWdt00 with WDIF/WDIE/WDP3, AvrWdt01 with a fixed 2.097152 s period).

### src/microsim/cores/avr/avrwdt.cpp
- Purpose: implements the AVR watchdog.
- Data flow: writing WDCE+WDE opens a 4-cycle window (a scheduled event) in which WDP and WDE may still be changed; afterwards the old values are restored via `overrideBits` and `m_regOverride`.
- Non-obvious design decisions: the "you may only change the prescaler for 4 cycles after WDCE" rule is modelled with a real scheduled event, and the illegal change is *hidden from firmware* by overriding the register value.

### src/microsim/cores/avr/avradc.h
- Purpose: declares `AvrAdc` plus a type ladder (AvrAdc00/02/03/04/10/11/20), each overriding `setup`/`updtVref`/`specialConv` for a different AVR ADC generation.

### src/microsim/cores/avr/avradc.cpp
- Purpose: implements the AVR ADC.
- Data flow: `configureA(ADCSRA)` computes the conversion time `psInst*(13+initCycles)*presc`, where the first conversion after enabling the ADC costs 12 extra cycles (25 instead of 13).
- Non-obvious design decisions: `autotriggerConf()` wires the ADC's auto-trigger to the *interrupt* of the comparator, the timer overflow or the capture event — the trigger source is a callback list, not a switch inside the ADC.

### src/microsim/cores/avr/avrcomparator.h
- Purpose: declares the AVR analog comparator — the ACSR/AIN0D/AIN1D bit sets and the ACO/ACI/ACIE/ACIC/ACIS register-bit handles.

### src/microsim/cores/avr/avrcomparator.cpp
- Purpose: implements the AVR analog comparator.
- Data flow: compares AIN0/AIN1 (or the 1.1 V bandgap) and raises the comparator interrupt on toggle/rising/falling edge; reading ACSR triggers a re-compare and clears ACO.
- Non-obvious design decisions: `readACO` is registered as a **read** watcher on ACSR and clears the flag through `m_regOverride` — the datasheet's "write 1 to clear" is modelled by a read hook.

### src/microsim/cores/avr/avreeprom.h
- Purpose: declares the AVR EEPROM — the EECR pointer and the EEPM/EEMPE/EEPE/EERE register-bit handles.

### src/microsim/cores/avr/avreeprom.cpp
- Purpose: implements the AVR EEPROM.
- Data flow: models the EEMPE/EEPE 4-cycle write-enable window and the 1.8/3.4/8.5 ms erase-write cycle via a scheduled Simulator event.

### src/microsim/cores/avr/avrpin.h
- Purpose: declares the AVR pin, overriding `setPortState` and `ConfExtInt`.

### src/microsim/cores/avr/avrpin.cpp
- Purpose: implements the AVR pin — a port-register write also sets the 100 kΩ pull-up (AVR ports have pull-ups), and the ISC bits choose the external-interrupt edge.

### src/microsim/cores/avr/avrport.h
- Purpose: declares the AVR port — `pinRegChanged` and the AvrPin factory.

### src/microsim/cores/avr/avrport.cpp
- Purpose: implements the AVR port — a write to the PORT register toggles only the changed bits (`outChanged` computes the XOR) and the PIN register read is overridden with the live pin state.

### src/microsim/cores/avr/avrinterrupt.h
- Purpose: declares `AVRInterrupt` with a static `getInterrupt` factory; the SREG-I handling it once had is commented out.

### src/microsim/cores/avr/avrinterrupt.cpp
- Purpose: implements the AVR interrupt — currently a thin subclass of the generic `Interrupt`, whose per-family `execute`/`exitInt` overrides are commented out.

### src/microsim/cores/avr/avricunit.h
- Purpose: declares the AVR input-capture unit — the per-instance ICES/ICNC bit set (the suffix is taken from the timer name).

### src/microsim/cores/avr/avricunit.cpp
- Purpose: implements the AVR input capture; ICES selects the edge, ICNC is not yet implemented (the `/// TODO INCN` at line 30).

### src/microsim/cores/avr/avrsleep.h
- Purpose: declares the AVR sleep modes — the `sleepMode_t` enum (idle/ADC/PowerDo/PowerSa/Stand/ExtSt) and the SM/SE bit handles.

### src/microsim/cores/avr/avrsleep.cpp
- Purpose: implements the AVR sleep modes; reads SM/SE bits, tracks the sleep mode, and detaches the configured wake-up interrupts when sleep is disabled.

### src/microsim/cores/avr/avrintosc.h
- Purpose: declares the AVR internal RC oscillator — the CLKPS prescaler bit set.

### src/microsim/cores/avr/avrintosc.cpp
- Purpose: implements the AVR internal RC oscillator.
- Data flow: derives the CPU frequency from the UI-set frequency divided by the CLKPR prescaler index, calling `freqChanged` when the index changes.
- Non-obvious design decisions: the file's header comment documents a known limitation — the CKDIV8 fuse divides the UI-set frequency by 8 before the user sees it.

### src/microsim/cores/pic/picmrcore.h
- Purpose: declares the PIC mid-range ALU — the 8-deep hardware circular stack, the bank register, the PCL/PCLATH program-counter write and the full ALU method set.

### src/microsim/cores/pic/picmrcore.cpp
- Purpose: the PIC mid-range ALU, written as one named method per instruction.
- Key abstractions: `m_Wreg`, `m_OPTION`, `m_FSR`, `m_bank`, and the 8-entry circular hardware stack.
- Data flow: `decode(instr)` is a switch on the top bits; each arm calls a named method that updates the file register and the STATUS bits.
- Non-obvious design decisions: `setPC()` writes the low byte of the PC back into the PCL register, so a program that reads PCL sees a consistent value.
- Edge cases / failure handling: `setBank()` masks the bank bits and shifts by 7, so the bank is a byte offset into the 256-byte space.
- Surprising: `picmrcore.cpp:48` — the carry is written as `write_S_Bit( C, newV & 0x100 )`, i.e. the *unshifted* value is passed to a bit-writer; it works only because the writer tests the truthiness. A latent bug that happens to be harmless.

### src/microsim/cores/pic/pic14core.h
- Purpose: declares the mid-range PIC core, overriding `GET_RAM`/`SET_RAM` to resolve the INDF indirect register and the PCL/PCLATH program-counter write.

### src/microsim/cores/pic/pic14core.cpp
- Purpose: implements the mid-range PIC core; binds the FSR/OPTION registers and watches the R0/R1 bank bits to switch the RAM bank.

### src/microsim/cores/pic/pic12core.h
- Purpose: declares the PIC12 core — the TRISGPIO register address.

### src/microsim/cores/pic/pic12core.cpp
- Purpose: implements the PIC12 core — decodes the 12-bit instruction set (OPTION/SLEEP/CLRWDT/TRIS plus the standard ALU/bit/control-transfer opcodes).

### src/microsim/cores/pic/pic14ecore.h
- Purpose: declares the enhanced PIC core — the FSR0/FSR1/BSR/PCLATH registers and their shadow (SHAD) copies used for interrupt context save/restore.

### src/microsim/cores/pic/pic14ecore.cpp
- Purpose: implements the enhanced PIC core — 16-deep hardware stack, two FSRs, and the enhanced opcode set (MOVIW/MOVWI/ADDFSR/LSRF/ASRF/SUBWFB/ADDWFC/BRA…).
- Non-obvious design decisions: the interrupt context is saved into **RAM shadow registers** (`WREG_SHAD`, `STATUS_SHAD`, `BSR_SHAD`, `PCLATH_SHAD`, `FSRx_SHAD`) that the XML device description must provide — the same mechanism the real silicon uses.

### src/microsim/cores/pic/pic14einterrupt.h
- Purpose: declares `Pic14eInterrupt`, overriding `execute` and `exitInt`.

### src/microsim/cores/pic/pic14einterrupt.cpp
- Purpose: implements the PIC14e interrupt — saves the CPU context on entry and restores it on exit, around the generic `Interrupt::execute`/`exitInt`.

### src/microsim/cores/pic/picinterrupt.h
- Purpose: declares the PIC interrupt; the GIE handling is commented out.

### src/microsim/cores/pic/picinterrupt.cpp
- Purpose: implements the PIC interrupt — `m_autoClear = false` (the flag is cleared by the handler) and `m_wakeup = 0xFF` (any source wakes the MCU from sleep).

### src/microsim/cores/pic/picconfigword.h
- Purpose: declares `PicConfigWord` over `ConfigWord` plus five per-family subclasses, and the `configClk`/`configWdt`/`configRst` helpers.

### src/microsim/cores/pic/picconfigword.cpp
- Purpose: implements the PIC configuration word.
- Data flow: decodes the config bits into clock source (FOSC), watchdog enable, MCLR enable and (type 04) PLL multiplier, applying them to the internal oscillator and the MCU component.
- Non-obvious design decisions: `configClk` maps FOSC to a human-readable string and to three booleans (`ioI`, `ioO`, `clO`) handed to the internal oscillator — the config word is the *only* thing that decides the clock source.

### src/microsim/cores/pic/picintosc.h
- Purpose: declares `PicIntOsc` plus three per-family variants with their OSCCON bit sets.

### src/microsim/cores/pic/picintosc.cpp
- Purpose: implements the PIC internal oscillator.
- Data flow: maps OSCCON (SCS/IRCF/OSCF/SPLLEN) to a frequency, with the PLL multiplier applied for the 8 MHz case, and the config word able to override the choice.

### src/microsim/cores/pic/pictimer.h
- Purpose: declares `PicTimer` and the variants PicTimer0/2/160/161 — the TCON/OPTION/PCON bit handles.

### src/microsim/cores/pic/pictimer.cpp
- Purpose: implements the PIC timers.
- Data flow: T0 (prescaler shared with the watchdog, T0CS/T0SE select the external clock), T2 (PR2 period, TOUTPS) and the 16-bit T1/T2 variants.
- Non-obvious design decisions: T0 and the watchdog **share one prescaler** — the PSA bit decides which one owns it, and the code implements the sharing by moving the prescaler index between the two modules.

### src/microsim/cores/pic/picccpunit.h
- Purpose: declares the CCP unit — the `ccpMode_t` enum and the three sub-unit handles.

### src/microsim/cores/pic/picccpunit.cpp
- Purpose: implements the CCP unit, which multiplexes capture, compare and PWM modes over one CCPxCON register and one interrupt.
- Non-obvious design decisions: the CCP unit owns three sub-units and forwards `setInterrupt` and `setPin` to all of them — one interrupt, one pin, three behaviours.

### src/microsim/cores/pic/picocunit.h
- Purpose: declares `PicOcUnit` and `PicPwmUnit` (plus two per-family PWM variants) over `McuOcUnit`.

### src/microsim/cores/pic/picocunit.cpp
- Purpose: implements the PIC compare and PWM units; the PWM duty is `CCPRxL` plus 2 bits from CCPxCON (the `rot=2` shift).

### src/microsim/cores/pic/picicunit.h
- Purpose: declares the PIC capture unit with a `configure(CCPxM)` entry point.

### src/microsim/cores/pic/picicunit.cpp
- Purpose: implements the PIC input capture; CCPxM 4/5/6/7 select falling, rising, rising/÷4, rising/÷16.

### src/microsim/cores/pic/picadc.h
- Purpose: declares `PicAdc` plus per-family variants (00/01/02/10/11/20/3), each binding its own ADCON/ADCS/PCFG/ANSEL bit set and Vref rules.

### src/microsim/cores/pic/picadc.cpp
- Purpose: implements the PIC ADC.
- Data flow: converts the selected channel voltage over a scheduled conversion time, implements the PCFG analog/digital pin masks per ADC type, and reads the internal temperature sensor / DAC output / FVR buffer for the special channels.

### src/microsim/cores/pic/piccomparator.h
- Purpose: declares `PicComp` and its per-family subclasses with the CMCON/CMxCON0 bit handles.

### src/microsim/cores/pic/piccomparator.cpp
- Purpose: implements the PIC comparators; each chip type wires a different set of pins as +/-, output and reference, and the mode bits choose between them.
- Non-obvious design decisions: the `connect(pinN, pinP, pinOut)` helper moves the callback subscription between pins as the mode changes, so a pin that becomes an input stops being sampled.

### src/microsim/cores/pic/picvref.h
- Purpose: declares `PicVref` and `PicVrefE` — the VRCON/FVRCON bit handles.

### src/microsim/cores/pic/picvref.cpp
- Purpose: implements the PIC voltage reference; the VRR/VR ladder and the FVR (fixed voltage reference + temperature sensor).

### src/microsim/cores/pic/picdac.h
- Purpose: declares the PIC DAC — the DACCON0/DACCON1 bit handles and the FVR reference.

### src/microsim/cores/pic/picdac.cpp
- Purpose: implements the PIC DAC; the output is `(VrefP-VrefN)*DACR/32 + VrefN`.

### src/microsim/cores/pic/piceeprom.h
- Purpose: declares the PIC EEPROM — the EECON1/EECON2 bit handles and the unlock-sequence state.

### src/microsim/cores/pic/piceeprom.cpp
- Purpose: implements the PIC EEPROM; enforces the 0x55/0xAA unlock sequence within two cycles, schedules a 5 ms write, and clears the WR/RD bits appropriately.

### src/microsim/cores/pic/picmssp.h
- Purpose: declares the MSSP — the SSPMx/SSPEN bit handles and the SPI/TWI unit handles.

### src/microsim/cores/pic/picmssp.cpp
- Purpose: implements the MSSP; the SSPx mode bits select SPI master/slave (with or without SS) or I2C master/slave, and the module disables the other unit before enabling the new one.

### src/microsim/cores/pic/picspi.h
- Purpose: declares the PIC SPI — the SSPEN/CKP/CKE bit handles.

### src/microsim/cores/pic/picspi.cpp
- Purpose: implements the PIC SPI; the SSPEN/CKP/CKE bits set the clock polarity, phase and sample edge, the SSPBUF write starts a master transaction, and the end of it clears the BF status bit and raises the interrupt.

### src/microsim/cores/pic/pictwi.h
- Purpose: declares the PIC SSP-mode I2C — the SSPCON/SSPCON2/SSPSTAT bit handles.

### src/microsim/cores/pic/pictwi.cpp
- Purpose: implements the PIC SSP-mode I2C; the SSPCON2 SEN/RSEN/PEN bits generate start/stop, RCEN triggers a master read, and the SSPSTAT BF/RW bits track the buffer state.

### src/microsim/cores/pic/picusart.h
- Purpose: declares the PIC USART — the TXSTA/RCSTA/PIR1/SPBRG bit handles.

### src/microsim/cores/pic/picusart.cpp
- Purpose: implements the PIC USART; TXSTA/RCSTA/SPBRG configure the transmitter and receiver, the baud period is `mult*(SPBRG+1)` instruction cycles, and the FERR/OERR flags are set from the received frame.

### src/microsim/cores/pic/picwdt.h
- Purpose: declares the PIC watchdog plus the two variants PicWdt00 (OPTION-driven) and PicWdt01 (WDTCON-driven with SWDTEN).

### src/microsim/cores/pic/picwdt.cpp
- Purpose: implements the PIC watchdog; an 18 ms base period scaled by the prescaler, resets the CPU on overflow, and shares the prescaler with TIMER0 when PSA is set.

### src/microsim/cores/pic/picpin.h
- Purpose: declares the PIC pin, overriding `ConfExtInt` and `setAnalog`.

### src/microsim/cores/pic/picpin.cpp
- Purpose: implements the PIC pin; switching a pin to analog disables its digital input buffer and forces the port input register bit to 0.

### src/microsim/cores/pic/picport.h
- Purpose: declares the PIC port, overriding `configureA`/`outChanged`/`readPort` and creating PicPin instances.

### src/microsim/cores/pic/picport.cpp
- Purpose: implements the PIC port; reading the port register returns the live pin state (or the RAM value when read from the monitor), and the port-change interrupt flag is cleared on both a read and an output change.

### src/microsim/cores/pic/picsleep.h
- Purpose: declares `PicSleep` over `McuSleep` with no extra members.

### src/microsim/cores/pic/picsleep.cpp
- Purpose: implements the PIC sleep module — enabled, sleep mode 1, nothing else implemented.

### src/microsim/cores/i51/i51core.h
- Purpose: declares the 8051 core — the SFR addresses, the `cpuState_t` machine-cycle enum, the addressing-mode bitmask enum and the per-instruction ALU method set.

### src/microsim/cores/i51/i51core.cpp
- Purpose: implements the 8051 core, modelled at **bus-cycle** level: ALE, PSEN and the external address/data multiplexing on PORT0.
- Key abstractions: a `cpuState_t` machine (RESET/FETCH/OPERAND/EXEC/WRITE), an `addrMode_t` bitmask enum, and a `memState_t` bus state machine (IDLE/LAEN/ADDR/LADI/DATA/READ).
- Data flow: `runEvent()` drives the ALE → address → latch-disable → data sequence with the four sub-timings computed at reset (`m_addrSetTime = 3*psStep`, `m_laEnEndTime = 4*psStep`, `m_readSetTime = 6*psStep`, `m_readBusTime = readCycle-10`).
- Non-obvious design decisions: the clock is derived as `readCycle/12` — the 8051's classic 12-oscillator machine cycle — so every timing constant is a fraction of `m_psStep`.
- Edge cases / failure handling: the parity bit is recomputed at the end of every instruction (`i51core.cpp:903-910`) rather than maintained incrementally, which is simpler and always correct.
- Surprising: `i51core.cpp:11-14` — the register bank is selected by masking the *PSW* bits at the point of use (`BANK`), not by a separate bank register.

### src/microsim/cores/i51/i51timer.h
- Purpose: declares the 8051 timer — the TMOD bit handles and the gate-pin member.

### src/microsim/cores/i51/i51timer.cpp
- Purpose: implements the 8051 timers; the TMOD mode selects 13-bit/16-bit/8-bit/8+8 counter widths, the C/T bit selects the external clock, and the GATE bit enables a gate pin (P3.2/P3.3) that stops the timer.

### src/microsim/cores/i51/i51usart.h
- Purpose: declares the 8051 USART — the SCON/PCON bit handles and the stop-bit-error flag.

### src/microsim/cores/i51/i51usart.cpp
- Purpose: implements the 8051 USART; the four SCON modes (synchronous 8-bit, timer-1 asynchronous 8/9-bit, MCU-clock 9-bit) and the SMOD doubling, with a 16-step divide for the timer-1 baud generator.

### src/microsim/cores/i51/i51pin.h
- Purpose: declares the 8051 pin, overriding `setOutState`/`scheduleState`/`ConfExtInt`.

### src/microsim/cores/i51/i51pin.cpp
- Purpose: implements the 8051 pin; the port latch gates the output (a port pin cannot drive high when the port register bit is low) and the external-interrupt edge mode is decoded.

### src/microsim/cores/i51/i51port.h
- Purpose: declares the 8051 port, overriding `reset` and `readPort` and creating I51Pin instances.

### src/microsim/cores/i51/i51port.cpp
- Purpose: implements the 8051 port; a port read returns the latched pin state (not the pin direction register), and reset deliberately does not clear the pin state.

### src/microsim/cores/mcs65/mcs65core.h
- Purpose: declares the 6502 core — the addressing modes, the status-bit enum, the bus/control pin handles and the member-function-pointer opcode dispatch (`m_EXEC`).

### src/microsim/cores/mcs65/mcs65core.cpp
- Purpose: implements the 6502 core, modelled at **bus-cycle** level with phi0/phi1/phi2 and the SYNC/RW bus lines.
- Key abstractions: a `cpuState_t` machine (cRESET/cFETCH/cDECODE/cREAD/cEXEC/cWRITE), an `addrMode_t` enum, an `addrFlags_t` bitmask (X-indexed/Y-indexed/page-cross) and a `funcPtr_t m_EXEC` member-function pointer for the opcode.
- Data flow: the decode switch sets `m_EXEC` and the addressing mode; the read/write phases fetch the operand bytes over successive bus cycles.
- Non-obvious design decisions: the bus timing constants are named and explicit: `m_tHR = 10 ns` (read data hold), `m_tHA = 25 ns` (address delay), `m_tHW = 20 ns` (write delay) — the 6502 datasheet's numbers, in the engine's picosecond unit.
- Edge cases / failure handling: an unimplemented opcode logs an error with the opcode and PC rather than silently doing nothing.

### src/microsim/cores/mcs65/mcs65interface.h
- Purpose: declares `Mcs65Interface` (Cpu8bits + eElement), whose only job is to publish an "Instruction" string variable to the monitor.

### src/microsim/cores/mcs65/mcs65interface.cpp
- Purpose: decodes an opcode byte into a human-readable mnemonic for the MCU monitor — a 256-case lookup table covering the irregular 6502 opcodes.

### src/microsim/cores/z80/z80core.h
- Purpose: declares the Z80 core — the register/member-word list published to the monitor and the bus-operation enum.

### src/microsim/cores/z80/z80core.cpp
- Purpose: implements the Z80 core, modelled at **T-state and machine-cycle** level.
- Key abstractions: `sm_MCycle` (the current machine cycle), `sm_TState`, `mc_busOp` (the bus operation of the current cycle), `XYState` (HL/IX/IY) and the prefix state machine.
- Data flow: the bus is modelled, not just the ALU — `noBusOp`, `readMem`, `writeMem`, `readIO`, `writeIO` are all real cycles. `opCodeFetch()` reads the opcode from the data bus, then looks up `mc_MCycles` and `mc_TStates` from the tables in `z80cycles.h`; each instruction method is written as a `switch(sm_MCycle)` that issues one bus operation per cycle.
- Non-obvious design decisions: modelling the real bus (MREQ/IORQ/RD/WR/RFSH/M1/WAIT/BUSACK/BUSREQ), plus interrupt modes 0/1/2, HALT and DMA bus requests, is what makes the ZX Spectrum ULA in the same directory possible at all.
- Edge cases / failure handling: `releaseBus(bool)` puts the bus pins into high-impedance and sets the `highImpedanceBus` flag, so a DMA request can hand the bus over cleanly.
- Surprising: `z80core.cpp:826-827` — the HALT pin is deasserted only if an interrupt is pending (`sNMI || (sInt && IFF1)`), i.e. the CPU physically leaves HALT when the interrupt arrives.

### src/microsim/cores/z80/z80cycles.h
- Purpose: the machine-cycle and T-state lookup tables for the no-prefix, CB and ED opcode sets.

### src/microsim/cores/z80/z80regs.h
- Purpose: the Z80 register helpers — `Z80RegPair` (two 8-bit registers viewed as one 16-bit register), `Z80Reg16`, and `Z80Flags` with a changed-bit tracker and the undocumented X/Y flag copies.

### src/microsim/cores/z80/ula_zx48k.h
- Purpose: declares the ZX Spectrum ULA — the 448×312 screen buffer, the ULA type enum (5C102E, 5C112E, 6C001E6, 6C001E7, 6C011E) and every bus/control pin handle.

### src/microsim/cores/z80/ula_zx48k.cpp
- Purpose: **a complete custom chip** — the ZX Spectrum video ULA — modelled cycle-accurately.
- Key abstractions: a 448×312 pixel framebuffer, the attribute/ink/paper latches, the border colour, and the ULA type enum.
- Data flow: the ULA watches the CPU bus (RAS/CAS/DRAMWE/MREQ/IORQ/RD/WR/A14/A15) and reconstructs the video signal; the contention signals are computed from the datasheet equations with the figure numbers cited in the comments.
- Non-obvious design decisions: the file's header comment names its source: *"The source of information is the book The ZX Spectrum ULA - How To Design A Microcomputer written by Chris Smith, ISBN 978-0-9565071-0-5"* — the model is traceable to a citable authority, and the per-figure comments ("Figure 18-12", "Figure 18-15") let a reader check each equation.
- Edge cases / failure handling: the colour conversion uses the ULA's analogue RGB weights (the `m_yTable`/`m_uTable`/`m_vTable` float tables) rather than a naive RGB lookup, so the picture looks like the real thing.

### src/microsim/cores/scripted/scriptcpu.h
- Purpose: declares `ScriptCpu` over `ScriptBase` and `Mcu8bits` — one `asIScriptFunction*` handle per script hook and per-property getter/setter maps.

### src/microsim/cores/scripted/scriptcpu.cpp
- Purpose: **an MCU whose CPU is an AngelScript program** — the "embedded-code" mechanism of this repo.
- Key abstractions: one `asIScriptFunction*` per lifecycle hook (initialize, reset, voltChanged, updateStep, runEvent, runStep, extClock, INTERRUPT, command, getIntReg, getStrReg) and separate AngelScript *contexts* for the re-entrant ones.
- Data flow: the C++ side calls `prepare(func)` + `SetArgX(...)` + `execute()`; the script calls back into C++ through ~40 registered methods (readPGM/writePGM/readRAM/writeRAM/readROM/writeROM, getPort/getPin, setPackageSize, setMargins, setBackground, addEvent, cancelEvents, toConsole, showValue).
- Non-obvious design decisions: the script can define its **own** CPU registers and variables via `addCpuReg(name, type)` / `addCpuVar(name, type)`, and the MCU Monitor then shows them — the register file of a scripted chip is declared by the script, not by the XML.
- Edge cases / failure handling: `m_vChangedCtx`, `m_runEventCtx`, `m_runStepCtx` and `m_extClockCtx` are separate contexts because those hooks can re-enter (a script can call back into the simulator from inside them).
- Surprising: `scriptcpu.cpp:61-70` — the script gets the `ScriptCpu` and `eElement` objects as **global properties**, so a script can call `component.element.elementId` and friends without any API ceremony.

### src/microsim/cores/scripted/scriptperif.h
- Purpose: declares `ScriptPerif`, the mix-in that lets any MCU peripheral register itself with the script engine and publish its method list.

### src/microsim/cores/scripted/scriptperif.cpp
- Purpose: implements the `ScriptPerif` constructor and destructor only.

### src/microsim/cores/scripted/scriptspi.h
- Purpose: declares `ScriptSpi` over `McuSpi` and `ScriptPerif`.

### src/microsim/cores/scripted/scriptspi.cpp
- Purpose: implements the script-visible SPI; it registers a "SPI `<name>`" global object with `setMode`/`sendByte` and calls the script's `byteReceived` function at the end of a transaction.

### src/microsim/cores/scripted/scriptusart.h
- Purpose: declares `ScriptUsart` over `McuUsart` and `ScriptPerif`.

### src/microsim/cores/scripted/scriptusart.cpp
- Purpose: implements the script-visible USART; it registers a "Uart `<name>`" global object with `setBaudRate`/`setDataBits`/`sendByte` and calls the script on byte received and frame sent.

### src/microsim/cores/scripted/scripttwi.h
- Purpose: declares `ScriptTwi` over `McuTwi` and `ScriptPerif` — the `byteReceived`/`writeByte`/`setTwiState` callback handles.

### src/microsim/cores/scripted/scripttwi.cpp
- Purpose: implements the script-visible TWI; it registers a "TWI `<name>`" global object with the master start/write/read/stop calls and lets the script supply the byte to transmit as a return value.

### src/microsim/cores/scripted/scripttcp.h
- Purpose: declares `ScriptTcp` over `TcpModule` and `ScriptPerif` — the three script callback handles.

### src/microsim/cores/scripted/scripttcp.cpp
- Purpose: implements the script-visible TCP; it registers a "TCP `<name>`" global object with `connectToHost`/`sendMsgToHost`/`closeSocket` and forwards connected/closed/received events into script functions.

### src/microsim/cores/scripted/scriptdisplay.h
- Purpose: declares `ScriptDisplay` over `DisplayArea` and `ScriptPerif` — the palette vector and the clear callback.

### src/microsim/cores/scripted/scriptdisplay.cpp
- Purpose: implements the script-visible framebuffer; it exposes `setPixel`/`drawLine`/`setData`/`setPalette` to the script and decodes a script array-of-arrays into pixels through the palette.

### src/microsim/cores/scripted/display.h
- Purpose: declares `DisplayArea` as a QWidget + Updatable + eElement, so a script can paint onto a canvas.

### src/microsim/cores/scripted/display.cpp
- Purpose: implements the `DisplayArea` widget — a scaled pixel canvas with Bresenham line drawing, background fill, BGR colour swapping and deferred resizing.

### src/microsim/cores/scripted/scriptport.h
- Purpose: declares `ScriptPort` over `ScriptBase` and `McuPort`.

### src/microsim/cores/scripted/scriptport.cpp
- Purpose: a script-driven port — **almost entirely stubbed out**; the `configureA/B/C` and `reset` bodies are commented out and only `setExtIntTrig` and `setScript` do anything.

### src/microsim/modules/script/scriptbase.h
- Purpose: declares `ScriptBase` over eElement — the AngelScript engine, module and context handles plus the compile/execute helpers.

### src/microsim/modules/script/scriptbase.cpp
- Purpose: the AngelScript host.
- Key abstractions: the engine, the module, the context, and the JIT compiler.
- Data flow: `compileScript()` → `compileSection()` → `AddScriptSection` → `Build()`; the script's hooks are then looked up by declaration string.
- Non-obvious design decisions: `compileSection()` implements a **preprocessor**: `#include "file"` resolves relative to the script's own folder and `#include <file>` resolves to the bundled `scriptlib` directory (`scriptbase.cpp:117-139`). The include is inlined textually, recursively, before compilation.
- Edge cases / failure handling: automatic GC is disabled (`asEP_AUTO_GARBAGE_COLLECT = false`) and a full GC is run manually at compile and at destruction — deterministic, but a script that allocates a lot will grow until the next compile.
- Surprising: `scriptbase.cpp:67-71` — the JIT compiler is only enabled on `__x86_64__`; on other architectures the script runs in the interpreter with no behavioural difference.

### src/microsim/modules/script/scriptmodule.h
- Purpose: declares `ScriptModule` over `ScriptBase` and `McuModule` — one `asIScriptFunction*` handle per hook.

### src/microsim/modules/script/scriptmodule.cpp
- Purpose: a **generic MCU peripheral whose behaviour is a script** — the register-write hooks and the callBack hooks are implemented in AngelScript, looked up by exact function declaration after compilation.
- Non-obvious design decisions: the lookup is by *declaration string*, not by name, so overloads are unambiguous — but a script that changes the parameter type silently loses the hook (`if( !m_configureA ) return;` swallows it).

### src/microsim/modules/twi/twimodule.h
- Purpose: declares the shared I2C engine — the I2C state enum, the TWI mode enum and the SDA/SCL pins.

### src/microsim/modules/twi/twimodule.cpp
- Purpose: implements the shared I2C engine.
- Key abstractions: an `i2cState_t` machine (IDLE/STOP/START/READ/WRITE/ACK/ENDACK/READACK) layered over the generic `twiState_t` status codes, plus the SDA/SCL pins.
- Data flow: `runEvent()` fires every half clock period (`m_clockPeriod/2`); each state issues one SDA/SCL transition, so the bit-level protocol emerges from a table of state cases.
- Non-obvious design decisions: the START and STOP conditions are *four-step sequences* written out as if/else chains over (SDA state, SCL state) — e.g. STOP lowers SDA, raises SCL, raises SDA, then finishes.
- Edge cases / failure handling: the `setTwiState` call happens **before** the state variable is changed in the STOP case, with the comment "Set State first so old m_i2cState is still available" — an explicit ordering dependency.
- Surprising: `twimodule.cpp:381-384` — `getTrasferTime()` returns `9*m_clockPeriod` — the 9 bits of a byte-plus-ack, used by the per-chip wrappers to know how long a transfer takes.

### src/microsim/modules/spi/spimodule.h
- Purpose: declares the shared SPI engine — the MOSI/MISO/SCK/SS pins and the edge configuration.

### src/microsim/modules/spi/spimodule.cpp
- Purpose: implements the shared SPI engine.
- Key abstractions: the `leadEdge`/`sampleEdge`/`tailEdge` triple, which together encode the four SPI modes, and the `m_useSS` flag.
- Data flow: `step()` samples one bit on the sample edge and shifts one bit out on the other; the master toggles SCK on a scheduled half period.
- Non-obvious design decisions: the master and the slave share the same `step()` function; only the pin ownership differs.
- Edge cases / failure handling: in slave mode the SS pin is active-low and its edge resets the shift register.

### src/microsim/modules/usart/usartmodule.h
- Purpose: declares the shared USART engine — `UsartModule` (the configuration and the TX/RX pair), `UartSync` (the synchronous-mode clock generator) and `UartTR` (the common base of the transmitter and the receiver, with the per-module pin multiplexing).

### src/microsim/modules/usart/usartmodule.cpp
- Purpose: implements the shared USART engine.
- Data flow: `setBaudRate` → `setPeriod(1e12/br)` in picoseconds; the TX/RX shift one bit per period.
- Non-obvious design decisions: the macros at the top of the header (`mSTOPBITS`, `mDATABITS`, `mDATAMASK`, `mPARITY`) read the *module's* configuration through the `m_usart` pointer, so the TX and RX sub-objects always agree on the frame format.
- Edge cases / failure handling: `UartTR::configureA` selects which pin the module uses (register-configured pin multiplexing).

### src/microsim/modules/usart/usarttx.h
- Purpose: declares the UART transmitter — `processData`/`startTransmission`.

### src/microsim/modules/usart/usarttx.cpp
- Purpose: implements the UART transmitter; builds the frame (start bit, data, optional parity, stop bits) and shifts it out one bit per baud period.

### src/microsim/modules/usart/usartrx.h
- Purpose: declares the UART receiver — the FIFO, the ignore-data (multiprocessor) flag and the start-bit state.

### src/microsim/modules/usart/usartrx.cpp
- Purpose: implements the UART receiver.
- Data flow: detects the start bit, samples the frame on the baud period, checks the stop and parity bits, and maintains a 2-entry FIFO with overrun and frame-error flags.
- Non-obvious design decisions: the frame carries its own error flags in the upper bits (`frameError = 1<<12`, `dataOverrun = 1<<13`, `parityError = 1<<14`), so the error state travels with the data and can be unpacked by the chip-specific layer.
- Edge cases / failure handling: a FIFO overrun overwrites the oldest entry and sets the overrun flag rather than dropping the byte silently.

### src/microsim/modules/tcp/tcpmodule.h
- Purpose: declares the TCP bridge — the per-link connection record and the virtual event hooks.

### src/microsim/modules/tcp/tcpmodule.cpp
- Purpose: implements the TCP bridge for scripted MCUs; opens `QTcpSocket` connections to a host/port and delivers the received text to the script.
- Non-obvious design decisions: the socket actions (connect/close) are *queued* and executed in `updateStep()` — the simulator's update phase — so a connect never blocks the simulation loop.
- Edge cases / failure handling: `initialize()` (teardown) disconnects and `waitForDisconnected(1000)`s each socket, so a simulator restart does not leave half-open connections.

### src/microsim/modules/transmodule.h
- Purpose: declares `TransModule` — the module name, the monitor window handle and the printOut/printIn helpers.

### src/microsim/modules/transmodule.cpp
- Purpose: implements the serial-monitor plumbing shared by every byte-oriented peripheral (TWI, SPI, USART, OneWire, TCP).
- Non-obvious design decisions: the module name is `name.split("-").last()` — the friendly name is the last dash-separated component of the element id.

### src/microsim/modules/onewire/onewire.h
- Purpose: declares the 1-Wire (DS18B20-style) slave — the 1-Wire state and command enums, the ROM array and the pulse-timing members.

### src/microsim/modules/onewire/onewire.cpp
- Purpose: implements the 1-Wire slave device.
- Key abstractions: a `w1State_t` machine (IDLE/ROM_CMD/FUN_CMD/SEARCH/MATCH/DATA/BUSY) and the ROM command set.
- Data flow: `voltChanged()` measures the **width of the pulse** on the single wire and decodes it: >480 µs is a reset, >30 µs is a 0, <15 µs is a 1 — the protocol is decoded from *timing*, not from a bit stream.
- Non-obvious design decisions: the reset threshold is 480 µs but the comment says "Tested in real device 202 us" — the model's threshold is the datasheet's, the real device's is faster, and the discrepancy is recorded rather than hidden.
- Edge cases / failure handling: the ROM search walks 64 bits and abandons the search as soon as a bit does not match (`m_state = W1_IDLE`).
- Surprising: `onewire.cpp:286-297` — `generateROM` builds a valid 64-bit ROM with a CRC8, using `rand()` for the serial number; the CRC implementation at line 269 is the standard Dallas/Maxim polynomial `0x8C`.

### src/microsim/cores/qemu/qemudevice.h
- Purpose: declares the `qemuArena_t` shared-memory struct (simulation time, QEMU time, register data/address, IRQ number/level, action codes) and the `QemuDevice` component.

### src/microsim/cores/qemu/qemudevice.cpp
- Purpose: the bridge to a real QEMU process, so a genuine ESP32/STM32 can be simulated.
- Data flow: `QemuDevice` creates the shared memory (POSIX `shm_open`+`mmap` on Linux, `CreateFileMapping`+`MapViewOfFile` on Windows), launches `qemu-system-*` as a child process, and services the arena's action codes (`SIM_READ`, `SIM_WRITE`, `SIM_FREQ`, `SIM_INTERRUPT`, `SIM_I2C`, `SIM_SPI`, `SIM_USART`, `SIM_GPIO_IN`).
- Non-obvious design decisions: the shared-memory key is `pid + component id` (`m_shMemKey = QString::number(pid) + id`), so several QEMU devices can run without colliding.
- Edge cases / failure handling: if the mapping fails the arena is null and the device logs an error instead of dereferencing null.
- Surprising: the arena's `ps_per_inst` field and the `SIM_GPIO_IN` action show the design intent — a **QEMU-side plugin** drives the peripheral side, and the GUI only sees MMIO reads and writes.

### src/microsim/cores/qemu/qemumodule.h
- Purpose: declares `QemuModule`, the per-peripheral base that owns an MMIO address window, a clock pointer and a pointer into the shared arena.

### src/microsim/cores/qemu/qemumodule.cpp
- Purpose: implements the QEMU module base — dispatches a read/write action to the subclass register handler and defaults to a plain 32-bit memory slot.

### src/microsim/cores/qemu/qemutimer.h
- Purpose: declares `QemuTimer` over `QemuModule` — the bidirectional/direction/one-shot fields that are not yet used.

### src/microsim/cores/qemu/qemutimer.cpp
- Purpose: the QEMU timer — a placeholder (constructor only, no counter behaviour).

### src/microsim/cores/qemu/qemuspi.h
- Purpose: declares `QemuSpi` over `QemuModule` and `SpiModule`, exposing the MOSI/MISO/SCK/SS pin pointers so the device can wire them.

### src/microsim/cores/qemu/qemuspi.cpp
- Purpose: the QEMU SPI — a placeholder; the constructor only, and the `doAction`/`setMode`/`endTransaction` overrides are commented out.

### src/microsim/cores/qemu/qemutwi.h
- Purpose: declares `QemuTwi` over `QemuModule` and `TwiModule` with the SCL/SDA pin-pointer accessors.

### src/microsim/cores/qemu/qemutwi.cpp
- Purpose: the QEMU I2C; `setMode` forwards to the shared `TwiModule` when both SCL and SDA pins exist.

### src/microsim/cores/qemu/qemuusart.h
- Purpose: declares `QemuUsart` over `QemuModule` and `UsartModule` — the QEMU_USART_RECEIVE/SENT action codes.

### src/microsim/cores/qemu/qemuusart.cpp
- Purpose: the QEMU USART — a thin wrapper that enables the shared transmitter/receiver and exposes the TX/RX pin pointers; the arena-based byte transfer is commented out and the file carries a `/// FIXME` marker.

### src/microsim/cores/qemu/qemuocunit.h
- Purpose: declares `QemuOcUnit` over `QemuModule` with no members.

### src/microsim/cores/qemu/qemuocunit.cpp
- Purpose: the QEMU output-compare unit — a placeholder (constructor only, no behaviour yet).

### src/microsim/cores/qemu/mcutypes32.h
- Purpose: the 32-bit variants of `regInfo_t` and `regBits_t` for the QEMU cores' 32-bit register space.

### src/microsim/cores/qemu/datautils32.h
- Purpose: the inline 32-bit equivalents of the 8-bit register-bit helpers (getRegBits/setRegBits/clearRegBits/writeRegBits) over `regBits32_t`.

### src/microsim/cores/qemu/datautils32.cpp
- Purpose: the 32-bit register-bit helpers; the DataSpace-based `getRegBits`/`writeBitsToReg` are commented out, leaving only the inline mask helpers.
- Surprising: the whole file is 40 lines and is almost entirely commented out.

### src/microsim/cores/qemu/esp32/esp32.h
- Purpose: declares `Esp32` over `QemuDevice` — the APB/CPU frequencies and the GPIO/IOMUX/LED module handles.

### src/microsim/cores/qemu/esp32/esp32.cpp
- Purpose: the ESP32 device; wires the GPIO/IOMUX/I2C/SPI/UART/LEDC modules to their MMIO address windows and builds the 256-entry in/out signal matrix.
- Non-obvious design decisions: the matrix is **data, not code** — ~400 lines of `m_gpio->m_matrixIn[N] = { …, "LABEL" }` assignments, one per peripheral signal.
- Edge cases / failure handling: the firmware file size is validated (`size == 0 || size > 4194304` is an error) before QEMU is launched.
- Surprising: `esp32.cpp:38` — the executable is a *relative* path (`./data/bin/qemu-system-xtensa`), so the whole design assumes the app is run from its install directory.

### src/microsim/cores/qemu/esp32/esp32gpio.h
- Purpose: declares `Esp32Gpio` over `QemuModule` — the 40-pad array and the 256-entry in/out matrix tables.

### src/microsim/cores/qemu/esp32/esp32gpio.cpp
- Purpose: implements the ESP32 GPIO block; decodes GPIO_OUT/GPIO_ENABLE/GPIO_PINxx/GPIO_FUNCx_IN_SEL_CFG registers into pin state, direction and the peripheral-function routing.
- Non-obvious design decisions: `strapMode()` computes the boot strap bits with an explicit bit permutation ("GPIO_STRAP uses a different bit order than the physical GPIO numbers") — the ESPRESSIF boot mode is a function of the pin levels at reset.

### src/microsim/cores/qemu/esp32/esp32iomux.h
- Purpose: declares `Esp32IoMux` over `QemuModule` — a 40-entry register array and a `getMuxGpio` offset-to-pad lookup.

### src/microsim/cores/qemu/esp32/esp32iomux.cpp
- Purpose: implements the ESP32 IOMUX; maps each IOMUX register offset to a GPIO pad number and forwards the written value to the GPIO module.

### src/microsim/cores/qemu/esp32/esp32pin.h
- Purpose: declares `Esp32Pin` over `IoPin` plus the `funcPin` struct that links a matrix entry to a peripheral pin pointer and a label.

### src/microsim/cores/qemu/esp32/esp32pin.cpp
- Purpose: implements the ESP32 pad; models the 45 kΩ weak pull-up/pull-down, selects one of six IOMUX functions and relabels the pin in the canvas with the current function name.

### src/microsim/cores/qemu/esp32/esp32spi.h
- Purpose: declares `Esp32Spi` over `QemuSpi`.

### src/microsim/cores/qemu/esp32/esp32spi.cpp
- Purpose: implements the ESP32 SPI; the SPI_CLOCK/SPI_SLAVE/data-buffer registers set the clock period, the master/slave role and start a transfer.

### src/microsim/cores/qemu/esp32/esp32twi.h
- Purpose: declares `Esp32Twi` over `QemuTwi` — the slave code and last-command state.

### src/microsim/cores/qemu/esp32/esp32twi.cpp
- Purpose: implements the ESP32 I2C; the I2C_CTR bits choose open-drain vs push-pull and master vs slave, the I2C_CMD opcode field dispatches start/write/read/stop, and `setTwiState` maps the TWI status codes onto ACK/NACK.

### src/microsim/cores/qemu/esp32/esp32usart.h
- Purpose: declares `Esp32Usart` over `QemuUsart` — the TX/RX FIFO queues.

### src/microsim/cores/qemu/esp32/esp32usart.cpp
- Purpose: implements the ESP32 UART; a 128-byte TX FIFO feeds the shared `UsartModule` transmitter, UART_CLKDIV sets the baud rate, and UART_CONF0 sets parity/data/stop bits and resets the FIFOs.

### src/microsim/cores/qemu/esp32/esp32led.h
- Purpose: declares `Esp32Led` plus the `LedTimer` and `LedPwm` helper elements.

### src/microsim/cores/qemu/esp32/esp32led.cpp
- Purpose: implements the ESP32 LEDC (PWM) peripheral; 8 low-speed timers drive 16 PWM channels.
- Non-obvious design decisions: the duty is scaled against a hard-coded `411205` (the 18-bit LEDC period constant) rather than the configured timer period — a magic constant that ties the model to the hardware.

### src/microsim/cores/qemu/stm32/stm32.h
- Purpose: declares `Stm32` over `QemuDevice` — the APB1/APB2 frequencies and the port vector.

### src/microsim/cores/qemu/stm32/stm32.cpp
- Purpose: the STM32 device; picks the package and the peripheral counts from the part-number suffix (4/6/8/B/C/D/E), creates the GPIO ports and timers, and implements the AFIO timer-remap wiring.

### src/microsim/cores/qemu/stm32/stm32port.h
- Purpose: declares `Stm32Port` over `QemuModule` — the pin vector.

### src/microsim/cores/qemu/stm32/stm32port.cpp
- Purpose: implements the STM32 GPIO port; decodes the CRL/CRH configuration nibbles into input/output/open-drain/pull/analog/alternate per pin and drives the output data register.
- Non-obvious design decisions: the same file contains the port's own resistor model via `setExtraSource` — the pin is driven as a *resistive* source so the pull-up participates in the node equation.

### src/microsim/cores/qemu/stm32/stm32pin.h
- Purpose: declares `Stm32Pin` over `IoPin` — the pull/analog/alternate flags.

### src/microsim/cores/qemu/stm32/stm32pin.cpp
- Purpose: implements the STM32 pad; honours the alternate-function flag (the port register only drives a pad that is not in alternate mode), models the pull resistor, and paints a pull-dot on the canvas.

### src/microsim/cores/qemu/stm32/stm32afio.h
- Purpose: declares `Stm32Afio` over `QemuModule` — the MAPR and EXTICR state.

### src/microsim/cores/qemu/stm32/stm32afio.cpp
- Purpose: implements the STM32 AFIO; decodes the MAPR remap bits and calls `Stm32::timerRemap` to move the timer output-compare pins, and tracks the EXTI source-port selection.

### src/microsim/cores/qemu/stm32/stm32timer.h
- Purpose: declares `Stm32Timer` over `QemuTimer` — the four output-compare channels and the register shadow fields.

### src/microsim/cores/qemu/stm32/stm32timer.cpp
- Purpose: implements the STM32 timer; a special write at offset 0 selects the output-compare channel and drives its pin, while the CR1/CR2/SMCR/DIER/SR/EGR/CCMR/CCER/PSC/ARR/CCR register handling is present but mostly commented out.

### src/microsim/cores/qemu/stm32/stm32ocunit.h
- Purpose: declares `Stm32OcUnit` over eElement — the CCR/CCMR/OCM state and the target pin.

### src/microsim/cores/qemu/stm32/stm32ocunit.cpp
- Purpose: implements the STM32 timer output-compare channel; the CCMR output-mode bits select frozen/high/low/toggle/forced output and the input prescaler.

### src/microsim/cores/qemu/stm32/stm32spi.h
- Purpose: declares `Stm32Spi` over `QemuSpi` — the CR1/CR2/status registers.

### src/microsim/cores/qemu/stm32/stm32spi.cpp
- Purpose: implements the STM32 SPI; CR1 sets CPHA/CPOL/MSTR/BR/LSBFIRST/SPE, DR starts a transfer, and the status register tracks TXE/RXNE/BUSY.

### src/microsim/cores/qemu/stm32/stm32twi.h
- Purpose: declares `Stm32Twi` over `QemuTwi` — the CR1/CR2/OAR/DR/SR1/SR2/CCR/TRISE registers and the event/error interrupt state.

### src/microsim/cores/qemu/stm32/stm32twi.cpp
- Purpose: implements the STM32 I2C; the CR1/CR2/DR/SR1 register handling with the write-0-to-clear error bits, the start/stop condition generation, and the event/error interrupt level computation.

### src/microsim/cores/qemu/stm32/stm32usart.h
- Purpose: declares `Stm32Usart` over `QemuUsart` — the DR/SR/divider and interrupt state.

### src/microsim/cores/qemu/stm32/stm32usart.cpp
- Purpose: implements the STM32 USART; CR1/CR2/CR3/SR/DR/BRR handling, the overrun flag cleared by an SR read followed by a DR read, and the interrupt level recomputed from the enabled TXE/TC/RXNE flags.

## Ideas worth stealing

- **A device description as DATA, not code** — `src/microsim/mcucreator.cpp:175-202` — the XML `.mcu` descriptor is walked once and each tag dispatches to a `createXxx()` that instantiates a peripheral *by name and type*. A new chip for a course is a new XML file, not a new C++ class. The August harness could adopt exactly this: a course's "74HC595 shift register" or "ATmega328" becomes a declarative spec, and the skill teaches the spec format, not a code generator.

- **The register map as a named table with aliases** — `src/microsim/mcucreator.cpp:488-501` — registers carry a name, an address, a reset value, a write mask and a list of bit names, and a bit name may have **aliases** (`A|B`) so that the same bit can be called `WDTIE` on one chip and `WDTCSR.WDIE` on another. This is exactly what an agent needs to write firmware against a datasheet: the bit names in the datasheet become the lookup keys, and the alias list is the chip-family difference.

- **A typed, masked, LIFO callback list as the only extension point** — `src/microsim/mcusignal.h:67-78` — every register read/write hook is a `CallBack<Obj>` with a bit mask, and new callbacks are **prepended** so that a later-registered hook runs first; the comment explains that the interrupt flag must be cleared *after* the register-write callback. The transferable lesson is the *ordering contract*: a registration-order dependency is a real requirement, so it is documented at the mechanism rather than discovered as a bug.

- **A value-override backchannel on a register read/write** — `src/microsim/mcudataspace.cpp:50-80` — a callback may set `m_regOverride` to substitute the value the CPU sees. This is how a timer publishes its live count, how the AVR comparator clears ACO on read, and how an interrupt clears its flag on write-1-to-clear, all through one mechanism. An August harness that needs "the read of register X returns a computed value" can copy this three-line pattern instead of inventing a getter hierarchy.

- **Derive state from the clock, never count events** — `src/microsim/mcutimer.cpp:183-200` — `calcCounter()` computes the counter value from `m_ovfTime - circTime`, so the counter is correct even if the scheduled event was late or coalesced. This is a genuinely better model than "increment on tick" and it makes the simulator robust to event reordering. The August harness's timers/ledgers could use the same principle: compute from the clock, so a missed wake-up does not corrupt the state.

- **Only re-schedule when the absolute time changes** — `src/microsim/mcutimer.cpp:117-141` — the overflow event is cancelled and re-added *only if* the computed absolute overflow time differs from the previous one. A register write that does not change the schedule therefore costs zero event-queue churn. This is a cheap, transferable performance rule for any event-driven harness.

- **A single `.mcu`-style description for the whole chip, including the peripherals' pin wiring** — `src/microsim/mcucreator.cpp:567-600` and `src/microsim/mcucreator.cpp:1133-1218` — the ports, the timers, the USART pins, the SPI/TWI pins are all named in the XML, and the creator resolves them by name. A course can therefore ship a chip that "lights LED0 on PORTB bit 5 when the counter overflows" as a text file.

- **A complete MCU written in a scripting language, with the register file declared by the script** — `src/microsim/cores/scripted/scriptcpu.cpp:61-99` and `src/microsim/cores/scripted/scriptcpu.cpp:41-45` — the script declares its own registers (`addCpuReg`) and variables (`addCpuVar`) and they appear in the monitor; the script *is* the CPU. For an August skill this is the "write your own processor" track: a student implements a 4-bit ALU in a script and it runs on the canvas next to the real chips.

- **A script preprocessor with a bundled library path** — `src/microsim/modules/script/scriptbase.cpp:117-139` — `#include "x"` resolves relative to the script and `#include <x>` resolves to the bundled `scriptlib`, and the include is inlined textually before compilation. A course can therefore ship a standard library of teaching peripherals (`#include <twi-slave>`) without a package manager.

- **A generic peripheral whose behaviour is a script** — `src/microsim/modules/script/scriptmodule.cpp:43-47` — `configureA/B/C`, `callBack` and `callBackDoub` are looked up by exact *declaration string* after compilation, so the script's register writes drive the same `McuModule` contract the C++ peripherals use. That is how a new peripheral can be added to an existing chip without touching the chip's class.

- **A shared-memory arena as the protocol to an external CPU core** — `src/microsim/cores/qemu/qemudevice.h:12-25` and `src/microsim/cores/qemu/qemudevice.cpp:78-117` — the entire interface to `qemu-system-*` is one flat C struct in shared memory (time, register address, register data, IRQ number/level, action code), created with `shm_open`+`mmap` or `CreateFileMapping`+`MapViewOfFile`. The pattern transfers directly: an August tool that needs a real external tool (a compiler, a solver, a simulator) can expose a shared-memory arena rather than a socket, and get a cheap, inspectable protocol.

- **Model a chip from a citable book, with the figure numbers in the comments** — `src/microsim/cores/z80/ula_zx48k.cpp:33-47` and the "Figure 18-12"/"Figure 18-15" comments in the contention logic — the ZX Spectrum ULA is modelled from Chris Smith's *The ZX Spectrum ULA*, with the source named at the top of the file and each bus-contention equation tagged with the figure it came from. This is the model an agent should copy for course work: the authority is named, the equations are checkable, and the colour tables are data.

- **Decode a protocol from timing, not from a bit stream** — `src/microsim/modules/onewire/onewire.cpp:44-77` — a 1-Wire bit is decoded by measuring the pulse width (>480 µs reset, >30 µs zero, <15 µs one) on a single wire. Any bus whose information is in the timing can be simulated this way, and the model even records where the datasheet and the real device disagree ("Tested in real device 202 us").

- **Cycle-accurate bus modelling as the enabling layer for peripherals** — `src/microsim/cores/z80/z80core.cpp:855-873` plus `src/microsim/cores/z80/z80cycles.h:25-53` — the CPU does not just execute instructions, it issues bus *operations* per machine cycle, and the number of cycles/T-states per opcode comes from a table. This is what makes a real video ULA simulable at all; for course work it is the difference between "an LED blinks" and "the video chip sees the real bus".

- **Explicit bus timing constants taken from the datasheet** — `src/microsim/cores/mcs65/mcs65core.cpp:139-142` — `tHR = 10 ns`, `tHA = 25 ns`, `tHW = 20 ns`, named and commented. Small, but it is the discipline that makes a cycle-accurate model auditable.

- **Every family plugs into five fixed seams** — `src/microsim/cores/mcu8bits.h:46-60`, `src/microsim/mcumodule.h:23-31`, `src/microsim/mcudataspace.h:33-34`, `src/microsim/cores/cpu8bits.h:30-36` — `Cpu8bits` (PC/STATUS/stack), `Mcu8bits` (RAM + SFR + stack helpers), `DataSpace` (masked register file), `McuModule` (setup/reset/configure/callBack/sleep) and `McuCreator` (per-family factory). A course can add a new architecture by filling in five seams, and the repo's own seven cores are the worked examples.

- **A shared bus engine reused by every chip family** — `src/microsim/modules/spi/spimodule.cpp:128-146` and `src/microsim/modules/twi/twimodule.cpp:41-99` — the SPI and I2C protocols live once, in chip-agnostic modules, and each family only supplies its registers and its pin wiring (the AVR SPI is 130 lines on top of a 203-line shared engine). The August harness should build its simulation primitives at this level, once, and let the "chips" be thin.

- **Resolve a bit field by name, not by position** — `src/microsim/datautils.cpp:16-34` — `getRegBits("ADEN,ADPS0")` finds the base bit by rotating the mask, so no core ever hard-codes a bit index. This is what makes the register map data-driven, and it is the single change that would most improve an agent's firmware-generation accuracy.

## Files skipped (with reasons)

None. All 258 files in the shard were opened and read. Three files are large enough that I read them in sections rather than in one pass, and I say so here rather than pretending otherwise:

- `src/microsim/cores/z80/z80core.cpp` (2213 lines / 155 KB) — read in five passes (1-330, 400-819, 820-1219, 1220-1931, 1932-2213). I did not read the comment-only decode tables at lines 1219-1700 line by line — they are one `case` per opcode with the mnemonic in a trailing comment, and I read the surrounding structure and the representative arms.

- `src/microsim/cores/qemu/esp32/esp32.cpp` (795 lines) — read in two passes (1-400, 401-795). Lines 300-790 are the signal-matrix table: ~490 lines of `m_gpio->m_matrixIn[N] = { nullptr, nullptr, "LABEL" };` assignments. I read the head and tail of that table and the two functions that consume it, and I am confident about the shape, but I did not verify all 512 entries individually.

- `src/microsim/mcucreator.cpp` (1472 lines) — read in two passes (1-1441, 1442-1472). The middle sections are repetitive per-peripheral `createXxx` functions; I read the dispatch table, `getRegisters`, `createCfgWord`, `createIntOsc`, `createTimer` and `setConfigRegs`/`setPrescalers` in full, and the remaining per-peripheral functions at the level of "which class it instantiates and which XML attributes it reads".

No file was skipped. There are no generated, vendored, binary or huge-data files in this shard — every one of the 258 files is hand-written C++ source or a hand-written header (the closest to "data" are the two lookup tables in `z80cycles.h` and the signal matrix in `esp32.cpp`, both of which I read).

## Uncertainties

- **I did not verify the build.** I did not compile anything (per the read-only rule), so I cannot say whether the shard builds cleanly as-is. The presence of `// FIXME` markers in the QEMU files (`qemuusart.cpp:21`, the commented-out register handling in `stm32timer.cpp` and `esp32usart.cpp`) suggests the QEMU bridge is a work in progress, but I could not confirm what still links.

- **I could not determine which parts of the shard are actually exercised.** There are no tests anywhere in `src/microsim/` (I checked: no file matches `test`/`spec`), so the manifest's "testing" lens is answered only negatively from this shard. Whether the QEMU bridge, the OneWire module or the ZX ULA are functional in the shipped application I cannot say from source alone — I would need to run the app.

- **I could not establish the exact contents of the `.mcu` XML files.** They live outside this shard (in `resources/`, which belongs to the resources shard), so my description of the device format is inferred from the *parser* (`mcucreator.cpp`) and the attribute names it reads, not from a sample file. The parser shows the tag names, the `core`/`data`/`prog`/`progword`/`progpage`/`eeprom`/`inst_cycle`/`cpu_cycle`/`freq` root attributes, and the per-register `name`/`addr`/`reset`/`mask`/`bits` attributes; it does not show the *format* of the file as a user would author it.

- **The undo/redo mechanism is not in this shard.** I grepped the whole of `src/microsim/` for `undo`/`redo`/`QUndo` and the only hits are the word "undocumented" in two Z80 comments. Undo/redo for the circuit editor therefore lives in the editor/canvas shard, and this shard contributes only the "does the simulation replay?" side of the question — which I also could not answer from here, since the simulator's event queue is not in this shard.

- **The simulator's event scheduler and the circuit solver are not in this shard either.** `Simulator::self()->addEvent/cancelEvents/circTime` is used pervasively (e.g. `mcutimer.cpp:137`) but `simulator.cpp` lives elsewhere, so the *time base* (how picoseconds map to real time, how the event queue is ordered, how the analog solver is interleaved) is outside what I could read. I have described the engine as "picosecond time base with a scheduled event queue" on the strength of the call sites, not on the strength of the scheduler itself.

- **Two small correctness observations I could not resolve.** `picmrcore.cpp:38` passes an unshifted `0x100` to `write_S_Bit` (works only because the writer tests truthiness), and `avrtimer.cpp:93` uses the prescaler index as the "is running" flag (so a timer with prescaler 0 reads as stopped). Both are in code I read carefully; I could not determine whether they are deliberate or latent, and I did not check whether any caller works around them.
